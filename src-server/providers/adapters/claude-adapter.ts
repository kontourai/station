import crypto from 'node:crypto';
import {
  deleteSession,
  forkSession,
  listSessions,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  CapabilityDeliveryChannelReport,
  CapabilityUndelivered,
  ResolvedAgentDefinition,
} from '@kontourai/station-contracts/provider';
import {
  APPROVAL_ESCALATION_REQUIRES_RESTART_CODE,
  MODEL_SELECTION_RECEIPT_METADATA_KEY,
  modelSelectionReceipt,
  SYSTEM_PROMPT_CAPABILITY_ID,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  ModelOption,
  ModelOptionCapabilities,
  Prerequisite,
} from '@kontourai/station-contracts/tool';
import type {
  PreToolPolicyDecision,
  StagedPreToolPolicyEvaluator,
} from '../../runtime/agents/pre-tool-policy.js';
import { isAutoApprovedExternalTool } from '../../runtime/tools/tool-executor.js';
import type { InvocationContext } from '../../runtime/types.js';
import { ensureEngineSpawnTmpDir } from '../../services/infra/engine-spawn-tmpdir.js';
import {
  agentCapabilityUndelivered,
  agentSystemPromptSessions,
  appHomeSessions,
  claudeSkillsMaterializedSessions,
  providerOps,
} from '../../telemetry/metrics.js';
import {
  childProcessEnvironment,
  scrubBootInternalSecrets,
} from '../../utils/child-process-environment.js';
import type {
  ProviderAdapterShape,
  ProviderAdoptionHooks,
  ProviderDiscardSessionRecovery,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionAdoptInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../adapter-shape.js';
import { ProviderTurnEndedError } from '../adapter-shape.js';
import { detectClaudeAuthState } from '../auth/claude-auth.js';
import {
  augmentedSpawnEnv,
  buildCliRuntimePrerequisites,
} from '../auth/cli-auth.js';
import { effectiveModelMetadata } from '../llm/effective-model-metadata.js';
import {
  decodeChatAttachments,
  decodeUtf8Attachment,
} from '../sessions/chat-attachments.js';
import { mergeCapabilityDeliveryMetadata } from './capability-delivery-metadata.js';
import {
  type ClaudeMessageState,
  mapClaudeDecisionToPermissionResult,
  mapClaudeSdkMessage,
} from './claude-adapter-events.js';
import {
  AsyncEventQueue,
  AsyncUserMessageQueue,
} from './claude-adapter-queues.js';
import {
  mapPermissionModeToApprovalMode,
  resolveClaudePermissionMode,
} from './claude-approval-mode.js';
import {
  type ClaudeToolServerSkip,
  resolveClaudeMcpServers,
} from './claude-mcp-passthrough.js';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_KNOWN_MODELS } from './claude-models.js';
import {
  cleanupMaterializedSkills,
  defaultClaudeGlobalConfigDirs,
  materializeSkills,
  sweepStaleManifests,
} from './claude-skills-materialization.js';
import {
  removeSkillOverlayDir,
  skillOverlayDirFor,
  sweepStaleSkillOverlays,
} from './claude-skills-overlay.js';
import { externalPreToolPolicyIdentity } from './external-pre-tool-policy-identity.js';

type PendingRequest = {
  resolve: (result: PermissionResult) => void;
  suggestions?: PermissionUpdate[];
  toolInput: Record<string, unknown>;
  /**
   * The SDK tool name this request was opened for. Needed because
   * `acceptForSession` has to be recordable even when the engine suggested no
   * rules to carry it — see `recordClaudeSessionGrants`.
   */
  toolName: string;
};

const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type ClaudeAppliedModelOptions = {
  effort?: ClaudeEffortLevel;
  thinking?: boolean;
  fastMode?: boolean;
  autoMode?: boolean;
};

