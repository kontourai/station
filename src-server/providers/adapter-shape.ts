import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import {
  parseEngineConnectionId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import type { ConnectionQuotaResult } from '@kontourai/station-contracts/connection-quota';
import type { ConnectionRecoveryCapability } from '@kontourai/station-contracts/connection-recovery';
import type { ModelInventoryExecutionIdentity } from '@kontourai/station-contracts/model-inventory';
import type {
  EngineId,
  ModelLaunchCapabilities,
  ProviderContinuityCapabilities,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionAdoptInput,
  ProviderSessionSourceAffinity,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '@kontourai/station-contracts/provider';
import { PROVIDER_TURN_IN_PROGRESS_CODE } from '@kontourai/station-contracts/provider';

/** The provider's live turn ended before mid-turn input could be enqueued. */
export class ProviderTurnEndedError extends Error {
  constructor() {
    super('The provider turn ended before the input could be enqueued.');
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
 * source (#2324): {@link ProviderTurnInProgressError}, retryable by its code.
 */
export class SendTurnRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendTurnRefusedError';
  }
}

/**
 * #2324: a send refused because the engine is running a turn it opened on
 * its own (`PROVIDER_TURN_TRIGGER`). Accepting it would fold the message
 * into a reply nobody asked for. Retryable: the same send succeeds once that
 * turn closes, so orchestration forwards the code and clients keep the
 * message queued rather than dropping it.
 */
export class ProviderTurnInProgressError extends SendTurnRefusedError {
  readonly code = PROVIDER_TURN_IN_PROGRESS_CODE;

  constructor() {
    super(
      'The agent is replying on its own; your message will be sent when it finishes.',
    );
    this.name = 'ProviderTurnInProgressError';
  }
}

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
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
export type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

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
}

export interface ProviderAdapterModelCatalog {
  models: Array<{
    id: string;
    name: string;
    originalId: string;
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
  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult>;
  interruptTurn(
    threadId: string,
    turnId?: string,
  ): Promise<ProviderInterruptTurnResult>;
  /** Present only when the adapter has a real additive-input channel for a running turn. */
  steerTurn?(threadId: string, input: string, turnId: string): Promise<void>;
  /**
   * Stop ONE provider-reported subagent without ending the turn or its
   * siblings.
   *
   * Present only where the engine exposes a task-scoped stop. Absent is the
   * honest answer for an engine whose only stop is turn-scoped: the caller
   * must not fall back to interrupting the turn, because that ends every
   * other running subagent too — the precise outcome this seam exists to
   * avoid.
   */
  stopProviderTask?(
    threadId: string,
    taskId: string,
  ): Promise<ProviderTaskStopResult>;
  respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void>;
  stopSession(threadId: string): Promise<void>;
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
