/**
 * AcpAdapter — ProviderAdapterShape implementation for ACP-connected agent
 * apps (e.g. Kiro), driven through the canonical adapter seam (ADR-0008).
 *
 * Wave 2 Track A scope (this file): connection resolution (Q2), lazy
 * ACPProcess lifecycle per threadId, Client construction (reusing
 * createACPBridgeClient's fs/terminal/ext-* handlers, with a canonical
 * `requestPermission` override), turn start/complete/abort, and
 * getCommands()/getPrerequisites() aggregation. Native ACP events are
 * translated to CanonicalRuntimeEvent via the pure mapper in
 * acp-adapter-events.ts (Wave 2 Track B, not modified here).
 *
 * Reused substrate (called, not rewritten, per the plan's Architecture
 * section): ACPProcess (spawn/initialize/newSession/prompt/cancel/setMode/
 * setConfigOption/extMethod/destroy), createACPBridgeClient (fs/terminal/
 * ext-notification/ext-method Client handlers), ApprovalRegistry (satisfies
 * createACPBridgeClient's parameter type only), ACPConnectionConfig/ACPConfig.
 */

import crypto from 'node:crypto';
import { resolve } from 'node:path';
import type {
  Client,
  ContentBlock,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { ACP_MODEL_OVERRIDE_PER_TURN } from '@kontourai/station-contracts/engine-capability-matrix';
import type {
  CapabilityUndelivered,
  ResolvedAgentDefinition,
} from '@kontourai/station-contracts/provider';
import {
  MODEL_SELECTION_RECEIPT_METADATA_KEY,
  modelSelectionReceipt,
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
  type SessionCapabilityDeliveryMetadata,
} from '@kontourai/station-contracts/provider';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { Prerequisite, ToolDef } from '@kontourai/station-contracts/tool';
import type { StagedPreToolPolicyEvaluator } from '../../runtime/agents/pre-tool-policy.js';
import {
  BUILTIN_STATION_DOCS_TOOL_SERVER_ID,
  isBuiltinStationDocs,
} from '../../runtime/bootstrap/station-control-runtime-env.js';
import { isAutoApprovedExternalTool } from '../../runtime/tools/tool-executor.js';
import type { InvocationContext } from '../../runtime/types.js';
import { createACPBridgeClient } from '../../services/acp/acp-bridge-client.js';
import type { ManagedTerminal } from '../../services/acp/acp-bridge-types.js';
import {
  type AcpInboundExtensionRefusalReason,
  createAcpInboundExtensionRequestHandler,
} from '../../services/acp/acp-inbound-extension-policy.js';
import {
  ACPProcess,
  type ACPProcessOptions,
} from '../../services/acp/acp-process.js';
import { prepareManagedAcpWorkspace } from '../../services/acp/managed-acp-workspace.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import {
  acpPassthroughSessions,
  acpResumeSessions,
  agentCapabilityUndelivered,
  sessionCwdResolution,
} from '../../telemetry/metrics.js';
import { expandTilde } from '../../utils/paths.js';
import type {
  CanonicalRuntimeEvent,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../adapter-shape.js';
import { buildCliRuntimePrerequisites } from '../auth/cli-auth.js';
import {
  effectiveModelMetadata,
  reportedModelMetadata,
} from '../llm/effective-model-metadata.js';
import { AsyncEventQueue } from '../sessions/async-event-queue.js';
import {
  decodeChatAttachments,
  rejectFileAttachments,
} from '../sessions/chat-attachments.js';
import {
  type AcpExtensionErrorNotification,
  type AcpMapperContext,
  extractReportedModelFromConfigOptions,
  mapAcpDecisionToApprovalStatus,
  mapAcpDecisionToOutcome,
  mapAcpExtensionNotification,
  mapAcpSessionUpdate,
  mapAcpStopReasonToFinishReason,
} from './acp-adapter-events.js';
import {
  type AcpToolServerSkip,
  type AcpToolServerSkipReason,
  resolveAcpPassthroughMcpServers,
} from './acp-mcp-passthrough.js';
import {
  AcpToolUpdateGlobalBudget,
  AcpToolUpdateSupervisor,
} from './acp-tool-update-supervisor.js';
import { toPassthroughToolDef } from './agent-tool-server-mapping.js';
import { mergeCapabilityDeliveryMetadata } from './capability-delivery-metadata.js';
import { externalPreToolPolicyIdentity } from './external-pre-tool-policy-identity.js';

/** Matches the `any`-typed logger threaded through the existing ACP substrate (acp-manager.ts, acp-connection.ts, ACPProcessOptions.logger). */
type AcpLogger = any;

type AcpDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/** Stable internal outcome for a user stop or adapter shutdown racing start. */
class AcpSessionStartCancelledError extends Error {
  constructor() {
    super('ACP session start was cancelled before it became ready.');
    this.name = 'AcpSessionStartCancelledError';
  }
}

const ACP_TOOL_SERVER_SKIP_REASON_MAP: Record<
  AcpToolServerSkipReason,
  CapabilityUndelivered['reason']
> = {
  'not-found': 'not-found',
  disabled: 'disabled',
  'requires-env-secrets': 'secret-boundary-env',
  'unsupported-transport': 'unsupported-transport',
  'binary-not-found': 'binary-not-found',
  // archive#1684: the ACP-only third state. NOT 'engine-unsupported' — that
  // one says the engine CLASS has no channel for this capability, which is
  // false here: the class has a reviewed mechanism, and this one connection's
  // live handshake is what withheld it.
  'engine-capability-absent': 'engine-capability-absent',
  'delivery-failed': 'delivery-failed',
};

function toCapabilityUndelivered(
  skip: AcpToolServerSkip,
): CapabilityUndelivered {
  return {
    capability: 'toolServers',
    id: skip.id,
    reason: ACP_TOOL_SERVER_SKIP_REASON_MAP[skip.reason],
    detail: skip.detail,
  };
}

/**
 * archive#895 wave B: an ACP session's resume cursor — the ACP-native session id
 * plus the Station connection id that owns it (mirrors codex's
 * `isResumeCursor` cursor-typing style). The connectionId lets recovery
 * re-resolve the connection when `startSession` input carries no
 * `metadata.connectionId` (orchestration-session-state.ts only persists
 * `resumeCursor`/`cwd`/`model`, not the full session-start metadata bag,
 * unless a `readSessionStartMetadata` callback is wired — see
 * orchestration-session-state.ts's recovery doc comment).
 */
export interface AcpResumeCursor {
  acpSessionId: string;
  connectionId: string;
  /**
   * Round-2 review fix (archive#895 wave B): a short sha256 fingerprint of the
   * connection's execution identity at the moment this cursor was captured
   * (see `acpExecutionIdentity`/`acpConnectionFingerprint`). Why this is
   * load-bearing: `routes/connections/acp.ts`'s `PUT /connections/:id`
   * removes and re-adds a connection IN PLACE under the same `id` — so a
   * same-id match alone does not prove the process being resumed is the one
   * that produced this transcript; the id could now point at a different
   * command/args/cwd, or even a different CLI entirely.
   *
   * MANDATORY — no legacy-cursor exemption. `resumeCursor` is
   * caller-authorable through the authenticated orchestration API
   * (`routes/orchestration/orchestration.ts` accepts it verbatim), so an
   * "absent fingerprint ⇒ trust it" fallback is a client-craftable bypass
   * of this whole identity check, not a real legacy-data case: before wave
   * B the ACP adapter never captured resume cursors at all, so no
   * genuinely-legacy fingerprint-less ACP cursor population exists.
   * `startReservedSession` rejects any resume cursor missing this field.
   */
  connectionFingerprint: string;
}

export function isAcpResumeCursor(value: unknown): value is AcpResumeCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AcpResumeCursor).acpSessionId === 'string' &&
    typeof (value as AcpResumeCursor).connectionId === 'string'
  );
}

/**
 * Round-2 review fix (archive#895 wave B): the exact execution identity a
 * connection is spawned with — `command`/`args` from the connection config,
 * plus `effectiveCwd`, the SAME resolved value `startReservedSession` spawns
 * `ACPProcess` with (session cwd, connection cwd, or the managed session
 * workspace), not
 * `config.cwd` alone. Binding to `config.cwd` only was the round-1 bug: two
 * sessions against a connection with an unset config `cwd` but different
 * caller-supplied workspaces (`input.cwd`) would hash identically and
 * silently share a fingerprint, defeating the whole check for exactly the
 * connections most likely to leave `cwd` unset.
 *
 * Deliberately a plain named-fields function, NOT `Pick<ACPConnectionConfig,
 * ...>`: a `Pick<>` would silently include (or, worse, silently keep
 * excluding) whatever fields a future `ACPConnectionConfig` change adds —
 * any future identity-bearing field (e.g. an `env` passthrough) must be
 * added to this parameter list and `AcpExecutionIdentity` DELIBERATELY, by
 * a human deciding it belongs in the resume identity, never by accident.
 */
export interface AcpExecutionIdentity {
  command: string;
  args: string[];
  effectiveCwd: string;
}

export function acpExecutionIdentity(params: {
  command: string;
  args?: string[];
  effectiveCwd: string;
}): AcpExecutionIdentity {
  return {
    command: params.command,
    args: params.args ?? [],
    effectiveCwd: params.effectiveCwd,
  };
}

/**
 * Short (16 hex chars / 64 bits) sha256 of an `AcpExecutionIdentity` —
 * collision resistance for this identity-pinning use case doesn't need the
 * full digest, and it keeps persisted cursors compact.
 */
export function acpConnectionFingerprint(
  identity: AcpExecutionIdentity,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 16);
}

