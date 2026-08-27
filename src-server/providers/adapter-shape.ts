import type {
  EngineConnectionId,
  EngineId,
  EngineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import {
  parseEngineConnectionId,
  parseEngineId,
  parseEngineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import type { ConnectionQuotaResult } from '@kontourai/station-contracts/connection-quota';
import type { ConnectionRecoveryCapability } from '@kontourai/station-contracts/connection-recovery';
import type { ModelInventoryExecutionIdentity } from '@kontourai/station-contracts/model-inventory';
import type {
  ModelLaunchCapabilities,
  ProviderContinuityCapabilities,
  ProviderKind,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionAdoptInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '@kontourai/station-contracts/provider';

/** The provider's live turn ended before mid-turn input could be enqueued. */
export class ProviderTurnEndedError extends Error {
  constructor() {
    super('The provider turn ended before the input could be enqueued.');
    this.name = 'ProviderTurnEndedError';
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
  runtimeId?: EngineRuntimeId;
  /** Stable public registry/navigation identity for this Adapter. */
  connectionId?: EngineConnectionId;
  builtin?: boolean;
  /**
   * Canonical engine identity (docs/design/agent-engine-unification.md §4.1):
   * `'station'` for Station's own engine, otherwise the engine's canonical
   * id (e.g. `'claude-code'`, `'codex'`, `'acp'`). Replaces `executionClass`
   * as of Phase B (station#1003 unification slice 6) — derive engineId via
   * `engineIdForAdapter` (adapter-identity.ts) rather than reading
   * `executionClass` directly.
   */
  engineId?: EngineId;
  /** @deprecated Phase-B read-compat for out-of-tree adapters; derive engineId instead. */
  executionClass?: 'managed' | 'connected';
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
   * Local default model id for an external native engine (station#977 —
   * "local default + defer to engine"). Used ONLY by the connected-CLI
   * launchability gate (`orchestration-service.ts`) as a fallback when no
   * explicit `modelId` was requested, and as a last-resort catalog entry
   * when the live model catalog is empty. Station-engine adapters
   * (Bedrock/Ollama/OpenAI) and ACP connections deliberately leave this
   * unset — Station-engine model resolution stays exact-match against its
   * own reliable catalog, and ACP already defers per-connection.
   */
  defaultModel?: string;
  /**
   * A small, hand-curated set of well-known model ids for an external
   * native engine, used as a catalog fallback (gate + model picker) when
   * the adapter's live/cached catalog is empty or unreachable. Not a
   * substitute for the live catalog — only consulted when it's empty.
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
  onProviderChildCreated(resumeCursor: unknown): void | Promise<void>;
}

export interface ProviderDiscardSessionRecovery {
  adoptionKey?: string;
  createdAt?: string;
  cwd?: string;
  resumeCursor?: unknown;
}

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
  readonly provider: ProviderKind;
  readonly metadata: ProviderAdapterMetadata;

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
  respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  listSessions(): Promise<ProviderSession[]>;
  /**
   * Whether THIS PROCESS currently holds a live engine binding for the
   * thread — never durable state (station#3493 residual 5). Answering from
   * persisted rows or resume cursors would be a lie the whole dormant/live
   * derivation is built on: boot recovery (station#3476) binds an adapter
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
     * station#1430 review, H-2: passed through to a provider's own
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
  const derivedRuntimeId =
    typeof candidate.provider === 'string'
      ? (metadata?.runtimeId ?? `${candidate.provider}-runtime`)
      : undefined;
  return (
    typeof candidate.provider === 'string' &&
    !!metadata &&
    typeof metadata.displayName === 'string' &&
    typeof metadata.description === 'string' &&
    Array.isArray(metadata.capabilities) &&
    parseEngineRuntimeId(derivedRuntimeId) !== undefined &&
    (metadata.connectionId === undefined ||
      parseEngineConnectionId(metadata.connectionId) !== undefined) &&
    (metadata.engineId === undefined ||
      parseEngineId(metadata.engineId) !== undefined) &&
    requiredMethods.every((method) => typeof candidate[method] === 'function')
  );
}

export type ProviderAdapterRegistrationProvenance = 'builtin' | 'plugin';

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
