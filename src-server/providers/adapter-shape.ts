import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import {
  parseEngineConnectionId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { ConnectionQuotaResult } from '@kontourai/station-contracts/connection-quota';
import type { ConnectionRecoveryCapability } from '@kontourai/station-contracts/connection-recovery';
import type { InputRequestContent } from '@kontourai/station-contracts/input-request';
import type { ModelInventoryExecutionIdentity } from '@kontourai/station-contracts/model-inventory';
import type {
  EngineId,
  ModelLaunchCapabilities,
  ProviderContinuityCapabilities,
  ProviderDurabilityProfile,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionAdoptInput,
  ProviderSessionRetirement,
  ProviderSessionSourceAffinity,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '@kontourai/station-contracts/provider';
import {
  ATTACHMENT_INPUT_UNSUPPORTED_CODE,
  CLIENT_TURN_IN_FLIGHT_CODE,
  CLIENT_TURN_INPUT_CONFLICT_CODE,
  PROVIDER_SESSION_START_FAILED_CODE,
  PROVIDER_SESSION_STARTING_CODE,
  PROVIDER_TURN_IN_PROGRESS_CODE,
} from '@kontourai/station-contracts/provider';
import {
  PROVIDER_FAILURE_KINDS,
  PROVIDER_FAILURE_RETRYABLE,
  type ProviderFailureCode,
  type ProviderFailureKind,
} from '@kontourai/station-contracts/provider-failure';
import { ProviderRefusalError } from './provider-failure.js';

/** The provider's live turn ended before mid-turn input could be enqueued. */
export class ProviderTurnEndedError extends ProviderRefusalError {
  constructor() {
    super(
      'The provider turn ended before the input could be enqueued.',
      'conflict',
    );
    this.name = 'ProviderTurnEndedError';
  }
}

/**
 * An adapter refused a turn BEFORE its first provider-visible effect: no
 * engine was invoked, no prompt was sent, and no `turn.started` was
 * published. Input validation (unsupported attachment kinds, an engine that
 * did not advertise a needed capability) is the expected source.
 *
 * Throw ONLY before the first provider-visible effect. Orchestration treats
 * this as a refusal to act — the turn boundary is retired, the client-turn
 * claim is released, the dispatch receipt is `rejected`, and the message is
 * surfaced honestly — instead of the fail-closed indeterminate path. An
 * adapter failure that MAY have reached the provider must stay a plain
 * error so callers keep refusing to retry it blindly.
 *
 * A send that races the session's still-running turn is the other expected
 * source (#2415), and the adapter is the first layer to refuse it:
 * `SessionExecutionCoordinator` serializes turn STARTS and refuses ("turn
 * start in progress") only while another start is still being prepared or
 * invoked, or was left indeterminate; an accepted turn that is still running
 * does not block the claim. An adapter's "already has an active turn" guard
 * must therefore throw this type. A plain error there is recorded as an
 * indeterminate turn start, and that lingering boundary row reads as an
 * in-flight turn that blocks later continuations of the thread.
 *
 * A send while the engine runs a turn it opened on its own is the third
 * source (#2324): {@link ProviderTurnInProgressError}, retryable by its kind.
 */
export class SendTurnRefusedError extends Error {
  readonly failurePhase = 'refused';
  get retryable(): boolean {
    return PROVIDER_FAILURE_RETRYABLE[this.kind];
  }
  constructor(
    message: string,
    readonly kind: ProviderFailureKind,
  ) {
    super(message);
    this.name = 'SendTurnRefusedError';
  }
}

/**
 * A pre-effect refusal of the send's ATTACHMENTS, carrying a structured code
 * so orchestration can forward it and clients can translate it without
 * matching prose. Deterministic: a retry with the same attachments is refused
 * again, which is exactly what a generic "retrying may help" hint got wrong.
 */
export class AttachmentInputUnsupportedError extends SendTurnRefusedError {
  readonly code = ATTACHMENT_INPUT_UNSUPPORTED_CODE;

  constructor(message: string) {
    super(message, 'input_unsupported');
    this.name = 'AttachmentInputUnsupportedError';
  }
}

/**
 * An adapter's `startSession` refused the session DEFINITIVELY: the engine
 * answered with a refusal and the adapter has torn down what it spawned, so
 * nothing of this start is left running. The expected source is a requested
 * model the engine's own fresh session options did not offer
 * ({@link MODEL_NOT_ADVERTISED_CODE}). Throwing it is also a promise to publish
 * the cause and then `session.exited` for a `session.started` already sent (the
 * ACP adapter does): the service binds the thread to the adapter on the first
 * event, and only that exit ends the session it announced.
 *
 * Throw ONLY when that is true. The start boundary otherwise records every
 * adapter failure as an indeterminate start and keeps the thread fenced until
 * it is inspected, which is right for a start that MAY have created a session.
 * This type is how the adapter, the only layer that knows, tells it the start
 * is settled; the dispatch receipt is then `rejected` and `code` is forwarded.
 */
export class SessionStartRefusedError extends Error {
  readonly failurePhase = 'refused';
  get kind(): ProviderFailureKind {
    return PROVIDER_FAILURE_KINDS[this.code];
  }
  get retryable(): boolean {
    return PROVIDER_FAILURE_RETRYABLE[this.kind];
  }
  constructor(
    message: string,
    readonly code: ProviderFailureCode,
  ) {
    super(message);
    this.name = 'SessionStartRefusedError';
  }
}

/**
 * #2324: a send refused because the engine is running a turn it opened on
 * its own (`PROVIDER_TURN_TRIGGER`). Accepting it would fold the message
 * into a reply nobody asked for. Before dispatch entry, a busy request may
 * wait in the inbox. A keyed send that has begun and is definitively refused
 * closes that key; a new explicit request requires a new key.
 */
export class ProviderTurnInProgressError extends SendTurnRefusedError {
  readonly code = PROVIDER_TURN_IN_PROGRESS_CODE;

  constructor() {
    super(
      'The agent is replying on its own; your message will be sent when it finishes.',
      'busy',
    );
    this.name = 'ProviderTurnInProgressError';
  }
}

/**
 * A send that waited for its session's engine start and gave up before the
 * start finished. Nothing reached the engine. Retryable: orchestration
 * forwards the code and clients keep the message queued.
 */
export class ProviderSessionStartingError extends SendTurnRefusedError {
  readonly code = PROVIDER_SESSION_STARTING_CODE;

  constructor() {
    super(
      'The session is still starting. Nothing was sent; try again in a moment.',
      'busy',
    );
    this.name = 'ProviderSessionStartingError';
  }
}

/**
 * A send whose session's engine start failed while it waited. Nothing was
 * sent; `reason` is short and user-facing (engine detail belongs in logs).
 * Kept by clients with a Retry rather than dropped.
 */
export class ProviderSessionStartFailedError extends SendTurnRefusedError {
  readonly code = PROVIDER_SESSION_START_FAILED_CODE;

  constructor(reason: string) {
    super(`The agent's session couldn't start: ${reason}`, 'unavailable');
    this.name = 'ProviderSessionStartFailedError';
  }
}

export class ClientTurnInputConflictError extends SendTurnRefusedError {
  readonly code = CLIENT_TURN_INPUT_CONFLICT_CODE;
  constructor() {
    super(
      'This client turn key already names a different submitted input.',
      'conflict',
    );
    this.name = 'ClientTurnInputConflictError';
  }
}

/**
 * A send whose `clientTurnId` another attempt still holds, or released
 * without sending. Nothing new was sent; the same key may be sent again.
 */
export class ClientTurnInFlightError extends SendTurnRefusedError {
  readonly code = CLIENT_TURN_IN_FLIGHT_CODE;

  constructor() {
    super(
      'An earlier attempt of this message has not finished. Nothing new was sent; try again in a moment.',
      'busy',
    );
    this.name = 'ClientTurnInFlightError';
  }
}

import type {
  ApprovalAcknowledgement,
  CanonicalRuntimeEvent,
} from '@kontourai/station-contracts/runtime-events';
import type {
  ConnectionCapability,
  Prerequisite,
} from '@kontourai/station-contracts/tool';
import type { AsyncEventStreamOptions } from './sessions/async-event-queue.js';

export type {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionAdoptInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '@kontourai/station-contracts/provider';
export type {
  CanonicalRuntimeEvent,
  ProviderRuntimeEvent,
} from '@kontourai/station-contracts/runtime-events';

export interface ProviderAdapterMetadata {
  displayName: string;
  description: string;
  capabilities: readonly ConnectionCapability[];
  /** Stable public registry/navigation identity for this Adapter. */
  connectionId?: EngineConnectionId;
  builtin?: boolean;
  /**
   * Canonical engine identity (docs/design/agent-engine-unification.md §4.1):
   * `'station'` for Station's own engine, otherwise the engine's canonical
   * id (e.g. `'claude'`, `'codex'`, `'acp'`). Derive the adapter identity via
   * `engineIdForAdapter` (adapter-identity.ts).
   */
  engineId?: EngineId;
  /** Evidence-scoping identity for models launched through this adapter. */
  modelExecution?: ModelInventoryExecutionIdentity;
  /** Abort does not settle discovery until adapter-owned resources are closed. */
  abortSettlement?: 'await';
  /** Optional bounded same-session recovery declaration; absence is unsupported. */
  recovery?: ConnectionRecoveryCapability;
  /**
   * Plugin-safe additive continuity declaration. Absent third-party adapters
   * are read as `none` until they opt in with a version they actually support.
   */
  continuity?: ProviderContinuityCapabilities;
  /** Absent on legacy plugins means unreported, never an inferred guarantee. */
  durability?: ProviderDurabilityProfile;
  /** Native process sandbox can enforce Station's independent-review policy. */
  reviewIsolation?: 'read-only';
  /**
   * Positive declaration of model omission and override behavior at each
   * lifecycle point. Absence is intentionally fail-closed for model input.
   */
  modelLaunch?: ModelLaunchCapabilities;
  /**
   * Local default model id for an external native engine (archive#977 —
   * "local default + defer to engine"). Used ONLY by the connected-CLI
   * launchability gate as a fallback when no explicit `modelId` was
   * requested. It is not picker contents. Station-engine adapters
   * (Bedrock/Ollama/OpenAI) and ACP connections deliberately leave this
   * unset — Station-engine model resolution stays exact-match against its
   * own reliable catalog, and ACP already defers per-connection.
   */
  defaultModel?: string;
  /**
   * Well-known short aliases an external native engine accepts directly
   * (`sonnet`/`opus`/`haiku` for Claude Code). Used only to match a
   * launch selector when the live catalog is empty — never as picker
   * contents. The picker is the adapter's live catalog.
   */
  knownModels?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * #2482: the adapter declares that every entry its `listModelCatalog` /
   * `listModels` returns has `originalId === id` — its catalog names each
   * model by the selector the engine is launched with, so there is no alias
   * to rewrite. Connected-CLI selector validation (`model-launch-planning`)
   * reads the catalog only to rewrite an alias, and passes an unlisted
   * selector through to the engine anyway (archive#977); for an adapter
   * declaring this it therefore skips the catalog read, which for Claude
   * Code is a whole CLI spawn before every start. Absent means the catalog
   * may rewrite, and validation keeps reading it. Declare it only where the
   * catalog's own construction sets `originalId` from `id`, and pin that
   * with a test against the adapter's real catalog.
   */
  modelCatalogIdentityMapped?: boolean;
  /**
   * #2880: what this adapter can report after Station records an approval
   * decision (see `ApprovalAcknowledgement`). The adapter stamps the same
   * value on each decision's `request.resolved`. Absent reads as `none`: a
   * plugin adapter claims no acknowledgement until it declares one.
   */
  approvalAcknowledgement?: ApprovalAcknowledgement;
}

export interface ProviderAdapterModelCatalog {
  models: Array<{
    id: string;
    name: string;
    originalId: string;
    /** Concrete catalog identity for an alias; not per-turn served-model proof. */
    resolvedModel?: string;
  }>;
  /** True when a bounded entry limit omitted additional adapter results. */
  truncated?: boolean;
}

export interface ProviderAdoptionHooks {
  /** Persist the creation boundary immediately before an external child may be created. */
  onProviderChildCreationStarted?(): void | Promise<void>;
  onProviderChildCreated(resumeCursor: unknown): void | Promise<void>;
}

/** Provider-owned native identity projected from an opaque resume cursor. */
export interface ProviderNativeSessionIdentity {
  sessionId: string;
  affinity?: ProviderSessionSourceAffinity;
}

/** Live launch facts held by the adapter, rather than inferred from persisted events. */
interface ProviderPreparedTurnBinding {
  readonly bindingKey: string;
  readonly nativeIdentity: ProviderNativeSessionIdentity;
}

export interface ProviderDiscardSessionRecovery {
  sourceAffinity?: ProviderSessionSourceAffinity;
  sourceSessionId?: string;
  sourceKind?: string;
  adoptionKey?: string;
  createdAt?: string;
  cwd?: string;
  resumeCursor?: unknown;
}

/**
 * Outcome of a task-scoped stop.
 *
 * `no-active-task` is a normal race, not a failure: a subagent can settle
 * between a client rendering its stop control and the request arriving.
 */
export type ProviderTaskStopResult =
  | { outcome: 'stopped'; taskId: string }
  | { outcome: 'no-active-task'; taskId: string }
  | { outcome: 'unsupported' };

/** Target-specific result of an interrupt request. */
export type ProviderInterruptTurnResult =
  | { outcome: 'cancelled'; turnId: string }
  | { outcome: 'no-active-turn' }
  | { outcome: 'target-mismatch'; activeTurnId?: string }
  | { outcome: 'termination-unconfirmed'; turnId: string };

/**
 * Provider adapters can arrive from runtime-loaded JavaScript plugins, where
 * the TypeScript contract is not enforcement. Keep the boundary check here so
 * callers never have to dereference an untrusted interrupt result.
 */
export function isProviderInterruptTurnResult(
  value: unknown,
): value is ProviderInterruptTurnResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    outcome?: unknown;
    turnId?: unknown;
    activeTurnId?: unknown;
  };
  switch (candidate.outcome) {
    case 'cancelled':
    case 'termination-unconfirmed':
      return typeof candidate.turnId === 'string';
    case 'no-active-turn':
      return true;
    case 'target-mismatch':
      return (
        candidate.activeTurnId === undefined ||
        typeof candidate.activeTurnId === 'string'
      );
    default:
      return false;
  }
}

export interface ProviderAdapterShape {
  /** Positive declaration that adoption calls the creation-start hook before its first child effect. */
  readonly adoptionLifecycle?: 'reported';
  readonly provider: EngineId;
  readonly metadata: ProviderAdapterMetadata;

  /** Read-only projection used to suppress duplicate attached-session aliases. */
  nativeSessionIdentity?(
    resumeCursor: unknown,
  ): ProviderNativeSessionIdentity | undefined;
  preparedTurnBinding?(
    threadId: string,
  ): ProviderPreparedTurnBinding | undefined;

  startSession(input: ProviderSessionStartInput): Promise<ProviderSession>;
  /** Optional independent-continuation capability for attached sessions. */
  adoptSession?(
    input: ProviderSessionAdoptInput,
    hooks?: ProviderAdoptionHooks,
  ): Promise<ProviderSession>;
  /** Permanently discard an abandoned adopted provider transcript. */
  discardSession?(
    threadId: string,
    recovery?: ProviderDiscardSessionRecovery,
  ): Promise<void>;
  /**
   * Wait until the thread's session can take a turn, for an adapter whose
   * session becomes visible before its engine start finishes. Orchestration
   * awaits this BEFORE taking the thread's turn-start claim, so a long start
   * never holds the lock Stop/End/park need. Resolves at once when nothing
   * is pending; rejects with a `SendTurnRefusedError` (start failed, or
   * {@link ProviderSessionStartingError} when still starting after the
   * adapter's bound) or the signal's abort error. Nothing reaches the engine.
   */
  whenSessionReady?(
    threadId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult>;
  interruptTurn(
    threadId: string,
    turnId?: string,
  ): Promise<ProviderInterruptTurnResult>;
  /** Present only when the adapter has a real additive-input channel for a running turn. */
  steerTurn?(threadId: string, input: string, turnId: string): Promise<void>;
  /**
   * Stop ONE provider-reported subagent, targeted rather than a blanket
   * turn interrupt.
   *
   * Present only where the engine exposes a task-scoped stop. Absent is the
   * honest answer for an engine whose only stop is turn-scoped: the caller
   * must not fall back to interrupting the turn, because that ends every
   * other running subagent too — the precise outcome this seam exists to
   * avoid for an engine that CAN leave the turn running.
   *
   * #2486: an engine with no softer path (Codex — no client method unblocks
   * a parent whose turn is waiting on the child any other way) may still end
   * the reporting session's own active turn as part of this call, though
   * never any OTHER sibling. The matrix's `subagentControl.stop.
   * endsParentTurn` cell says which is true for a given engine; a client
   * reads that flag rather than assuming every engine's stop behaves the
   * same way.
   */
  stopProviderTask?(
    threadId: string,
    taskId: string,
  ): Promise<ProviderTaskStopResult>;
  respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
    /**
     * Who answered (#2344). Only adapters that record the decision
     * themselves read it; the command receipt carries it for every engine.
     */
    context?: {
      clientOrigin?: ClientOrigin;
      /**
       * #3390: accepted content for a form input request (a harness question
       * or a tool server's elicitation), already validated against the
       * stored request. An adapter that holds its own copy of the form
       * checks it again before it reaches the engine.
       */
      inputContent?: InputRequestContent;
      expectedRequestEventId?: string;
    },
  ): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  /** Native ownership may move only after this reports confirmed retirement. */
  retireSession?(threadId: string): Promise<ProviderSessionRetirement>;
  listSessions(): Promise<ProviderSession[]>;
  /**
   * Whether THIS PROCESS currently holds a live engine binding for the
   * thread — never durable state (archive#3493 residual 5). Answering from
   * persisted rows or resume cursors would be a lie the whole dormant/live
   * derivation is built on: boot recovery (archive#3476) binds an adapter
   * only when this returns true, and every command's engine-free branch
   * trusts that a `false` here meant "no process to act on". After a
   * restart the correct answer is almost always `false`, even for sessions
   * this adapter could resume — resumability is the ROW's claim
   * (`resumeCursor`), not this method's. The exception that makes the
   * contract load-bearing: an adapter attached to an external process that
   * genuinely survives restarts may truthfully report `true`.
   */
  hasSession(threadId: string): Promise<boolean>;
  stopAll(): Promise<void>;
  /** Implementations must settle pending reads when the signal is aborted. */
  streamEvents(
    options?: AsyncEventStreamOptions,
  ): AsyncIterable<CanonicalRuntimeEvent>;
  getPrerequisites?(options?: {
    signal?: AbortSignal;
    /**
     * chat-dock-maximize-readiness (AC8): scope prerequisites to a single
     * connection when the adapter manages multiple (e.g. ACP's OpenCode +
     * Cursor siblings). Absent preserves the aggregate behavior for adapters
     * that own a single connection (Bedrock, Ollama, etc.).
     */
    connectionId?: string;
  }): Promise<Prerequisite[]>;
  /** Reads provider-reported connection quota data when the engine supports it. */
  readQuotaSnapshot?(options: {
    connectionId: string;
    /** Server-only profile selector; never serialized into the snapshot. */
    credentialProfileRef?: string;
  }): Promise<ConnectionQuotaResult>;
  /** Drops a cached provider read after connection credentials/config change. */
  invalidateQuotaSnapshot?(options?: { connectionId?: string }): void;
  getCommands?(options?: { signal?: AbortSignal }): Promise<
    Array<{
      name: string;
      description: string;
      argumentHint?: string;
      passthrough: boolean;
    }>
  >;
  listModels?(options?: { signal?: AbortSignal; maxEntries?: number }): Promise<
    Array<{
      id: string;
      name: string;
      originalId: string;
    }>
  >;
  listModelCatalog?(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
    /**
     * archive#1430 review, H-2: passed through to a provider's own
     * `ModelCatalogRequest` (`model-provider-types.ts`) for adapters whose
     * underlying provider does per-model capability enrichment beyond its
     * base catalog call (currently: Ollama's `/api/show` `supportsTools`
     * lookups). A caller whose own return shape has no capability field to
     * populate (this adapter-level `ProviderAdapterModelCatalog.models` is
     * `{id, name, originalId}` — no capabilities at all) should set this so
     * it doesn't pay for work it structurally cannot use. Adapters with no
     * enrichment step of their own are free to ignore it.
     */
    skipCapabilityEnrichment?: boolean;
  }): Promise<ProviderAdapterModelCatalog>;
}

export function isProviderAdapterShape(
  value: unknown,
): value is ProviderAdapterShape {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProviderAdapterShape>;
  const metadata = candidate.metadata as
    | ProviderAdapterShape['metadata']
    | undefined;
  const requiredMethods: Array<keyof ProviderAdapterShape> = [
    'startSession',
    'sendTurn',
    'interruptTurn',
    'respondToRequest',
    'stopSession',
    'listSessions',
    'hasSession',
    'stopAll',
    'streamEvents',
  ];
  return (
    typeof candidate.provider === 'string' &&
    !!metadata &&
    typeof metadata.displayName === 'string' &&
    typeof metadata.description === 'string' &&
    Array.isArray(metadata.capabilities) &&
    (metadata.connectionId === undefined ||
      parseEngineConnectionId(metadata.connectionId) !== undefined) &&
    (metadata.engineId === undefined ||
      parseEngineId(metadata.engineId) !== undefined) &&
    requiredMethods.every((method) => typeof candidate[method] === 'function')
  );
}

type ProviderAdapterRegistrationProvenance = 'builtin' | 'plugin';

const providerAdapterProvenance = new WeakMap<
  ProviderAdapterShape,
  ProviderAdapterRegistrationProvenance
>();

export function setProviderAdapterRegistrationProvenance(
  adapter: ProviderAdapterShape,
  provenance: ProviderAdapterRegistrationProvenance,
): void {
  providerAdapterProvenance.set(adapter, provenance);
}

export function getProviderAdapterRegistrationProvenance(
  adapter: ProviderAdapterShape,
): ProviderAdapterRegistrationProvenance {
  return providerAdapterProvenance.get(adapter) ?? 'plugin';
}
