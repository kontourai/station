import type { ProviderRuntimeErrorEvent } from '@kontourai/station-contracts/runtime-events';
import { providerFailure } from '../provider-failure.js';
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
  McpServer,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import {
  ACP_ENGINE_DURABILITY,
  ACP_MODEL_OVERRIDE_PER_TURN,
  type AcpApprovalControl,
  acpApprovalControl,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type {
  CapabilityUndelivered,
  ResolvedAgentDefinition,
} from '@kontourai/station-contracts/provider';
import {
  ACP_APPROVAL_TAKEOVER_FAILED_CODE,
  FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY,
  MODEL_NOT_ADVERTISED_CODE,
  MODEL_SELECTION_RECEIPT_METADATA_KEY,
  modelSelectionReceipt,
  readApprovalMode,
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
  type SessionCapabilityDeliveryMetadata,
} from '@kontourai/station-contracts/provider';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { Prerequisite, ToolDef } from '@kontourai/station-contracts/tool';
import { toolRequestNeedsPerson } from '@kontourai/station-shared/tool-request-preview';
import {
  delegatedApprovalDenial,
  type StagedPreToolPolicyEvaluator,
} from '../../runtime/agents/pre-tool-policy.js';
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
import { COLD_START_OPERATION_TIMEOUT_MS } from '../../services/acp/acp-probe.js';
import {
  ACPProcess,
  type ACPProcessOptions,
} from '../../services/acp/acp-process.js';
import { prepareManagedAcpWorkspace } from '../../services/acp/managed-acp-workspace.js';
import {
  type OpenCodeApprovalFloor,
  withStationOpenCodeApprovalConfig,
} from '../../services/acp/opencode-approval-launch.js';
import {
  type OpenCodeAgentReader,
  openCodeAgentReader,
  verifyOpenCodeApprovalFloor,
} from '../../services/acp/opencode-approval-verify.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import {
  acpPassthroughSessions,
  acpResumeSessions,
  agentCapabilityUndelivered,
  sessionCwdResolution,
} from '../../telemetry/metrics.js';
import { raceWithSignal } from '../../utils/bounded-async.js';
import { errorMessage } from '../../utils/error-message.js';
import { expandTilde } from '../../utils/paths.js';
import {
  ApprovalGovernanceRefusedError,
  AttachmentInputUnsupportedError,
  type ProviderRuntimeEvent as CanonicalRuntimeEvent,
  type ProviderAdapterShape,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderSessionStartFailedError,
  type ProviderSessionStartInput,
  ProviderSessionStartingError,
  ProviderTurnEndedError,
  type ProviderTurnStartResult,
  SendTurnRefusedError,
  SessionStartRefusedError,
} from '../adapter-shape.js';
import {
  augmentedSpawnEnv,
  buildCliRuntimePrerequisites,
  findCliBinaryAsync,
} from '../auth/cli-auth.js';
import {
  effectiveModelMetadata,
  reportedModelMetadata,
} from '../llm/effective-model-metadata.js';
import {
  classifyProviderQuotaFailure,
  PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE,
  PROVIDER_PLAN_QUOTA_MESSAGE,
  providerQuotaEventDetails,
} from '../provider-plan-quota.js';
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
  mapAcpStopReasonToTurnCompletion,
} from './acp-adapter-events.js';
import {
  ACP_ENGINE_DECIDES_APPROVAL_MESSAGE,
  type AcpAppliedApprovalMode,
  acpAppliedApprovalMode,
  acpApprovalFloor,
  acpApprovalModeAllows,
  governedModeRefusal,
  isOpenCodeGovernedMode,
} from './acp-approval-mode.js';
import {
  type AcpToolServerSkip,
  type AcpToolServerSkipReason,
  resolveAcpPassthroughMcpServers,
} from './acp-mcp-passthrough.js';
import {
  type AdvertisedAcpModeCatalog,
  advertisedAcpSessionModes,
  applyAdvertisedAcpSessionMode,
  permittedAcpSessionMode,
  requestedAcpSessionMode,
} from './acp-session-mode.js';
import {
  ACP_INTERJECT_METHODS,
  ACP_SESSION_STEER_METHOD,
  acpInterjectParams,
  acpSessionSteerParams,
  isAcpMethodNotFound,
  resolveAcpSteerChannel,
} from './acp-steer.js';
import {
  AcpToolUpdateGlobalBudget,
  AcpToolUpdateSupervisor,
  engineToolKind,
} from './acp-tool-update-supervisor.js';
import { toPassthroughToolDef } from './agent-tool-server-mapping.js';
import {
  assertExecutionOverrideDelivery,
  mergeCapabilityDeliveryMetadata,
} from './capability-delivery-metadata.js';
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
interface AcpExecutionIdentity {
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

/**
 * The directory a connection starts a session in when the session has none
 * of its own: its configured `cwd`, tilde-expanded and resolved, else none
 * (the adapter then prepares a Station-managed workspace). The one
 * derivation, shared by the spawn below and by the dispatch scope check
 * that must decide on the same directory before it (#2873).
 */
export function acpConnectionDefaultCwd(config: {
  cwd?: string;
}): string | undefined {
  return config.cwd ? resolve(expandTilde(config.cwd)) : undefined;
}

/** How long a passed start preflight stands for the start that follows. */
export const START_PREFLIGHT_REUSE_MS = 60_000;

export interface AcpAdapterOptions {
  getConnections: () => Promise<ACPConnectionConfig[]>;
  /**
   * #3290: how long a new engine process may take to start and resume the
   * session when the approval floor changes. Defaults to the cold-start
   * bound an engine probe allows (`COLD_START_OPERATION_TIMEOUT_MS`).
   */
  approvalRelaunchTimeoutMs?: number;
  /** Injectable clock for the start preflight's reuse window (#3290). */
  now?: () => number;
  /**
   * #3290: reads OpenCode's resolved agent rules (`opencode debug agent`);
   * tests replace it. Defaults to running the connection's command.
   */
  readOpenCodeAgents?: (input: {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => OpenCodeAgentReader;
  /** Overrides {@link DEFAULT_SEND_TURN_START_WAIT_MS} (tests). */
  sendTurnStartWaitMs?: number;
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
  mintStationKnowledgeMcpAuth?: (
    threadId: string,
    tenantExecutionContext?: TenantExecutionContext,
  ) => { url: string; token: string } | undefined;
  /** Best-effort cleanup counterpart to `mintStationControlMcpAuth` — called
   * on ordinary session stop and on a failed start. Never required; a
   * missing closure just means the token lives out its bounded TTL. */
  revokeStationControlMcpAuth?: (
    threadId: string,
    serverId?: 'station-control' | 'station-knowledge',
  ) => void;
}

/** Last-known slash command surfaced by a live ACP session (aggregated across sessions in `getCommands()` — see Risks: no per-connection threadId param on the shared shape). */
interface AcpSlashCommand {
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
interface AcpPendingRequest {
  resolve: (decision: AcpDecision) => void;
  options: PermissionOption[];
  /**
   * Tool-level session-grant identity (`params.toolCall.name`), stored so
   * `respondToRequest` can remember an `acceptForSession` grant. Absent
   * when the agent named no tool (nothing is granted or remembered).
   */
  toolName?: string;
  /**
   * #2933: the request is addressed to a person (`toolRequestNeedsPerson`:
   * a plan exit, or a tool named as a harness question). A session answer to
   * it is a one-call accept and mints no session grant, so a later plan exit
   * is still reviewed.
   */
  needsPerson?: true;
}

export interface AcpSessionRecord {
  session: ProviderSession;
  process: ACPProcess;
  connectionId: string;
  command: string;
  args?: string[];
  /**
   * Bumps on each `session/prompt` this Station turn owns. A
   * cancel+reprompt steer increments it so the cancelled prompt's settlement
   * cannot complete or fail the still-open turn.
   */
  promptEpoch: number;
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
  /**
   * Tool-level session grants from `acceptForSession` (mirrors
   * claude-adapter/station-agent-adapter `approvedTools`). The grant is
   * checked Station-side because an agent that only offers `allow_once`
   * degrades the `allow_always` wire preference to a one-call allow.
   * Dies with the session.
   */
  approvedTools: Set<string>;
  preToolPolicy?: StagedPreToolPolicyEvaluator;
  delegation?: InvocationContext['delegation'];
  activeTurnId?: string;
  stopping?: boolean;
  /** At most one engine re-establishment is attempted for this session. */
  credentialRecoveryAttempted?: boolean;
  currentModeId?: string;
  /**
   * #3290: who decides which of this session's actions ask, from the
   * command it was launched with (`acpApprovalControl`).
   */
  approvalControl: AcpApprovalControl;
  /**
   * #3290: the approval mode a `station`-controlled session answers the
   * engine's permission requests with (`acp-approval-mode.ts`). Absent on an
   * `engine`-controlled session, which applies none.
   */
  approvalMode?: AcpAppliedApprovalMode;
  /**
   * #3290: the launch configuration the current engine process runs under;
   * absent when it runs on the engine's own configuration.
   */
  approvalFloor?: OpenCodeApprovalFloor;
  /** #3290: launches a replacement process for this session on a floor. */
  relaunch?: (floor: OpenCodeApprovalFloor | undefined) => ACPProcess;
  /** The MCP servers the session was established with, for a relaunch. */
  mcpServers?: McpServer[];
  /** Drops `session/update` while a relaunch replays history (`session/load`). */
  suppressSessionUpdates?: boolean;
  configOptions?: unknown[];
  /** Last advertised ACP session-mode catalog (station#1945). */
  acpModeCatalog?: AdvertisedAcpModeCatalog;
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
  /**
   * True while `session/resume` or `session/load` reattaches this record to
   * its native session. Replayed content is history Station already stored,
   * so it is not published; session-state updates (commands, mode, config,
   * usage) still apply. `sendTurn` waits for the start (`startSettled`).
   */
  reattaching?: boolean;
  /**
   * Settles (never rejects) when this record's `startSession` finishes,
   * successfully or not. The record is visible to `sendTurn` from before the
   * engine starts, so a send that arrives meanwhile waits on this instead of
   * racing the start. Absent once nothing is pending.
   */
  startSettled?: Promise<void>;
  /** Why this record's start failed, for a send that waited on it. */
  startFailure?: unknown;
  /** Sends waiting in `whenSessionReady`, woken when a Stop begins. */
  startWaiters?: Set<() => void>;
}

/**
 * How long a send waits for its session's engine start (for a restored ACP
 * session, the reattach) before refusing retryably. Short: the client keeps
 * the message queued and re-sends it.
 */
const DEFAULT_SEND_TURN_START_WAIT_MS = 15_000;

/** The first line of an error, bounded, for a user-facing refusal. */
function shortReason(error: unknown): string {
  const line = errorMessage(error).split('\n')[0]?.trim() || 'unknown error';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/**
 * How this engine can reattach to a stored session: `session/resume` (no
 * history replay) when advertised, else `session/load`. Omitted and `null`
 * both mean `resume` is not advertised.
 */
function acpReattachMethod(
  initResult: ACPProcess['initResult'],
): 'resume' | 'load' | undefined {
  const capabilities = initResult?.agentCapabilities;
  if (capabilities?.sessionCapabilities?.resume != null) return 'resume';
  if (capabilities?.loadSession === true) return 'load';
  return undefined;
}

/**
 * The `session/update` kinds an ACP `session/load` replays as history
 * (ACP: the agent streams the entire conversation back before it answers
 * the load request).
 */
const ACP_HISTORY_REPLAY_UPDATES: ReadonlySet<string> = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);

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
    // #2880: the protocol has no acknowledgement of a decision; delivery is
    // not reported.
    approvalAcknowledgement: 'none' as const,
    displayName: 'Custom engine',
    description:
      'Custom engine connections launched from a configured command (e.g. Kiro), driven through the canonical ACP adapter seam.',
    capabilities: [...ACP_ADAPTER_CAPABILITIES],
    // ACP's `loadSession` is negotiated per connected CLI. A global adapter
    // declaration would overstate arbitrary/older connections; the inspector
    // must project an observed connection-specific capability instead.
    durability: ACP_ENGINE_DURABILITY,
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

  private readonly approvalRelaunchTimeoutMs: number;
  private readonly now: () => number;
  /** #3290: governance checks `preflightStart` passed, by thread. */
  private readonly startPreflights = new Map<
    string,
    { command: string; cwd: string; floor: OpenCodeApprovalFloor; at: number }
  >();

  constructor(private readonly options: AcpAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.approvalRelaunchTimeoutMs =
      options.approvalRelaunchTimeoutMs ?? COLD_START_OPERATION_TIMEOUT_MS;
  }

  private async resolvePreToolPolicy(
    input: ProviderSessionStartInput,
  ): Promise<StagedPreToolPolicyEvaluator | undefined> {
    if (!input.agent || !this.options.resolvePreToolPolicy) return undefined;
    try {
      return await this.options.resolvePreToolPolicy(input);
    } catch (error) {
      const reason = `Station pre-tool policy could not be prepared; tool execution was denied: ${errorMessage(error)}`;
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

  /**
   * #3290: Station governs only build and plan, and only once OpenCode itself
   * resolves Station's rules for them. Otherwise the chat is not started
   * under a mode nothing would apply.
   */
  private async assertStartGovernable(
    input: ProviderSessionStartInput,
    command: string,
    cwd: string,
    floor: OpenCodeApprovalFloor,
  ): Promise<void> {
    const startMode = requestedAcpSessionMode(input.modelOptions);
    if (startMode && !isOpenCodeGovernedMode(startMode)) {
      throw new ApprovalGovernanceRefusedError(governedModeRefusal(startMode));
    }
    const verified = await this.verifyApprovalFloor(command, cwd, floor);
    if (!verified.ok) {
      throw new ApprovalGovernanceRefusedError(
        `Station can't apply its approval mode to OpenCode, so the chat was not started: ${verified.reason}.`,
      );
    }
  }

  /**
   * #3290: the governance check of a start, run by the orchestrator before
   * it claims the start boundary, so a refusal is definitive. The result is
   * kept briefly for the start that follows.
   */
  async preflightStart(input: ProviderSessionStartInput): Promise<void> {
    // The same connection the start resolves, a resumed one included.
    const connectionId =
      typeof input.metadata?.connectionId === 'string'
        ? input.metadata.connectionId
        : isAcpResumeCursor(input.resumeCursor)
          ? input.resumeCursor.connectionId
          : undefined;
    const config = (await this.options.getConnections()).find(
      (candidate) => candidate.id === connectionId,
    );
    if (!config || acpApprovalControl(config.command) !== 'station') return;
    const floor = acpApprovalFloor(
      acpAppliedApprovalMode(
        readApprovalMode(input.modelOptions),
        input.confinement,
      ),
    );
    if (!floor) return;
    const cwd =
      input.cwd ||
      acpConnectionDefaultCwd(config) ||
      (await prepareManagedAcpWorkspace(
        { kind: 'session', connectionId: config.id, threadId: input.threadId },
        this.options.managedWorkspaceHomeDir,
      ));
    await this.assertStartGovernable(input, config.command, cwd, floor);
    this.startPreflights.set(input.threadId, {
      command: config.command,
      cwd,
      floor,
      at: this.now(),
    });
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
    // #3290: an engine that decides which of its actions ask is not started
    // with an approval mode it would never apply. The server sends a mode
    // only to a `station` connection, so this refuses a caller-carried one.
    const approvalControl = acpApprovalControl(config.command);
    const requestedApprovalMode = readApprovalMode(input.modelOptions);
    if (approvalControl === 'engine' && requestedApprovalMode) {
      throw new Error(ACP_ENGINE_DECIDES_APPROVAL_MESSAGE);
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
    const connectionCwd = acpConnectionDefaultCwd(config);
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

    // #3290: nothing requested leaves OpenCode on its own configuration; a
    // mode puts it on Station's floor for that mode.
    const startApprovalMode =
      approvalControl === 'station'
        ? acpAppliedApprovalMode(requestedApprovalMode, input.confinement)
        : undefined;
    const startApprovalFloor = acpApprovalFloor(startApprovalMode);
    if (startApprovalFloor) {
      const preflight = this.startPreflights.get(input.threadId);
      this.startPreflights.delete(input.threadId);
      // A preflight this start already passed (moments ago, same command,
      // directory and floor) is not repeated; anything else is checked here.
      if (
        !preflight ||
        preflight.command !== config.command ||
        preflight.cwd !== cwd ||
        preflight.floor !== startApprovalFloor ||
        this.now() - preflight.at > START_PREFLIGHT_REUSE_MS
      ) {
        await this.assertStartGovernable(
          input,
          config.command,
          cwd,
          startApprovalFloor,
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
      command: config.command,
      args: config.args,
      promptEpoch: 0,
      generation: options?.generation ?? this.sessionGeneration(input.threadId),
      approvalControl,
      ...(startApprovalMode ? { approvalMode: startApprovalMode } : {}),
      ...(startApprovalFloor ? { approvalFloor: startApprovalFloor } : {}),
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
        // #3290: the start's confinement bounds the approval mode a
        // re-established session comes back in.
        ...(input.confinement ? { confinement: input.confinement } : {}),
      },
      pendingRequests: new Map(),
      approvedTools: new Set(),
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
    // #3290: a governed OpenCode is launched on Station's floor for its mode,
    // merged into whatever inline configuration it already had; the same
    // launch is reused to move the session onto another floor.
    const launch = (floor: OpenCodeApprovalFloor | undefined) =>
      processFactory({
        command: config.command,
        args: config.args,
        cwd,
        ...(floor
          ? {
              spawnEnv: (env: NodeJS.ProcessEnv) =>
                withStationOpenCodeApprovalConfig(env, floor),
            }
          : {}),
        createClient: () =>
          this.buildClient(record, {
            cwd,
            terminals,
            nextTerminalId: () => `acp-term-${++terminalCounter}`,
            logger,
          }),
        logger,
      });
    const acpProcess = launch(startApprovalFloor);
    record.process = acpProcess;
    record.relaunch = launch;
    let settleStart!: () => void;
    record.startSettled = new Promise<void>((resolve) => {
      settleStart = resolve;
    });
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
          ? [
              ...new Set([
                ...(input.agent?.toolServerMode === 'add'
                  ? (config.provideToolServers ?? [])
                  : []),
                ...agentToolServers.map((server) => server.id),
              ]),
            ]
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
      let stationKnowledgeAuth =
        requestedToolServerIds?.includes('station-knowledge') &&
        mcpHttp === true
          ? this.options.mintStationKnowledgeMcpAuth?.(
              input.threadId,
              input.tenantExecutionContext,
            )
          : undefined;
      const stationKnowledgeUnavailable = {
        reason:
          acpProcess.initResult == null || mcpHttp !== true
            ? ('engine-capability-absent' as const)
            : ('delivery-failed' as const),
        detail:
          acpProcess.initResult == null
            ? 'no runtime MCP capability observation is available'
            : mcpHttp !== true
              ? 'the engine did not advertise HTTP MCP support'
              : 'Knowledge session auth could not be minted',
      };
      const capabilityUndelivered: CapabilityUndelivered[] = [];
      try {
        const resolved = await resolveAcpPassthroughMcpServers({
          toolServerIds: requestedToolServerIds,
          ...(stationControlAuth ? { stationControlAuth } : {}),
          ...(stationKnowledgeAuth ? { stationKnowledgeAuth } : {}),
          stationKnowledgeUnavailable,
          ...(stationControlUnavailable ? { stationControlUnavailable } : {}),
          resolveToolServer:
            agentToolServers !== undefined
              ? async (id) => {
                  const match = agentToolServers.find(
                    (server) => server.id === id,
                  );
                  return match
                    ? toPassthroughToolDef(match)
                    : input.agent?.toolServerMode === 'add'
                      ? (this.options.resolveToolServer?.(id) ?? null)
                      : null;
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
          this.options.revokeStationControlMcpAuth?.(
            input.threadId,
            'station-control',
          );
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
        if (stationKnowledgeAuth && !resolved.stationKnowledgeDelivered) {
          this.options.revokeStationControlMcpAuth?.(
            input.threadId,
            'station-knowledge',
          );
          stationKnowledgeAuth = undefined;
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
        if (stationKnowledgeAuth)
          this.options.revokeStationControlMcpAuth?.(
            input.threadId,
            'station-knowledge',
          );
        logger.warn?.(
          `ACP connection '${config.id}': MCP passthrough resolution failed unexpectedly; continuing without passthrough tool servers.`,
          error,
        );
        capabilityUndelivered.push({
          capability: 'toolServers',
          reason: 'delivery-failed',
          detail: errorMessage(error),
        });
      }
      assertExecutionOverrideDelivery(input.metadata, capabilityUndelivered);
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
      record.mcpServers = passthroughMcpServers;
      if (isAcpResumeCursor(input.resumeCursor)) {
        const reattach = acpReattachMethod(acpProcess.initResult);
        if (!reattach) {
          acpResumeSessions.add(1, {
            connectionId: config.id,
            outcome: 'load-unsupported',
          });
          throw new Error(
            "This engine's CLI does not advertise session loading (ACP session/resume or loadSession); the previous conversation cannot be resumed.",
          );
        }
        const acpSessionId = input.resumeCursor.acpSessionId;
        // A turn sent while the engine reattaches would race the history
        // suppression below, so `sendTurn` waits for the start to finish.
        // `session/load` makes the engine replay the whole conversation as
        // `session/update` notifications before it answers; `session/resume`
        // does not. Station already holds that history, so a replay is not
        // published: persisting it stored a second, turn-less copy of every
        // earlier answer.
        record.reattaching = true;
        try {
          let outcome: 'resumed' | 'loaded';
          if (reattach === 'resume') {
            try {
              await acpProcess.resumeSession(
                acpSessionId,
                cwd,
                passthroughMcpServers,
              );
              outcome = 'resumed';
            } catch (error) {
              // An engine that advertises `sessionCapabilities.resume` but
              // answers "method not found" is loaded instead. Any other
              // failure is real and propagates (fail closed: loading after
              // an unexplained resume failure could mask it).
              if (
                !isAcpMethodNotFound(error) ||
                acpProcess.initResult?.agentCapabilities?.loadSession !== true
              ) {
                throw error;
              }
              await acpProcess.loadSession(
                acpSessionId,
                cwd,
                passthroughMcpServers,
              );
              outcome = 'loaded';
            }
          } else {
            await acpProcess.loadSession(
              acpSessionId,
              cwd,
              passthroughMcpServers,
            );
            outcome = 'loaded';
          }
          // The SDK dispatches each notification without awaiting it before
          // reading the next message, so the last replayed updates can still
          // be in flight (as microtasks) when the response resolves. Yield a
          // macrotask so they land while the replay is still suppressed.
          await new Promise<void>((resolve) => setImmediate(resolve));
          acpResumeSessions.add(1, { connectionId: config.id, outcome });
        } finally {
          record.reattaching = false;
        }
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
        record.configOptions = sessionResult.configOptions;
        const modeCatalog = advertisedAcpSessionModes({
          configOptions: sessionResult.configOptions,
          modes: sessionResult.modes,
        });
        record.acpModeCatalog = modeCatalog;
        if (modeCatalog.modes.length > 0) {
          record.currentModeId = modeCatalog.currentModeId;
        }
        // #2569: a full-access mode is the ACP form of approval `never`.
        // Outside a `host` session it is not applied, and the session keeps
        // (and reports, as `acpSessionMode`) the connection's own current
        // mode. `mode` is not an effective-model-option key, so nothing
        // reports the withheld request as applied.
        //
        // Only a fresh `session/new` applies a start mode: a credential
        // re-establishment always resumes with `session/load`. (Its
        // `recoveryStart` copy carries the start's confinement for the
        // approval mode only, #3290.)
        const requestedMode =
          permittedAcpSessionMode(
            modeCatalog,
            requestedAcpSessionMode(input.modelOptions),
            input.confinement,
          ) ??
          // #3290: a governed session runs build unless it asked for plan;
          // `default_agent` is pinned, but a managed configuration outranks
          // that, and its agent would keep its own rules.
          (startApprovalFloor &&
          modeCatalog.currentModeId &&
          !isOpenCodeGovernedMode(modeCatalog.currentModeId)
            ? 'build'
            : undefined);
        if (requestedMode) {
          if (modeCatalog.modes.length === 0) {
            throw new Error(
              `ACP mode option unavailable: connection '${config.id}' did not advertise a session mode for this session.`,
            );
          }
          const appliedMode = await applyAdvertisedAcpSessionMode(
            acpProcess,
            modeCatalog,
            requestedMode,
            config.id,
          );
          record.currentModeId = appliedMode.currentModeId;
          record.acpModeCatalog = {
            ...modeCatalog,
            currentModeId: appliedMode.currentModeId,
          };
          if (appliedMode.configOptions) {
            record.configOptions = appliedMode.configOptions;
          }
        }
        reportedModel = extractReportedModelFromConfigOptions(
          sessionResult.configOptions,
        );
        const requestedModel = input.modelId?.trim();
        if (requestedModel) {
          const modelOption = findAcpModelConfigOption(
            sessionResult.configOptions,
          );
          if (!modelOption) {
            throw new SessionStartRefusedError(
              `ACP model option unavailable: connection '${config.id}' did not advertise a model configuration option for this session.`,
              MODEL_NOT_ADVERTISED_CODE,
            );
          }
          if (
            !modelOption.options.some(
              (option) => option.value === requestedModel,
            )
          ) {
            throw new SessionStartRefusedError(
              `ACP model value unsupported: connection '${config.id}' did not advertise '${requestedModel}' for this session.`,
              MODEL_NOT_ADVERTISED_CODE,
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
              ...(record.currentModeId
                ? { acpSessionMode: record.currentModeId }
                : {}),
              ...(record.acpModeCatalog?.modes.length
                ? { acpSessionModes: record.acpModeCatalog.modes }
                : {}),
              // #3290: the mode this session answers permission requests
              // with, so the approval control shows what applies.
              ...(record.approvalMode
                ? { approvalMode: record.approvalMode }
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
      record.startFailure = error;
      // A Stop that landed while `session/new` was in flight ends the start
      // as a stop whatever the engine then said: the user asked for it, so a
      // refusal arriving afterwards is not reported as the model's.
      const superseded =
        error instanceof SessionStartRefusedError &&
        !this.isCurrentGeneration(input.threadId, record.generation);
      const cancelled =
        error instanceof AcpSessionStartCancelledError || superseded;
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
        // `session.started` went out before `session/new` answered, so the
        // service has bound this thread to this adapter. A refused start ends
        // that session: say why, then end it, or the thread stays bound and
        // the very retry the refusal invites fails with "Session already
        // exists". `exitCode` is deliberately absent (no process observation):
        // the cause is the `runtime.error`, which is what folds the lifecycle
        // to `failed` with the engine's own words.
        if (
          error instanceof SessionStartRefusedError &&
          !superseded &&
          record.startedPublished
        ) {
          this.publish({
            eventId: crypto.randomUUID(),
            provider: this.provider,
            threadId: input.threadId,
            createdAt: new Date().toISOString(),
            method: 'runtime.error',
            ...providerFailure(error.kind, error.failurePhase),
            severity: 'error',
            code: error.code,
            message: error.message,
          } satisfies ProviderRuntimeErrorEvent);
          this.publish({
            eventId: crypto.randomUUID(),
            provider: this.provider,
            threadId: input.threadId,
            createdAt: new Date().toISOString(),
            method: 'session.exited',
            sessionId: input.threadId,
            reason: 'start-refused',
          });
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'ACP session startup failed and process cleanup was not confirmed.',
        );
      }
      throw error;
    } finally {
      record.startSettled = undefined;
      settleStart();
    }
  }

  /**
   * A send that arrives while its session is still starting (the record is
   * registered before the engine answers, and a restored ACP session spends
   * that time reattaching) waits for the start rather than racing it: updates
   * during a reattach are treated as replayed history and dropped, so a turn
   * opened then would lose its own output. Orchestration awaits this before
   * taking the thread's turn-start claim, so Stop/End/park never queue
   * behind it. Nothing reaches the engine here.
   */
  async whenSessionReady(
    threadId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const record = this.sessions.get(threadId);
    const pending = record?.startSettled;
    if (!record || !pending) return;
    const waitMs =
      this.options.sendTurnStartWaitMs ?? DEFAULT_SEND_TURN_START_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const outcome = await raceWithSignal(
      Promise.race([
        pending.then(() => 'settled' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), waitMs);
        }),
        // A Stop does not wait for the start to unwind before this send
        // learns it will never run.
        new Promise<'stopping'>((resolve) => {
          wake = () => resolve('stopping');
          record.startWaiters ??= new Set();
          record.startWaiters.add(wake);
        }),
      ]),
      options.signal,
    ).finally(() => {
      clearTimeout(timer);
      if (wake) record.startWaiters?.delete(wake);
    });
    // Still starting: retryable, so the client keeps the message queued.
    if (outcome === 'timeout') throw new ProviderSessionStartingError();
    // A Stop ended the start: the user's decision, so definitive.
    if (
      outcome === 'stopping' ||
      record.stopping ||
      record.startFailure instanceof AcpSessionStartCancelledError
    ) {
      throw new SendTurnRefusedError(
        "The agent's session ended before it was ready. Nothing was sent.",
        'session_gone',
      );
    }
    if (record.startFailure !== undefined) {
      // The engine's own words stay in the log; the refusal is user-facing.
      this.options.logger?.warn?.(
        {
          threadId,
          connectionId: record.connectionId,
          err: record.startFailure,
        },
        'ACP send refused: the session it waited for failed to start',
      );
      throw new ProviderSessionStartFailedError(
        shortReason(record.startFailure),
      );
    }
    if (this.sessions.get(threadId) !== record) {
      throw new SendTurnRefusedError(
        "The agent's session ended before it was ready. Nothing was sent.",
        'session_gone',
      );
    }
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const record = this.requireSession(input.threadId);
    // Orchestration waits in `whenSessionReady` before claiming the turn; a
    // caller that did not (or a start that began since) is refused
    // retryably rather than racing the start.
    if (record.startSettled) throw new ProviderSessionStartingError();
    // #2415: a send that races the session's active turn is refused here,
    // before any provider-visible effect, so it must be a
    // `SendTurnRefusedError`. A plain error is recorded by orchestration as
    // an INDETERMINATE turn start, and that lingering boundary row reads as
    // an in-flight turn that blocks every later send on the thread — for a
    // send that provably never started. The turn-start coordinator does not
    // refuse this case first: it serializes turn STARTS, and an accepted
    // turn that is still running does not block its claim.
    if (record.activeTurnId) {
      throw new SendTurnRefusedError(
        `ACP session '${input.threadId}' already has an active turn.`,
        'busy',
      );
    }
    const turnId = crypto.randomUUID();
    // Every throw below runs before the first provider-visible effect (no
    // prompt sent, no `turn.started` published), so each is a
    // `SendTurnRefusedError`: orchestration surfaces the message honestly
    // instead of reporting the turn as possibly started.
    let decodedAttachments: ReturnType<typeof decodeChatAttachments>;
    try {
      decodedAttachments = decodeChatAttachments(input.attachments);
    } catch (error) {
      throw new SendTurnRefusedError(errorMessage(error), 'input_unsupported');
    }
    // Both attachment refusals carry a structured code: the same send is
    // refused again on retry, so the client must not present it as a
    // transient failure.
    try {
      rejectFileAttachments('This engine', decodedAttachments);
    } catch (error) {
      throw new AttachmentInputUnsupportedError(errorMessage(error));
    }
    if (
      decodedAttachments.length > 0 &&
      record.process.initResult?.agentCapabilities?.promptCapabilities
        ?.image !== true
    ) {
      throw new AttachmentInputUnsupportedError(
        'This engine did not advertise image attachment support.',
      );
    }
    // #3290: the server sends the conversation's posture on a turn that
    // changes it; from here on the session answers requests with it.
    const turnApprovalMode = readApprovalMode(input.modelOptions);
    let approvalTakeoverFailed = false;
    if (turnApprovalMode) {
      if (record.approvalControl !== 'station') {
        throw new SendTurnRefusedError(
          ACP_ENGINE_DECIDES_APPROVAL_MESSAGE,
          'input_unsupported',
        );
      }
      const applied = acpAppliedApprovalMode(
        turnApprovalMode,
        input.confinement,
      );
      // Station takes over from the engine's own configuration, or moves
      // between floors: relaunch on the floor and resume the same session.
      const floor = acpApprovalFloor(applied);
      const switched: { ok: true } | { ok: false; reason: string } =
        floor === record.approvalFloor
          ? { ok: true }
          : await this.relaunchOnApprovalFloor(record, floor);
      if (switched.ok) {
        record.approvalMode = applied;
        // A credential re-establishment restarts from `recoveryStart`; it
        // must come back in the mode the session runs now.
        record.recoveryStart = {
          ...record.recoveryStart,
          modelOptions: {
            ...record.recoveryStart.modelOptions,
            approvalMode: turnApprovalMode,
          },
        };
      } else {
        // The session keeps the process, floor and mode it had. Say so,
        // and report nothing as applied that is not.
        const running = record.approvalFloor;
        const message = running
          ? running === 'full'
            ? "Couldn't switch OpenCode to Station's approval rules; it is still running with full access"
            : "Couldn't switch OpenCode to Station's full-access rules; it's still asking first as before"
          : "Couldn't switch OpenCode to Station's approval rules; it's still using its own settings";
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          method: 'runtime.warning',
          severity: 'warning',
          code: ACP_APPROVAL_TAKEOVER_FAILED_CODE,
          message: `${message}: ${switched.reason}.`,
          details: {
            requestedApprovalMode: applied,
            reason: switched.reason,
            ...(record.approvalMode
              ? { appliedApprovalMode: record.approvalMode }
              : {}),
          },
        });
        // A turn may run only under rules at least as strict as the pick.
        // OpenCode's own settings are not known to be (its defaults allow
        // shell commands and edits), and full access is looser than any
        // other mode, so only a failed move from Ask or Auto to full access
        // still runs, at the stricter mode it already had.
        if (running !== 'confined') {
          throw new ApprovalGovernanceRefusedError(
            `${message}, so this message was not sent: ${switched.reason}.`,
          );
        }
        approvalTakeoverFailed = true;
      }
    }
    const turnCatalog = record.acpModeCatalog ?? { modes: [] };
    // #2569: see startSession.
    const requestedMode = permittedAcpSessionMode(
      turnCatalog,
      requestedAcpSessionMode(input.modelOptions),
      input.confinement,
    );
    if (
      requestedMode &&
      record.approvalFloor &&
      !isOpenCodeGovernedMode(requestedMode)
    ) {
      throw new ApprovalGovernanceRefusedError(
        governedModeRefusal(requestedMode),
      );
    }
    if (requestedMode && requestedMode !== record.currentModeId) {
      const catalog = turnCatalog;
      if (catalog.modes.length === 0) {
        throw new Error(
          `ACP mode option unavailable: this session did not advertise a session mode.`,
        );
      }
      const appliedMode = await applyAdvertisedAcpSessionMode(
        record.process,
        { ...catalog, currentModeId: record.currentModeId },
        requestedMode,
        record.connectionId,
      );
      record.currentModeId = appliedMode.currentModeId;
      record.acpModeCatalog = {
        ...catalog,
        currentModeId: appliedMode.currentModeId,
      };
      if (appliedMode.configOptions) {
        record.configOptions = appliedMode.configOptions;
      }
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
      // Independent review HIGH-1 fix-adjacent: muse-adapter.ts and
      // codex-adapter.ts already persist this (the uncomposed ambient text
      // TurnStartedEvent.ambientContext's doc comment names); this adapter
      // silently omitted it, so a crash-recovery replay of an ACP turn
      // (session-recovery-coordinator.ts's `buildReplayInput`, sourced from
      // this very event) had no ambient context to recompose at all —
      // including a pending first-turn instructions receipt riding it.
      ...(input.ambientContext ? { ambientContext: input.ambientContext } : {}),
      metadata: {
        ...effectiveModelMetadata(
          input.modelId ?? record.session.model,
          input.modelOptions,
        ),
        // Independent review MEDIUM-1: carries the server-owned
        // `firstTurnInstructionsComposed` marker onto THIS turn's own
        // persisted record — see the constant's doc comment in
        // provider.ts — so the delegate-seam disclosure can derive
        // 'delivered' from this turn having actually composed it, not
        // merely from having started.
        ...(input.metadata?.[FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]
          ? { [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: true }
          : {}),
        // #3290: the mode this turn's permission requests are answered with,
        // and whether the mode the turn asked for could not be switched to.
        ...(record.approvalMode ? { approvalMode: record.approvalMode } : {}),
        ...(approvalTakeoverFailed ? { approvalTakeoverFailed: true } : {}),
      },
    });

    const content: ContentBlock[] = [
      ...(input.input ? [{ type: 'text' as const, text: input.input }] : []),
      ...decodedAttachments.map(({ attachment, base64 }) => ({
        type: 'image' as const,
        data: base64,
        mimeType: attachment.mimeType,
      })),
    ];
    record.promptEpoch += 1;
    this.bindPromptSettlement(
      record,
      input.threadId,
      turnId,
      record.promptEpoch,
      record.process.prompt(content),
    );

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
    this.cancelPendingRequests(record, threadId);
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

  async steerTurn(
    threadId: string,
    input: string,
    turnId: string,
  ): Promise<void> {
    const record = this.requireSession(threadId);
    if (record.activeTurnId !== turnId) {
      throw new ProviderTurnEndedError();
    }
    const text = input.trim();
    if (!text) {
      throw new Error('Steer input is empty.');
    }
    const native = await this.tryNativeAcpSteer(record, text);
    if (!native) {
      await this.steerByCancelReprompt(record, threadId, turnId, text);
    }
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      turnId,
      method: 'turn.started',
      prompt: text,
      inputKind: 'steer',
      ...(native ? {} : { steerInterruptedRun: true as const }),
    });
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
    // #2933: a plan exit is answered for this call only: no session grant is
    // minted, and the agent is sent its allow-once option, not allow-always.
    const effective =
      decision === 'acceptForSession' && pending.needsPerson
        ? 'accept'
        : decision;
    if (effective === 'acceptForSession' && pending.toolName) {
      record.approvedTools.add(pending.toolName);
    }
    pending.resolve(effective);

    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      requestId,
      method: 'request.resolved',
      status: mapAcpDecisionToApprovalStatus(decision),
      acknowledgement: this.metadata.approvalAcknowledgement,
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

  /**
   * #2316: a cancelled prompt's open permission requests can never run their
   * call (ACP answers an outstanding `session/request_permission` with
   * `cancelled` after `session/cancel`). Settle them, so no later answer lands
   * on a dead request and no session grant is minted for it.
   */
  private cancelPendingRequests(
    record: AcpSessionRecord,
    threadId: string,
  ): void {
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

  /**
   * An ACP permission request belongs to the prompt that raised it: once
   * `session/prompt` settles, the engine has stopped waiting and will never
   * read the answer. Left open, it stayed open everywhere that folds
   * `request.opened`/`request.resolved` — the approval inbox and its header
   * count, the approval toast queue, the chat's pending-approval banner —
   * while the transcript had already retired the card at `turn.completed`
   * (`approvalRetiredBy`). Settling it here as `cancelled` is the same
   * terminal the interrupt path publishes, and it is what every one of those
   * consumers already clears on.
   */
  private settleRequestsAtPromptEnd(
    record: AcpSessionRecord,
    threadId: string,
  ): void {
    if (record.pendingRequests.size === 0) return;
    this.cancelPendingRequests(record, threadId);
  }

  private prepareRecordForStop(record: AcpSessionRecord): void {
    const threadId = record.session.threadId;
    record.toolUpdateSupervisor.dispose();
    for (const wake of record.startWaiters ?? []) wake();
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
      // #2933: a tool-level grant (`tools.autoApprove`, matched by name)
      // covers plain calls to the tool, never a plan exit. ACP marks a mode
      // switch such as leaving plan mode with the `switch_mode` tool kind;
      // it reports no other escalation signal on a permission request.
      // The shared predicate also covers a tool the agent names
      // `AskUserQuestion` (#3021) or `SandboxNetworkAccess` (#2932). Station
      // has no ACP question card, but a question is still a person's to
      // answer, and a network-host ask is asked per host. Either prompts as
      // an ordinary approval rather than being accepted by a pattern or a
      // session grant.
      const needsPerson = toolRequestNeedsPerson(
        toolName,
        params.toolCall?.kind,
      );
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
        // #2947: no Station allow answers a request addressed to a person.
        // That holds for the approval guardian's allow as for a tool-level
        // grant: the guardian reviews a tool call, not the plan a plan exit
        // asks a person to review.
        if (decision.behavior === 'allow' && !needsPerson) {
          return {
            outcome: mapAcpDecisionToOutcome('accept', params.options),
          };
        }
        if (decision.behavior === 'allow' && !decision.toolGrant) {
          // The evaluator has already logged the guardian's allow; say here
          // that it did not decide the request. The guardian is still asked
          // about such a request: its enforce-mode deny must decline it.
          context.logger.info?.(
            'Approval guardian allow not applied; the request goes to a person',
            {
              toolName,
              threadId: record.session.threadId,
              reason: 'the request is a plan exit or a question for a person',
            },
          );
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
        !needsPerson &&
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

      // #3290: the chat's approval mode answers what it allows (Auto: a file
      // edit; full access: everything), after authored policy above had its
      // say and never for a request addressed to a person. An engine that
      // offers no allow option falls through to the prompt.
      if (
        !needsPerson &&
        acpApprovalModeAllows(record.approvalMode, params.toolCall?.kind)
      ) {
        const allowed = mapAcpDecisionToOutcome('accept', params.options);
        if (allowed.outcome !== 'cancelled') return { outcome: allowed };
      }

      // Tool-level session grant: "Allow for this session" covers every later
      // call of the tool, not just this call. Checked after authored policy
      // (preToolPolicy/autoApprove above stay first) and before publishing,
      // so granted tools never re-prompt. Denies are never cached. When the
      // agent offers no allow option at all, the auto-acceptance would be
      // `cancelled` — fall through to the prompt rather than auto-cancel.
      // #2933: never for a plan exit, which a session grant cannot answer.
      if (toolName && !needsPerson && record.approvedTools.has(toolName)) {
        const grantedOutcome = mapAcpDecisionToOutcome(
          'accept',
          params.options,
        );
        if (grantedOutcome.outcome !== 'cancelled') {
          return { outcome: grantedOutcome };
        }
      }

      // #2933: a delegated child that may not grant approvals reaches here
      // when a tool-level grant or the approval guardian's allow (#2947) let
      // a plan exit past the staged evaluator's
      // own denial, when no evaluator ran, or when the agent named no tool
      // (a nameless request skips the evaluator). Nobody can answer the
      // child's request, so decline it fail-fast rather than wait.
      if (record.delegation?.denyApprovals) {
        // Called for its toolDenials metric only: an ACP permission outcome
        // has no reason channel, so the denial text reaches nobody.
        delegatedApprovalDenial(
          toolName ?? params.toolCall?.title ?? 'tool call',
          'external',
        );
        return {
          outcome: mapAcpDecisionToOutcome('decline', params.options),
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
          // The programmatic name, when the engine reports one: it is what
          // `respondToRequest` records a session grant under, so the grant
          // button must be able to name it.
          ...(toolName ? { toolName } : {}),
          rawInput: params.toolCall?.rawInput,
          // The engine's ACP kind, so a card with no bound transcript row
          // still says whether it gates a command, an edit or a read.
          // #2933: surfaces also compute the session grant they offer from
          // it; a `switch_mode` kind offers none. Only a kind in the ACP
          // vocabulary is published: an unknown one is dropped, not coerced.
          ...(engineToolKind(params.toolCall?.kind)
            ? { toolKind: engineToolKind(params.toolCall?.kind) }
            : {}),
          options: params.options,
        },
      });

      const decision = await new Promise<AcpDecision>((resolve) => {
        record.pendingRequests.set(requestId, {
          resolve,
          options: params.options,
          ...(toolName ? { toolName } : {}),
          ...(needsPerson ? { needsPerson: true as const } : {}),
        });
      });

      return { outcome: mapAcpDecisionToOutcome(decision, params.options) };
    };

    return client;
  }

  /**
   * #3290: move a live session onto another launch configuration. OpenCode
   * reads its permission rules only at launch, so Station starts a second
   * engine process on the new floor and resumes the same ACP session in it:
   * `session/resume` when advertised (no history replay), else
   * `session/load` with its replay dropped. Only once that has succeeded does
   * the new process replace the old one, which is then stopped. Two
   * `opencode acp` processes can hold one session at once (checked against
   * OpenCode 1.18.18: the second resumed while the first still answered a
   * turn), so the old one keeps running until the swap.
   *
   * Returns `false`, and leaves the session exactly as it was (the old
   * process, its floor and its mode), when the switch fails: the engine
   * cannot resume a session, it refuses or fails the resume, or start plus
   * resume outlasts `approvalRelaunchTimeoutMs` (the cold-start bound an
   * engine probe already allows). The new process is discarded. The session's
   * Mode and model are re-applied after the swap if the resumed session
   * reports others. Runs between turns only (`sendTurn` refuses a send while
   * one is active).
   */
  private async relaunchOnApprovalFloor(
    record: AcpSessionRecord,
    floor: OpenCodeApprovalFloor | undefined,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cursor = record.session.resumeCursor;
    const capabilities = record.process.initResult?.agentCapabilities as
      | { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } }
      | undefined;
    const canResume = !!capabilities?.sessionCapabilities?.resume;
    const logger = this.options.logger ?? console;
    if (
      !record.relaunch ||
      !isAcpResumeCursor(cursor) ||
      (!canResume && capabilities?.loadSession !== true)
    ) {
      logger.warn?.(
        {
          threadId: record.session.threadId,
          connectionId: record.connectionId,
        },
        'ACP approval floor not switched: the engine cannot resume this session in a new process',
      );
      return {
        ok: false,
        reason: 'the engine cannot resume this session in a new process',
      };
    }
    // Station governs only build and plan: a user's own primary agent keeps
    // its own rules, so Station does not take over while one is in use.
    if (
      floor &&
      record.currentModeId &&
      !isOpenCodeGovernedMode(record.currentModeId)
    ) {
      return { ok: false, reason: governedModeRefusal(record.currentModeId) };
    }
    if (floor) {
      const verified = await this.verifyApprovalFloor(
        record.command,
        record.session.cwd ?? '',
        floor,
      );
      if (!verified.ok) return verified;
    }
    const cwd = record.session.cwd ?? '';
    const previous = record.process;
    const next = record.relaunch(floor);
    let configOptions: unknown[] | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const establish = (async () => {
        await next.start();
        if (canResume) {
          const resumed = await next.resumeSession(
            cursor.acpSessionId,
            cwd,
            record.mcpServers ?? [],
          );
          configOptions = resumed.configOptions ?? undefined;
          return;
        }
        record.suppressSessionUpdates = true;
        try {
          await next.loadSession(
            cursor.acpSessionId,
            cwd,
            record.mcpServers ?? [],
          );
        } finally {
          record.suppressSessionUpdates = false;
        }
      })();
      establish.catch(() => undefined);
      await Promise.race([
        establish,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `the new engine process did not resume the session within ${this.approvalRelaunchTimeoutMs}ms`,
                ),
              ),
            this.approvalRelaunchTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      logger.warn?.(
        {
          threadId: record.session.threadId,
          connectionId: record.connectionId,
        },
        'ACP approval floor not switched; the session keeps its current engine process',
        error,
      );
      await next.destroy().catch((destroyError: unknown) => {
        logger.warn?.(
          { threadId: record.session.threadId },
          'ACP approval relaunch: the discarded engine process did not stop cleanly',
          destroyError,
        );
      });
      return {
        ok: false,
        reason: `the new engine process did not resume the session (${errorMessage(error)})`,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }

    record.process = next;
    record.approvalFloor = floor;
    await previous.destroy().catch((error: unknown) => {
      logger.warn?.(
        { threadId: record.session.threadId },
        'ACP approval relaunch: the replaced engine process did not stop cleanly',
        error,
      );
    });
    if (configOptions) {
      record.configOptions = configOptions;
      try {
        // A resumed session reports the agent it last ran; while Station
        // governs, it runs build unless the chat chose plan.
        if (floor && !record.currentModeId) record.currentModeId = 'build';
        const catalog = advertisedAcpSessionModes({ configOptions });
        if (
          record.currentModeId &&
          catalog.currentModeId !== record.currentModeId &&
          catalog.modes.some((mode) => mode.id === record.currentModeId)
        ) {
          const applied = await applyAdvertisedAcpSessionMode(
            next,
            catalog,
            record.currentModeId,
            record.connectionId,
          );
          if (applied.configOptions)
            record.configOptions = applied.configOptions;
        }
        const requestedModel = record.recoveryStart.modelId?.trim();
        const modelOption = findAcpModelConfigOption(record.configOptions);
        if (
          requestedModel &&
          modelOption &&
          modelOption.currentValue !== requestedModel &&
          modelOption.options.some((option) => option.value === requestedModel)
        ) {
          const response = await next.setConfigOption(
            modelOption.id,
            requestedModel,
          );
          const options = (response as { configOptions?: unknown[] } | null)
            ?.configOptions;
          if (options) record.configOptions = options;
        }
      } catch (error) {
        // The rules already apply; a session that came back in another
        // Mode or model is refused rather than run unnoticed.
        throw new SendTurnRefusedError(
          `The engine restarted with Station's approval rules but did not keep this chat's mode or model: ${errorMessage(error)}`,
          'provider_error',
        );
      }
    }
    return { ok: true };
  }

  /**
   * #3290: whether `floor`'s rules are what OpenCode resolves for this
   * command in `cwd`, read from the engine itself before Station claims to
   * govern (`opencode-approval-verify.ts`).
   */
  private async verifyApprovalFloor(
    command: string,
    cwd: string,
    floor: OpenCodeApprovalFloor,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    let env: NodeJS.ProcessEnv;
    try {
      env = withStationOpenCodeApprovalConfig(await augmentedSpawnEnv(), floor);
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
    const resolved = await findCliBinaryAsync(command);
    if (!resolved) {
      return { ok: false, reason: `${command} could not be found` };
    }
    const reader = (this.options.readOpenCodeAgents ?? openCodeAgentReader)({
      command: resolved,
      cwd,
      env,
    });
    return verifyOpenCodeApprovalFloor(floor, reader);
  }

  private handleSessionUpdate(
    record: AcpSessionRecord,
    update: SessionNotification['update'],
  ): void {
    // #3290: a relaunch that had to `session/load` replays the conversation
    // the transcript already holds.
    if (record.suppressSessionUpdates) return;
    // Session-state mutation (row 11 of the Lifecycle Mapping Table) lives
    // entirely in the mapper's AcpMapperState branches now — `state: record`
    // makes AcpSessionRecord the live backing store the mapper mutates
    // directly, so this method is pure wiring.
    if (
      record.reattaching &&
      ACP_HISTORY_REPLAY_UPDATES.has(update.sessionUpdate)
    ) {
      return;
    }
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
   * unavailable cursor or reattach (`session/resume` / `loadSession`)
   * capability is a diagnostic-only
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
      !acpReattachMethod(record.process.initResult)
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
          ...providerFailure('indeterminate'),
          severity: 'error',
          message:
            'The engine process could not be terminated during credential-refusal recovery.',
        } satisfies ProviderRuntimeErrorEvent);
        throw destroyError;
      }
      if (this.sessions.get(threadId) !== record) return;
      this.sessions.delete(threadId);
      // station#1569 (item 4): this is a session ending — the child is gone
      // and a replacement one starts below with its own supervisor — so the
      // calls this one still has open can never report. Unlike the stop path
      // (`prepareRecordForStop` → `dispose`), nothing settled them here at
      // all: they were abandoned mid-flight and left running forever in every
      // client. Before `session.exited`, which closes their cards as
      // "Stopped" (`background-tasks-store.ts`) and would take the honest
      // terminal with it.
      record.toolUpdateSupervisor.settleUnresolvedAtSessionEnd();
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
          ...providerFailure('provider_error'),
          severity: 'error',
          message:
            'The engine session could not be re-established after its credential request was refused.',
        } satisfies ProviderRuntimeErrorEvent);
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

  private bindPromptSettlement(
    record: AcpSessionRecord,
    threadId: string,
    turnId: string,
    promptEpoch: number,
    prompt: Promise<PromptResponse>,
  ): void {
    prompt
      .then((response) => {
        // archive#4084 review fix round F2: unquarantine unconditionally —
        // this specific prompt() has now settled, regardless of whether it
        // still owns the active turn (an interrupted turn's own settlement
        // lands here too, since interruptTurn does not replace this
        // handler). Must run before the ownsActiveTurn early return below,
        // or a superseded turn's quarantine would never clear.
        record.quarantinedTurnIds?.delete(turnId);
        if (record.promptEpoch !== promptEpoch) return;
        if (!this.ownsActiveTurn(threadId, record, turnId)) return;
        record.turnErrorNotifications = undefined;
        this.settleRequestsAtPromptEnd(record, threadId);
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId,
          createdAt: new Date().toISOString(),
          turnId,
          method: 'turn.completed',
          ...mapAcpStopReasonToTurnCompletion(response.stopReason),
        });
        record.session.status = 'ready';
        record.session.updatedAt = new Date().toISOString();
        record.activeTurnId = undefined;
      })
      .catch((error) => {
        record.quarantinedTurnIds?.delete(turnId);
        if (record.promptEpoch !== promptEpoch) return;
        if (!this.ownsActiveTurn(threadId, record, turnId)) return;
        // #2265: a classified provider-plan quota exhaustion publishes
        // fixed safe copy plus bounded facts — never the engine's raw
        // message, and never the co-reported notification text (which is
        // correlation, not a proven cause, and stays out of this terminal).
        const quota = classifyProviderQuotaFailure(error);
        const coReportedCause = record.turnErrorNotifications?.at(-1)?.message;
        record.turnErrorNotifications = undefined;
        this.settleRequestsAtPromptEnd(record, threadId);
        if (quota) {
          this.publish({
            eventId: crypto.randomUUID(),
            provider: this.provider,
            threadId,
            createdAt: new Date().toISOString(),
            turnId,
            method: 'runtime.error',
            ...providerFailure('quota_exhausted'),
            severity: 'error',
            code: PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE,
            message: PROVIDER_PLAN_QUOTA_MESSAGE,
            details: providerQuotaEventDetails(quota),
          } satisfies ProviderRuntimeErrorEvent);
        } else {
          const baseMessage = errorMessage(error);
          this.publish({
            eventId: crypto.randomUUID(),
            provider: this.provider,
            threadId,
            createdAt: new Date().toISOString(),
            turnId,
            method: 'runtime.error',
            ...providerFailure('provider_error'),
            severity: 'error',
            message: coReportedCause
              ? `${baseMessage} — engine also reported during this turn: ${coReportedCause}`
              : baseMessage,
          } satisfies ProviderRuntimeErrorEvent);
        }
        record.session.status = 'error';
        record.session.updatedAt = new Date().toISOString();
        record.activeTurnId = undefined;
      });
  }

  private async tryNativeAcpSteer(
    record: AcpSessionRecord,
    text: string,
  ): Promise<boolean> {
    const channel = resolveAcpSteerChannel({
      command: record.command,
      args: record.args,
      agentName: record.process.initResult?.agentInfo?.name,
    });
    const sessionId = record.process.sessionId;
    if (!sessionId) return false;
    if (channel === 'session-steer') {
      try {
        await record.process.extMethod(
          ACP_SESSION_STEER_METHOD,
          acpSessionSteerParams(sessionId, text),
        );
        return true;
      } catch (error) {
        if (!isAcpMethodNotFound(error)) throw error;
        return false;
      }
    }
    if (channel === 'interject') {
      for (const method of ACP_INTERJECT_METHODS) {
        try {
          await record.process.extMethod(
            method,
            acpInterjectParams(sessionId, text),
          );
          return true;
        } catch (error) {
          if (!isAcpMethodNotFound(error)) throw error;
        }
      }
      return false;
    }
    return false;
  }

  private async steerByCancelReprompt(
    record: AcpSessionRecord,
    threadId: string,
    turnId: string,
    text: string,
  ): Promise<void> {
    record.promptEpoch += 1;
    const promptEpoch = record.promptEpoch;
    record.toolUpdateSupervisor.cancelAll();
    this.cancelPendingRequests(record, threadId);
    await record.process.cancel();
    if (record.activeTurnId !== turnId) {
      throw new ProviderTurnEndedError();
    }
    this.bindPromptSettlement(
      record,
      threadId,
      turnId,
      promptEpoch,
      record.process.prompt([{ type: 'text', text }]),
    );
  }
}