export interface AcpAdapterOptions {
  getConnections: () => Promise<ACPConnectionConfig[]>;
  logger?: AcpLogger;
  processFactory?: (opts: ACPProcessOptions) => ACPProcess;
  /** Injectable Station home for private unbound-session workspaces. */
  managedWorkspaceHomeDir?: string;
  /** Resolve Station's shared staged policy for a real resolved agent. */
  resolvePreToolPolicy?: (
    input: ProviderSessionStartInput,
  ) => Promise<StagedPreToolPolicyEvaluator | undefined>;
  /**
   * Resolve a Station tool-server id (`ToolDef.id`, kind 'mcp') to its
   * configured definition for MCP passthrough (docs/design/connections-onboarding.md
   * §5).
   *
   * Consulted for connections with a non-empty `provideToolServers`, AND —
   * as of archive#1547 AC5 — exactly once per session for
   * `station-docs`, whatever the connection opted into. The
   * off-by-default passthrough case therefore no longer means "never
   * called": Station grants the credential-free docs server on its own
   * account (see the grant block in `startSession`). Returning `null` for
   * that id is a supported outcome and simply means no documentation is
   * delivered.
   *
   * archive#1684 CORRECTS what this comment used to assert — that an ACP
   * engine "can never carry `station-control`". It can, when the connected
   * CLI advertises `mcpCapabilities.http` at `initialize`; see
   * `mintStationControlMcpAuth` below. The docs grant is unaffected and
   * still unconditional: a CLI that does NOT advertise it is exactly the
   * population the grant was written for, and a CLI that does gets both.
   *
   * Defaults to a no-op resolver (always `null`) so existing call sites and
   * tests that don't wire it keep passthrough off and receive no grant.
   */
  resolveToolServer?: (id: string) => Promise<ToolDef | null>;
  /**
   * archive#1684 (the ACP analog of codex-adapter.ts's option of the same
   * name): mint a per-session, station-control-scoped bearer token on the
   * 12-hour bounded default TTL (`DEFAULT_TTL_MS`, revoked eagerly on stop
   * and on a failed start) and return it together with the BARE
   * header-channel endpoint URL
   * (`buildStationControlMcpHeaderUrl` — no token in the query string; the
   * credential rides `Authorization: Bearer` instead).
   *
   * Called ONLY when BOTH hold: the session's resolved tool servers name
   * `station-control`, AND this session's own live `initialize` result
   * advertised `agentCapabilities.mcpCapabilities.http`. The second
   * condition is the whole reason the `acp` matrix cell carries
   * `basis: 'runtime_observation'` — the cell declares that a mechanism
   * exists, and this gate is what makes it true for one connection. A
   * missing closure degrades to not delivering the built-in server (with a
   * receipt), never to a thrown or blocked session start.
   */
  mintStationControlMcpAuth?: (
    threadId: string,
    tenantExecutionContext?: TenantExecutionContext,
  ) => { url: string; token: string } | undefined;
  /** Best-effort cleanup counterpart to `mintStationControlMcpAuth` — called
   * on ordinary session stop and on a failed start. Never required; a
   * missing closure just means the token lives out its bounded TTL. */
  revokeStationControlMcpAuth?: (threadId: string) => void;
}

/** Last-known slash command surfaced by a live ACP session (aggregated across sessions in `getCommands()` — see Risks: no per-connection threadId param on the shared shape). */
export interface AcpSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

type AcpModelConfigOption = {
  id: string;
  category: 'model';
  currentValue?: string;
  options: Array<{ value: string }>;
};

function findAcpModelConfigOption(
  configOptions: unknown,
): AcpModelConfigOption | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions) {
    if (!option || typeof option !== 'object') continue;
    const candidate = option as Record<string, unknown>;
    if (
      candidate.category !== 'model' ||
      typeof candidate.id !== 'string' ||
      !candidate.id.trim()
    ) {
      continue;
    }
    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof (entry as { value?: unknown }).value === 'string'
            ? [{ value: (entry as { value: string }).value }]
            : [],
        )
      : [];
    return {
      id: candidate.id,
      category: 'model',
      ...(typeof candidate.currentValue === 'string'
        ? { currentValue: candidate.currentValue }
        : {}),
      options,
    };
  }
  return undefined;
}

/**
 * A pending mid-turn `session/request_permission` call, keyed by requestId.
 * `resolve` is invoked by `respondToRequest` with the adapter-level decision;
 * the `Client.requestPermission` handler built in this file awaits this and
 * maps the decision + `options` into the ACP `RequestPermissionOutcome` via
 * `mapAcpDecisionToOutcome` (acp-adapter-events.ts).
 */
export interface AcpPendingRequest {
  resolve: (decision: AcpDecision) => void;
  options: PermissionOption[];
}

export interface AcpSessionRecord {
  session: ProviderSession;
  process: ACPProcess;
  connectionId: string;
  /** Invalidation generation captured when this session start was accepted. */
  generation: number;
  /** A `session.started` receipt was published and needs a terminal peer. */
  startedPublished?: boolean;
  /**
   * Server-accepted launch facts retained solely to re-establish this ACP
   * session after the engine refuses its own credential-refresh callback.
   * This deliberately excludes `signal` (which may already be aborted) and
   * replaces `resumeCursor` with the cursor the first process actually
   * produced. It never contains an engine credential.
   */
  recoveryStart: Omit<
    ProviderSessionStartInput,
    'threadId' | 'resumeCursor' | 'signal'
  >;
  pendingRequests: Map<string, AcpPendingRequest>;
  preToolPolicy?: StagedPreToolPolicyEvaluator;
  delegation?: InvocationContext['delegation'];
  activeTurnId?: string;
  stopping?: boolean;
  /** At most one engine re-establishment is attempted for this session. */
  credentialRecoveryAttempted?: boolean;
  currentModeId?: string;
  configOptions?: unknown[];
  slashCommands?: AcpSlashCommand[];
  /**
   * Fix (external autoApprove parity): the resolved session agent
   * (session-agent-resolution.ts), carrying the authored
   * `tools.autoApprove` patterns Station's `requestPermission` override
   * checks BEFORE surfacing a request to Station's ApprovalRegistry —
   * mirrors Station-engine's `isAutoApproved` gate. `undefined` for
   * synthetic (`__acp:`) or agent-less sessions, matching every other
   * `ResolvedAgentDefinition` consumer in this file.
   */
  agent?: ResolvedAgentDefinition;
  /**
   * Credential-shaped inbound extension methods already surfaced to the user
   * on this session (see `publishCredentialRefusalWarning`). The observed
   * live traffic sends the same method twice before `initialize` is
   * answered, and one transcript warning per session per method is the
   * useful amount.
   */
  credentialRefusalsSurfaced?: Set<string>;
  /**
   * Extension notifications bound to `acp.turn-error-cause` (an exact,
   * evidenced tuple — see `src-shared/extension-notification-bindings.ts`)
   * received during the current turn window (archive#4084) — see
   * `AcpMapperState.turnErrorNotifications` in acp-adapter-events.ts (this
   * field's type; the mapper appends to it via `ctx.state`, structurally the
   * same object as this record). Reset to an empty array at the start of
   * every `sendTurn` and read (last entry) by its `.catch` handler to
   * enrich an otherwise-generic turn failure with the message the engine
   * also reported over a separate notification in that same window.
   */
  turnErrorNotifications?: AcpExtensionErrorNotification[];
  /**
   * TurnIds cancelled by `interruptTurn` whose `prompt()` has not yet
   * settled (archive#4084 review fix round F2) — LEAK-CLEANUP mechanics
   * only; see `turnErrorNotificationsSuppressed` below for where the actual
   * suppression decision now lives (review fix round M1) and
   * `AcpMapperState.quarantinedTurnIds` in acp-adapter-events.ts for the
   * full rationale (this field's type; structurally the same object as
   * this record).
   */
  quarantinedTurnIds?: Set<string>;
  /**
   * Whether the CURRENT turn's entire error-cause retention window is
   * suppressed (archive#4084 review fix round M1) — see
   * `AcpMapperState.turnErrorNotificationsSuppressed` in
   * acp-adapter-events.ts for the full rationale (this field's type;
   * structurally the same object as this record). Snapshotted once, at
   * `sendTurn` start, from whether `quarantinedTurnIds` was non-empty at
   * that moment; never re-derived afterward, so a later leak-cleanup
   * deletion from that live set cannot reopen this turn's window.
   */
  turnErrorNotificationsSuppressed?: boolean;
  /** Bounded per-session owner for ACP's redraw-style tool updates. */
  toolUpdateSupervisor: AcpToolUpdateSupervisor;
}

/**
 * The ACP engine's declared capabilities, exported because
 * `connection-inspector.ts` cannot reach this adapter's metadata: it filters
 * ACP out of its adapter loop and hand-builds the ACP `AgentConnectionView`
 * from live connection config instead. That hand-built view used to carry its
 * own capability literal, which had silently dropped `image-input` — so the
 * composer, which gives a connection's declared capabilities precedence,
 * refused every image on an engine whose adapter builds real image
 * `ContentBlock`s and whose server-side gate accepts them (archive#3344).
 * One array, both readers.
 */
export const ACP_ADAPTER_CAPABILITIES = [
  'agent-runtime',
  'image-input',
  'session-lifecycle',
  'tool-calls',
  'interrupt',
  'approvals',
  'acp',
] as const;

/**
 * archive#4075 stage 2 map correction (verified, not a gap): this adapter's
 * three `...input.metadata` spreads (`startSession`'s `recoveryStart` above,
 * the `session.started` publish, and `session.configured`'s publish) all
 * forward `input.metadata` — the `ProviderSessionStartInput.metadata` object
 * STATION ITSELF composed to start this session (which is where
 * `metadata.userId` already lives, per stage 1/2's principal work) — never a
 * value received FROM the ACP protocol. Nothing in this file reads a
 * protocol-inbound `userId`/actor field and writes it into an outbound
 * canonical event's `metadata`; ACP inbound has no vocabulary for one in the
 * first place (there is no `userId` anywhere in `session/update` or its
 * sibling notification shapes). So "ACP inbound cannot inject an actor" is
 * correct as stated, and durable per-turn attribution for an ACP-connected
 * agent works exactly like every other adapter: Station's own resolved
 * principal rides `metadata.userId` (via `input.metadata`, already spread
 * here) and the `ClientOriginTurnPropagation`-stamped `principal` field on
 * `turn.started`, both stamped by ORCHESTRATION before this adapter ever
 * sees the turn — this file needs no change to participate correctly.
 */