// Claude's interactive CLI can occasionally leak terminal SGR styling into
// model-catalog values. Some launch paths have already removed ESC itself,
// leaving a literal trailing "[1m]" behind; normalize both forms at the
// external boundary so selectors never become durable session identities.
const ANSI_ESCAPE = String.fromCharCode(0x1b);
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${ANSI_ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|[@-_][0-?]*[ -/]*[@-~])`,
  'g',
);
const STRANDED_SGR_SUFFIX = /\[(?:\d{1,3}(?:;\d{1,3})*)m\]?$/;

function cleanClaudeCatalogText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(STRANDED_SGR_SUFFIX, '')
    .trim();
  return cleaned && cleaned.length <= 256 ? cleaned : undefined;
}

function claudeAppliedModelOptions(
  options?: Record<string, unknown>,
): ClaudeAppliedModelOptions {
  const effort =
    typeof options?.effort === 'string' &&
    CLAUDE_EFFORT_LEVELS.has(options.effort)
      ? (options.effort as ClaudeEffortLevel)
      : undefined;
  return {
    ...(effort ? { effort } : {}),
    ...(typeof options?.thinking === 'boolean'
      ? { thinking: options.thinking }
      : {}),
    ...(typeof options?.fastMode === 'boolean'
      ? { fastMode: options.fastMode }
      : {}),
    ...(typeof options?.autoMode === 'boolean'
      ? { autoMode: options.autoMode }
      : {}),
  };
}

function claudeModelCapabilities(
  model: Record<string, unknown>,
): ModelOptionCapabilities | undefined {
  const capabilities: ModelOptionCapabilities = {};
  let reported = false;
  for (const key of [
    'supportsEffort',
    'supportsAdaptiveThinking',
    'supportsFastMode',
    'supportsAutoMode',
  ] as const) {
    if (typeof model[key] === 'boolean') {
      capabilities[key] = model[key];
      reported = true;
    }
  }
  if (Array.isArray(model.supportedEffortLevels)) {
    const supportedEffortLevels = [
      ...new Set(
        model.supportedEffortLevels.filter(
          (level): level is string =>
            typeof level === 'string' && CLAUDE_EFFORT_LEVELS.has(level),
        ),
      ),
    ];
    capabilities.supportedEffortLevels = supportedEffortLevels;
    reported = true;
  }
  return reported ? capabilities : undefined;
}

type ClaudeSessionRecord = {
  session: ProviderSession;
  promptQueue: AsyncUserMessageQueue;
  query: Query;
  pendingRequests: Map<string, PendingRequest>;
  activeTurnId?: string;
  /** Set only once the prompt has entered the live SDK queue. */
  dispatchedTurnId?: string;
  /**
   * Mirrors `ClaudeMessageState.interruptingTurnId`; same object at runtime.
   * The SDK result mapper consumes it for the exact requested Stop only.
   */
  interruptingTurnId?: string;
  /** Mirrors `ClaudeMessageState.interruptedResultObserved`. */
  interruptedResultObserved?: boolean;
  /**
   * Tool names the operator granted for THIS session through Station's own
   * approval flow (`respondToRequest`'s `acceptForSession`, which forces every
   * suggested `PermissionUpdate` to `destination: 'session'`).
   *
   * Read only by the `PreToolUse` ask floor. The floor exists to override
   * authorities Station never saw — the engine's command classifier and the
   * settings files the CLI loaded — but a session grant is an authority
   * Station itself issued, on this operator's answer, so overriding it would
   * make "Allow for this session" mean nothing: the floor re-asks every time
   * and the engine's session rule never gets consulted (measured live before
   * this carve-out existed). Tracked by tool NAME only, which is coarser than
   * the engine's own rule (`Bash(pwd)` vs any `Bash`) — the residual is
   * recorded on `claudePermissionModeForcesAsk`.
   */
  sessionGrantedTools?: Set<string>;
  lastSessionState: 'idle' | 'running' | 'requires_action';
  streamTask: Promise<void>;
  /** Tracks the live SDK permission mode so sendTurn only calls
   * `setPermissionMode` when the resolved approvalMode actually changes. */
  currentPermissionMode: PermissionMode;
  /**
   * Whether this live process was spawned with
   * `allowDangerouslySkipPermissions: true` — the SDK requires that flag be
   * set at `query()` time for `permissionMode: 'bypassPermissions'` to take
   * effect, and it cannot be granted mid-session via `setPermissionMode`.
   * A mid-session escalation to `'never'` when this is `false` must be
   * rejected rather than silently applied (archive#727 review item 1).
   */
  allowsBypassPermissions: boolean;
  /** Model controls confirmed at spawn or by a successful SDK control call. */
  currentModelOptions: ClaudeAppliedModelOptions;
  /**
   * archive#1182: mirrors `ClaudeMessageState.lastReportedModel`
   * (`claude-adapter-events.ts`) — same object at runtime, declared here too
   * so `sendTurn` can reset it per-turn. See that field's docblock.
   */
  lastReportedModel?: string;
  /**
   * archive#1174: set only when this session's skills were materialized
   * into the Station-owned cwd-less overlay (see claude-skills-overlay.ts)
   * rather than a real project/user cwd. stopSession uses this to clean up
   * and remove the overlay directory; a session with a real cwd leaves this
   * unset and keeps using the existing cwd-scoped cleanup path unchanged.
   */
  skillsOverlayDir?: string;
  /**
   * archive#1827: mirrors `ClaudeMessageState.terminalResultObserved`
   * (`claude-adapter-events.ts`) — same object at runtime, declared here too
   * so `consumeMessages`' catch can read it. See that field's docblock.
   */
  terminalResultObserved?: boolean;
};

function adoptionTitle(threadId: string): string {
  return `Station continuation ${threadId}`;
}

/** Matches the `any`-typed logger convention used across `providers/adapters` (e.g. AcpAdapterOptions.logger). */
type ClaudeAdapterLogger = any;

export interface ClaudeAdapterOptions {
  /**
   * Resolve the claude connection's opted-in skill ids
   * (`AgentConnectionSettings.config.provideSkills`,
   * docs/design/connections-onboarding.md §5). Returns `undefined`/empty
   * ⇒ off — the default. Absent entirely ⇒ materialization never runs.
   */
  getProvideSkills?: () => Promise<string[] | undefined>;
  /**
   * Resolve a skill id to its installed on-disk directory (containing
   * SKILL.md); `null` when unknown. Required, alongside
   * `getProvideSkills`, for materialization to do anything.
   */
  resolveSkillDir?: (id: string) => Promise<string | null>;
  /**
   * App-home profile env (archive#896, agent-engine-unification.md §6.1's overlay
   * model, channel 2) — `undefined` when the claude connection has
   * not opted in (`config.useAppHome`) or on any resolution failure; the
   * caller degrades to `undefined` rather than throwing. Applied at
   * `startSession` only — see `adoptSession`'s doc comment for why
   * adoption deliberately never applies it.
   */
  getAppHomeEnv?: (
    credentialProfileRef?: string,
  ) => Promise<Record<string, string> | undefined>;
  /**
   * Station#1157 review fix (MEDIUM): the running instance's own
   * station-control operational env (`stationControlSpawnEnv(port)`'s
   * shape — `STATION_API_BASE`/`STATION_PORT`), forwarded alongside the
   * internal token ONLY when an authored `toolServers` resolves the
   * canonical built-in station-control server
   * (`claude-mcp-passthrough.ts`). Sync/no I/O — the caller already knows
   * its own bound port; deliberately NOT read from `process.env` here,
   * which is stale/unset under `PORT=0`/auto-allocate (see
   * `stationControlSpawnEnv`'s doc comment). Absent in callers that don't
   * wire it (e.g. most unit tests): station-control still gets the
   * internal token, just not STATION_API_BASE/STATION_PORT.
   */
  getStationControlEnv?: () => Record<string, string> | undefined;
  /**
   * Resolves Station's shared staged pre-tool evaluator for a real resolved
   * agent. It is intentionally absent for agent-less/synthetic sessions;
   * those retain the SDK's native permission behavior.
   */
  resolvePreToolPolicy?: (
    input: ProviderSessionStartInput,
  ) => Promise<StagedPreToolPolicyEvaluator | undefined>;
  /** Testable bound for the in-process PreToolUse callback. */
  preToolPolicyTimeoutMs?: number;
  logger?: ClaudeAdapterLogger;
}

const DEFAULT_PRE_TOOL_POLICY_TIMEOUT_MS = 5_000;

/**
 * Keep the raw SDK name for authentic grant provenance and any user-visible
 * receipt. Matching stages use the forms their owning policy understands:
 * `<server>_<tool>` for delegation and the MCP leaf for config protection.
 */
function sdkPreToolMatcherTimeoutSeconds(inProcessTimeoutMs: number): number {
  // The SDK matcher is a coarse, seconds-based outer circuit breaker. Keep it
  // strictly beyond Station's millisecond evaluator so Station can return its
  // fail-closed denial rather than the SDK timing out first.
  return Math.max(1, Math.floor(inProcessTimeoutMs / 1_000) + 1);
}

function serverDelegation(
  metadata: Record<string, unknown> | undefined,
): InvocationContext['delegation'] {
  const delegation = metadata?.delegation;
  return delegation && typeof delegation === 'object'
    ? (delegation as InvocationContext['delegation'])
    : undefined;
}

/**
 * Whether Station's approval mode obliges the hook to force an approval for a
 * call Station's own policy did not decide.
 *
 * `'default'` is what Station's `ask` approval mode resolves to
 * (claude-approval-mode.ts), and `ask` means ask. The engine's `default` mode
 * on its own does NOT: it consults its command classifier and every settings
 * file it loaded first, and `query()` here never narrows `settingSources`, so
 * the CLI default applies and a workspace's checked-in
 * `.claude/settings.json` `permissions.allow` (say `Bash(rm:*)`) is honored —
 * running the tool with no `request.opened` and no chance for the operator to
 * see it. `permissionDecision: 'ask'` is the hook's floor over all of that,
 * so it is the only value that makes the chip's promise true.
 *
 * `'acceptEdits'` and `'bypassPermissions'` are the opposite promise —
 * `auto` accepts edits, `never` never asks — so for those the hook must state
 * no opinion and let the engine's mode mean what it says. `'plan'` (raw
 * `modelOptions.permissionMode`, no `ApprovalMode` analog) keeps the engine's
 * own behavior for the same reason.
 */
function claudePermissionModeForcesAsk(mode: PermissionMode): boolean {
  return mode === 'default';
}

/**
 * Records what `acceptForSession` granted, so the ask floor can stand down for
 * it. Reads the tool names off the SDK's own suggested rules — the exact
 * updates Station forwarded — rather than inferring them from the tool that
 * happened to be pending.
 *
 * DISCLOSED RESIDUAL: matching is by tool name, not by the engine's rule
 * content, so after the operator allows (say) `Bash(pwd)` for the session, a
 * settings-file `allow` rule for a DIFFERENT `Bash` command is no longer
 * re-asked by the floor for the rest of that session. Narrowing this needs the
 * engine's rule matcher, and reimplementing that here is how a second reader
 * of an authorization eventually gets it wrong; the honest bound is to record
 * the gap where the decision is made.
 */
function recordClaudeSessionGrants(
  record: { sessionGrantedTools?: Set<string> },
  pending: { suggestions?: PermissionUpdate[]; toolName: string },
): void {
  const granted = new Set<string>();
  for (const update of pending.suggestions ?? []) {
    if (update.type !== 'addRules' && update.type !== 'replaceRules') continue;
    if (update.behavior !== 'allow') continue;
    for (const rule of update.rules) {
      if (typeof rule.toolName === 'string' && rule.toolName) {
        granted.add(rule.toolName);
      }
    }
  }
  // A request the ASK FLOOR forced arrives with no suggested rules at all
  // (measured live: `request.opened` for a floored `Bash pwd` carries none),
  // so `updatedPermissions` goes back empty and the engine records nothing —
  // "Allow for this session" would silently mean "allow once". Station asked
  // the question ("Allow Bash") and the operator answered it for the session,
  // so Station records the answer against the tool it asked about. Subsequent
  // calls to that tool still reach the engine's own flow, which asks again for
  // anything it does not already allow.
  if (granted.size === 0) granted.add(pending.toolName);
  for (const toolName of granted) {
    record.sessionGrantedTools ??= new Set<string>();
    record.sessionGrantedTools.add(toolName);
  }
}

function preToolPolicyHookOutput(
  decision: PreToolPolicyDecision,
  forcesAsk: boolean,
) {
  if (decision.behavior === 'allow') {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'allow' as const,
      },
    };
  }
  if (decision.behavior === 'deny') {
    return {
      continue: false,
      stopReason: decision.denial.reason,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: decision.denial.reason,
      },
    };
  }
  // `ask` and `defer` both mean the same thing here: Station's policy is not
  // deciding this call, so the engine's permission flow owns it and
  // `canUseTool` is where it reaches Station's ApprovalRegistry. Neither ever
  // opens a second Station request from inside the hook.
  //
  // What the hook says about it depends on the mode Station promised the
  // operator — see `claudePermissionModeForcesAsk`. In `ask` the hook forces
  // the request; otherwise it states no opinion at all.
  //
  // NEVER `permissionDecision: 'defer'`, which this used to return for both.
  // `'defer'` is not a pass-through in the Claude hook contract: it hands the
  // tool call BACK to the SDK host to execute. For a SOLO tool call the CLI
  // ends the turn on the spot with `stop_reason: 'tool_deferred'` and the call
  // on `result.deferred_tool_use`, and never consults `canUseTool` — so every
  // solo call reaching this branch (anything not already granted or
  // auto-approved) died silently: a `tool.started` with no `tool.completed`,
  // and a turn that read as an ordinary stop (#1536 finding B1, #765 A4). An
  // assistant message carrying more than one `tool_use` was unaffected — the
  // engine ignores `defer` for a parallel batch — which is why the defect
  // presented as intermittent rather than total. Verified live against
  // `claude` 2.1.261: with `defer`, `permissionMode` `default`, `acceptEdits`
  // and `bypassPermissions` all returned `stop_reason: 'tool_deferred'`,
  // `result: ''`, `num_turns: 1` with `canUseTool` uncalled; with `'ask'` and
  // with no `permissionDecision` the same prompt reached `canUseTool` and ran.
  if (forcesAsk) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'ask' as const,
      },
    };
  }
  return { continue: true };
}

async function evaluateClaudePreToolPolicy(
  evaluator: StagedPreToolPolicyEvaluator,
  input: { tool_name: string; tool_input: unknown; tool_use_id: string },
  invocation: InvocationContext,
  timeoutMs: number,
  /**
   * Whether the hook must force an approval for THIS call, resolved per call
   * rather than captured at spawn: `sendTurn` can move a live session between
   * approval modes via `setPermissionMode` (see `record.currentPermissionMode`)
   * and `acceptForSession` can add a session grant mid-turn, so a hook that
   * answered from a closed-over spawn-time value would keep forcing — or keep
   * not forcing — an approval the operator has since changed.
   */
  resolveForcesAsk: (toolName: string) => boolean,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const decision = await Promise.race([
      evaluator(
        {
          toolName: input.tool_name,
          toolCallId: input.tool_use_id,
          toolArgs: input.tool_input,
        },
        invocation,
        {
          interaction: 'external',
          identity: externalPreToolPolicyIdentity(input.tool_name),
        },
      ),
      new Promise<PreToolPolicyDecision>((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              behavior: 'deny',
              denial: {
                allowed: false,
                reason:
                  'Station pre-tool policy timed out; tool execution was denied.',
              },
            }),
          timeoutMs,
        );
      }),
    ]);
    return preToolPolicyHookOutput(decision, resolveForcesAsk(input.tool_name));
  } catch (error) {
    const reason = `Station pre-tool policy failed; tool execution was denied: ${error instanceof Error ? error.message : String(error)}`;
    // A deny ignores this argument; it is still resolved from the same seam so
    // there is only one way to answer the question.
    return preToolPolicyHookOutput(
      { behavior: 'deny', denial: { allowed: false, reason } },
      resolveForcesAsk(input.tool_name),
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ClaudeAdapter implements ProviderAdapterShape {
  readonly provider = 'claude' as const;
  readonly metadata = {
    displayName: 'Claude Code',
    description: 'Claude Code integration with approvals and reasoning events.',
    capabilities: [
      'agent-runtime',
      'session-lifecycle',
      'tool-calls',
      'interrupt',
      'approvals',
      'reasoning-events',
      'image-input',
      'file-input',
    ],
    continuity: { resume: 'same-session', fork: 'none', rewind: 'none' },
    connectionId: engineConnectionId('claude'),
    builtin: true,
    engineId: engineId('claude'),
    abortSettlement: 'await',
    recovery: {
      sameSession: true,
      maxAttempts: 1,
      // CLAUDE_CONFIG_DIR does not isolate macOS Keychain OAuth identity, so
      // Station cannot yet prove that a selected credential profile changed accounts.
      application: 'unsupported',
    },
    defaultModel: CLAUDE_DEFAULT_MODEL,
    knownModels: CLAUDE_KNOWN_MODELS,
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  } as const;

  private readonly events = new AsyncEventQueue();
  private readonly sessions = new Map<string, ClaudeSessionRecord>();

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const { report: skillsReport, overlayDir } =
      await this.prepareSkillsMaterialization(
        input.cwd,
        input.cwdDefaulted,
        input.threadId,
        input.agent,
      );
    const appHomeEnv = await this.resolveAppHomeEnv(input.credentialProfileRef);
    const augmentedEnv = await this.resolveAugmentedSpawnEnv();
    const preToolPolicy = await this.resolvePreToolPolicy(input);
    return this.startTrackedSession(
      input,
      input.persistSession === true,
      skillsReport,
      appHomeEnv,
      overlayDir,
      augmentedEnv,
      preToolPolicy,
    );
  }

  async adoptSession(
    input: ProviderSessionAdoptInput,
    hooks?: ProviderAdoptionHooks,
  ): Promise<ProviderSession> {
    if (input.sourceKind !== 'claude-transcript') {
      throw new Error(
        'Claude can only continue a discovered Claude transcript.',
      );
    }
    if (this.sessions.has(input.threadId)) {
      throw new Error(`Claude session already exists: ${input.threadId}`);
    }
    const fork = await forkSession(input.sourceSessionId, {
      dir: input.cwd,
      title: adoptionTitle(input.threadId),
    });
    if (!fork.sessionId || fork.sessionId === input.sourceSessionId) {
      throw new Error(
        'Claude adoption did not produce a distinct child session.',
      );
    }
    try {
      await hooks?.onProviderChildCreated(fork.sessionId);
      const { report: skillsReport, overlayDir } =
        await this.prepareSkillsMaterialization(
          input.cwd,
          input.cwdDefaulted,
          input.threadId,
          input.agent,
        );
      // Adoption deliberately never applies the app-home env: forking a
      // transcript uses the server-process SDK helpers (`forkSession`,
      // and `listSessions`/`deleteSession` on discard/recovery below),
      // which are bound to the server's own (global) config root and have
      // no per-call config-dir override — running the forked child under a
      // different config home would orphan it there (archive#896, decision 2). The
      // login-PATH augmentation (archive#1156) is unrelated to that
      // config-root concern and DOES still apply here — an adopted session
      // spawns MCP servers exactly like a fresh one.
      const augmentedEnv = await this.resolveAugmentedSpawnEnv();
      const preToolPolicy = await this.resolvePreToolPolicy(input);
      return this.startTrackedSession(
        { ...input, resumeCursor: fork.sessionId, persistSession: true },
        true,
        skillsReport,
        undefined,
        overlayDir,
        augmentedEnv,
        preToolPolicy,
      );
    } catch (error) {
      await deleteSession(fork.sessionId, { dir: input.cwd }).catch(() => {});
      throw error;
    }
  }

  async discardSession(
    threadId: string,
    recovery?: ProviderDiscardSessionRecovery,
  ): Promise<void> {
    const record = this.sessions.get(threadId);
    let cursor = record?.session.resumeCursor ?? recovery?.resumeCursor;
    const cwd = record?.session.cwd ?? recovery?.cwd;
    await this.stopSession(threadId);
    if (
      typeof cursor !== 'string' &&
      cwd &&
      recovery?.adoptionKey &&
      recovery.createdAt
    ) {
      const earliest = Date.parse(recovery.createdAt);
      const recovered = (await listSessions({ dir: cwd })).find(
        (session) =>
          session.customTitle === adoptionTitle(recovery.adoptionKey!) &&
          session.lastModified >= earliest - 1_000,
      );
      cursor = recovered?.sessionId;
    }
    if (typeof cursor === 'string') {
      // Best-effort: a session that ran under an app-home profile may have
      // its transcript under a different config root than the server-env
      // `deleteSession` call resolves (archive#896, decision 5) — Station owns the
      // profile dir, so an orphaned transcript there is not a discard
      // failure. Profile GC is a wave-2 follow-up, not implemented here.
      await deleteSession(cursor, { dir: cwd }).catch((error) => {
        (this.options.logger ?? console).warn?.(
          `Claude discardSession: deleteSession failed for cursor '${cursor}' (possibly an app-home-profile session whose transcript lives under a different config root): ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  private async resolvePreToolPolicy(
    input: ProviderSessionStartInput,
  ): Promise<StagedPreToolPolicyEvaluator | undefined> {
    if (!input.agent || !this.options.resolvePreToolPolicy) return undefined;
    try {
      return await this.options.resolvePreToolPolicy(input);
    } catch (error) {
      const reason = `Station pre-tool policy could not be prepared; tool execution was denied: ${error instanceof Error ? error.message : String(error)}`;
      return async () => ({
        behavior: 'deny',
        denial: { allowed: false, reason },
      });
    }
  }

  private startTrackedSession(
    input: ProviderSessionStartInput,
    persistSession: boolean,
    skillsReport?: CapabilityDeliveryChannelReport,
    appHomeEnv?: Record<string, string>,
    skillsOverlayDir?: string,
    augmentedEnv?: Record<string, string | undefined>,
    preToolPolicy?: StagedPreToolPolicyEvaluator,
  ): ProviderSession {
    const now = new Date().toISOString();
    const promptQueue = new AsyncUserMessageQueue();
    const permissionMode = this.resolvePermissionMode(input.modelOptions);
    const appHome: 'profile' | 'global' = appHomeEnv ? 'profile' : 'global';
    const toolServers = this.resolveAgentToolServers(input);
    const sdkQuery = query({
      prompt: promptQueue,
      options: this.buildOptions(
        input,
        persistSession,
        permissionMode,
        appHomeEnv,
        toolServers.mcpServers,
        skillsOverlayDir,
        augmentedEnv,
        preToolPolicy,
      ),
    });

    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'connecting',
      model: input.modelId,
      cwd: input.cwd,
      resumeCursor: input.resumeCursor,
      controlMode: 'station-owned',
      persistSession,
      createdAt: now,
      updatedAt: now,
    };

    const record: ClaudeSessionRecord = {
      session,
      promptQueue,
      query: sdkQuery,
      pendingRequests: new Map(),
      lastSessionState: 'idle',
      streamTask: Promise.resolve(),
      currentPermissionMode: permissionMode,
      allowsBypassPermissions: permissionMode === 'bypassPermissions',
      currentModelOptions: claudeAppliedModelOptions(input.modelOptions),
      skillsOverlayDir,
    };
    record.streamTask = this.consumeMessages(record);
    this.sessions.set(input.threadId, record);

    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: input.threadId,
      initialState: 'created',
      metadata: { ...input.metadata, cwd: input.cwd },
    });
    const baseConfiguredMetadata: Record<string, unknown> = {
      ...input.metadata,
      ...effectiveModelMetadata(input.modelId, record.currentModelOptions),
      // Explicit resolved values (not just the raw modelOptions spread
      // above) so the durable record reflects what the adapter actually
      // applied — including the 'plan' escape hatch and the
      // allowDangerouslySkipPermissions grant (archive#727 review item 5).
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
      // Lets the client track a durable lastAppliedApprovalMode baseline at
      // session start (archive#727 review round 3, item 1 — the pending-apply chip
      // state).
      approvalMode: mapPermissionModeToApprovalMode(permissionMode),
      // archive#896: whether this session's SDK spawn env was layered with the
      // claude app-home profile, or left at the global config
      // (opted out, adoption, or a degraded lookup).
      appHome,
    };
    let configuredMetadata: Record<string, unknown> = skillsReport
      ? mergeCapabilityDeliveryMetadata(
          baseConfiguredMetadata,
          'skills',
          skillsReport,
        )
      : baseConfiguredMetadata;
    // archive#1157: chained over the skills merge above, same composition
    // rationale as the systemPrompt merge below — mergeCapabilityDeliveryMetadata
    // prepends any resolution-stage undelivered entries already present in
    // inputMetadata (session-agent-resolution.ts's engine-unsupported/
    // not-found/secret-boundary-env receipts), so passing the previous
    // call's output as inputMetadata preserves every channel report.
    if (toolServers.report) {
      configuredMetadata = mergeCapabilityDeliveryMetadata(
        configuredMetadata,
        'toolServers',
        toolServers.report,
      );
    }
    // archive#895 wave B: chained over the skills merge above —
    // mergeCapabilityDeliveryMetadata composes (it prepends any
    // resolution-stage undelivered entries already present in
    // inputMetadata), so passing the previous call's output as
    // inputMetadata here preserves both channel reports.
    if (input.agent?.systemPrompt) {
      configuredMetadata = mergeCapabilityDeliveryMetadata(
        configuredMetadata,
        'systemPrompt',
        {
          source: 'agent',
          requested: [SYSTEM_PROMPT_CAPABILITY_ID],
          delivered: [SYSTEM_PROMPT_CAPABILITY_ID],
          undelivered: [],
        },
      );
      agentSystemPromptSessions.add(1, {
        provider: this.provider,
        channel: 'flag',
      });
    }

    configuredMetadata[MODEL_SELECTION_RECEIPT_METADATA_KEY] =
      modelSelectionReceipt(input.modelId, record.session.model);

    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.configured',
      sessionId: input.threadId,
      model: input.modelId,
      cwd: input.cwd,
      metadata: configuredMetadata,
    });
    providerOps.add(1, {
      operation: 'adapter-session-start',
      provider: this.provider,
      model_options:
        Object.keys(record.currentModelOptions).length > 0 ? 'applied' : 'none',
    });
    appHomeSessions.add(1, { provider: this.provider, applied: appHome });

    return session;
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const record = this.requireSession(input.threadId);
    const turnId = crypto.randomUUID();
    record.activeTurnId = turnId;
    // archive#1182: a fresh turn has not reported anything yet — clear the
    // previous turn's value so a turn that ends before any assistant
    // message arrives publishes no `reportedModel` rather than a stale one.
    record.lastReportedModel = undefined;
    const decodedAttachments = decodeChatAttachments(input.attachments);
    const content: string | ContentBlockParam[] =
      decodedAttachments.length === 0
        ? input.input
        : [
            ...(input.input
              ? ([{ type: 'text', text: input.input }] as ContentBlockParam[])
              : []),
            ...decodedAttachments.map(({ attachment, base64 }) => {
              if (attachment.kind === 'image') {
                return {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: attachment.mimeType,
                    data: base64,
                  },
                } as ContentBlockParam;
              }
              if (attachment.mimeType === 'application/pdf') {
                return {
                  type: 'document',
                  title: attachment.name,
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: base64,
                  },
                } as ContentBlockParam;
              }
              return {
                type: 'document',
                title: attachment.name,
                source: {
                  type: 'text',
                  media_type: 'text/plain',
                  data: decodeUtf8Attachment({ attachment, base64 }),
                },
              } as ContentBlockParam;
            }),
          ];

    // A session-level approval override reaches Claude Code from the next
    // turn: the live SDK Query exposes setPermissionMode for exactly this,
    // so no thread restart is needed. Station resends the full session
    // override bag on every turn (see useActiveChatSessionMessaging.ts),
    // so this only calls the SDK when the resolved mode actually changed.
    const targetPermissionMode = this.resolvePermissionMode(input.modelOptions);
    let rejectedEscalation = false;
    if (targetPermissionMode !== record.currentPermissionMode) {
      if (
        targetPermissionMode === 'bypassPermissions' &&
        !record.allowsBypassPermissions
      ) {
        // The SDK requires allowDangerouslySkipPermissions to be granted at
        // spawn time (see buildOptions) — it cannot be flipped on mid-session
        // via setPermissionMode. Refuse the escalation instead of pretending
        // it applied: do not call the SDK, do not update
        // currentPermissionMode, and tell the caller which mode is actually
        // still in effect so the composer chip can revert to reality rather
        // than show 'never' for a mode that never took effect.
        rejectedEscalation = true;
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          method: 'runtime.warning',
          severity: 'warning',
          message:
            'Full-access mode requires restarting the session with that mode enabled from the start. Approval mode was not changed.',
          code: APPROVAL_ESCALATION_REQUIRES_RESTART_CODE,
          details: {
            requestedApprovalMode: 'never',
            revertToApprovalMode:
              mapPermissionModeToApprovalMode(record.currentPermissionMode) ??
              'ask',
          },
        });
      } else {
        await record.query.setPermissionMode(targetPermissionMode);
        record.currentPermissionMode = targetPermissionMode;
      }
    }

    if (input.modelId && input.modelId !== record.session.model) {
      await record.query.setModel(input.modelId);
      record.session.model = input.modelId;
      record.session.updatedAt = new Date().toISOString();
    }

    const requestedModelOptions = claudeAppliedModelOptions(input.modelOptions);
    const flagSettings: Record<string, unknown> = {};
    if (requestedModelOptions.effort !== record.currentModelOptions.effort) {
      flagSettings.effortLevel = requestedModelOptions.effort ?? null;
    }
    if (
      requestedModelOptions.thinking !== record.currentModelOptions.thinking
    ) {
      flagSettings.alwaysThinkingEnabled =
        requestedModelOptions.thinking ?? null;
    }
    if (
      requestedModelOptions.fastMode !== record.currentModelOptions.fastMode
    ) {
      flagSettings.fastMode = requestedModelOptions.fastMode ?? null;
    }
    if (
      requestedModelOptions.autoMode !== record.currentModelOptions.autoMode
    ) {
      flagSettings.disableAutoMode =
        requestedModelOptions.autoMode === false ? 'disable' : null;
    }
    if (Object.keys(flagSettings).length > 0) {
      // The live SDK control surface applies the same flag-settings layer used
      // by Claude Code. Its generated Settings type can lag newly reported
      // effort values (for example `max`), so runtime success—not a local cast—
      // is the confirmation boundary before Station records the selection.
      try {
        await record.query.applyFlagSettings(
          flagSettings as Parameters<Query['applyFlagSettings']>[0],
        );
        record.currentModelOptions = requestedModelOptions;
        providerOps.add(1, {
          operation: 'adapter-model-options',
          provider: this.provider,
          model_options:
            Object.keys(requestedModelOptions).length > 0 ? 'applied' : 'none',
        });
      } catch (error) {
        providerOps.add(1, {
          operation: 'adapter-model-options',
          provider: this.provider,
          model_options: 'rejected',
        });
        throw error;
      }
    }

    record.promptQueue.push({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      session_id: input.threadId,
      uuid: turnId,
      timestamp: new Date().toISOString(),
    });
    // An allocated ID is not enough to attribute an inbound SDK result: a
    // resume/init handshake can arrive while async setup above is in flight.
    // Arm completion provenance only after this turn's prompt is queued.
    record.dispatchedTurnId = turnId;

    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      turnId,
      method: 'turn.started',
      // Transcript-facing: the typed text, never the composed model input.
      prompt: input.displayInput ?? input.input,
      attachments: input.attachments,
      ...(input.ambientContext ? { ambientContext: input.ambientContext } : {}),
      // Durable per-turn record of the resolved (actually-applied, not
      // merely requested) approval posture (archive#727 review item 5).
      metadata: {
        ...effectiveModelMetadata(
          record.session.model,
          record.currentModelOptions,
        ),
        ...(input.recoveryCorrelationId
          ? { recoveryCorrelationId: input.recoveryCorrelationId }
          : {}),
        permissionMode: record.currentPermissionMode,
        approvalMode: mapPermissionModeToApprovalMode(
          record.currentPermissionMode,
        ),
        ...(rejectedEscalation ? { approvalEscalationRejected: true } : {}),
        [MODEL_SELECTION_RECEIPT_METADATA_KEY]: modelSelectionReceipt(
          input.modelId,
          input.modelId ? record.session.model : undefined,
        ),
      },
    });

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: record.session.resumeCursor,
    };
  }

  async interruptTurn(threadId: string, turnId?: string) {
    const record = this.requireSession(threadId);
    if (!record.activeTurnId) return { outcome: 'no-active-turn' } as const;
    if (turnId && turnId !== record.activeTurnId) {
      return {
        outcome: 'target-mismatch',
        activeTurnId: record.activeTurnId,
      } as const;
    }
    const targetTurnId = turnId ?? record.activeTurnId;
    // Mark before calling the SDK: its async iterator may publish the
    // `is_error` result before `interrupt()` resolves. The mapper consumes
    // this marker only for this exact dispatched turn.
    record.interruptingTurnId = targetTurnId;
    // A rejected control promise does not prove the engine ignored the
    // interrupt. Keep the exact-turn marker armed until the SDK result stream
    // confirms what happened; a second Stop must not clear the first one's
    // still-pending receipt either.
    await record.query.interrupt();
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      turnId: targetTurnId,
      method: 'turn.aborted',
      reason: 'interrupted',
    });
    return { outcome: 'cancelled', turnId: targetTurnId } as const;
  }

  async steerTurn(
    threadId: string,
    input: string,
    turnId: string,
  ): Promise<void> {
    const record = this.requireSession(threadId);
    if (record.activeTurnId !== turnId) {
      throw new Error(`Claude turn '${turnId}' is no longer active.`);
    }
    // The SDK query was created with this still-open AsyncIterable. Pushing a
    // second SDKUserMessage is Query.streamInput's native mid-turn input path.
    const enqueued = record.promptQueue.push({
      type: 'user',
      message: { role: 'user', content: input },
      parent_tool_use_id: null,
      session_id: threadId,
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });
    if (!enqueued) {
      throw new ProviderTurnEndedError();
    }
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      turnId,
      method: 'turn.started',
      prompt: input,
      inputKind: 'steer',
    });
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    const record = this.requireSession(threadId);
    const pending = record.pendingRequests.get(requestId);
    if (!pending) {
      throw new Error(`Unknown Claude permission request: ${requestId}`);
    }

    record.pendingRequests.delete(requestId);
    if (decision === 'acceptForSession') {
      recordClaudeSessionGrants(record, pending);
    }
    pending.resolve(
      mapClaudeDecisionToPermissionResult(
        decision,
        pending.toolInput,
        pending.suggestions,
      ),
    );

    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      requestId,
      method: 'request.resolved',
      status:
        decision === 'accept' || decision === 'acceptForSession'
          ? 'approved'
          : decision === 'decline'
            ? 'denied'
            : 'cancelled',
    });
  }

  async stopSession(threadId: string): Promise<void> {
    const record = this.sessions.get(threadId);
    if (!record) return;
    this.sessions.delete(threadId);
    // Settle outstanding canUseTool promises before teardown so the SDK
    // callback never hangs on a stopped session (mirrors acp-adapter, archive#148).
    for (const [requestId, pending] of record.pendingRequests) {
      pending.resolve(
        mapClaudeDecisionToPermissionResult(
          'cancel',
          pending.toolInput,
          pending.suggestions,
        ),
      );
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId,
        createdAt: new Date().toISOString(),
        requestId,
        method: 'request.resolved',
        status: 'cancelled',
      });
    }
    record.pendingRequests.clear();
    record.promptQueue.close();
    record.query.close();
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      sessionId: threadId,
      reason: 'stopped',
    });
    if (record.skillsOverlayDir) {
      // archive#1174: the overlay is fully Station-owned (see
      // claude-skills-overlay.ts), so cleanup goes further than the
      // real-cwd path below — after the hash-verified per-file cleanup,
      // the whole per-session overlay directory is removed unconditionally.
      const overlayDir = record.skillsOverlayDir;
      await cleanupMaterializedSkills({
        cwd: overlayDir,
        sessionId: threadId,
        globalConfigDirs: defaultClaudeGlobalConfigDirs(
          undefined,
          undefined,
          overlayDir,
        ),
        logger: this.options.logger,
      })
        .catch((error) => {
          (this.options.logger ?? console).warn?.(
            `Claude skills overlay cleanup failed for '${overlayDir}': ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() =>
          removeSkillOverlayDir(threadId, { logger: this.options.logger }),
        );
    } else if (record.session.cwd) {
      // Best-effort — a cleanup failure must never surface as a stopSession
      // failure (mirrors the never-reject posture at session start). Scoped
      // to THIS session's own manifest only (per-session manifests —
      // concurrent sessions in the same cwd never touch each other's files).
      await cleanupMaterializedSkills({
        cwd: record.session.cwd,
        sessionId: threadId,
        globalConfigDirs: defaultClaudeGlobalConfigDirs(
          undefined,
          undefined,
          record.session.cwd,
        ),
        logger: this.options.logger,
      }).catch((error) => {
        (this.options.logger ?? console).warn?.(
          `Claude skills materialization cleanup failed for '${record.session.cwd}': ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()].map((record) => record.session);
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    try {
      await Promise.all(
        [...this.sessions.keys()].map((threadId) => this.stopSession(threadId)),
      );
    } finally {
      this.events.close();
    }
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }

  async getPrerequisites(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]> {
    return buildCliRuntimePrerequisites({
      command: 'claude',
      displayName: 'Claude',
      versionArgs: ['--version'],
      // Older Claude CLIs parse `claude auth status` as a chat prompt.
      authArgs: [],
      detectAuthState: detectClaudeAuthState,
      installStep: 'Install the Claude CLI and ensure `claude` is on PATH.',
      authStep: 'Run `claude auth login` before starting Station.',
      signal: options?.signal,
    });
  }

  async listModelCatalog(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<{
    models: ModelOption[];
    truncated?: boolean;
  }> {
    const maxEntries = Math.min(
      1000,
      Math.max(1, Math.floor(options?.maxEntries ?? 1000)),
    );
    options?.signal?.throwIfAborted();

    const abortController = new AbortController();
    const abortProbe = () => abortController.abort(options?.signal?.reason);
    options?.signal?.addEventListener('abort', abortProbe, { once: true });
    const promptQueue = new AsyncUserMessageQueue();
    const sdkQuery = query({
      prompt: promptQueue,
      options: {
        abortController,
        // The Agent SDK owns this process spawn, so it cannot inherit
        // Station's normal subprocess environment. Give discovery the same
        // Station-owned tmp directory as an interactive session; otherwise a
        // systemd PrivateTmp namespace makes Claude's extracted payloads
        // invisible to Station's reaper.
        env: childProcessEnvironment({ TMPDIR: ensureEngineSpawnTmpDir() }),
        mcpServers: {},
        persistSession: false,
        plugins: [],
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
        tools: [],
      },
    });

    try {
      const reported = await sdkQuery.supportedModels();
      const seen = new Set<string>();
      const models: ModelOption[] = [];
      const maxInspections = Math.min(4000, Math.max(32, maxEntries * 4));
      let truncated = reported.length > maxInspections;
      for (const model of reported.slice(0, maxInspections)) {
        if (!model || typeof model !== 'object') continue;
        const id = cleanClaudeCatalogText(model.value);
        if (!id) continue;
        const catalogName = cleanClaudeCatalogText(model.displayName);
        if (
          typeof model.displayName === 'string' &&
          model.displayName.trim() &&
          !catalogName
        )
          continue;
        const name = catalogName ?? id;
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        if (models.length === maxEntries) {
          truncated = true;
          break;
        }
        const capabilities = claudeModelCapabilities(
          model as Record<string, unknown>,
        );
        const candidateResolvedModel = cleanClaudeCatalogText(
          model.resolvedModel,
        );
        const resolvedModel =
          candidateResolvedModel && candidateResolvedModel !== id
            ? candidateResolvedModel
            : undefined;
        models.push({
          id,
          name,
          originalId: id,
          ...(resolvedModel ? { resolvedModel } : {}),
          ...(capabilities ? { capabilities } : {}),
        });
      }
      return {
        models,
        ...(truncated ? { truncated: true } : {}),
      };
    } finally {
      options?.signal?.removeEventListener('abort', abortProbe);
      promptQueue.close();
      sdkQuery.close();
    }
  }

  async listModels(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<ModelOption[]> {
    return (await this.listModelCatalog(options)).models;
  }

  async getCommands() {
    return [
      {
        name: 'compact',
        description: 'Compact conversation context',
        passthrough: true,
      },
      {
        name: 'clear',
        description: 'Clear conversation history',
        passthrough: true,
      },
      {
        name: 'undo',
        description: 'Undo last assistant action',
        passthrough: true,
      },
      {
        name: 'resume',
        description: 'Resume a previous session',
        passthrough: true,
      },
      {
        name: 'help',
        description: 'Show available commands',
        passthrough: true,
      },
      {
        name: 'init',
        description: 'Reset session to initial state',
        passthrough: true,
      },
      { name: 'bug', description: 'Report a bug', passthrough: true },
      { name: 'doctor', description: 'Run diagnostics', passthrough: true },
    ];
  }

  /**
   * Station#1157 (agent-engine-unification.md §4.1 Tool-servers row,
   * channel 'subprocess' — the Claude Agent SDK spawns each MCP server
   * itself, inside Station's own process; see `DeliveryChannel`'s doc
   * comment for why that's a distinct channel from ACP's 'wire'): resolve
   * an authored `input.agent.toolServers` into the Claude Agent SDK's
   * `mcpServers` map plus the delivery-channel report
   * `startTrackedSession` merges into `session.configured`. An unauthored
   * `toolServers` (agent has none, or this isn't a resolved-agent session
   * at all) returns `{}` — `mcpServers` stays `undefined` so `buildOptions`
   * leaves the SDK option entirely unset, keeping every session that
   * doesn't author tool servers byte-identical to before this feature
   * (same rationale as the systemPrompt channel's doc comment above).
   * Pure/synchronous: `resolveClaudeMcpServers` does no I/O (see its own
   * header comment for why, unlike ACP, no binary-existence check is
   * needed here).
   */
  private resolveAgentToolServers(input: ProviderSessionStartInput): {
    mcpServers?: Record<string, McpServerConfig>;
    report?: CapabilityDeliveryChannelReport;
  } {
    const toolServers = input.agent?.toolServers;
    if (toolServers === undefined) return {};

    const { servers, skipped } = resolveClaudeMcpServers(toolServers, {
      ...this.options.getStationControlEnv?.(),
      ...(input.tenantExecutionContext
        ? { STATION_INTERNAL_TENANT: input.tenantExecutionContext.tenantId }
        : {}),
    });
    const undelivered: CapabilityUndelivered[] = skipped.map(
      (skip: ClaudeToolServerSkip) => ({
        capability: 'toolServers',
        id: skip.id,
        reason: skip.reason,
        detail: skip.detail,
      }),
    );
    for (const entry of undelivered) {
      agentCapabilityUndelivered.add(1, {
        provider: this.provider,
        capability: entry.capability,
        reason: entry.reason,
      });
    }

    return {
      mcpServers: servers,
      report: {
        source: 'agent',
        requested: toolServers.map((server) => server.id),
        delivered: Object.keys(servers),
        undelivered,
      },
    };
  }

  private buildOptions(
    input: ProviderSessionStartInput,
    persistSession = false,
    permissionMode: PermissionMode = 'default',
    appHomeEnv?: Record<string, string>,
    mcpServers?: Record<string, McpServerConfig>,
    skillsOverlayDir?: string,
    augmentedEnv?: Record<string, string | undefined>,
    preToolPolicy?: StagedPreToolPolicyEvaluator,
  ): Options {
    const modelOptions = claudeAppliedModelOptions(input.modelOptions);
    return {
      cwd: input.cwd,
      model: input.modelId,
      resume:
        typeof input.resumeCursor === 'string' ? input.resumeCursor : undefined,
      includePartialMessages: true,
      persistSession,
      // archive#1174: a cwd-less session materializes its skills into a
      // Station-owned overlay directory (see claude-skills-overlay.ts)
      // rather than the real (home-defaulted) cwd, so it is delivered here
      // as an additional working-directory root instead of by changing
      // `cwd` above — the real session cwd (and every session that HAS a
      // real project/user cwd) is completely unaffected.
      ...(skillsOverlayDir
        ? { additionalDirectories: [skillsOverlayDir] }
        : {}),
      // Station#1157: only set when the agent authored toolServers (see
      // resolveAgentToolServers) — an unauthored session leaves both
      // options unset, matching Claude's own default MCP discovery
      // (project/user .mcp.json, settings) exactly as before this
      // feature. `strictMcpConfig: true` is required alongside an
      // authored (even empty) `mcpServers`: an authored empty array is the
      // agent explicitly disabling every tool server, and without
      // strictMcpConfig the SDK would still auto-discover the connection's
      // own local MCP config underneath it.
      ...(mcpServers !== undefined
        ? { mcpServers, strictMcpConfig: true }
        : {}),
      // archive#895 wave B (agent-engine-unification.md §4.1 System-prompt row,
      // channel 'flag'): deliver the agent's authored prompt as an APPEND to
      // the engine's own claude_code preset prompt — the engine owns its
      // loop; Station adds the agent's instructions. NOTE the SDK's default
      // (option unset) is an EMPTY custom prompt, so authored-prompt
      // sessions also gain the claude_code preset here; sessions without an
      // authored prompt keep byte-identical options (option entirely
      // unset). A bare-string value would instead REPLACE the prompt and
      // strip the engine's own behavior — rejected.
      ...(input.agent?.systemPrompt
        ? {
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: input.agent.systemPrompt,
            },
          }
        : {}),
      // The SDK's `env` REPLACES the subprocess environment wholesale (it
      // does not merge with `process.env`) — so the spread here is
      // load-bearing. Station#1156: the Claude Agent SDK spawns each MCP
      // server (Station's built-in npx-based Filesystem MCP, defaults.ts;
      // any agent-authored or user-configured MCP command; and Claude's own
      // auto-discovered project/user .mcp.json servers) as a child of THIS
      // subprocess, inheriting whatever env we hand the SDK here — so
      // `augmentedEnv` (station-1150's login-shell/well-known-dir PATH
      // resolve, threaded down from `resolveAugmentedSpawnEnv`) must be
      // layered in even when no app-home profile is active, or those
      // children only ever see Station's own (possibly minimal
      // launchd/service) PATH one layer down from what archive#1150 fixed for
      // Station's own CLI-binary search. `augmentedEnv` is already
      // `{...process.env, PATH: <augmented>}` (see `augmentedSpawnEnv` in
      // cli-auth.ts) — never a bare override — so this still never drops
      // an inherited var. `STATION_DISABLE_LOGIN_PATH_RESOLVE=1` (or
      // win32, where the login-shell resolve is POSIX-only) makes
      // `augmentedEnv`'s PATH value equal to `process.env.PATH` again
      // (dedup only, no login-shell/well-known-dir additions), so the
      // session env this produces preserves that PATH layering, while the
      // final Station-owned TMPDIR below deliberately replaces any ambient
      // value — see the `archive#1156: login-PATH augmentation` and `archive#1908`
      // describe blocks in claude-adapter.test.ts.
      // TMPDIR must be final: both augmentedEnv and appHomeEnv can contain a
      // caller/ambient value, but every Claude SDK spawn must use Station's
      // reaped engine-spawn directory (archive#1908).
      env: scrubBootInternalSecrets({
        ...(augmentedEnv ?? process.env),
        ...appHomeEnv,
        TMPDIR: ensureEngineSpawnTmpDir(),
      }),
      canUseTool: async (toolName, toolInput, options) => {
        // Fix (external autoApprove parity): match Station's own
        // engine — which honors the session agent's
        // `tools.autoApprove` via `isAutoApproved` (agent-hooks.ts,
        // stream-orchestrator.ts) — BEFORE ever surfacing the request to
        // Station's ApprovalRegistry. `input.agent.autoApprove` is the
        // resolved agent's authored patterns (session-agent-resolution.ts);
        // `isAutoApprovedExternalTool` canonicalizes the SDK's
        // `mcp__<server>__<tool>` tool name into the same `<server>_<tool>`
        // shape Station-engine patterns are authored against, so e.g.
        // `station-control_*` matches `mcp__station-control__list_agents`.
        if (
          isAutoApprovedExternalTool(
            toolName,
            input.agent?.autoApprove,
            input.agent?.toolServers,
            // The Agent SDK generates this name from the actual mcpServers
            // config key, in Station's own process — authentically bound to
            // the server that will run.
            'authentic',
          )
        ) {
          return { behavior: 'allow', updatedInput: toolInput };
        }
        const requestId = crypto.randomUUID();
        const record = this.requireSession(input.threadId);
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          requestId,
          method: 'request.opened',
          requestType: 'approval',
          title: options.title ?? `Allow ${toolName}`,
          description: options.description,
          payload: {
            toolName,
            toolInput,
            blockedPath: options.blockedPath,
            displayName: options.displayName,
            suggestions: options.suggestions,
          },
        });

        return await new Promise<PermissionResult>((resolve) => {
          record.pendingRequests.set(requestId, {
            resolve,
            suggestions: options.suggestions,
            toolInput,
            toolName,
          });
        });
      },
      ...(preToolPolicy && input.agent
        ? {
            hooks: {
              PreToolUse: [
                {
                  timeout: sdkPreToolMatcherTimeoutSeconds(
                    this.options.preToolPolicyTimeoutMs ??
                      DEFAULT_PRE_TOOL_POLICY_TIMEOUT_MS,
                  ),
                  hooks: [
                    async (hookInput) =>
                      evaluateClaudePreToolPolicy(
                        preToolPolicy,
                        hookInput as {
                          tool_name: string;
                          tool_input: unknown;
                          tool_use_id: string;
                        },
                        {
                          agentSlug: input.agent!.slug,
                          conversationId: input.threadId,
                          delegation: serverDelegation(input.metadata),
                        },
                        this.options.preToolPolicyTimeoutMs ??
                          DEFAULT_PRE_TOOL_POLICY_TIMEOUT_MS,
                        // Read per call, from the record `sendTurn` and
                        // `respondToRequest` keep current, so a mid-session
                        // approval-mode change or session grant is honored by
                        // the next tool call rather than by the next session.
                        // The spawn-time argument is the fallback for the
                        // window before the record exists.
                        (toolName) => {
                          const live = this.sessions.get(input.threadId);
                          if (
                            !claudePermissionModeForcesAsk(
                              live?.currentPermissionMode ?? permissionMode,
                            )
                          ) {
                            return false;
                          }
                          return (
                            live?.sessionGrantedTools?.has(toolName) !== true
                          );
                        },
                      ),
                  ],
                },
              ],
            },
          }
        : {}),
      permissionMode,
      // Required by the SDK whenever bypassPermissions is granted at spawn
      // time (sdk.d.ts: "Must be set to true when using permissionMode:
      // 'bypassPermissions'"). Only ever set at session start — the SDK has
      // no mid-session equivalent, which is why sendTurn below refuses a
      // mid-session escalation into 'bypassPermissions' instead of pretending
      // it applied.
      allowDangerouslySkipPermissions:
        permissionMode === 'bypassPermissions' ? true : undefined,
      thinking:
        modelOptions.thinking === false
          ? { type: 'disabled' }
          : modelOptions.thinking === true
            ? { type: 'adaptive' }
            : undefined,
      effort: modelOptions.effort,
      settings:
        modelOptions.fastMode !== undefined ||
        modelOptions.autoMode !== undefined
          ? {
              ...(modelOptions.fastMode !== undefined
                ? { fastMode: modelOptions.fastMode }
                : {}),
              ...(modelOptions.autoMode === false
                ? { disableAutoMode: 'disable' as const }
                : {}),
            }
          : undefined,
    };
  }

  /**
   * Resolves this session/turn's effective Claude PermissionMode: an
   * explicit raw `permissionMode: 'plan'` (predates approvalMode) wins,
   * then a mapped `approvalMode`, then the adapter's existing default.
   *
   * Disclosed gap (archive#727 review item 6): plan mode has no `ApprovalMode`
   * analog and isn't reachable through the composer chip, so entering plan
   * via this raw escape hatch is real server-side precedence but the chip
   * will keep showing whatever `approvalMode` resolves to — it does not
   * (and currently cannot) reflect "the session is actually in plan mode."
   */
  private resolvePermissionMode(
    modelOptions?: Record<string, unknown>,
  ): PermissionMode {
    if (modelOptions?.permissionMode === 'plan') return 'plan';
    return resolveClaudePermissionMode(modelOptions) ?? 'default';
  }

  private async consumeMessages(record: ClaudeSessionRecord): Promise<void> {
    try {
      for await (const message of record.query) {
        // `interruptedResultObserved` suppresses only the iterator rejection
        // immediately following the consumed result. If the iterator yields
        // another message instead, that proves there was no wrapper to
        // suppress and the marker must not leak into a later failure.
        record.interruptedResultObserved = false;
        this.mapMessage(record, message);
      }
      record.interruptedResultObserved = false;
    } catch (error) {
      // Claude rethrows a structured `is_error` result after the mapper has
      // already consumed it. For a requested interruption that wrapper is not
      // a second terminal fact and must not become an unscoped runtime.error.
      if (record.interruptedResultObserved) {
        record.interruptedResultObserved = false;
        record.session.status = 'ready';
        return;
      }
      // archive#1827: once `mapMessage` has already published a structured
      // `runtime.error` for a `terminal`-classified `result` message
      // (`classifyClaudeResultOutcome`, `claude-adapter-events.ts`), the SDK
      // re-throws the SAME underlying failure a moment later as a generic
      // wrapped Error when the `claude` CLI process exits (its own
      // `lastErrorResultText` mechanism — see `claude-result-outcome.ts`'s
      // doc comment). Publishing a second raw-text `runtime.error` for that
      // one failure is exactly the "shown twice, then retried and shown
      // again" shape this ticket exists to fix — skip it here; the
      // structured event already told the caller everything this generic
      // catch would, and (unlike this catch) also carried the terminal
      // classification the recovery path acts on.
      if (record.terminalResultObserved) {
        record.session.status = 'dead';
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      const message = record.session.model
        ? `Claude model "${record.session.model}" failed: ${detail}`
        : detail;
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.session.threadId,
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        severity: 'error',
        message,
      });
      record.session.status = 'error';
    }
  }

  private mapMessage(record: ClaudeSessionRecord, message: SDKMessage): void {
    mapClaudeSdkMessage({
      provider: this.provider,
      record: record as ClaudeMessageState,
      message,
      publish: (event) => this.publish(event),
      logInfo: (message, details) =>
        (this.options.logger ?? console).info?.(message, details),
    });
  }

  private publish(event: CanonicalRuntimeEvent): void {
    this.events.push(event);
  }

  private requireSession(threadId: string): ClaudeSessionRecord {
    const record = this.sessions.get(threadId);
    if (!record) {
      throw new Error(`Unknown Claude session: ${threadId}`);
    }
    return record;
  }

  /**
   * Resolves the app-home profile env for a fresh `startSession` call
   * (archive#896) — never for adoption, see `adoptSession`'s doc comment. A missing
   * resolver or opted-out legacy connection degrades to global config. A
   * selected credential-profile lookup fails closed so Station cannot commit
   * a candidate that was never applied.
   */
  private async resolveAppHomeEnv(
    credentialProfileRef?: string,
  ): Promise<Record<string, string> | undefined> {
    try {
      return await this.options.getAppHomeEnv?.(credentialProfileRef);
    } catch (error) {
      if (credentialProfileRef) {
        throw new Error(
          'Credential profile environment could not be prepared.',
        );
      }
      (this.options.logger ?? console).warn?.(
        `Claude app-home profile lookup failed; continuing with the global Claude Code config: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Station#1156: resolves the augmented spawn env (`{...process.env, PATH:
   * <login-shell + well-known-dir augmented PATH>}`, `augmentedSpawnEnv` in
   * cli-auth.ts — the SAME reviewed helper archive#1150 uses for Station's
   * own CLI-binary resolution/probing/ACP subprocess spawn) for both a
   * fresh `startSession` AND `adoptSession` — unlike the app-home env
   * above, PATH augmentation has no config-root concern that would make
   * adoption special, and an adopted session spawns MCP servers exactly
   * like a fresh one. `augmentedSpawnEnv` itself never throws (every
   * failure inside it — missing shell, timeout, non-zero exit — degrades
   * to `process.env.PATH` alone), but this wrapper still degrades to
   * `undefined` (today's byte-identical `buildOptions` behavior when no
   * app-home env is set either) on an unexpected failure, never blocking
   * session start.
   */
  private async resolveAugmentedSpawnEnv(): Promise<
    Record<string, string | undefined> | undefined
  > {
    try {
      return await augmentedSpawnEnv();
    } catch (error) {
      (this.options.logger ?? console).warn?.(
        `Claude login-PATH augmentation failed; continuing with the unaugmented process env: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Skills materialization (docs/design/connections-onboarding.md §5): runs
   * a best-effort stale SWEEP first — never this session's own
   * manifest/overlay (that would be a self-inflicted crash-safety false
   * positive), and never another session's that is still live or inside its
   * grace window. Then materializes skills into THIS session's own
   * per-session manifest (`.station-materialized.<threadId>.json`) —
   * concurrent sessions in the same `cwd` never share or contend for one
   * shared manifest. Never rejects — a materialization failure degrades to
   * "no materialized skills", not a blocked session start.
   *
   * archive#1174: when `cwdDefaulted` is true (no real project/user cwd —
   * see `ProviderSessionStartInput.cwdDefaulted`'s doc comment), skills are
   * materialized into a Station-owned per-session overlay directory instead
   * of the real (home-defaulted) `cwd` — see claude-skills-overlay.ts. The
   * caller (`startTrackedSession`/`buildOptions`) delivers that overlay to
   * the SDK via `additionalDirectories`, never by changing `Options.cwd`,
   * so the engine's real working directory is completely unaffected. A
   * session with a real project/user cwd (`cwdDefaulted` absent/false)
   * takes the exact pre-existing path, byte-for-byte.
   *
   * archive#895 wave A: `agent.skills` (including an authored empty array) wins
   * over the connection's `getProvideSkills` opt-in — see
   * ResolvedAgentDefinition's doc comment (authored-field-wins). Returns
   * the channel-delivery report to merge into `session.configured`
   * metadata (`report` absent only when there was truly nothing requested —
   * no authored agent skills and the connection never opted in) alongside
   * the overlay directory actually used, if any. Never silent otherwise: a
   * missing `cwd` or a failed connection-default lookup still returns a
   * report with every requested id undelivered — an absent `report` would
   * let an upstream resolution-stage-only report (see
   * session-agent-resolution.ts) look like a completed delivery.
   */
  private async prepareSkillsMaterialization(
    cwd: string | undefined,
    cwdDefaulted: boolean | undefined,
    threadId: string,
    agent?: ResolvedAgentDefinition,
  ): Promise<{
    report?: CapabilityDeliveryChannelReport;
    overlayDir?: string;
  }> {
    const logger = this.options.logger ?? console;

    const useOverlay = cwdDefaulted === true;
    const materializeCwd = useOverlay ? skillOverlayDirFor(threadId) : cwd;

    if (useOverlay) {
      await sweepStaleSkillOverlays({
        // Never sweep our own about-to-be-used overlay, nor any other
        // threadId this adapter still has a live in-memory session for.
        isLiveSessionId: (id) => id === threadId || this.sessions.has(id),
        logger,
      }).catch((error) => {
        logger.warn?.(
          `Claude skills overlay: stale-overlay sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } else if (cwd) {
      await sweepStaleManifests({
        cwd,
        // Never sweep our own about-to-be-used manifest, nor any other
        // threadId this adapter still has a live in-memory session for.
        isLiveSessionId: (id) => id === threadId || this.sessions.has(id),
        globalConfigDirs: defaultClaudeGlobalConfigDirs(
          undefined,
          undefined,
          cwd,
        ),
        logger,
      }).catch((error) => {
        logger.warn?.(
          `Claude skills materialization: stale-manifest sweep failed for '${cwd}': ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    const agentSkills = agent?.skills;
    let skillIds: string[];
    let resolveSkillDir: (id: string) => Promise<string | null>;
    let source: 'agent' | 'connection-default';
    if (agentSkills !== undefined) {
      skillIds = agentSkills.map((skill) => skill.id);
      resolveSkillDir = async (id) =>
        agentSkills.find((skill) => skill.id === id)?.dir ?? null;
      source = 'agent';
    } else if (this.options.getProvideSkills && this.options.resolveSkillDir) {
      source = 'connection-default';
      resolveSkillDir = this.options.resolveSkillDir;
      try {
        skillIds = (await this.options.getProvideSkills()) ?? [];
      } catch (error) {
        // archive#895 review MEDIUM: never-silent — a lookup failure degrades to
        // "no materialized skills" for the session, but that outcome is
        // still receipted (delivery-failed), not dropped.
        logger.warn?.(
          `Claude skills materialization failed${cwd ? ` for '${cwd}'` : ''}; continuing without materialized skills: ${error instanceof Error ? error.message : String(error)}`,
        );
        const entry: CapabilityUndelivered = {
          capability: 'skills',
          reason: 'delivery-failed',
          detail: error instanceof Error ? error.message : String(error),
        };
        agentCapabilityUndelivered.add(1, {
          provider: this.provider,
          capability: entry.capability,
          reason: entry.reason,
        });
        return {
          report: {
            source: 'connection-default',
            // The failed lookup never returned an id list — nothing more
            // specific to report as "requested".
            requested: [],
            delivered: [],
            undelivered: [entry],
          },
        };
      }
      // Preserve the exact pre-#895 no-op: an off-by-default connection
      // (nothing opted in) produces no report at all, not an empty one —
      // only an authored `agent.skills` makes an empty list authoritative.
      if (skillIds.length === 0) return {};
    } else {
      return {};
    }

    if (!useOverlay && !materializeCwd) {
      // archive#895 review MEDIUM: never-silent — there ARE requested skill ids
      // (agent-authored or a non-empty connection-default list), but there
      // is no session cwd to materialize into (and no cwdDefaulted signal
      // to route through the archive#1174 overlay instead). Receipt every
      // requested id as undelivered rather than silently dropping the whole
      // report (an absent report here would let a resolution-stage-only
      // report — set upstream by session-agent-resolution.ts for an
      // agent-authored capability — pass through session.configured looking
      // complete when channel delivery never even attempted).
      const undelivered: CapabilityUndelivered[] = skillIds.map((id) => ({
        capability: 'skills',
        id,
        reason: 'materialization-skipped',
        detail: 'no-session-cwd',
      }));
      for (const entry of undelivered) {
        agentCapabilityUndelivered.add(1, {
          provider: this.provider,
          capability: entry.capability,
          reason: entry.reason,
        });
      }
      return {
        report: { source, requested: skillIds, delivered: [], undelivered },
      };
    }

    const targetCwd = materializeCwd as string;
    try {
      const result = await materializeSkills({
        skillIds,
        cwd: targetCwd,
        sessionId: threadId,
        resolveSkillDir,
        globalConfigDirs: defaultClaudeGlobalConfigDirs(
          undefined,
          undefined,
          targetCwd,
        ),
        logger,
      });
      if (result.skipped.length > 0) {
        logger.warn?.(
          `Claude skills materialization: skipped ${result.skipped.length} opted-in skill(s) for '${targetCwd}'`,
          result.skipped,
        );
      }
      if (result.materialized.length > 0) {
        claudeSkillsMaterializedSessions.add(1, {
          skillCount: String(result.materialized.length),
          source,
        });
      }
      const undelivered = result.skipped.map(
        (skip): CapabilityUndelivered => ({
          capability: 'skills',
          id: skip.id,
          reason:
            skip.reason === 'not-found'
              ? 'not-found'
              : skip.reason === 'global-config-target'
                ? 'global-config-target-refused'
                : 'materialization-skipped',
          detail:
            skip.reason === 'not-found' ||
            skip.reason === 'global-config-target'
              ? undefined
              : skip.reason,
        }),
      );
      for (const entry of undelivered) {
        agentCapabilityUndelivered.add(1, {
          provider: this.provider,
          capability: entry.capability,
          reason: entry.reason,
        });
      }
      return {
        report: {
          source,
          requested: skillIds,
          delivered: result.materialized,
          undelivered,
        },
        overlayDir: useOverlay ? targetCwd : undefined,
      };
    } catch (error) {
      logger.warn?.(
        `Claude skills materialization failed for '${targetCwd}'; continuing without materialized skills: ${error instanceof Error ? error.message : String(error)}`,
      );
      const entry: CapabilityUndelivered = {
        capability: 'skills',
        reason: 'delivery-failed',
        detail: error instanceof Error ? error.message : String(error),
      };
      agentCapabilityUndelivered.add(1, {
        provider: this.provider,
        capability: entry.capability,
        reason: entry.reason,
      });
      return {
        report: {
          source,
          requested: skillIds,
          delivered: [],
          undelivered: [entry],
        },
        overlayDir: useOverlay ? targetCwd : undefined,
      };
    }
  }
}