export class AcpAdapter implements ProviderAdapterShape {
  readonly provider = 'acp' as const;
  readonly metadata = {
    displayName: 'Custom engine',
    description:
      'Custom engine connections launched from a configured command (e.g. Kiro), driven through the canonical ACP adapter seam.',
    capabilities: [...ACP_ADAPTER_CAPABILITIES],
    // ACP's `loadSession` is negotiated per connected CLI. A global adapter
    // declaration would overstate arbitrary/older connections; the inspector
    // must project an observed connection-specific capability instead.
    continuity: { resume: 'none', fork: 'none', rewind: 'none' },
    builtin: true,
    engineId: engineId('acp'),
    // A fresh ACP session can advertise a model config option and confirm an
    // applied value through session/set_config_option. Resume and per-turn
    // lack the fresh option evidence required by that fail-closed path.
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: false,
      overridePerTurn: ACP_MODEL_OVERRIDE_PER_TURN,
    },
  } as const;

  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly sessions = new Map<string, AcpSessionRecord>();
  private readonly startingSessionThreads = new Set<string>();
  private readonly startingSessionTasks = new Map<
    string,
    Promise<ProviderSession>
  >();
  private readonly recoveryTasks = new Map<string, Promise<void>>();
  private readonly sessionStopGenerations = new Map<string, number>();
  private readonly toolUpdateBudget = new AcpToolUpdateGlobalBudget();
  private shuttingDown = false;

  constructor(private readonly options: AcpAdapterOptions) {}

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

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    if (this.shuttingDown) {
      throw new Error(
        'ACP adapter is shutting down and cannot start a session.',
      );
    }
    if (
      this.sessions.has(input.threadId) ||
      this.startingSessionThreads.has(input.threadId)
    ) {
      throw new Error(`ACP session already exists: ${input.threadId}`);
    }
    this.startingSessionThreads.add(input.threadId);
    const generation = this.sessionStopGenerations.get(input.threadId) ?? 0;
    const start = this.startReservedSession(input, { generation });
    this.startingSessionTasks.set(input.threadId, start);
    try {
      return await start;
    } finally {
      this.startingSessionThreads.delete(input.threadId);
      if (this.startingSessionTasks.get(input.threadId) === start) {
        this.startingSessionTasks.delete(input.threadId);
      }
      this.maybeForgetGeneration(input.threadId);
    }
  }

  private async startReservedSession(
    input: ProviderSessionStartInput,
    options?: { credentialRecoveryAttempted?: boolean; generation?: number },
  ): Promise<ProviderSession> {
    // Review fix (archive#895 wave B, round-3 MED): fail-closed on a MALFORMED
    // resume cursor. A present-but-invalid-shape resumeCursor (e.g. a
    // caller-crafted `{}` through the authenticated orchestration API, or a
    // corrupted persisted record) must never silently fall through to the
    // fresh session/new branch below just because `isAcpResumeCursor`
    // returns false — that would show the user a brand-new native session
    // while Station's own transcript implies a resumed one. Only a fully
    // ABSENT cursor (undefined/null) selects the fresh-session path. Placed
    // before connection resolution and any process construction.
    if (
      input.resumeCursor !== undefined &&
      input.resumeCursor !== null &&
      !isAcpResumeCursor(input.resumeCursor)
    ) {
      throw new Error(
        "This conversation's resume record is malformed and cannot be resumed.",
      );
    }

    // archive#895 wave B: fall back to the resume cursor's connectionId when
    // startSession input carries no metadata.connectionId — the recovery
    // path (orchestration-session-state.ts) may not have persisted metadata
    // for older sessions, but the resumeCursor is always persisted.
    const connectionId =
      typeof input.metadata?.connectionId === 'string'
        ? input.metadata.connectionId
        : isAcpResumeCursor(input.resumeCursor)
          ? input.resumeCursor.connectionId
          : undefined;
    const connections = await this.options.getConnections();
    const config = connections.find(
      (candidate) => candidate.id === connectionId,
    );
    if (!config) {
      throw new Error(
        `Unknown ACP connection: ${connectionId ?? '(none provided)'}`,
      );
    }

    // archive#1011: the SESSION's cwd wins over the connection's configured
    // default. `config.cwd` is a fallback for a connection used without a
    // workspace; taking it first meant a chat bound to a project launched the
    // CLI in the connection's directory instead — the same class of silent
    // wrong-directory bug the orchestration layer resolves for every engine.
    //
    // archive#1403: the LAST resort is a private Station-managed workspace, never
    // HOME or process.cwd(). Workspace-indexing ACP CLIs recursively scan
    // their launch directory, so HOME traversed protected macOS roots and
    // triggered recurring TCC prompts. Resolution stays here because only
    // the adapter can see `config.cwd`; preparation fails closed and the
    // deterministic connection/thread identity survives resume and restart.
    // `||`, not `??`: an empty string is falsy but not nullish, and Node's
    // `spawn` treats `cwd: ''` as "inherit the parent's" — an exact synonym for
    // the bug this chain closes. Not hypothetical: the Connections form
    // initialises Working Directory to `''` and always sends the field, and the
    // route schema is `cwd: z.string().optional()` with no `.min(1)`, so a user
    // who leaves that box alone persists `cwd: ""`. With `??` that empty string
    // won the chain and the CLI landed in Station's install directory.
    //
    // `config.cwd` is also the one leg that never passed through `expandTilde`.
    // Station stores working directories with a literal `~` and this field is
    // free text, so `~/x` reached `spawn` as a RELATIVE path: ENOENT, thrown as
    // an uncaught exception that took the whole server down on the connection
    // probe — and the message named the command, not the cwd.
    //
    // Expansion only. An existence check was tried and backed out here: a
    // directory that does not exist yet is not obviously an error, and silently
    // relocating to $HOME is the same class of lie archive#1087 removed.
    //
    // archive#1089: the crash that paragraph deferred ("tracked separately") had
    // no issue behind it and is now closed at the right layer — `ACPProcess`
    // listens for the child's `'error'` event, so a working directory that does
    // not exist fails THIS session with `Cannot start '<command>': its working
    // directory does not exist: <path>` instead of reaching the process-level
    // uncaughtException handler and taking the whole server down. Nothing is
    // relocated, and the message names the directory rather than the command.
    // Keeping the check there rather than duplicating it here covers the probe
    // path (acp-probe.ts) with the same mechanism.
    // `resolve` as well as `expandTilde` — see probeCwd(). A relative
    // `config.cwd` otherwise resolves against Station's own directory at spawn
    // time and is handed to `session/new` as a string the agent reads
    // differently.
    const connectionCwd = config.cwd
      ? resolve(expandTilde(config.cwd))
      : undefined;
    const cwd =
      input.cwd ||
      connectionCwd ||
      (await prepareManagedAcpWorkspace(
        {
          kind: 'session',
          connectionId: config.id,
          threadId: input.threadId,
        },
        this.options.managedWorkspaceHomeDir,
      ));

    // archive#1023: the orchestration resolver records every other engine's
    // session-cwd outcome but can only report `acp_connection_default` for
    // this one, because the connection-level fallback lives here. Record the
    // outcome the resolver could not see, on the same instrument, so the ACP
    // path is observable rather than the one silent branch left.
    sessionCwdResolution.add(1, {
      provider: 'acp',
      // Derived from the SAME expressions the chain uses, including the
      // expanded connection cwd rather than its raw configured value.
      source: input.cwd ? 'explicit' : connectionCwd ? 'connection' : 'none',
      outcome: input.cwd
        ? 'resolved'
        : connectionCwd
          ? 'connection_default'
          : 'managed_workspace',
      reason: input.cwd
        ? 'session_bound'
        : connectionCwd
          ? 'acp_connection_default'
          : 'acp_without_connection_directory',
    });

    // Review fix (archive#895 wave B, MED): resume-time identity binding — all
    // three checks are resume-only (a fresh session/new never carries a
    // resumeCursor) and run BEFORE any process is spawned, so a stale,
    // mismatched, or identity-less resume never pays the cost of starting a
    // CLI it's about to reject.
    if (isAcpResumeCursor(input.resumeCursor)) {
      if (
        typeof input.metadata?.connectionId === 'string' &&
        input.metadata.connectionId !== input.resumeCursor.connectionId
      ) {
        throw new Error(
          `ACP resume connection mismatch: session metadata names connection '${input.metadata.connectionId}' but the resume cursor was captured under connection '${input.resumeCursor.connectionId}'.`,
        );
      }
      // Round-2 review fix (MED-1): NO legacy-cursor exemption — see
      // AcpResumeCursor.connectionFingerprint's doc comment. `resumeCursor`
      // is caller-authorable through the authenticated orchestration API,
      // so tolerating an absent fingerprint would let a client-crafted
      // cursor bypass identity binding entirely.
      if (!input.resumeCursor.connectionFingerprint) {
        throw new Error(
          "This conversation's resume record is missing its connection identity and cannot be resumed.",
        );
      }
      // Round-2 review fix (MED-2): `effectiveCwd` must be the SAME resolved
      // `cwd` the process is actually spawned with (below), not
      // `config.cwd` alone — otherwise two sessions against a connection
      // with an unset config cwd but different caller-supplied workspaces
      // would hash identically and silently share a fingerprint.
      const currentFingerprint = acpConnectionFingerprint(
        acpExecutionIdentity({
          command: config.command,
          args: config.args,
          effectiveCwd: cwd,
        }),
      );
      if (currentFingerprint !== input.resumeCursor.connectionFingerprint) {
        throw new Error(
          'This conversation was started under a different engine connection configuration and cannot be resumed.',
        );
      }
    }

    const preToolPolicy = await this.resolvePreToolPolicy(input);
    const createdAt = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'connecting',
      model: input.modelId,
      cwd,
      resumeCursor: input.resumeCursor,
      createdAt,
      updatedAt: createdAt,
    };

    const record: AcpSessionRecord = {
      session,
      process: undefined as unknown as ACPProcess,
      connectionId: config.id,
      generation: options?.generation ?? this.sessionGeneration(input.threadId),
      recoveryStart: {
        provider: input.provider,
        cwd: input.cwd,
        cwdDefaulted: input.cwdDefaulted,
        modelId: input.modelId,
        modelOptions: input.modelOptions
          ? { ...input.modelOptions }
          : undefined,
        workspaceIsolation: input.workspaceIsolation,
        metadata: input.metadata ? { ...input.metadata } : undefined,
        credentialProfileRef: input.credentialProfileRef,
        persistSession: input.persistSession,
        agent: input.agent,
        tenantExecutionContext: input.tenantExecutionContext,
      },
      pendingRequests: new Map(),
      preToolPolicy,
      delegation:
        input.metadata?.delegation &&
        typeof input.metadata.delegation === 'object'
          ? (input.metadata.delegation as InvocationContext['delegation'])
          : undefined,
      agent: input.agent,
      credentialRecoveryAttempted: options?.credentialRecoveryAttempted,
      toolUpdateSupervisor: undefined as unknown as AcpToolUpdateSupervisor,
    };
    record.toolUpdateSupervisor = new AcpToolUpdateSupervisor(
      session,
      (event) => this.publish(event),
      this.toolUpdateBudget,
    );

    const terminals = new Map<string, ManagedTerminal>();
    let terminalCounter = 0;
    const logger = this.options.logger ?? console;

    const processFactory =
      this.options.processFactory ?? ((opts) => new ACPProcess(opts));
    const acpProcess = processFactory({
      command: config.command,
      args: config.args,
      cwd,
      createClient: () =>
        this.buildClient(record, {
          cwd,
          terminals,
          nextTerminalId: () => `acp-term-${++terminalCounter}`,
          logger,
        }),
      logger,
    });
    record.process = acpProcess;
    this.sessions.set(input.threadId, record);

    try {
      await acpProcess.start();
      this.requireCurrentGeneration(input.threadId, record.generation);
      record.startedPublished = true;
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
        method: 'session.started',
        sessionId: input.threadId,
        initialState: 'created',
        metadata: { ...input.metadata, cwd, connectionId: config.id },
      });

      // archive#895 wave A: an authored input.agent.toolServers (including an
      // authored empty array) wins over the connection's provideToolServers
      // — see ResolvedAgentDefinition's doc comment (authored-field-wins).
      const agentToolServers = input.agent?.toolServers;
      const passthroughSource: 'agent' | 'connection-default' =
        agentToolServers !== undefined ? 'agent' : 'connection-default';
      const requestedToolServerIds =
        agentToolServers !== undefined
          ? agentToolServers.map((server) => server.id)
          : config.provideToolServers;

      // archive#1684 — THE LIVE GATE for the built-in station-control server.
      //
      // The `acp` matrix cell names a delivery mechanism whose
      // `basis` is `'runtime_observation'`: it declares that a reviewed,
      // non-secret-crossing mechanism EXISTS for this engine class, and that
      // using it requires a live observation of THIS subject. This block is
      // that observation being read, and it is the only place it can be
      // read — the matrix is static data and the resolver runs before any
      // process exists. `session-agent-resolution.ts`'s static `!== undefined`
      // exemption may therefore let station-control through to an ACP session
      // that this gate then refuses; that divergence is documented there and
      // is safe in one direction only, because a refusal here delivers
      // nothing and emits a receipt.
      //
      // Three cases, deliberately NOT collapsed into one boolean (see
      // docs/guides/code-quality.md, "a default that decides"): observed-yes,
      // observed-no, and never-observed are three different facts, and the
      // last two produce different receipts. A single
      // `mcpCapabilities?.http === true` test would report a session that
      // never got an `initialize` result as an engine that answered no.
      const mcpHttp =
        acpProcess.initResult?.agentCapabilities?.mcpCapabilities?.http;
      let stationControlAuth: { url: string; token: string } | undefined;
      let stationControlUnavailable:
        | { reason: AcpToolServerSkipReason; detail: string }
        | undefined;
      // Only consult the gate (and only ever mint) when the session's
      // resolved tool servers actually name station-control — an unrelated
      // ACP session must not mint a credential it will never use.
      //
      // This early exit is NOT sufficient on its own, and saying otherwise
      // was a review finding: it keys on an ID, while
      // `isBuiltinStationControl` in the passthrough decides delivery on an
      // IDENTITY. They disagree for an id-sharing impostor and for a genuine
      // built-in whose persisted `args[0]` no longer resolves to the shipped
      // server path. The reconciliation right after
      // `resolveAcpPassthroughMcpServers` below — mint-but-not-delivered ⇒
      // revoke now, with its own receipt — is what closes that gap.
      if (requestedToolServerIds?.includes('station-control')) {
        if (mcpHttp === true) {
          stationControlAuth = input.tenantExecutionContext
            ? this.options.mintStationControlMcpAuth?.(
                input.threadId,
                input.tenantExecutionContext,
              )
            : this.options.mintStationControlMcpAuth?.(input.threadId);
          if (!stationControlAuth) {
            // The engine said yes and Station still produced nothing: a
            // Station-side wiring gap, never a fact about the engine. Saying
            // 'engine-capability-absent' here would be a receipt blaming a
            // CLI that did exactly what was asked of it.
            stationControlUnavailable = {
              reason: 'delivery-failed',
              detail:
                'the engine advertised mcpCapabilities.http, but no station-control MCP auth could be minted for this session',
            };
          }
        } else if (acpProcess.initResult == null) {
          stationControlUnavailable = {
            reason: 'engine-capability-absent',
            detail:
              "no initialize result was available for this session; the engine's MCP HTTP capability could not be observed",
          };
        } else {
          stationControlUnavailable = {
            reason: 'engine-capability-absent',
            detail:
              'the connected engine did not advertise mcpCapabilities.http at initialize',
          };
        }
      }

      // Defensive isolation (repo review, 2026-07-26): passthrough
      // resolution is a best-effort enrichment, never a session-start
      // gate — an unexpected throw here (a buggy resolveToolServer, etc.)
      // must degrade to "no passthrough servers", not abort the whole ACP
      // session start.
      let passthroughMcpServers: Awaited<
        ReturnType<typeof resolveAcpPassthroughMcpServers>
      >['servers'] = [];
      const capabilityUndelivered: CapabilityUndelivered[] = [];
      try {
        const resolved = await resolveAcpPassthroughMcpServers({
          toolServerIds: requestedToolServerIds,
          ...(stationControlAuth ? { stationControlAuth } : {}),
          ...(stationControlUnavailable ? { stationControlUnavailable } : {}),
          resolveToolServer:
            agentToolServers !== undefined
              ? async (id) => {
                  const match = agentToolServers.find(
                    (server) => server.id === id,
                  );
                  return match ? toPassthroughToolDef(match) : null;
                }
              : (this.options.resolveToolServer ?? (async () => null)),
          logger,
        });
        passthroughMcpServers = resolved.servers;
        if (resolved.skipped.length > 0) {
          logger.warn?.(
            `ACP connection '${config.id}': skipped ${resolved.skipped.length} opted-in tool server(s) for MCP passthrough`,
            resolved.skipped,
          );
          capabilityUndelivered.push(
            ...resolved.skipped.map(toCapabilityUndelivered),
          );
        }
        // archive#1684 (review fix): the mint keyed on the id
        // `'station-control'`; delivery keyed on `isBuiltinStationControl`.
        // When those disagree a credential exists that nothing will ever
        // present, and the receipts above describe a DIFFERENT fact — an
        // id-sharing impostor is reported `secret-boundary-env` (or delivered
        // as an ordinary stdio server, which is the correct outcome and stays
        // unchanged), and neither says a word about the live token. Revoke it
        // the moment it is known to be undeliverable rather than leaving it
        // live until `stopSession` or the 12-hour TTL, and record WHY in
        // wording that cannot be mistaken for the secret-boundary refusal.
        if (stationControlAuth && !resolved.stationControlDelivered) {
          this.options.revokeStationControlMcpAuth?.(input.threadId);
          stationControlAuth = undefined;
          // Delta-review finding (LOW-1): `not-found` short-circuits BEFORE
          // the identity branch, so "did not match the built-in identity"
          // would assert a comparison that never ran — nothing resolved, and
          // `isBuiltinStationControl` was never called. Naming the identity
          // check in that case is the same defect this whole reconciliation
          // exists to remove, one size smaller. Say only what was computed.
          const unresolved = resolved.skipped.some(
            (skip) =>
              skip.id === 'station-control' && skip.reason === 'not-found',
          );
          capabilityUndelivered.push({
            capability: 'toolServers',
            id: 'station-control',
            reason: 'delivery-failed',
            detail: unresolved
              ? 'a station-control credential was minted for this session, but the id resolved to no tool server at all, so no identity comparison was performed; nothing was delivered and the token was revoked immediately'
              : 'a station-control credential was minted for this session, but the resolved tool server did not match the built-in station-control identity (isBuiltinStationControl); nothing was delivered and the token was revoked immediately',
          });
          logger.warn?.(
            `ACP connection '${config.id}': a station-control MCP credential was minted but not delivered (identity check failed); it has been revoked.`,
          );
        }
      } catch (error) {
        // A throw here means nothing was delivered, so a credential minted
        // above is now unpresentable exactly as in the reconciliation branch —
        // revoke it on this path too rather than leaving it live for the
        // 12-hour TTL. Same reasoning, weaker case (this receipt is honest
        // rather than misleading), but the credential lifetime should not
        // depend on which way the resolution failed.
        if (stationControlAuth) {
          this.options.revokeStationControlMcpAuth?.(input.threadId);
          stationControlAuth = undefined;
        }
        logger.warn?.(
          `ACP connection '${config.id}': MCP passthrough resolution failed unexpectedly; continuing without passthrough tool servers.`,
          error,
        );
        capabilityUndelivered.push({
          capability: 'toolServers',
          reason: 'delivery-failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      for (const entry of capabilityUndelivered) {
        agentCapabilityUndelivered.add(1, {
          provider: this.provider,
          capability: entry.capability,
          reason: entry.reason,
        });
      }
      // archive#1547 AC5 — the runtime docs grant.
      //
      // Its original premise was "an ACP engine can never receive
      // `station-control`". archive#1684 narrowed that premise but did not
      // remove it: an ACP engine receives station-control only when its
      // connected CLI advertises `mcpCapabilities.http` at `initialize`, so
      // the population this grant was written for — a command-backed CLI
      // that cannot run the built-in assistant, whose user therefore talks
      // to the engine's OWN agent, which is exactly the agent
      // `builtinStationAgentSpec` does not cover (it grants only the
      // `station` slug) — still exists, and is now identified per
      // connection rather than per engine class. Without this, the engine
      // that the built-in-assistant empty state is talking about is
      // precisely the engine that receives no documentation, and the
      // sentence "it can still explain Station" would be a claim with no
      // producer (delivery protocol §6).
      //
      // Deliberately UNCONDITIONAL, not gated on the station-control gate
      // above: this server needs no credential and no capability, so making
      // its delivery depend on another server's outcome would only create a
      // way for a capable engine to lose documentation it can plainly
      // receive.
      //
      // Three properties make this a grant rather than a substitution, and
      // each was a way to get it wrong:
      //
      //  1. It is appended AFTER the authored/connection resolution above and
      //     never participates in it. `passthroughSource` and `requested` keep
      //     meaning exactly what they meant — Station adding a server on its
      //     own account must not be reported as the agent having authored one,
      //     and must not flip a connection-default session into an
      //     agent-authored one.
      //  2. It never displaces anything. An id already delivered — authored,
      //     or opted in via `provideToolServers` — wins and this adds nothing,
      //     so a user who opted a connection into tool servers keeps exactly
      //     the set they chose.
      //  3. It is identity-checked, and the check fails toward genuine.
      //     Post-#3063 the ConfigLoader overlay injects the real shipped
      //     command/args for any def resolved under a registered built-in
      //     id, so `isBuiltinStationDocs` passing here guarantees the
      //     GENUINE docs bundle is what spawns — an unrelated binary a user
      //     saved under `integrations/station-docs/` cannot ride this grant
      //     into an engine, because its authored command/args never survive
      //     loading. A def that reaches here WITHOUT the overlay's genuine
      //     identity (hand-built, stale path) simply fails the check and is
      //     not granted. See `isBuiltinStationControl`'s doc comment
      //     (station-control-runtime-env.ts) for the full contract.
      //
      // The whole grant is only safe because the server declares no `env` —
      // pinned by the AC3 guard in `runtime-default-agent.test.ts` — so it
      // crosses the §5 secret boundary the same way it crosses every other
      // channel: by having no secret. `resolveAcpPassthroughMcpServers` is
      // reused rather than hand-rolled so the env filter, the transport
      // check, and the binary-existence check are the identical ones every
      // other passthrough server passes.
      const runtimeProvided: string[] = [];
      if (
        !passthroughMcpServers.some(
          (server) => server.name === BUILTIN_STATION_DOCS_TOOL_SERVER_ID,
        )
      ) {
        try {
          const resolveOne = this.options.resolveToolServer;
          const docs = await resolveOne?.(BUILTIN_STATION_DOCS_TOOL_SERVER_ID);
          if (
            docs &&
            isBuiltinStationDocs(BUILTIN_STATION_DOCS_TOOL_SERVER_ID, docs)
          ) {
            const granted = await resolveAcpPassthroughMcpServers({
              toolServerIds: [BUILTIN_STATION_DOCS_TOOL_SERVER_ID],
              resolveToolServer: async () => docs,
              logger,
            });
            passthroughMcpServers = [
              ...passthroughMcpServers,
              ...granted.servers,
            ];
            runtimeProvided.push(
              ...granted.servers.map((server) => server.name),
            );
            if (granted.skipped.length > 0) {
              // Recorded, never silent: this server exists to be delivered,
              // so a build where it cannot be is a fact an operator needs.
              // It is NOT pushed into `capabilityUndelivered` — that list is
              // the receipt for what the AGENT asked for, and nothing the
              // agent asked for failed here.
              logger.warn?.(
                `ACP connection '${config.id}': the built-in Station docs server could not be delivered`,
                granted.skipped,
              );
            }
          }
        } catch (error) {
          // Same defensive isolation as the passthrough block above: the docs
          // grant is an enrichment and must never be able to fail a session
          // start. An engine with no documentation still works.
          logger.warn?.(
            `ACP connection '${config.id}': the built-in Station docs grant failed unexpectedly; continuing without it.`,
            error,
          );
        }
      }

      if (passthroughMcpServers.length > 0) {
        acpPassthroughSessions.add(1, {
          connectionId: config.id,
          serverCount: String(passthroughMcpServers.length),
          source: passthroughSource,
        });
      }

      // archive#1182: the ACP agent's own reported model, when its `newSession`
      // response includes a `model`-category config option — see
      // `extractReportedModelFromConfigOptions`'s docblock. `loadSession`
      // (the resume branch below) returns nothing, so a resumed session
      // stays honestly unset here.
      let reportedModel: string | undefined;
      let verifiedModelSelection:
        | ReturnType<typeof modelSelectionReceipt>
        | undefined;

      // archive#895 wave B: resume via session/load when the caller supplied a
      // resume cursor, else start a fresh session/new — both branches
      // deliver the SAME resolved passthroughMcpServers (LoadSessionRequest
      // requires `mcpServers`, so tool servers ARE deliverable on resume;
      // see acp-mcp-passthrough.ts's header). Fail-closed rationale
      // (decided ambiguity A3): falling back to newSession on a
      // non-loadSession CLI would show the user their full Station-side
      // history against an engine process with no context — silent
      // degradation. Failing start reproduces today's observable outcome
      // for recovery (session closed) with a truthful reason.
      this.requireCurrentGeneration(input.threadId, record.generation);
      if (isAcpResumeCursor(input.resumeCursor)) {
        if (acpProcess.initResult?.agentCapabilities?.loadSession !== true) {
          acpResumeSessions.add(1, {
            connectionId: config.id,
            outcome: 'load-unsupported',
          });
          throw new Error(
            "This engine's CLI does not advertise session loading (ACP loadSession); the previous conversation cannot be resumed.",
          );
        }
        await acpProcess.loadSession(
          input.resumeCursor.acpSessionId,
          cwd,
          passthroughMcpServers,
        );
        acpResumeSessions.add(1, {
          connectionId: config.id,
          outcome: 'loaded',
        });
      } else {
        const sessionResult = await acpProcess.newSession(
          cwd,
          passthroughMcpServers,
        );
        session.resumeCursor = {
          acpSessionId: sessionResult.sessionId,
          connectionId: config.id,
          connectionFingerprint: acpConnectionFingerprint(
            acpExecutionIdentity({
              command: config.command,
              args: config.args,
              effectiveCwd: cwd,
            }),
          ),
        } satisfies AcpResumeCursor;
        record.currentModeId = sessionResult.modes?.currentModeId;
        record.configOptions = sessionResult.configOptions;
        reportedModel = extractReportedModelFromConfigOptions(
          sessionResult.configOptions,
        );
        const requestedModel = input.modelId?.trim();
        if (requestedModel) {
          const modelOption = findAcpModelConfigOption(
            sessionResult.configOptions,
          );
          if (!modelOption) {
            throw new Error(
              `ACP model option unavailable: connection '${config.id}' did not advertise a model configuration option for this session.`,
            );
          }
          if (
            !modelOption.options.some(
              (option) => option.value === requestedModel,
            )
          ) {
            throw new Error(
              `ACP model value unsupported: connection '${config.id}' did not advertise '${requestedModel}' for this session.`,
            );
          }
          const response = await acpProcess.setConfigOption(
            modelOption.id,
            requestedModel,
          );
          const appliedOption = findAcpModelConfigOption(
            (response as { configOptions?: unknown } | null)?.configOptions,
          );
          if (
            appliedOption?.id !== modelOption.id ||
            appliedOption.currentValue !== requestedModel
          ) {
            throw new Error(
              `ACP model application unverified: connection '${config.id}' reported '${appliedOption?.currentValue ?? 'no current value'}' after '${requestedModel}' was requested.`,
            );
          }
          record.configOptions = (
            response as { configOptions: unknown[] }
          ).configOptions;
          reportedModel = appliedOption.currentValue;
          verifiedModelSelection = modelSelectionReceipt(
            requestedModel,
            appliedOption.currentValue,
          );
        }
      }

      session.status = 'ready';
      session.updatedAt = new Date().toISOString();
      this.requireCurrentGeneration(input.threadId, record.generation);

      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
        method: 'session.configured',
        sessionId: input.threadId,
        model: input.modelId,
        cwd,
        metadata: (() => {
          const deliveryMetadata = mergeCapabilityDeliveryMetadata(
            {
              ...input.metadata,
              ...effectiveModelMetadata(input.modelId, input.modelOptions),
              ...reportedModelMetadata(reportedModel),
              ...(verifiedModelSelection
                ? {
                    [MODEL_SELECTION_RECEIPT_METADATA_KEY]:
                      verifiedModelSelection,
                  }
                : {}),
            },
            'toolServers',
            {
              source: passthroughSource,
              // Deliberately NOT widened by the runtime docs grant: nothing
              // authored or opted into it, and saying otherwise would report
              // the agent as having asked for a server it never named.
              requested:
                agentToolServers !== undefined
                  ? agentToolServers.map((server) => server.id)
                  : (config.provideToolServers ?? []),
              delivered: passthroughMcpServers.map((server) => server.name),
              ...(runtimeProvided.length > 0 ? { runtimeProvided } : {}),
              undelivered: capabilityUndelivered,
            },
          );
          const existing = deliveryMetadata[
            SESSION_CAPABILITY_DELIVERY_METADATA_KEY
          ] as SessionCapabilityDeliveryMetadata | undefined;
          return {
            ...deliveryMetadata,
            [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
              ...existing,
              ...(record.preToolPolicy
                ? {
                    toolPolicy: {
                      coverage: 'partial' as const,
                      permissionHook: 'requestPermission' as const,
                      evidence: 'sharedStagedPolicy' as const,
                      toolIdentity: 'self-reported' as const,
                      limitation:
                        'Only ACP calls that invoke requestPermission and report a tool name are covered; the external engine reports that identity.',
                    },
                  }
                : {}),
            } satisfies SessionCapabilityDeliveryMetadata,
          };
        })(),
      });

      return session;
    } catch (error) {
      const cancelled = error instanceof AcpSessionStartCancelledError;
      session.status = 'error';
      session.updatedAt = new Date().toISOString();
      // archive#1684: the session never started — a station-control MCP token
      // minted above would otherwise linger unused until its TTL expires.
      // Best-effort and id-tolerant (revokeStationControlMcpToken ignores an
      // unknown id), so a session that never minted one is a no-op.
      this.options.revokeStationControlMcpAuth?.(input.threadId);
      try {
        await acpProcess.destroy();
        if (this.sessions.get(input.threadId) === record) {
          this.sessions.delete(input.threadId);
        }
        if (cancelled && record.startedPublished) {
          this.publish({
            eventId: crypto.randomUUID(),
            provider: this.provider,
            threadId: input.threadId,
            createdAt: new Date().toISOString(),
            method: 'session.exited',
            sessionId: input.threadId,
            reason: 'stopped',
          });
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'ACP session startup failed and process cleanup was not confirmed.',
        );
      }
      throw error;
    }
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const record = this.requireSession(input.threadId);
    if (record.activeTurnId) {
      throw new Error(
        `ACP session '${input.threadId}' already has an active turn.`,
      );
    }
    const turnId = crypto.randomUUID();
    const decodedAttachments = decodeChatAttachments(input.attachments);
    rejectFileAttachments('This engine', decodedAttachments);
    if (
      decodedAttachments.length > 0 &&
      record.process.initResult?.agentCapabilities?.promptCapabilities
        ?.image !== true
    ) {
      throw new Error(
        'This engine did not advertise image attachment support.',
      );
    }
    record.activeTurnId = turnId;
    record.session.status = 'running';
    record.session.updatedAt = new Date().toISOString();
    // archive#4084: start this turn's error-notification window clean —
    // discards anything retained from a prior turn (already consumed or
    // discarded when that turn settled below) rather than letting a stale
    // notification enrich an unrelated later failure.
    record.turnErrorNotifications = [];
    // archive#4084 review fix round M1: snapshot suppression ONCE, here, at
    // turn start — if any interrupted-but-unsettled prompt exists for this
    // session right now, THIS turn's retention window is suppressed for its
    // entire duration, immune to quarantinedTurnIds later losing that entry
    // (leak cleanup only, once the cancelled prompt settles — see
    // AcpMapperState.turnErrorNotificationsSuppressed for why re-deriving
    // this per notification from the live set is wrong). Fail-closed only
    // for this turn; does not block the turn itself from starting.
    record.turnErrorNotificationsSuppressed =
      (record.quarantinedTurnIds?.size ?? 0) > 0;

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
      metadata: effectiveModelMetadata(
        input.modelId ?? record.session.model,
        input.modelOptions,
      ),
    });

    const content: ContentBlock[] = [
      ...(input.input ? [{ type: 'text' as const, text: input.input }] : []),
      ...decodedAttachments.map(({ attachment, base64 }) => ({
        type: 'image' as const,
        data: base64,
        mimeType: attachment.mimeType,
      })),
    ];
    record.process
      .prompt(content)
      .then((response) => {
        // archive#4084 review fix round F2: unquarantine unconditionally —
        // this specific prompt() has now settled, regardless of whether it
        // still owns the active turn (an interrupted turn's own settlement
        // lands here too, since interruptTurn does not replace this
        // handler). Must run before the ownsActiveTurn early return below,
        // or a superseded turn's quarantine would never clear.
        record.quarantinedTurnIds?.delete(turnId);
        if (!this.ownsActiveTurn(input.threadId, record, turnId)) return;
        // Turn succeeded: any notification retained during this window
        // turned out not to matter. Clear it rather than let it leak into a
        // future failure it did not co-occur with (archive#4084).
        record.turnErrorNotifications = undefined;
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          turnId,
          method: 'turn.completed',
          finishReason: mapAcpStopReasonToFinishReason(response.stopReason),
        });
        record.session.status = 'ready';
        record.session.updatedAt = new Date().toISOString();
        record.activeTurnId = undefined;
      })
      .catch((error) => {
        // archive#4084 review fix round F2: see the `.then` branch above —
        // must run before the ownsActiveTurn early return.
        record.quarantinedTurnIds?.delete(turnId);
        if (!this.ownsActiveTurn(input.threadId, record, turnId)) return;
        const baseMessage =
          error instanceof Error ? error.message : String(error);
        // archive#4084: a bare JSON-RPC error (e.g. -32603 "Internal error")
        // carries no actionable detail, but the engine may have already
        // sent a separate, evidenced extension notification earlier in this
        // same turn window (live evidence: kiro-cli's
        // `_kiro.dev/error/rate_limit`). Quote the most recent such
        // notification's own `message`, unmodified and clearly attributed
        // to the engine — never fabricated when none arrived. Framed as
        // co-occurrence, not causation (F5): Station observed the two
        // events in the same turn window, and did not verify that the
        // notification actually caused this failure.
        const coReportedCause = record.turnErrorNotifications?.at(-1)?.message;
        record.turnErrorNotifications = undefined;
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          method: 'runtime.error',
          severity: 'error',
          message: coReportedCause
            ? `${baseMessage} — engine also reported during this turn: ${coReportedCause}`
            : baseMessage,
        });
        record.session.status = 'error';
        record.session.updatedAt = new Date().toISOString();
        record.activeTurnId = undefined;
      });

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: record.session.resumeCursor,
    };
  }

  async interruptTurn(threadId: string, turnId?: string) {
    const record = this.requireSession(threadId);
    const activeTurnId = record.activeTurnId;
    if (!activeTurnId) return { outcome: 'no-active-turn' } as const;
    if (turnId && turnId !== activeTurnId) {
      return { outcome: 'target-mismatch', activeTurnId } as const;
    }
    const targetTurnId = turnId ?? activeTurnId;
    // archive#4084 review fix round F2: quarantine BEFORE awaiting cancel()
    // — a notification tied to this cancelled operation can arrive at any
    // point from here until its `prompt()` promise actually settles
    // (sendTurn's `.then`/`.catch`, which is what clears this entry). Set
    // unconditionally, even though a race below may report
    // 'target-mismatch': the point is exactly that ownership can shift
    // before cancellation is confirmed, and a late notification from this
    // turn must never enrich whatever turn ends up active afterward.
    record.quarantinedTurnIds ??= new Set();
    record.quarantinedTurnIds.add(targetTurnId);
    // ACP has no per-tool cancellation acknowledgement. Preserve the latest
    // bounded redraw and close every live tool row before awaiting the child;
    // this makes an interrupt truthful even when the process never settles.
    record.toolUpdateSupervisor.cancelAll();
    await record.process.cancel();
    if (!this.ownsActiveTurn(threadId, record, targetTurnId)) {
      return {
        outcome: 'target-mismatch',
        activeTurnId: record.activeTurnId,
      } as const;
    }
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      turnId: targetTurnId,
      method: 'turn.aborted',
      reason: 'interrupted',
    });
    record.activeTurnId = undefined;
    record.session.status = 'ready';
    record.session.updatedAt = new Date().toISOString();
    return { outcome: 'cancelled', turnId: targetTurnId } as const;
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: AcpDecision,
  ): Promise<void> {
    const record = this.requireSession(threadId);
    const pending = record.pendingRequests.get(requestId);
    if (!pending) {
      throw new Error(`Unknown ACP permission request: ${requestId}`);
    }

    record.pendingRequests.delete(requestId);
    pending.resolve(decision);

    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      requestId,
      method: 'request.resolved',
      status: mapAcpDecisionToApprovalStatus(decision),
    });
  }

  async stopSession(threadId: string): Promise<void> {
    this.invalidateSession(threadId);
    const current = this.sessions.get(threadId);
    if (current) this.prepareRecordForStop(current);
    // A detached credential recovery may be between process teardown and a
    // replacement start. Joining it after invalidation makes an explicit
    // stop win that race; the recovery checks the same generation before it
    // can create a new child or mint a replacement station-control token.
    try {
      await this.joinLifecycleTasks(threadId);
      const record = this.sessions.get(threadId);
      if (!record) return;
      await this.stopRecord(record, 'stopped');
    } finally {
      this.maybeForgetGeneration(threadId);
    }
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()].map((record) => record.session);
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const threadIds = new Set([
      ...this.sessions.keys(),
      ...this.startingSessionTasks.keys(),
      ...this.recoveryTasks.keys(),
    ]);
    await Promise.all(
      [...threadIds].map((threadId) => this.stopSession(threadId)),
    );
    await Promise.allSettled([
      ...this.startingSessionTasks.values(),
      ...this.recoveryTasks.values(),
    ]);
    for (const threadId of threadIds) this.maybeForgetGeneration(threadId);
    this.events.close();
  }

  private sessionGeneration(threadId: string): number {
    return this.sessionStopGenerations.get(threadId) ?? 0;
  }

  private invalidateSession(threadId: string): void {
    this.sessionStopGenerations.set(
      threadId,
      this.sessionGeneration(threadId) + 1,
    );
  }

  private isCurrentGeneration(threadId: string, generation: number): boolean {
    return (
      !this.shuttingDown && this.sessionGeneration(threadId) === generation
    );
  }

  private requireCurrentGeneration(threadId: string, generation: number): void {
    if (!this.isCurrentGeneration(threadId, generation)) {
      throw new AcpSessionStartCancelledError();
    }
  }

  private maybeForgetGeneration(threadId: string): void {
    if (
      !this.sessions.has(threadId) &&
      !this.startingSessionTasks.has(threadId) &&
      !this.recoveryTasks.has(threadId) &&
      !this.startingSessionThreads.has(threadId)
    ) {
      this.sessionStopGenerations.delete(threadId);
    }
  }

  private async joinLifecycleTasks(threadId: string): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    const start = this.startingSessionTasks.get(threadId);
    const recovery = this.recoveryTasks.get(threadId);
    if (start) tasks.push(start);
    if (recovery) tasks.push(recovery);
    await Promise.allSettled(tasks);
  }

  private async stopRecord(
    record: AcpSessionRecord,
    reason: string,
  ): Promise<void> {
    const threadId = record.session.threadId;
    this.prepareRecordForStop(record);
    try {
      await record.process.destroy();
    } finally {
      // Token revocation cannot be conditional on process teardown. A child
      // that failed to exit is quarantined in this record, but it must never
      // retain authority to Station while an operator retries destruction.
      this.options.revokeStationControlMcpAuth?.(threadId);
    }
    if (this.sessions.get(threadId) !== record) return;
    this.sessions.delete(threadId);
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      sessionId: threadId,
      reason,
    });
  }

  private prepareRecordForStop(record: AcpSessionRecord): void {
    const threadId = record.session.threadId;
    record.toolUpdateSupervisor.dispose();
    if (!record.stopping) {
      record.stopping = true;
      record.activeTurnId = undefined;
      for (const [requestId, pending] of record.pendingRequests) {
        pending.resolve('cancel');
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId,
          createdAt: new Date().toISOString(),
          requestId,
          method: 'request.resolved',
          status: mapAcpDecisionToApprovalStatus('cancel'),
        });
      }
      record.pendingRequests.clear();
    }
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }

  async getPrerequisites(options?: {
    signal?: AbortSignal;
    connectionId?: string;
  }): Promise<Prerequisite[]> {
    const connections = await this.options.getConnections();
    if (connections.length === 0) {
      return [];
    }

    // chat-dock-maximize-readiness (AC8): scope to the selected connection so
    // a ready OpenCode is not rejected because an unavailable Cursor sibling
    // adds a missing prerequisite to the aggregate. Absent preserves the
    // aggregate behavior (system-status / onboarding panels).
    const scoped = options?.connectionId
      ? connections.filter((config) => config.id === options.connectionId)
      : connections;
    if (scoped.length === 0) {
      return [];
    }

    const results = await Promise.all(
      scoped.map((config) =>
        buildCliRuntimePrerequisites({
          command: config.command,
          displayName: config.name,
          versionArgs: ['--version'],
          authArgs: ['--version'],
          installStep: `Install ${config.name} and ensure \`${config.command}\` is on PATH.`,
          authStep: `Verify ${config.name} is configured and reachable via \`${config.command}\`.`,
        }),
      ),
    );

    return results.flat();
  }

  async getCommands(): Promise<
    Array<{
      name: string;
      description: string;
      argumentHint?: string;
      passthrough: boolean;
    }>
  > {
    const commands = new Map<string, AcpSlashCommand>();
    for (const record of this.sessions.values()) {
      for (const command of record.slashCommands ?? []) {
        commands.set(command.name, command);
      }
    }
    return [...commands.values()].map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      passthrough: true,
    }));
  }

  private buildClient(
    record: AcpSessionRecord,
    context: {
      cwd: string;
      terminals: Map<string, ManagedTerminal>;
      nextTerminalId: () => string;
      logger: AcpLogger;
    },
  ): Client {
    const client = createACPBridgeClient({
      cwd: context.cwd,
      terminals: context.terminals,
      // Constructed only to satisfy createACPBridgeClient's parameter type —
      // never invoked, since `requestPermission` is overridden below with the
      // adapter's own canonical implementation (Q2 resolution in the plan).
      approvalRegistry: new ApprovalRegistry(context.logger),
      getActiveWriter: () => null,
      nextTerminalId: context.nextTerminalId,
      onSessionUpdate: async (params: SessionNotification) => {
        this.handleSessionUpdate(record, params.update);
      },
      onExtNotification: (method, params) => {
        this.handleExtensionNotification(record, method, params);
      },
      // Unrecognized inbound extension REQUESTS get a spec-conformant
      // `-32601` refusal, and a credential-shaped one can never acquire a
      // handler at all. This replaces `onExtMethod: () => ({})`, which
      // answered every agent→client extension request — including Kiro's
      // token-refresh callback `_kiro/auth/getAccessToken` — with an empty
      // object Station never computed, handed back AS the refreshed token.
      // See acp-inbound-extension-policy.ts and ADR 0013 Layer 1.
      // (Unrecognized NOTIFICATIONS stay ignored, per spec, above.)
      onExtMethod: createAcpInboundExtensionRequestHandler({
        logger: context.logger,
        connectionId: record.connectionId,
        onRefused: (method, reason) =>
          this.handleCredentialRefusal(record, method, reason),
      }),
    });

    client.requestPermission = async (
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      const toolName = params.toolCall?.name;
      if (toolName && record.preToolPolicy) {
        const decision = await record.preToolPolicy(
          {
            toolName,
            toolCallId: params.toolCall.toolCallId,
            toolDescription: params.toolCall.title ?? undefined,
            toolArgs: params.toolCall.rawInput,
          },
          {
            agentSlug: record.agent?.slug ?? 'unknown',
            conversationId: record.session.threadId,
            delegation: record.delegation,
          },
          {
            interaction: 'external',
            // ACP names are reported by the external process. Keep the raw
            // name authoritative so reserved-name grants remain fail-closed.
            identity: externalPreToolPolicyIdentity(toolName),
          },
        );
        if (decision.behavior === 'allow') {
          return {
            outcome: mapAcpDecisionToOutcome('accept', params.options),
          };
        }
        if (decision.behavior === 'deny') {
          return {
            outcome: mapAcpDecisionToOutcome('decline', params.options),
          };
        }
        // `defer` (and defensive `ask`) preserve ACP's one existing approval
        // flow below; Station never opens a second prompt.
      } else if (
        toolName &&
        isAutoApprovedExternalTool(
          toolName,
          record.agent?.autoApprove,
          record.agent?.toolServers,
          'self-reported',
        )
      ) {
        return {
          outcome: mapAcpDecisionToOutcome('accept', params.options),
        };
      }

      const requestId = crypto.randomUUID();
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.session.threadId,
        createdAt: new Date().toISOString(),
        requestId,
        method: 'request.opened',
        requestType: 'approval',
        title: params.toolCall?.title ?? 'Allow tool call',
        payload: {
          toolCallId: params.toolCall?.toolCallId,
          rawInput: params.toolCall?.rawInput,
          options: params.options,
        },
      });

      const decision = await new Promise<AcpDecision>((resolve) => {
        record.pendingRequests.set(requestId, {
          resolve,
          options: params.options,
        });
      });

      return { outcome: mapAcpDecisionToOutcome(decision, params.options) };
    };

    return client;
  }

  private handleSessionUpdate(
    record: AcpSessionRecord,
    update: SessionNotification['update'],
  ): void {
    // Session-state mutation (row 11 of the Lifecycle Mapping Table) lives
    // entirely in the mapper's AcpMapperState branches now — `state: record`
    // makes AcpSessionRecord the live backing store the mapper mutates
    // directly, so this method is pure wiring.
    const ctx: AcpMapperContext = {
      provider: this.provider,
      session: record.session,
      activeTurnId: record.activeTurnId,
      publish: (event) => this.publish(event),
      state: record,
      toolUpdateSupervisor: record.toolUpdateSupervisor,
    };
    mapAcpSessionUpdate(update, ctx);
  }

  /**
   * Handle a refused CREDENTIAL request. The first observable refusal gets
   * one safe re-establishment attempt; only an unavailable recovery, a
   * failed re-establishment, or a later refusal reaches the user warning.
   *
   * WHERE THIS ACTUALLY GOES, since the prose used to overstate it: the
   * canonical `runtime.warning` becomes a **5-second toast**
   * (`src-ui/src/hooks/orchestration/turnHandlers.ts` →
   * `toastStore.show(message, threadId, 5000)`) and a **session diagnostics
   * log** row (`src-ui/src/utils/sessionDiagnosticsLog.ts`). It is NOT a
   * transcript message and does not persist in the conversation. The
   * message below is therefore kept short enough to read in five seconds,
   * with the machine-readable specifics in `details` and the durable record
   * in the event store. Under Station's default engine path the refusal
   * fires lazily on token expiry, so the user may not be watching — the
   * diagnostics-log row is what makes it recoverable, and a
   * transcript-grade surface is a follow-up, not a claim made here.
   *
   * A bare `-32601` is honest on the wire and invisible in the product, and
   * the user's actual situation is both specific and fixable. The dominant
   * live case is an engine's **session-token refresh callback**: Kiro in ACP
   * mode delegates refresh to the host (`_kiro/auth/getAccessToken`,
   * kirodotdev/Kiro#10416) and, under Station's default engine path, asks
   * lazily *on expiry* — so a long chat dies mid-session while the user's
   * on-disk credential is still perfectly valid. The engine's own workaround
   * is to restart it so a fresh process re-reads that credential, which is
   * exactly what this message tells the user to do.
   *
   * The message deliberately does NOT assert that the token expired.
   * Station observed a credential-shaped request and refused it; it did not
   * compute a diagnosis, and saying otherwise here would be the same defect
   * this whole change exists to remove. It names the usual cause as usual,
   * and the action as certain.
   *
   * Recovery restarts a child only from its own validated resume cursor.
   * Station must not become the engine's auth host either way; it holds
   * nothing to refresh with, and acquiring something is the opposite of the
   * invariant.
   *
   * Only `credential-shaped` refusals are surfaced. An ordinary unknown
   * method (`_kiro/terminal/shell_type`) is a routine protocol non-event and
   * belongs in the log, not in the user's transcript — surfacing every
   * refusal would train users to ignore the one that matters.
   *
   * Deduped per session because the observed live traffic sends the same
   * method twice before `initialize` is answered.
   *
   * The engine's credential callback is refused synchronously on the ACP
   * wire. Recovery is deliberately detached from that refusal: Station never
   * needs to compute, retain, or forward a credential to restart the child.
   *
   * The boolean is set before the first await in `recoverCredentialRefusal`,
   * so two eager callbacks cannot each replace the same process. A later
   * refusal is the bounded fallback condition and is surfaced as the existing
   * diagnostic rather than beginning a loop.
   */
  private handleCredentialRefusal(
    record: AcpSessionRecord,
    method: string,
    reason: AcpInboundExtensionRefusalReason,
  ): void {
    if (reason !== 'credential-shaped') return;
    if (
      record.stopping ||
      this.sessions.get(record.session.threadId) !== record
    ) {
      return;
    }
    if (record.credentialRecoveryAttempted) {
      this.publishCredentialRefusalWarning(record, method, reason);
      return;
    }

    record.credentialRecoveryAttempted = true;
    const recovery = this.recoverCredentialRefusal(record);
    this.recoveryTasks.set(record.session.threadId, recovery);
    void recovery
      .catch((error) => {
        if (error instanceof AcpSessionStartCancelledError) return;
        const logger = this.options.logger ?? console;
        logger.warn?.(
          {
            threadId: record.session.threadId,
            connectionId: record.connectionId,
            method,
          },
          'ACP credential-refusal recovery did not re-establish the session',
          error,
        );
        this.publishCredentialRefusalWarning(record, method, reason);
      })
      .finally(() => {
        if (this.recoveryTasks.get(record.session.threadId) === recovery) {
          this.recoveryTasks.delete(record.session.threadId);
          this.maybeForgetGeneration(record.session.threadId);
        }
      });
  }

  /**
   * Re-establish exactly once from an already-validated resume cursor. A
   * fresh `session/new` would silently abandon the native conversation, so an
   * unavailable cursor or `loadSession` capability is a diagnostic-only
   * outcome rather than a new child process.
   */
  private async recoverCredentialRefusal(
    record: AcpSessionRecord,
  ): Promise<void> {
    const threadId = record.session.threadId;
    const resumeCursor = record.session.resumeCursor;
    if (
      !isAcpResumeCursor(resumeCursor) ||
      !resumeCursor.connectionFingerprint ||
      record.process.initResult?.agentCapabilities?.loadSession !== true
    ) {
      throw new Error(
        'The ACP session cannot be re-established safely after the engine refused its credential callback.',
      );
    }

    const recoveryInput: ProviderSessionStartInput = {
      ...record.recoveryStart,
      threadId,
      // Preserve the exact child-produced cursor and bind the restart to the
      // same validated connection. Do not inspect an engine credential.
      resumeCursor: { ...resumeCursor },
      metadata: {
        ...record.recoveryStart.metadata,
        connectionId: record.connectionId,
      },
    };

    // `startSession` reserves this set before its first await. The recovery
    // path invokes `startReservedSession` directly, so it takes the same
    // reservation explicitly and leaves no window for a competing start.
    this.startingSessionThreads.add(threadId);
    try {
      if (
        this.sessions.get(threadId) !== record ||
        record.stopping ||
        !this.isCurrentGeneration(threadId, record.generation)
      ) {
        return;
      }
      record.stopping = true;
      await this.abortRecordForCredentialRecovery(record);
      let destroyError: unknown;
      try {
        await record.process.destroy();
      } catch (error) {
        destroyError = error;
      } finally {
        // The child may be retained for a later termination retry, but it
        // cannot keep the per-session Station authority while quarantined.
        this.options.revokeStationControlMcpAuth?.(threadId);
      }
      if (destroyError !== undefined) {
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId,
          createdAt: new Date().toISOString(),
          method: 'runtime.error',
          severity: 'error',
          message:
            'The engine process could not be terminated during credential-refusal recovery.',
        });
        throw destroyError;
      }
      if (this.sessions.get(threadId) !== record) return;
      this.sessions.delete(threadId);
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId,
        createdAt: new Date().toISOString(),
        method: 'session.exited',
        sessionId: threadId,
        reason: this.isCurrentGeneration(threadId, record.generation)
          ? 'credential-refusal-recovery'
          : 'stopped',
      });
      // A user stop or shutdown can land while cancel/destroy awaited. It
      // wins even though the original refusal callback continues resolving.
      if (!this.isCurrentGeneration(threadId, record.generation)) return;
      try {
        this.requireCurrentGeneration(threadId, record.generation);
        await this.startReservedSession(recoveryInput, {
          credentialRecoveryAttempted: true,
          generation: record.generation,
        });
      } catch (error) {
        if (error instanceof AcpSessionStartCancelledError) return;
        // The replacement child emitted session.started before its ACP
        // session/load attempt. Make the failed restart explicit instead of
        // leaving a plausible started lifecycle behind.
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId,
          createdAt: new Date().toISOString(),
          method: 'runtime.error',
          severity: 'error',
          message:
            'The engine session could not be re-established after its credential request was refused.',
        });
        throw error;
      }
    } finally {
      this.startingSessionThreads.delete(threadId);
    }
  }

  /** Make a running turn and open approvals terminal before replacing child. */
  private async abortRecordForCredentialRecovery(
    record: AcpSessionRecord,
  ): Promise<void> {
    const threadId = record.session.threadId;
    const turnId = record.activeTurnId;
    if (turnId) {
      try {
        await record.process.cancel();
      } catch (error) {
        // Process destruction immediately follows. The event remains truthful:
        // the turn was aborted because the engine process is being replaced,
        // not because Station claims its cancel RPC succeeded.
        const logger = this.options.logger ?? console;
        logger.warn?.(
          { threadId, connectionId: record.connectionId },
          'ACP turn cancel failed before credential-refusal recovery',
          error,
        );
      }
      if (record.activeTurnId === turnId) {
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId,
          createdAt: new Date().toISOString(),
          turnId,
          method: 'turn.aborted',
          reason: this.isCurrentGeneration(threadId, record.generation)
            ? 'engine-restarted'
            : 'stopped',
        });
        record.activeTurnId = undefined;
      }
    }

    for (const [requestId, pending] of record.pendingRequests) {
      pending.resolve('cancel');
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId,
        createdAt: new Date().toISOString(),
        requestId,
        method: 'request.resolved',
        status: mapAcpDecisionToApprovalStatus('cancel'),
      });
    }
    record.pendingRequests.clear();
    record.session.status = 'error';
    record.session.updatedAt = new Date().toISOString();
  }

  private publishCredentialRefusalWarning(
    record: AcpSessionRecord,
    method: string,
    reason: AcpInboundExtensionRefusalReason,
  ): void {
    if (reason !== 'credential-shaped') return;
    if (record.credentialRefusalsSurfaced?.has(method)) return;
    record.credentialRefusalsSurfaced ??= new Set();
    record.credentialRefusalsSurfaced.add(method);

    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.session.threadId,
      createdAt: new Date().toISOString(),
      method: 'runtime.warning',
      severity: 'warning',
      code: 'acp.credential-request-refused',
      // Short on purpose: this is read in a five-second toast. The method
      // name and connection ride `details`; the full reasoning lives in
      // docs/guides/acp.md.
      message:
        'This engine asked Station for a credential (typically a token ' +
        'refresh). Station never supplies one. If the engine has stopped ' +
        'responding, sign in with its own CLI and start a new chat.',
      details: { method, connectionId: record.connectionId },
    });
  }

  private handleExtensionNotification(
    record: AcpSessionRecord,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const ctx: AcpMapperContext = {
      provider: this.provider,
      session: record.session,
      activeTurnId: record.activeTurnId,
      publish: (event) => this.publish(event),
      state: record,
      toolUpdateSupervisor: record.toolUpdateSupervisor,
    };
    mapAcpExtensionNotification(method, params, ctx);
  }

  private publish(event: CanonicalRuntimeEvent): void {
    this.events.push(event);
  }

  private requireSession(threadId: string): AcpSessionRecord {
    const record = this.sessions.get(threadId);
    if (!record || record.stopping) {
      throw new Error(`Unknown ACP session: ${threadId}`);
    }
    return record;
  }

  private ownsActiveTurn(
    threadId: string,
    record: AcpSessionRecord,
    turnId: string,
  ): boolean {
    return (
      !record.stopping &&
      this.sessions.get(threadId) === record &&
      record.activeTurnId === turnId
    );
  }
}
