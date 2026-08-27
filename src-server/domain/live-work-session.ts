/** #2914: bounded live work with recoverable, exact-once material history. */
import { createHash } from 'node:crypto';
import type {
  CommittedRevision,
  EvidenceRevisionId,
  ImmutableRevisionReference,
  RevisionReferenceResolution,
} from './revision-bound-evidence.js';

export const LIVE_WORK_SESSION_SCHEMA_VERSION =
  'station.live-work-session/v6' as const;
export const LIVE_WORK_RECOVERY_SCHEMA_VERSION =
  'station.live-work-recovery/v3' as const;

export type LiveWorkCapability =
  | 'join'
  | 'read'
  | 'write'
  | 'watch'
  | 'follow'
  | 'announce'
  | 'history-read';
export interface LiveWorkScope {
  readonly projectId: string;
  readonly taskId: string;
  readonly surfaceId: string;
  readonly sessionId: string;
  readonly channelId: string;
}
export interface LiveWorkActor {
  readonly actorId: string;
  readonly kind: 'human' | 'agent';
  readonly label: string;
}
export interface LiveWorkAuthorization {
  readonly actorId: string;
  readonly scope: LiveWorkScope;
  readonly capabilities: ReadonlySet<LiveWorkCapability>;
}
export interface LiveWorkRecoveryAuthorization {
  readonly kind: 'system';
  readonly recoveryId: string;
  readonly scope: LiveWorkScope;
}
export interface LiveWorkIdentity {
  readonly actor: LiveWorkActor;
  /** Stable identity for this independent live-work occurrence. */
  readonly occurrenceId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly workName: string;
  readonly workState: 'working' | 'reviewing' | 'blocked';
  readonly startedAt: number;
  /** Server-issued request identity used only for restart/TTL closure. */
  readonly ttlClosureRequestId: string;
}
export interface LiveWorkIdentityAuthority {
  resolve(input: {
    readonly actorId: string;
    readonly scope: LiveWorkScope;
    readonly requestId: string;
  }):
    | { readonly state: 'AVAILABLE'; readonly identity: LiveWorkIdentity }
    | { readonly state: 'UNAVAILABLE' };
}
export interface LiveWorkRecoveryAuthority {
  authorize(input: {
    readonly authorization: LiveWorkRecoveryAuthorization;
    readonly operation: 'export' | 'restore' | 'reconcile';
    readonly scope: LiveWorkScope;
  }): boolean;
}
export interface LiveWorkBounds {
  readonly ttlMs: number;
  readonly pausedTtlMs: number;
  readonly typingTtlMs: number;
  readonly maxTyping: number;
  readonly maxParticipants: number;
  readonly maxViewerPanes: number;
  readonly maxReplayEvents: number;
  readonly maxTransitionTimestamps: number;
  readonly maxRecoveryTimestamps: number;
  readonly maxPendingIntents: number;
  readonly maxPendingBytes: number;
  readonly maxTerminalIntents: number;
  readonly rateWindowMs: number;
  readonly maxTransitionsPerWindow: number;
  readonly maxRecoveriesPerWindow: number;
  readonly maxIdLength: number;
  readonly maxLabelLength: number;
  readonly maxStringBytes: number;
}
export const DEFAULT_LIVE_WORK_BOUNDS: LiveWorkBounds = Object.freeze({
  ttlMs: 30_000,
  pausedTtlMs: 30_000,
  typingTtlMs: 8_000,
  maxTyping: 64,
  maxParticipants: 64,
  maxViewerPanes: 128,
  maxReplayEvents: 128,
  maxTransitionTimestamps: 256,
  // Checkpoint export is the normal durability rail for a live transition.
  // Keep its ledger large enough for the advertised 120 transitions/minute;
  // the runtime deliberately takes one export admission per ordinary command.
  maxRecoveryTimestamps: 256,
  maxPendingIntents: 256,
  maxPendingBytes: 256 * 1024,
  maxTerminalIntents: 512,
  rateWindowMs: 60_000,
  maxTransitionsPerWindow: 120,
  maxRecoveriesPerWindow: 120,
  maxIdLength: 128,
  maxLabelLength: 256,
  maxStringBytes: 1024,
});
const ABSOLUTE: LiveWorkBounds = Object.freeze({
  ttlMs: 86_400_000,
  pausedTtlMs: 86_400_000,
  typingTtlMs: 86_400_000,
  maxTyping: 256,
  maxParticipants: 256,
  maxViewerPanes: 512,
  maxReplayEvents: 512,
  maxTransitionTimestamps: 1024,
  maxRecoveryTimestamps: 1024,
  maxPendingIntents: 1024,
  maxPendingBytes: 4 * 1024 * 1024,
  maxTerminalIntents: 2048,
  rateWindowMs: 86_400_000,
  maxTransitionsPerWindow: 512,
  maxRecoveriesPerWindow: 512,
  maxIdLength: 256,
  maxLabelLength: 512,
  maxStringBytes: 4096,
});

export type DurablePortOutcome =
  | { readonly state: 'committed'; readonly receipt?: unknown }
  | { readonly state: 'refused'; readonly reason: string }
  | { readonly state: 'indeterminate' };
interface IntentBase {
  readonly intentId: string;
  readonly requestId: string;
  readonly occurrenceId: string;
  readonly ordinal: number;
  readonly scope: LiveWorkScope;
  readonly actor: LiveWorkActor;
  readonly work: Omit<
    LiveWorkIdentity,
    'actor' | 'occurrenceId' | 'ttlClosureRequestId'
  >;
  readonly occurredAt: number;
}
export interface LiveWorkHistoryIntent extends IntentBase {
  readonly kind: 'announce' | 'departure' | 'work-finished';
  /** A lifecycle closure records loss of presence, not completion of work. */
  readonly presenceReason?: 'departed' | 'withdrawn' | 'expired';
  /** Work completion is deliberate and materially distinct from presence. */
  readonly finishOutcome?: 'completed' | 'failed' | 'cancelled';
  readonly revisionId?: EvidenceRevisionId;
}
export interface LiveWorkRevisionIntent extends IntentBase {
  readonly kind: 'revision-reference';
  readonly revisionId: EvidenceRevisionId;
}
export interface LiveWorkPorts {
  readonly history?: {
    /** Async ports are settled only through the explicit async session calls. */
    readonly asynchronous?: boolean;
    commit(
      intent: LiveWorkHistoryIntent,
    ): DurablePortOutcome | Promise<DurablePortOutcome>;
    close?(): Promise<LiveWorkPortCloseOutcome>;
  };
  readonly revision?: {
    readonly asynchronous?: boolean;
    commit(
      intent: LiveWorkRevisionIntent,
    ): DurablePortOutcome | Promise<DurablePortOutcome>;
    close?(): Promise<LiveWorkPortCloseOutcome>;
  };
}
export type LiveWorkPortCloseOutcome = {
  readonly outcome: 'closed' | 'pending' | 'unavailable';
};
export type LiveWorkCloseOutcome = LiveWorkPortCloseOutcome;
export interface LiveWorkRevisionAuthority {
  resolveEvidence(reference: unknown): RevisionReferenceResolution;
}
export interface LiveWorkDependencies {
  readonly identityAuthority?: LiveWorkIdentityAuthority;
  readonly revisionAuthority?: LiveWorkRevisionAuthority;
  readonly recoveryAuthority?: LiveWorkRecoveryAuthority;
}

export type LiveWorkMutationOutcome =
  | {
      readonly outcome:
        | 'joined'
        | 'refreshed'
        | 'updated'
        | 'cleared'
        | 'departed'
        | 'paused';
      /** Immutable projection of the durable adapter's committed receipt. */
      readonly receipt?: unknown;
    }
  | {
      readonly outcome: 'degraded';
      readonly intentId: string;
      readonly state: 'indeterminate' | 'refused';
    }
  | {
      readonly outcome:
        | 'invalid'
        | 'forbidden'
        | 'unavailable'
        | 'identity_changed'
        | 'capacity_exceeded'
        | 'rate_limited';
    };
export type LiveWorkReplayEvent = LiveWorkHistoryIntent;
export interface LiveWorkSnapshot {
  readonly schemaVersion: typeof LIVE_WORK_SESSION_SCHEMA_VERSION;
  readonly scope: LiveWorkScope;
  readonly state: 'active' | 'stale' | 'degraded';
  readonly participants: readonly {
    readonly actor: LiveWorkActor;
    readonly work: LiveWorkHistoryIntent['work'];
    readonly publication: 'published' | 'private';
  }[];
  readonly panes: readonly {
    readonly actorId: string;
    readonly paneId: string;
    readonly state: 'watching' | 'following' | 'paused';
    readonly targetActorId?: string;
    readonly reason?: 'target_departed' | 'expired';
  }[];
  readonly typing: readonly {
    readonly actorId: string;
    readonly expiresAt: number;
  }[];
}
export type LiveWorkReadOutcome =
  | { readonly outcome: 'available'; readonly snapshot: LiveWorkSnapshot }
  | { readonly outcome: 'unavailable' | 'invalid' | 'rate_limited' };
export type LiveWorkReplayOutcome =
  | {
      readonly outcome: 'available';
      readonly events: readonly LiveWorkReplayEvent[];
    }
  | { readonly outcome: 'unavailable' | 'invalid' | 'rate_limited' };

interface Participant {
  identity: LiveWorkIdentity;
  expiresAt: number;
  published: boolean;
}
interface Pane {
  state: 'watching' | 'following' | 'paused';
  targetActorId?: string;
  reason?: 'target_departed' | 'expired';
  expiresAt: number;
}
type DurableIntent = LiveWorkHistoryIntent | LiveWorkRevisionIntent;
interface Pending {
  readonly intent: DurableIntent;
  readonly port: 'history' | 'revision';
  readonly capability: LiveWorkCapability;
  readonly actorId: string;
  readonly lifecycleId?: string;
  readonly afterIntentId?: string;
  readonly bytes: number;
}
interface Lifecycle {
  readonly announcementId: string;
  identity: LiveWorkIdentity;
  readonly announceRequestId: string;
  reservedClosureBytes: number;
  state: 'announcing' | 'published' | 'closing';
  closureId?: string;
}
interface RecoveryPending {
  readonly intent: DurableIntent;
  readonly port: Pending['port'];
  readonly capability: LiveWorkCapability;
  readonly actorId: string;
  readonly lifecycleId?: string;
  readonly afterIntentId?: string;
}
interface RecoveryLifecycle {
  readonly announcementId: string;
  readonly identity: LiveWorkIdentity;
  readonly announceRequestId: string;
  readonly reservedClosureBytes: number;
  readonly state: Lifecycle['state'];
  readonly closureId?: string;
}
interface TerminalIntent {
  readonly intent: DurableIntent;
  readonly port: Pending['port'];
  readonly capability: LiveWorkCapability;
  readonly actorId: string;
  readonly lifecycleId?: string;
  readonly afterIntentId?: string;
  readonly result: 'committed' | 'refused';
  readonly receipt?: unknown;
}
interface RateEntry {
  readonly principalId: string;
  readonly at: number;
}
export interface LiveWorkRecoveryState {
  readonly schemaVersion: typeof LIVE_WORK_RECOVERY_SCHEMA_VERSION;
  readonly scope: LiveWorkScope;
  readonly safeClock: number;
  readonly nextOrdinal: number;
  readonly pending: readonly RecoveryPending[];
  readonly lifecycles: readonly RecoveryLifecycle[];
  readonly terminal: readonly {
    readonly intent: DurableIntent;
    readonly port: Pending['port'];
    readonly capability: LiveWorkCapability;
    readonly actorId: string;
    readonly lifecycleId?: string;
    readonly afterIntentId?: string;
    readonly result: 'committed' | 'refused';
  }[];
  readonly replay: readonly LiveWorkReplayEvent[];
  readonly transitionTimes: readonly RateEntry[];
  readonly recoveryTimes: readonly RateEntry[];
}
export type LiveWorkRecoveryExportOutcome =
  | { readonly outcome: 'available'; readonly state: LiveWorkRecoveryState }
  | {
      readonly outcome:
        | 'invalid'
        | 'forbidden'
        | 'capacity_exceeded'
        | 'rate_limited';
    };
export type LiveWorkRestoreOutcome =
  | { readonly outcome: 'available'; readonly session: LiveWorkSession }
  | {
      readonly outcome:
        | 'invalid'
        | 'forbidden'
        | 'unavailable'
        | 'capacity_exceeded'
        | 'rate_limited';
    };

const capabilities: readonly LiveWorkCapability[] = [
  'join',
  'read',
  'write',
  'watch',
  'follow',
  'announce',
  'history-read',
];
const clone = <T>(value: T): T => structuredClone(value);
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function';
const plain = (value: unknown): value is Record<string, unknown> => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    });
  } catch {
    return false;
  }
};
const only = (value: Record<string, unknown>, keys: readonly string[]) => {
  try {
    const own = Reflect.ownKeys(value);
    return (
      own.every((key) => typeof key === 'string' && keys.includes(key)) &&
      own.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && 'value' in descriptor;
      })
    );
  } catch {
    return false;
  }
};
const validCloseOutcome = (value: unknown): value is LiveWorkPortCloseOutcome =>
  plain(value) &&
  only(value, ['outcome']) &&
  (value.outcome === 'closed' ||
    value.outcome === 'pending' ||
    value.outcome === 'unavailable');

/**
 * One exact Project/Task/surface/session projection. Durable adapters receive
 * material lifecycle/revision intents only; they remain the persistence owner.
 */
export class LiveWorkSession {
  readonly #scope: LiveWorkScope;
  readonly #bounds: LiveWorkBounds;
  readonly #ports: LiveWorkPorts;
  readonly #dependencies: LiveWorkDependencies;
  readonly #participants = new Map<string, Participant>();
  readonly #panes = new Map<string, Map<string, Pane>>();
  readonly #typing = new Map<string, number>();
  readonly #pending = new Map<string, Pending>();
  readonly #lifecycles = new Map<string, Lifecycle>();
  readonly #activeLifecycleByActor = new Map<string, string>();
  readonly #recoveryClosures = new Map<string, Pending>();
  readonly #terminal = new Map<string, TerminalIntent>();
  readonly #settlements = new Map<string, Promise<LiveWorkMutationOutcome>>();
  readonly #replay: LiveWorkReplayEvent[] = [];
  readonly #transitionTimes: RateEntry[] = [];
  readonly #recoveryTimes: RateEntry[] = [];
  #pendingBytes = 0;
  #reservedClosureBytes = 0;
  #lastNow = 0;
  #nextOrdinal = 0;
  #restoreUnavailable = false;
  #closed = false;
  #generation = 0;
  #closeSettlement: Promise<LiveWorkCloseOutcome> | undefined;

  constructor(
    scope: LiveWorkScope,
    bounds: Partial<LiveWorkBounds> = {},
    ports: LiveWorkPorts = {},
    dependencies: LiveWorkDependencies = {},
  ) {
    this.#bounds = Object.freeze({ ...DEFAULT_LIVE_WORK_BOUNDS, ...bounds });
    if (!this.#validBounds() || !this.#scopeOk(scope))
      throw new Error('invalid live-work configuration');
    this.#scope = clone(scope);
    this.#ports = ports;
    this.#dependencies = dependencies;
  }

  static restore(
    scope: LiveWorkScope,
    state: unknown,
    authorization: LiveWorkRecoveryAuthorization,
    now: number,
    bounds: Partial<LiveWorkBounds> = {},
    ports: LiveWorkPorts = {},
    dependencies: LiveWorkDependencies = {},
  ): LiveWorkRestoreOutcome {
    let session: LiveWorkSession;
    try {
      session = new LiveWorkSession(scope, bounds, ports, dependencies);
    } catch {
      return { outcome: 'invalid' };
    }
    const admission = session.#authorizeRecovery(authorization, 'restore', now);
    if (admission) return admission;
    let imported = false;
    try {
      imported = session.#importRecovery(state, now);
    } catch {
      imported = false;
    }
    if (!imported)
      return session.#restoreUnavailable
        ? { outcome: 'unavailable' }
        : { outcome: 'invalid' };
    if (
      !session.#rateAvailable(
        session.#recoveryTimes,
        authorization.recoveryId,
        now,
        session.#bounds.maxRecoveriesPerWindow,
      )
    )
      return { outcome: 'rate_limited' };
    session.#commitTime(session.#recoveryTimes, authorization.recoveryId, now);
    return { outcome: 'available', session };
  }

  get scope(): LiveWorkScope {
    return clone(this.#scope);
  }

  join(
    input: { readonly actorId: string; readonly requestId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const admission = this.#admitActor(
      input,
      ['actorId', 'requestId'],
      authorization,
      'join',
      now,
    );
    if (admission) return admission;
    const identity = this.#resolveIdentity(input.actorId, input.requestId);
    if (!identity) return { outcome: 'unavailable' };
    this.#prune(now);
    const current = this.#participants.get(input.actorId);
    if (current) {
      if (!sameIdentity(current.identity, identity))
        return { outcome: 'identity_changed' };
      // A same-device rejoin is a fresh liveness assertion.  Preserve the
      // occurrence (and therefore its durable history identity), but carry
      // forward the newly issued TTL-closure handle so a later expiry cannot
      // replay a stale credential's closure authority.
      current.identity = clone(identity);
      const lifecycle = this.#activeLifecycle(input.actorId);
      if (lifecycle) {
        lifecycle.identity = clone(identity);
        this.#renewDormantRecoveryClosure(lifecycle);
      }
      current.expiresAt = this.#expiry(now);
      return { outcome: 'refreshed' };
    }
    if (this.#participants.size >= this.#bounds.maxParticipants)
      return { outcome: 'capacity_exceeded' };
    this.#participants.set(input.actorId, {
      identity: clone(identity),
      expiresAt: this.#expiry(now),
      published: false,
    });
    return { outcome: 'joined' };
  }

  heartbeat(
    input: { readonly actorId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const admission = this.#admitActor(
      input,
      ['actorId'],
      authorization,
      'join',
      now,
    );
    if (admission) return admission;
    this.#prune(now);
    const participant = this.#participants.get(input.actorId);
    if (!participant) return { outcome: 'forbidden' };
    participant.expiresAt = this.#expiry(now);
    return { outcome: 'updated' };
  }

  announce(
    input: { readonly actorId: string; readonly requestId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const admission = this.#admitActor(
      input,
      ['actorId', 'requestId'],
      authorization,
      'announce',
      now,
    );
    if (admission) return admission;
    if (!this.#ports.history) return { outcome: 'unavailable' };
    if (!this.#ordinalCapacity(2)) return { outcome: 'capacity_exceeded' };
    if (!this.#replayReservationAvailable())
      return { outcome: 'capacity_exceeded' };
    this.#prune(now);
    const participant = this.#participants.get(input.actorId);
    if (
      !participant ||
      participant.published ||
      this.#activeLifecycleByActor.has(input.actorId)
    )
      return { outcome: 'forbidden' };
    const intent = this.#historyIntent(
      'announce',
      participant.identity,
      input.requestId,
      now,
    );
    const reserve = this.#closureReservation(participant.identity);
    if (!this.#canAdmit(intent, 2, reserve))
      return { outcome: 'capacity_exceeded' };
    const lifecycle: Lifecycle = {
      announcementId: intent.intentId,
      identity: clone(participant.identity),
      announceRequestId: input.requestId,
      reservedClosureBytes: reserve,
      state: 'announcing',
    };
    this.#lifecycles.set(intent.intentId, lifecycle);
    this.#activeLifecycleByActor.set(input.actorId, intent.intentId);
    this.#reservedClosureBytes += reserve;
    return this.#insertAndAttempt({
      intent,
      port: 'history',
      capability: 'announce',
      actorId: input.actorId,
      lifecycleId: intent.intentId,
      bytes: this.#intentBytes(intent),
    });
  }

  withdrawAnnouncement(
    input: { readonly actorId: string; readonly requestId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    return this.#leave('withdraw', input, authorization, now);
  }

  depart(
    input: { readonly actorId: string; readonly requestId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    return this.#leave('depart', input, authorization, now);
  }

  /**
   * Settles an asynchronous durable port before returning.  The synchronous
   * operations remain the pure/in-memory compatibility surface; callers that
   * compose a remote authority must use these methods so no Promise is ever
   * mistaken for a durable receipt.
   */
  async announceAsync(
    input: { readonly actorId: string; readonly requestId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): Promise<LiveWorkMutationOutcome> {
    return this.#settleActor(this.announce(input, authorization, now));
  }

  /** Settles a runtime-prepared announce without spending another public transition. */
  async settlePreparedAsync(
    intentId: string,
    authorization: LiveWorkAuthorization,
    now: number,
  ): Promise<LiveWorkMutationOutcome> {
    if (!this.#safeTime(now) || !this.#intentIdOk(intentId))
      return { outcome: 'invalid' };
    const pending = this.#pending.get(intentId);
    const terminal = this.#terminal.get(intentId);
    const record = pending ?? terminal;
    if (
      !record ||
      !this.#authOk(authorization) ||
      !sameScope(this.#scope, authorization.scope) ||
      authorization.actorId !== record.actorId ||
      !authorization.capabilities.has(record.capability)
    )
      return { outcome: 'forbidden' };
    this.#prune(now);
    return pending
      ? this.#settlePending(pending)
      : this.#terminalOutcome(terminal!);
  }

  /** Drops a prepared announce that was never armed for durable dispatch. */
  discardPrepared(intentId: string): boolean {
    const pending = this.#pending.get(intentId);
    if (pending?.intent.kind !== 'announce') return false;
    this.#forgetPending(intentId);
    this.#finishLifecycle(pending.lifecycleId);
    return true;
  }

  async withdrawAnnouncementAsync(
    input: { readonly actorId: string; readonly requestId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): Promise<LiveWorkMutationOutcome> {
    return this.#settleActor(
      this.withdrawAnnouncement(input, authorization, now),
    );
  }

  async departAsync(
    input: { readonly actorId: string; readonly requestId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): Promise<LiveWorkMutationOutcome> {
    return this.#settleActor(this.depart(input, authorization, now));
  }

  watch(
    input: {
      readonly actorId: string;
      readonly paneId: string;
      readonly targetActorId: string;
    },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    return this.#setPane('watching', input, authorization, now);
  }

  follow(
    input: {
      readonly actorId: string;
      readonly paneId: string;
      readonly targetActorId: string;
    },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    return this.#setPane('following', input, authorization, now);
  }

  localInput(
    input: { readonly actorId: string; readonly paneId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const admission = this.#admitActor(
      input,
      ['actorId', 'paneId'],
      authorization,
      undefined,
      now,
    );
    if (admission) return admission;
    this.#prune(now);
    const panes = this.#panes.get(input.actorId);
    panes?.delete(input.paneId);
    if (panes?.size === 0) this.#panes.delete(input.actorId);
    return { outcome: 'cleared' };
  }

  setTyping(
    input: { readonly actorId: string; readonly active: boolean },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const admission = this.#admitActor(
      input,
      ['actorId', 'active'],
      authorization,
      'write',
      now,
    );
    if (admission) return admission;
    this.#prune(now);
    if (!this.#participants.get(input.actorId)?.published)
      return { outcome: 'forbidden' };
    if (
      input.active &&
      !this.#typing.has(input.actorId) &&
      this.#typing.size >= this.#bounds.maxTyping
    )
      return { outcome: 'capacity_exceeded' };
    if (input.active) this.#typing.set(input.actorId, this.#typingExpiry(now));
    else this.#typing.delete(input.actorId);
    return { outcome: 'updated' };
  }

  referenceRevision(
    input: {
      readonly actorId: string;
      readonly requestId: string;
      readonly reference: ImmutableRevisionReference;
    },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const admission = this.#admitActor(
      input,
      ['actorId', 'requestId', 'reference'],
      authorization,
      'write',
      now,
    );
    if (admission) return admission;
    if (!this.#ports.revision) return { outcome: 'unavailable' };
    if (!this.#ordinalCapacity(1)) return { outcome: 'capacity_exceeded' };
    this.#prune(now);
    const participant = this.#participants.get(input.actorId);
    if (!participant?.published) return { outcome: 'forbidden' };
    const revision = this.#resolveRevision(
      input.reference,
      participant.identity,
    );
    if (!revision) return { outcome: 'invalid' };
    const intent = this.#revisionIntent(
      participant.identity,
      input.requestId,
      revision.revisionId,
      now,
    );
    if (!this.#canAdmit(intent, 1, 0)) return { outcome: 'capacity_exceeded' };
    return this.#insertAndAttempt({
      intent,
      port: 'revision',
      capability: 'write',
      actorId: input.actorId,
      bytes: this.#intentBytes(intent),
    });
  }

  async referenceRevisionAsync(
    input: {
      readonly actorId: string;
      readonly requestId: string;
      readonly reference: ImmutableRevisionReference;
    },
    authorization: LiveWorkAuthorization,
    now: number,
  ): Promise<LiveWorkMutationOutcome> {
    return this.#settleActor(this.referenceRevision(input, authorization, now));
  }

  /** Deliberately materialize a work terminal state; leaving never implies it. */
  finish(
    input: {
      readonly actorId: string;
      readonly requestId: string;
      readonly outcome: 'completed' | 'failed' | 'cancelled';
      readonly reference?: ImmutableRevisionReference;
    },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const admission = this.#admitActor(
      input,
      ['actorId', 'requestId', 'outcome', 'reference'],
      authorization,
      'write',
      now,
    );
    if (admission) return admission;
    if (!this.#ports.history) return { outcome: 'unavailable' };
    if (!['completed', 'failed', 'cancelled'].includes(input.outcome))
      return { outcome: 'invalid' };
    if (!this.#ordinalCapacity(1)) return { outcome: 'capacity_exceeded' };
    this.#prune(now);
    const participant = this.#participants.get(input.actorId);
    if (!participant?.published) return { outcome: 'forbidden' };
    const revision = input.reference
      ? this.#resolveRevision(input.reference, participant.identity)
      : undefined;
    if (input.reference && !revision) return { outcome: 'invalid' };
    const intent = this.#historyIntent(
      'work-finished',
      participant.identity,
      input.requestId,
      now,
      undefined,
      input.outcome,
      revision?.revisionId,
    );
    if (!this.#canAdmit(intent, 1, 0)) return { outcome: 'capacity_exceeded' };
    return this.#insertAndAttempt({
      intent,
      port: 'history',
      capability: 'write',
      actorId: input.actorId,
      bytes: this.#intentBytes(intent),
    });
  }

  async finishAsync(
    input: {
      readonly actorId: string;
      readonly requestId: string;
      readonly outcome: 'completed' | 'failed' | 'cancelled';
      readonly reference?: ImmutableRevisionReference;
    },
    authorization: LiveWorkAuthorization,
    now: number,
  ): Promise<LiveWorkMutationOutcome> {
    return this.#settleActor(this.finish(input, authorization, now));
  }

  reconcile(
    intentId: string,
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    if (!this.#safeTime(now) || !this.#intentIdOk(intentId))
      return { outcome: 'invalid' };
    const pending = this.#pending.get(intentId);
    const terminal = this.#terminal.get(intentId);
    const record = pending ?? terminal;
    let authorized = false;
    try {
      authorized =
        record !== undefined &&
        this.#authOk(authorization) &&
        sameScope(this.#scope, authorization.scope) &&
        authorization.actorId === record.actorId &&
        authorization.capabilities.has(record.capability);
    } catch {
      return { outcome: 'invalid' };
    }
    if (!authorized) return { outcome: 'forbidden' };
    if (
      !this.#rateAvailable(
        this.#transitionTimes,
        authorization.actorId,
        now,
        this.#bounds.maxTransitionsPerWindow,
      )
    )
      return { outcome: 'rate_limited' };
    this.#commitTime(this.#transitionTimes, authorization.actorId, now);
    this.#prune(now);
    return pending ? this.#attempt(pending) : this.#terminalOutcome(terminal!);
  }

  recover(
    intentId: string,
    authorization: LiveWorkRecoveryAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    if (!this.#safeTime(now) || !this.#intentIdOk(intentId))
      return { outcome: 'invalid' };
    const pending = this.#pending.get(intentId);
    const terminal = this.#terminal.get(intentId);
    if (!pending && !terminal) return { outcome: 'forbidden' };
    const admission = this.#admitRecovery(authorization, 'reconcile', now);
    if (admission) return admission;
    this.#prune(now);
    return pending ? this.#attempt(pending) : this.#terminalOutcome(terminal!);
  }

  async reconcileAsync(
    intentId: string,
    authorization: LiveWorkAuthorization,
    now: number,
  ): Promise<LiveWorkMutationOutcome> {
    return this.#settleActor(this.reconcile(intentId, authorization, now));
  }

  async recoverAsync(
    intentId: string,
    authorization: LiveWorkRecoveryAuthorization,
    now: number,
  ): Promise<LiveWorkMutationOutcome> {
    const outcome = this.recover(intentId, authorization, now);
    if (outcome.outcome !== 'degraded' || outcome.state !== 'indeterminate')
      return outcome;
    const pending = this.#pending.get(outcome.intentId);
    return pending ? this.#settlePending(pending) : outcome;
  }

  close(): Promise<LiveWorkCloseOutcome> {
    if (this.#closeSettlement) return this.#closeSettlement;
    this.#closed = true;
    this.#generation += 1;
    const ports = [this.#ports.history, this.#ports.revision].filter(
      (port): port is NonNullable<typeof port> => port !== undefined,
    );
    this.#closeSettlement = Promise.all(
      ports.map(async (port) => {
        if (!port.close) return { outcome: 'closed' } as const;
        try {
          const result = await port.close();
          return validCloseOutcome(result)
            ? result
            : ({ outcome: 'unavailable' } as const);
        } catch {
          return { outcome: 'unavailable' } as const;
        }
      }),
    ).then((settled) => {
      if (settled.some((result) => result.outcome === 'unavailable'))
        return { outcome: 'unavailable' };
      if (settled.some((result) => result.outcome === 'pending'))
        return { outcome: 'pending' };
      return { outcome: 'closed' };
    });
    return this.#closeSettlement;
  }

  snapshot(
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkReadOutcome {
    return this.#snapshot(authorization, now, true);
  }

  /**
   * Builds the projection that accompanies an already-admitted mutation.
   * This must not spend a second transition admission for one command.
   */
  snapshotAfterMutation(
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkReadOutcome {
    // Checkpoint export may have sampled a newer clock between the mutation
    // and its reply projection. A runtime clock regression must not turn an
    // otherwise admitted command into an invalid response.
    return this.#snapshot(authorization, this.#clampNow(now), false);
  }

  #snapshot(
    authorization: LiveWorkAuthorization,
    now: number,
    chargeRead: boolean,
  ): LiveWorkReadOutcome {
    const admission = this.#admitRead(authorization, 'read', now, chargeRead);
    if (admission) return admission;
    this.#prune(now);
    const participants = [...this.#participants.values()]
      .filter(
        (participant) =>
          participant.published ||
          participant.identity.actor.actorId === authorization.actorId,
      )
      .map((participant) => ({
        actor: clone(participant.identity.actor),
        work: workProjection(participant.identity),
        publication: participant.published
          ? ('published' as const)
          : ('private' as const),
      }));
    return {
      outcome: 'available',
      snapshot: clone({
        schemaVersion: LIVE_WORK_SESSION_SCHEMA_VERSION,
        scope: this.scope,
        state: this.#pending.size
          ? ('degraded' as const)
          : participants.length
            ? ('active' as const)
            : ('stale' as const),
        participants,
        panes: this.#paneProjection(authorization.actorId),
        typing: [...this.#typing.entries()]
          .filter(([actorId]) => this.#participants.get(actorId)?.published)
          .map(([actorId, expiresAt]) => ({ actorId, expiresAt })),
      }),
    };
  }

  replay(
    authorization: LiveWorkAuthorization,
    now: number,
    limit = this.#bounds.maxReplayEvents,
  ): LiveWorkReplayOutcome {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > this.#bounds.maxReplayEvents
    )
      return { outcome: 'invalid' };
    const admission = this.#admitRead(authorization, 'history-read', now);
    if (admission) return admission;
    this.#prune(now);
    return { outcome: 'available', events: clone(this.#replay.slice(-limit)) };
  }

  exportRecovery(
    authorization: LiveWorkRecoveryAuthorization,
    now: number,
  ): LiveWorkRecoveryExportOutcome {
    return this.#exportRecovery(authorization, now, true);
  }

  /** Runtime-private checkpoint path; preserves authorization without a public rate charge. */
  checkpointRecovery(
    authorization: LiveWorkRecoveryAuthorization,
    now: number,
  ): LiveWorkRecoveryExportOutcome {
    return this.#exportRecovery(authorization, now, false);
  }

  #exportRecovery(
    authorization: LiveWorkRecoveryAuthorization,
    now: number,
    chargeRecovery: boolean,
  ): LiveWorkRecoveryExportOutcome {
    const admission = this.#admitRecovery(
      authorization,
      'export',
      now,
      chargeRecovery,
    );
    if (admission) return admission;
    this.#prune(now);
    // Export materializes every still-reserved closure. Do not consume an
    // ordinal unless every such allocation remains representable.
    if (!this.#ordinalCapacity(0)) return { outcome: 'capacity_exceeded' };
    const pending = [...this.#pending.values()].map(recoveryPending);
    const lifecycles: RecoveryLifecycle[] = [];
    for (const lifecycle of this.#lifecycles.values()) {
      let projected: RecoveryLifecycle = clone(lifecycle);
      if (!lifecycle.closureId) {
        const closure = this.#dormantRecoveryClosure(lifecycle, now);
        pending.push({
          ...recoveryPending(closure),
        });
        projected = {
          ...projected,
          closureId: closure.intent.intentId,
          state: 'closing',
          reservedClosureBytes: 0,
        };
      }
      lifecycles.push(projected);
    }
    return {
      outcome: 'available',
      state: clone({
        schemaVersion: LIVE_WORK_RECOVERY_SCHEMA_VERSION,
        scope: this.scope,
        safeClock: this.#lastNow,
        nextOrdinal: this.#nextOrdinal,
        pending,
        lifecycles,
        terminal: [...this.#terminal.values()].map((terminal) => {
          const { receipt: _receipt, ...recoverable } = terminal;
          return clone(recoverable);
        }),
        replay: this.#replay,
        transitionTimes: this.#transitionTimes,
        recoveryTimes: this.#recoveryTimes,
      }),
    };
  }

  #leave(
    mode: 'withdraw' | 'depart',
    input: { readonly actorId: string; readonly requestId: string },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const admission = this.#admitActor(
      input,
      ['actorId', 'requestId'],
      authorization,
      mode === 'withdraw' ? 'announce' : 'join',
      now,
    );
    if (admission) return admission;
    this.#prune(now);
    const lifecycle = this.#activeLifecycle(input.actorId);
    const participant = this.#participants.get(input.actorId);
    const priorClosure = this.#terminalClosureForActor(
      input.actorId,
      participant?.identity.occurrenceId,
      mode === 'withdraw' ? 'announce' : 'join',
    );
    if (!participant && !lifecycle)
      return priorClosure
        ? this.#terminalOutcome(priorClosure)
        : { outcome: 'forbidden' };
    if (!lifecycle) {
      if (mode === 'depart') return this.#removeParticipant(input.actorId, now);
      return priorClosure
        ? this.#terminalOutcome(priorClosure)
        : { outcome: 'forbidden' };
    }
    if (lifecycle.closureId)
      return this.#pendingOrTerminal(lifecycle.closureId);
    if (!this.#ports.history) return { outcome: 'unavailable' };
    // A request can be valid yet larger than a legacy reservation only if the
    // reservation calculation is wrong. Fence that before changing presence.
    if (!this.#closureFitsReservation(lifecycle, input.requestId, now))
      return { outcome: 'capacity_exceeded' };
    const closure = this.#takeClosure(
      lifecycle,
      input.requestId,
      now,
      mode === 'withdraw' ? 'withdrawn' : 'departed',
    );
    if (!this.#convertClosureReservation(lifecycle, closure))
      return { outcome: 'capacity_exceeded' };
    if (mode === 'depart') this.#removeParticipant(input.actorId, now);
    else this.#hideParticipant(input.actorId, now);
    lifecycle.closureId = closure.intentId;
    lifecycle.state = 'closing';
    const pending: Pending = {
      intent: closure,
      port: 'history',
      capability: mode === 'withdraw' ? 'announce' : 'join',
      actorId: input.actorId,
      lifecycleId: lifecycle.announcementId,
      afterIntentId: lifecycle.announcementId,
      bytes: this.#intentBytes(closure),
    };
    this.#pending.set(closure.intentId, pending);
    this.#pendingBytes += pending.bytes;
    return this.#attempt(pending);
  }

  #setPane(
    state: 'watching' | 'following',
    input: {
      readonly actorId: string;
      readonly paneId: string;
      readonly targetActorId: string;
    },
    authorization: LiveWorkAuthorization,
    now: number,
  ): LiveWorkMutationOutcome {
    const capability = state === 'watching' ? 'watch' : 'follow';
    const admission = this.#admitActor(
      input,
      ['actorId', 'paneId', 'targetActorId'],
      authorization,
      capability,
      now,
    );
    if (admission) return admission;
    this.#prune(now);
    if (!this.#participants.get(input.targetActorId)?.published)
      return { outcome: 'forbidden' };
    const exists = this.#panes.get(input.actorId)?.has(input.paneId);
    if (!exists && this.#paneCount() >= this.#bounds.maxViewerPanes)
      return { outcome: 'capacity_exceeded' };
    let panes = this.#panes.get(input.actorId);
    if (!panes) {
      panes = new Map();
      this.#panes.set(input.actorId, panes);
    }
    panes.set(input.paneId, {
      state,
      targetActorId: input.targetActorId,
      expiresAt: this.#expiry(now),
    });
    return { outcome: 'updated' };
  }

  #insertAndAttempt(pending: Pending): LiveWorkMutationOutcome {
    this.#pending.set(pending.intent.intentId, clone(pending));
    this.#pendingBytes += pending.bytes;
    return this.#attempt(pending);
  }

  async #settleActor(
    outcome: LiveWorkMutationOutcome,
  ): Promise<LiveWorkMutationOutcome> {
    if (outcome.outcome !== 'degraded' || outcome.state !== 'indeterminate')
      return outcome;
    const pending = this.#pending.get(outcome.intentId);
    return pending ? this.#settlePending(pending) : outcome;
  }

  #settlePending(pending: Pending): Promise<LiveWorkMutationOutcome> {
    const existing = this.#settlements.get(pending.intent.intentId);
    if (existing) return existing;
    const settlement = this.#attemptAsync(pending);
    this.#settlements.set(pending.intent.intentId, settlement);
    void settlement.then(
      () => {
        if (this.#settlements.get(pending.intent.intentId) === settlement)
          this.#settlements.delete(pending.intent.intentId);
      },
      () => {
        if (this.#settlements.get(pending.intent.intentId) === settlement)
          this.#settlements.delete(pending.intent.intentId);
      },
    );
    return settlement;
  }

  #attempt(pending: Pending): LiveWorkMutationOutcome {
    if (pending.afterIntentId) {
      if (this.#pending.has(pending.afterIntentId)) {
        return {
          outcome: 'degraded',
          intentId: pending.intent.intentId,
          state: 'indeterminate',
        };
      }
      const dependency = this.#terminal.get(pending.afterIntentId);
      if (dependency?.result !== 'committed') {
        this.#forgetPending(pending.intent.intentId);
        this.#rememberTerminal(pending, {
          state: 'refused',
          reason: 'dependency_refused',
        });
        this.#finishLifecycle(pending.lifecycleId);
        return {
          outcome: 'degraded',
          intentId: pending.intent.intentId,
          state: 'refused',
        };
      }
    }
    const adapter =
      pending.port === 'history' ? this.#ports.history : this.#ports.revision;
    if (!adapter) return { outcome: 'unavailable' };
    if (adapter.asynchronous)
      return {
        outcome: 'degraded',
        intentId: pending.intent.intentId,
        state: 'indeterminate',
      };
    let result: DurablePortOutcome;
    try {
      const value = adapter.commit(clone(pending.intent) as never);
      result =
        !isPromiseLike(value) && this.#portOutcomeOk(value)
          ? value
          : { state: 'indeterminate' };
    } catch {
      result = { state: 'indeterminate' };
    }
    return this.#applyPortResult(pending, result);
  }

  async #attemptAsync(pending: Pending): Promise<LiveWorkMutationOutcome> {
    if (this.#closed)
      return {
        outcome: 'degraded',
        intentId: pending.intent.intentId,
        state: 'indeterminate',
      };
    if (pending.afterIntentId) {
      if (this.#pending.has(pending.afterIntentId))
        return {
          outcome: 'degraded',
          intentId: pending.intent.intentId,
          state: 'indeterminate',
        };
      const dependency = this.#terminal.get(pending.afterIntentId);
      if (dependency?.result !== 'committed')
        return this.#applyPortResult(pending, {
          state: 'refused',
          reason: 'dependency_refused',
        });
    }
    const adapter =
      pending.port === 'history' ? this.#ports.history : this.#ports.revision;
    if (!adapter)
      return {
        outcome: 'degraded',
        intentId: pending.intent.intentId,
        state: 'indeterminate',
      };
    const generation = this.#generation;
    let result: DurablePortOutcome;
    try {
      const value = await adapter.commit(clone(pending.intent) as never);
      result = this.#portOutcomeOk(value) ? value : { state: 'indeterminate' };
    } catch {
      result = { state: 'indeterminate' };
    }
    // The authority may finish after a close; its receipt remains remote truth
    // but must not resurrect or disclose this closed projection.
    if (this.#closed || generation !== this.#generation)
      return {
        outcome: 'degraded',
        intentId: pending.intent.intentId,
        state: 'indeterminate',
      };
    const current = this.#pending.get(pending.intent.intentId);
    if (current !== pending)
      return this.#terminal.get(pending.intent.intentId)
        ? this.#terminalOutcome(this.#terminal.get(pending.intent.intentId)!)
        : {
            outcome: 'degraded',
            intentId: pending.intent.intentId,
            state: 'indeterminate',
          };
    return this.#applyPortResult(pending, result);
  }

  #applyPortResult(
    pending: Pending,
    result: DurablePortOutcome,
  ): LiveWorkMutationOutcome {
    if (result.state === 'indeterminate')
      return {
        outcome: 'degraded',
        intentId: pending.intent.intentId,
        state: 'indeterminate',
      };
    this.#forgetPending(pending.intent.intentId);
    this.#rememberTerminal(pending, result);
    if (result.state === 'refused') {
      if (pending.intent.kind === 'announce')
        this.#cancelLifecycleAfterAnnouncementRefusal(pending);
      else if (pending.intent.kind === 'departure')
        this.#finishLifecycle(pending.lifecycleId);
      return {
        outcome: 'degraded',
        intentId: pending.intent.intentId,
        state: 'refused',
      };
    }
    if (pending.intent.kind === 'announce') {
      this.#confirmMaterial(pending.intent);
      const lifecycle = this.#lifecycles.get(pending.lifecycleId ?? '');
      if (lifecycle) {
        lifecycle.state = lifecycle.closureId ? 'closing' : 'published';
        const participant = this.#participants.get(pending.actorId);
        if (participant && !lifecycle.closureId) participant.published = true;
        if (lifecycle.closureId) {
          const closure = this.#pending.get(lifecycle.closureId);
          if (closure) return this.#attempt(closure);
        }
      }
    } else if (pending.intent.kind === 'departure') {
      this.#confirmMaterial(pending.intent);
      this.#finishLifecycle(pending.lifecycleId);
    } else if (pending.intent.kind === 'work-finished') {
      this.#confirmMaterial(pending.intent);
    }
    return {
      outcome: 'updated',
      ...(result.receipt !== undefined
        ? { receipt: clone(result.receipt) }
        : {}),
    };
  }

  #cancelLifecycleAfterAnnouncementRefusal(pending: Pending): void {
    const lifecycle = this.#lifecycles.get(pending.lifecycleId ?? '');
    if (!lifecycle) return;
    if (lifecycle.closureId) {
      const closure = this.#pending.get(lifecycle.closureId);
      this.#forgetPending(lifecycle.closureId);
      if (closure)
        this.#rememberTerminal(closure, {
          state: 'refused',
          reason: 'announcement_refused',
        });
    }
    this.#finishLifecycle(lifecycle.announcementId);
  }

  #confirmMaterial(intent: LiveWorkHistoryIntent): void {
    const insertion = this.#replay.findIndex(
      (event) => event.ordinal > intent.ordinal,
    );
    this.#replay.splice(
      insertion < 0 ? this.#replay.length : insertion,
      0,
      clone(intent),
    );
    while (this.#replay.length > this.#bounds.maxReplayEvents) {
      if (!this.#evictReplayBlock()) return;
    }
  }

  #finishLifecycle(lifecycleId: string | undefined): void {
    if (!lifecycleId) return;
    const lifecycle = this.#lifecycles.get(lifecycleId);
    if (!lifecycle) return;
    this.#releaseClosureReservation(lifecycle);
    this.#lifecycles.delete(lifecycleId);
    this.#recoveryClosures.delete(lifecycleId);
    if (
      this.#activeLifecycleByActor.get(lifecycle.identity.actor.actorId) ===
      lifecycleId
    )
      this.#activeLifecycleByActor.delete(lifecycle.identity.actor.actorId);
  }

  #prune(now: number): void {
    this.#pruneRateLedger(this.#transitionTimes, now);
    this.#pruneRateLedger(this.#recoveryTimes, now);
    for (const [actorId, participant] of [...this.#participants]) {
      if (participant.expiresAt > now) continue;
      const lifecycle = this.#activeLifecycle(actorId);
      if (lifecycle && !lifecycle.closureId && this.#ports.history) {
        const closure = this.#takeClosure(
          lifecycle,
          lifecycle.identity.ttlClosureRequestId,
          now,
          'expired',
        );
        this.#convertClosureReservation(lifecycle, closure);
        lifecycle.closureId = closure.intentId;
        lifecycle.state = 'closing';
        const pending: Pending = {
          intent: closure,
          port: 'history',
          capability: 'join',
          actorId,
          lifecycleId: lifecycle.announcementId,
          afterIntentId: lifecycle.announcementId,
          bytes: this.#intentBytes(closure),
        };
        this.#pending.set(closure.intentId, pending);
        this.#pendingBytes += pending.bytes;
      }
      // A published participant can only exist with a reserved/retained closure.
      if (!participant.published || !lifecycle || lifecycle.closureId)
        this.#removeParticipant(actorId, now);
    }
    for (const [actorId, panes] of this.#panes) {
      for (const [paneId, pane] of panes) {
        if (pane.expiresAt > now) continue;
        if (pane.state === 'paused') panes.delete(paneId);
        else {
          pane.state = 'paused';
          delete pane.targetActorId;
          pane.reason = 'expired';
          pane.expiresAt = this.#pausedExpiry(now);
        }
      }
      if (!panes.size) this.#panes.delete(actorId);
    }
    for (const [actorId, expiresAt] of this.#typing)
      if (expiresAt <= now) this.#typing.delete(actorId);
  }

  #removeParticipant(actorId: string, now: number): LiveWorkMutationOutcome {
    this.#participants.delete(actorId);
    this.#typing.delete(actorId);
    this.#pauseTarget(actorId, now);
    return { outcome: 'departed' };
  }

  #hideParticipant(actorId: string, now: number): void {
    const participant = this.#participants.get(actorId);
    if (participant) participant.published = false;
    this.#typing.delete(actorId);
    this.#pauseTarget(actorId, now);
  }

  #pauseTarget(actorId: string, now: number): void {
    for (const panes of this.#panes.values()) {
      for (const pane of panes.values()) {
        if (pane.targetActorId !== actorId) continue;
        pane.state = 'paused';
        delete pane.targetActorId;
        pane.reason = 'target_departed';
        pane.expiresAt = this.#pausedExpiry(now);
      }
    }
  }

  #admitActor(
    input: unknown,
    keys: readonly string[],
    authorization: LiveWorkAuthorization,
    capability: LiveWorkCapability | undefined,
    now: number,
  ): LiveWorkMutationOutcome | undefined {
    try {
      if (this.#closed) return { outcome: 'unavailable' };
      if (!this.#safeTime(now)) return { outcome: 'invalid' };
      if (!plain(input) || !only(input, keys)) return { outcome: 'invalid' };
      const actorId = input.actorId;
      if (
        !this.#idOk(actorId) ||
        !this.#authOk(authorization) ||
        !sameScope(this.#scope, authorization.scope) ||
        authorization.actorId !== actorId ||
        (capability && !authorization.capabilities.has(capability))
      )
        return { outcome: 'forbidden' };
      if (
        ['requestId', 'paneId', 'targetActorId'].some(
          (key) => key in input && !this.#idOk(input[key]),
        ) ||
        ('active' in input && typeof input.active !== 'boolean') ||
        ('reference' in input &&
          !this.#revisionReferenceInputOk(input.reference))
      )
        return { outcome: 'invalid' };
      if (
        !this.#rateAvailable(
          this.#transitionTimes,
          actorId,
          now,
          this.#bounds.maxTransitionsPerWindow,
        )
      )
        return { outcome: 'rate_limited' };
      this.#commitTime(this.#transitionTimes, actorId, now);
      return undefined;
    } catch {
      return { outcome: 'invalid' };
    }
  }

  #admitRead(
    authorization: LiveWorkAuthorization,
    capability: 'read' | 'history-read',
    now: number,
    charge = true,
  ):
    | { readonly outcome: 'unavailable' | 'invalid' | 'rate_limited' }
    | undefined {
    try {
      if (!this.#safeTime(now)) return { outcome: 'invalid' };
      if (
        !this.#authOk(authorization) ||
        !sameScope(this.#scope, authorization.scope) ||
        !authorization.capabilities.has(capability)
      )
        return { outcome: 'unavailable' };
      if (
        charge &&
        !this.#rateAvailable(
          this.#transitionTimes,
          authorization.actorId,
          now,
          this.#bounds.maxTransitionsPerWindow,
        )
      )
        return { outcome: 'rate_limited' };
      if (charge)
        this.#commitTime(this.#transitionTimes, authorization.actorId, now);
      return undefined;
    } catch {
      return { outcome: 'invalid' };
    }
  }

  #admitRecovery(
    authorization: LiveWorkRecoveryAuthorization,
    operation: 'export' | 'restore' | 'reconcile',
    now: number,
    charge = true,
  ):
    | { readonly outcome: 'invalid' | 'forbidden' | 'rate_limited' }
    | undefined {
    const authorizationFailure = this.#authorizeRecovery(
      authorization,
      operation,
      now,
    );
    if (authorizationFailure) return authorizationFailure;
    if (
      charge &&
      !this.#rateAvailable(
        this.#recoveryTimes,
        authorization.recoveryId,
        now,
        this.#bounds.maxRecoveriesPerWindow,
      )
    )
      return { outcome: 'rate_limited' };
    if (charge)
      this.#commitTime(this.#recoveryTimes, authorization.recoveryId, now);
    return undefined;
  }

  #authorizeRecovery(
    authorization: LiveWorkRecoveryAuthorization,
    operation: 'export' | 'restore' | 'reconcile',
    now: number,
  ): { readonly outcome: 'invalid' | 'forbidden' } | undefined {
    try {
      if (!this.#safeTime(now)) return { outcome: 'invalid' };
      if (
        !this.#recoveryAuthOk(authorization) ||
        !sameScope(this.#scope, authorization.scope)
      )
        return { outcome: 'forbidden' };
      let allowed = false;
      try {
        allowed =
          this.#dependencies.recoveryAuthority?.authorize({
            authorization: clone(authorization),
            operation,
            scope: this.scope,
          }) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) return { outcome: 'forbidden' };
      return undefined;
    } catch {
      return { outcome: 'invalid' };
    }
  }

  #safeTime(now: unknown): now is number {
    return (
      typeof now === 'number' &&
      Number.isSafeInteger(now) &&
      now >= this.#lastNow &&
      now >= 0 &&
      now <=
        Number.MAX_SAFE_INTEGER -
          Math.max(
            this.#bounds.ttlMs,
            this.#bounds.pausedTtlMs,
            this.#bounds.typingTtlMs,
          )
    );
  }

  #clampNow(now: number): number {
    return Number.isSafeInteger(now) && now >= 0
      ? Math.max(now, this.#lastNow)
      : now;
  }

  #rateAvailable(
    times: readonly RateEntry[],
    _principalId: string,
    now: number,
    maximum: number,
  ): boolean {
    let retained = 0;
    for (const entry of times)
      if (entry.at > now - this.#bounds.rateWindowMs) retained += 1;
    return retained < maximum;
  }

  #commitTime(times: RateEntry[], principalId: string, now: number): void {
    this.#pruneRateLedger(times, now);
    times.push({ principalId, at: now });
    while (
      times.length >
      (times === this.#recoveryTimes
        ? this.#bounds.maxRecoveryTimestamps
        : this.#bounds.maxTransitionTimestamps)
    )
      times.shift();
    this.#lastNow = now;
  }

  #pruneRateLedger(times: RateEntry[], now: number): void {
    while (
      times[0] !== undefined &&
      times[0].at <= now - this.#bounds.rateWindowMs
    )
      times.shift();
  }

  #resolveIdentity(
    actorId: string,
    requestId: string,
  ): LiveWorkIdentity | undefined {
    try {
      let result: ReturnType<LiveWorkIdentityAuthority['resolve']>;
      try {
        result = this.#dependencies.identityAuthority?.resolve({
          actorId,
          requestId,
          scope: this.scope,
        }) ?? { state: 'UNAVAILABLE' };
      } catch {
        return undefined;
      }
      if (
        !plain(result) ||
        !only(
          result,
          result.state === 'AVAILABLE' ? ['state', 'identity'] : ['state'],
        ) ||
        result.state !== 'AVAILABLE' ||
        !this.#identityOk(result.identity) ||
        result.identity.actor.actorId !== actorId ||
        result.identity.sessionId !== this.#scope.sessionId ||
        result.identity.startedAt > this.#lastNow
      )
        return undefined;
      return clone(result.identity);
    } catch {
      return undefined;
    }
  }

  #resolveRevision(
    reference: unknown,
    identity: LiveWorkIdentity,
  ): CommittedRevision | undefined {
    try {
      if (
        !plain(reference) ||
        !only(reference, ['revisionId', 'verification']) ||
        !this.#revisionIdOk(reference.revisionId)
      )
        return undefined;
      let result: RevisionReferenceResolution;
      try {
        result = this.#dependencies.revisionAuthority?.resolveEvidence(
          clone(reference),
        ) ?? { state: 'UNVERIFIED', reason: 'unverified_reference' };
      } catch {
        return undefined;
      }
      if (
        !plain(result) ||
        !only(
          result,
          result.state === 'AVAILABLE'
            ? ['state', 'revision']
            : ['state', 'reason', 'revisionId'],
        ) ||
        result.state !== 'AVAILABLE' ||
        !plain(result.revision) ||
        result.revision.revisionId !== reference.revisionId ||
        !plain(result.revision.scope) ||
        !plain(result.revision.correlation)
      )
        return undefined;
      const revision = result.revision;
      if (
        revision.scope.projectId !== this.#scope.projectId ||
        revision.scope.taskId !== this.#scope.taskId ||
        revision.correlation.projectId !== this.#scope.projectId ||
        revision.correlation.taskId !== this.#scope.taskId ||
        revision.correlation.agentSessionId !== this.#scope.sessionId ||
        revision.correlation.runId !== identity.runId
      )
        return undefined;
      return clone(revision);
    } catch {
      return undefined;
    }
  }

  #revisionReferenceInputOk(
    value: unknown,
  ): value is ImmutableRevisionReference {
    return (
      plain(value) &&
      only(value, ['revisionId', 'verification']) &&
      this.#revisionIdOk(value.revisionId) &&
      (value.verification === 'verified' || value.verification === 'unverified')
    );
  }

  #historyIntent(
    kind: LiveWorkHistoryIntent['kind'],
    identity: LiveWorkIdentity,
    requestId: string,
    occurredAt: number,
    presenceReason?: LiveWorkHistoryIntent['presenceReason'],
    finishOutcome?: LiveWorkHistoryIntent['finishOutcome'],
    revisionId?: EvidenceRevisionId,
  ): LiveWorkHistoryIntent {
    return this.#historyIntentAt(
      kind,
      identity,
      requestId,
      occurredAt,
      this.#takeOrdinal(),
      presenceReason,
      finishOutcome,
      revisionId,
    );
  }

  #historyIntentAt(
    kind: LiveWorkHistoryIntent['kind'],
    identity: LiveWorkIdentity,
    requestId: string,
    occurredAt: number,
    ordinal: number,
    presenceReason?: LiveWorkHistoryIntent['presenceReason'],
    finishOutcome?: LiveWorkHistoryIntent['finishOutcome'],
    revisionId?: EvidenceRevisionId,
  ): LiveWorkHistoryIntent {
    const intent: Omit<LiveWorkHistoryIntent, 'intentId'> = {
      kind,
      requestId,
      occurrenceId: identity.occurrenceId,
      ordinal,
      scope: this.scope,
      actor: clone(identity.actor),
      work: workProjection(identity),
      occurredAt,
      ...(presenceReason ? { presenceReason } : {}),
      ...(finishOutcome ? { finishOutcome } : {}),
      ...(revisionId ? { revisionId } : {}),
    };
    return { ...intent, intentId: digestIntent(intent) };
  }

  #dormantRecoveryClosure(lifecycle: Lifecycle, now: number): Pending {
    const existing = this.#recoveryClosures.get(lifecycle.announcementId);
    if (existing) return existing;
    const intent = this.#historyIntent(
      'departure',
      lifecycle.identity,
      lifecycle.identity.ttlClosureRequestId,
      now,
      'expired',
    );
    const pending: Pending = {
      intent,
      port: 'history',
      capability: 'join',
      actorId: lifecycle.identity.actor.actorId,
      lifecycleId: lifecycle.announcementId,
      afterIntentId: lifecycle.announcementId,
      bytes: this.#intentBytes(intent),
    };
    this.#recoveryClosures.set(lifecycle.announcementId, pending);
    return pending;
  }

  /** Refreshes a checkpointed-but-not-yet-materialized TTL closure in place. */
  #renewDormantRecoveryClosure(lifecycle: Lifecycle): void {
    const existing = this.#recoveryClosures.get(lifecycle.announcementId);
    if (existing?.intent.kind !== 'departure') return;
    const intent = this.#historyIntentAt(
      'departure',
      lifecycle.identity,
      lifecycle.identity.ttlClosureRequestId,
      existing.intent.occurredAt,
      existing.intent.ordinal,
      existing.intent.presenceReason ?? 'expired',
    );
    this.#recoveryClosures.set(lifecycle.announcementId, {
      ...existing,
      intent,
      actorId: lifecycle.identity.actor.actorId,
      bytes: this.#intentBytes(intent),
    });
  }

  #takeClosure(
    lifecycle: Lifecycle,
    requestId: string,
    now: number,
    reason: NonNullable<LiveWorkHistoryIntent['presenceReason']>,
  ): LiveWorkHistoryIntent {
    const dormant = this.#recoveryClosures.get(lifecycle.announcementId);
    if (dormant) {
      this.#recoveryClosures.delete(lifecycle.announcementId);
      return clone(dormant.intent) as LiveWorkHistoryIntent;
    }
    return this.#historyIntent(
      'departure',
      lifecycle.identity,
      requestId,
      now,
      reason,
    );
  }

  #revisionIntent(
    identity: LiveWorkIdentity,
    requestId: string,
    revisionId: EvidenceRevisionId,
    occurredAt: number,
  ): LiveWorkRevisionIntent {
    const ordinal = this.#takeOrdinal();
    const intent: Omit<LiveWorkRevisionIntent, 'intentId'> = {
      kind: 'revision-reference',
      requestId,
      occurrenceId: identity.occurrenceId,
      ordinal,
      scope: this.scope,
      actor: clone(identity.actor),
      work: workProjection(identity),
      revisionId,
      occurredAt,
    };
    return { ...intent, intentId: digestIntent(intent) };
  }

  #closureReservation(identity: LiveWorkIdentity): number {
    const requestId = this.#maxSerializedRequestId();
    const intent: Omit<LiveWorkHistoryIntent, 'intentId'> = {
      kind: 'departure',
      // This is an actual admitted request ID whose JSON/UTF-8 representation
      // is maximal under both string bounds. A backslash-only approximation is
      // unsound: U+0800 consumes three bytes while using one UTF-16 unit.
      requestId,
      occurrenceId: identity.occurrenceId,
      ordinal: Number.MAX_SAFE_INTEGER,
      scope: this.scope,
      actor: clone(identity.actor),
      work: workProjection(identity),
      occurredAt: Number.MAX_SAFE_INTEGER,
      presenceReason: 'withdrawn',
    };
    return this.#intentBytes({ ...intent, intentId: digestIntent(intent) });
  }

  #maxSerializedRequestId(): string {
    const characters = Math.min(
      this.#bounds.maxIdLength,
      this.#bounds.maxStringBytes,
    );
    // Start with JSON-escaped one-byte characters (two serialized bytes each).
    // Replacing one with U+0800 costs two more input bytes but adds one
    // serialized byte; no admitted scalar has a better byte/code-unit ratio.
    const upgrades = Math.min(
      characters,
      Math.floor((this.#bounds.maxStringBytes - characters) / 2),
    );
    return '\u0800'.repeat(upgrades) + '\\'.repeat(characters - upgrades);
  }

  #closureFitsReservation(
    lifecycle: Lifecycle,
    requestId: string,
    now: number,
  ): boolean {
    const dormant = this.#recoveryClosures.get(lifecycle.announcementId);
    if (dormant) return dormant.bytes <= lifecycle.reservedClosureBytes;
    const intent = this.#historyIntentAt(
      'departure',
      lifecycle.identity,
      requestId,
      now,
      this.#nextOrdinal + 1,
      'withdrawn',
    );
    return this.#intentBytes(intent) <= lifecycle.reservedClosureBytes;
  }

  #canAdmit(
    intent: DurableIntent,
    requiredCount: number,
    reservedBytes: number,
  ): boolean {
    return (
      this.#pending.size + this.#reservedClosureCount() + requiredCount <=
        this.#bounds.maxPendingIntents &&
      this.#pendingBytes +
        this.#reservedClosureBytes +
        this.#intentBytes(intent) +
        reservedBytes <=
        this.#bounds.maxPendingBytes
    );
  }

  #convertClosureReservation(
    lifecycle: Lifecycle,
    closure: LiveWorkHistoryIntent,
  ): boolean {
    const bytes = this.#intentBytes(closure);
    if (bytes > lifecycle.reservedClosureBytes) return false;
    this.#reservedClosureBytes -= lifecycle.reservedClosureBytes;
    lifecycle.reservedClosureBytes = 0;
    return true;
  }

  #releaseClosureReservation(lifecycle: Lifecycle): void {
    this.#reservedClosureBytes -= lifecycle.reservedClosureBytes;
    lifecycle.reservedClosureBytes = 0;
  }

  #reservedClosureCount(): number {
    let count = 0;
    for (const lifecycle of this.#lifecycles.values())
      if (!lifecycle.closureId) count += 1;
    return count;
  }

  #activeLifecycle(actorId: string): Lifecycle | undefined {
    const id = this.#activeLifecycleByActor.get(actorId);
    return id ? this.#lifecycles.get(id) : undefined;
  }

  #pendingOrTerminal(intentId: string): LiveWorkMutationOutcome {
    if (this.#pending.has(intentId))
      return { outcome: 'degraded', intentId, state: 'indeterminate' };
    const terminal = this.#terminal.get(intentId);
    return terminal?.result === 'refused'
      ? { outcome: 'degraded', intentId, state: 'refused' }
      : {
          outcome: 'departed',
          ...(terminal?.receipt ? { receipt: clone(terminal.receipt) } : {}),
        };
  }

  #terminalOutcome(terminal: TerminalIntent): LiveWorkMutationOutcome {
    if (terminal.result === 'refused')
      return {
        outcome: 'degraded',
        intentId: terminal.intent.intentId,
        state: 'refused',
      };
    return terminal.intent.kind === 'departure' &&
      terminal.capability === 'join'
      ? {
          outcome: 'departed',
          ...(terminal.receipt ? { receipt: clone(terminal.receipt) } : {}),
        }
      : {
          outcome: 'updated',
          ...(terminal.receipt ? { receipt: clone(terminal.receipt) } : {}),
        };
  }

  #terminalClosureForActor(
    actorId: string,
    occurrenceId: string | undefined,
    capability: 'join' | 'announce',
  ): TerminalIntent | undefined {
    const terminals = [...this.#terminal.values()];
    for (let index = terminals.length - 1; index >= 0; index -= 1) {
      const terminal = terminals[index]!;
      if (
        terminal.intent.kind === 'departure' &&
        terminal.actorId === actorId &&
        terminal.capability === capability &&
        (occurrenceId === undefined ||
          terminal.intent.occurrenceId === occurrenceId)
      )
        return terminal;
    }
    return undefined;
  }

  #forgetPending(intentId: string): void {
    const pending = this.#pending.get(intentId);
    if (!pending) return;
    this.#pending.delete(intentId);
    this.#pendingBytes -= pending.bytes;
  }

  #evictReplayBlock(): boolean {
    const block = this.#evictableReplayBlock();
    if (!block) return false;
    const closure = this.#terminal.get(block.closureId);
    if (closure?.result === 'refused')
      this.#removeReplayIntents([block.announcementId]);
    else this.#dropTerminalBlock(block.announcementId, block.closureId);
    return true;
  }

  #replayReservationAvailable(): boolean {
    return (
      this.#lifecycles.size + 1 <= this.#bounds.maxReplayEvents &&
      (this.#replay.length < this.#bounds.maxReplayEvents ||
        this.#evictableReplayBlock() !== undefined)
    );
  }

  #evictableReplayBlock():
    | { readonly announcementId: string; readonly closureId: string }
    | undefined {
    for (const event of this.#replay) {
      if (event.kind !== 'announce') continue;
      const closure = [...this.#terminal.values()].find(
        (candidate) =>
          candidate.intent.kind === 'departure' &&
          candidate.afterIntentId === event.intentId,
      );
      if (closure)
        return {
          announcementId: event.intentId,
          closureId: closure.intent.intentId,
        };
    }
    return undefined;
  }

  #evictTerminalBlock(): boolean {
    for (const closure of this.#terminal.values()) {
      if (closure.intent.kind !== 'departure' || !closure.afterIntentId)
        continue;
      const announcement = this.#terminal.get(closure.afterIntentId);
      if (!announcement || this.#pendingDependsOn(announcement.intent.intentId))
        continue;
      this.#dropTerminalBlock(
        announcement.intent.intentId,
        closure.intent.intentId,
      );
      return true;
    }
    const standalone = [...this.#terminal.values()].find(
      (record) =>
        record.intent.kind !== 'departure' &&
        !this.#replay.some(
          (event) => event.intentId === record.intent.intentId,
        ) &&
        !this.#pendingDependsOn(record.intent.intentId),
    );
    if (!standalone) return false;
    this.#terminal.delete(standalone.intent.intentId);
    return true;
  }

  #dropTerminalBlock(announcementId: string, closureId: string): void {
    this.#terminal.delete(announcementId);
    this.#terminal.delete(closureId);
    this.#removeReplayIntents([announcementId, closureId]);
  }

  #removeReplayIntents(intentIds: readonly string[]): void {
    for (let index = this.#replay.length - 1; index >= 0; index -= 1)
      if (intentIds.includes(this.#replay[index]!.intentId))
        this.#replay.splice(index, 1);
  }

  #pendingDependsOn(intentId: string): boolean {
    return [...this.#pending.values()].some(
      (pending) => pending.afterIntentId === intentId,
    );
  }

  #rememberTerminal(
    pending: Pending,
    result: Extract<DurablePortOutcome, { state: 'committed' | 'refused' }>,
  ): void {
    const intentId = pending.intent.intentId;
    if (this.#terminal.has(intentId)) return;
    while (this.#terminal.size >= this.#bounds.maxTerminalIntents) {
      if (!this.#evictTerminalBlock()) return;
    }
    this.#terminal.set(intentId, {
      intent: clone(pending.intent),
      port: pending.port,
      capability: pending.capability,
      actorId: pending.actorId,
      ...(pending.lifecycleId ? { lifecycleId: pending.lifecycleId } : {}),
      ...(pending.afterIntentId
        ? { afterIntentId: pending.afterIntentId }
        : {}),
      result: result.state,
      ...(result.state === 'committed' && result.receipt !== undefined
        ? { receipt: clone(result.receipt) }
        : {}),
    });
  }

  #portOutcomeOk(value: unknown): value is DurablePortOutcome {
    return (
      plain(value) &&
      ((value.state === 'committed' &&
        (only(value, ['state']) ||
          (only(value, ['state', 'receipt']) &&
            value.receipt !== undefined))) ||
        (value.state === 'indeterminate' && only(value, ['state'])) ||
        (value.state === 'refused' &&
          only(value, ['state', 'reason']) &&
          this.#textOk(value.reason, this.#bounds.maxStringBytes)))
    );
  }

  #importRecovery(value: unknown, restoreNow: number): boolean {
    if (
      !plain(value) ||
      !only(value, [
        'schemaVersion',
        'scope',
        'safeClock',
        'nextOrdinal',
        'pending',
        'lifecycles',
        'terminal',
        'replay',
        'transitionTimes',
        'recoveryTimes',
      ]) ||
      value.schemaVersion !== LIVE_WORK_RECOVERY_SCHEMA_VERSION ||
      !this.#scopeOk(value.scope) ||
      !sameScope(this.#scope, value.scope) ||
      !Number.isSafeInteger(value.safeClock) ||
      (value.safeClock as number) < 0 ||
      (value.safeClock as number) > restoreNow ||
      !Number.isSafeInteger(value.nextOrdinal) ||
      (value.nextOrdinal as number) < 0 ||
      (value.nextOrdinal as number) > Number.MAX_SAFE_INTEGER - 2 ||
      !Array.isArray(value.pending) ||
      !Array.isArray(value.lifecycles) ||
      !Array.isArray(value.terminal) ||
      !Array.isArray(value.replay) ||
      !Array.isArray(value.transitionTimes) ||
      !Array.isArray(value.recoveryTimes) ||
      value.pending.length > this.#bounds.maxPendingIntents ||
      value.lifecycles.length > this.#bounds.maxPendingIntents ||
      value.terminal.length > this.#bounds.maxTerminalIntents ||
      value.replay.length > this.#bounds.maxReplayEvents
    )
      return false;
    const transitionTimes = this.#parseRateLedger(
      value.transitionTimes,
      this.#bounds.maxTransitionTimestamps,
      value.safeClock as number,
    );
    const recoveryTimes = this.#parseRateLedger(
      value.recoveryTimes,
      this.#bounds.maxRecoveryTimestamps,
      value.safeClock as number,
    );
    if (!transitionTimes || !recoveryTimes) return false;
    const pending: Pending[] = [];
    const pendingIds = new Set<string>();
    let missingPort = false;
    let pendingBytes = 0;
    let maximumOrdinal = 0;
    for (const item of value.pending) {
      const parsed = this.#parseRecoveryPending(item);
      if (
        !parsed ||
        !this.#recordSemanticsOk(parsed) ||
        pendingIds.has(parsed.intent.intentId) ||
        parsed.actorId !== parsed.intent.actor.actorId ||
        parsed.intent.occurredAt > (value.safeClock as number)
      )
        return false;
      if (
        (parsed.port === 'history' && !this.#ports.history) ||
        (parsed.port === 'revision' && !this.#ports.revision)
      )
        missingPort = true;
      pending.push(parsed);
      pendingIds.add(parsed.intent.intentId);
      maximumOrdinal = Math.max(maximumOrdinal, parsed.intent.ordinal);
      pendingBytes += parsed.bytes;
      if (pendingBytes > this.#bounds.maxPendingBytes) return false;
    }
    const lifecycles: Lifecycle[] = [];
    const lifecycleIds = new Set<string>();
    const lifecycleActors = new Set<string>();
    let reservationBytes = 0;
    for (const item of value.lifecycles) {
      const parsed = this.#parseRecoveryLifecycle(item);
      if (
        !parsed ||
        lifecycleIds.has(parsed.announcementId) ||
        lifecycleActors.has(parsed.identity.actor.actorId) ||
        parsed.identity.sessionId !== this.#scope.sessionId ||
        parsed.identity.startedAt > (value.safeClock as number) ||
        (parsed.closureId === undefined &&
          parsed.reservedClosureBytes !==
            this.#closureReservation(parsed.identity)) ||
        (parsed.closureId !== undefined && parsed.reservedClosureBytes !== 0)
      )
        return false;
      lifecycles.push(parsed);
      lifecycleIds.add(parsed.announcementId);
      lifecycleActors.add(parsed.identity.actor.actorId);
      reservationBytes += parsed.reservedClosureBytes;
      if (pendingBytes + reservationBytes > this.#bounds.maxPendingBytes)
        return false;
    }
    const terminal: TerminalIntent[] = [];
    const terminalIds = new Set<string>();
    for (const item of value.terminal) {
      const parsed = this.#parseRecoveryTerminal(item);
      if (
        !parsed ||
        !this.#recordSemanticsOk(parsed) ||
        terminalIds.has(parsed.intent.intentId) ||
        pendingIds.has(parsed.intent.intentId) ||
        parsed.intent.occurredAt > (value.safeClock as number)
      )
        return false;
      terminal.push(parsed);
      terminalIds.add(parsed.intent.intentId);
      maximumOrdinal = Math.max(maximumOrdinal, parsed.intent.ordinal);
    }
    const replay: LiveWorkReplayEvent[] = [];
    const replayIds = new Set<string>();
    let previousReplayOrdinal = 0;
    for (const item of value.replay) {
      if (!this.#replayEventOk(item)) return false;
      const committed = terminal.find(
        (candidate) => candidate.intent.intentId === item.intentId,
      );
      if (
        item.occurredAt > (value.safeClock as number) ||
        replayIds.has(item.intentId) ||
        item.ordinal <= previousReplayOrdinal ||
        !committed ||
        committed.result !== 'committed' ||
        committed.port !== 'history' ||
        !sameIntent(committed.intent, item)
      )
        return false;
      replay.push(clone(item));
      replayIds.add(item.intentId);
      previousReplayOrdinal = item.ordinal;
    }
    const pendingById = new Map(
      pending.map((item) => [item.intent.intentId, item] as const),
    );
    const pendingClosureByLifecycle = new Map<string, Pending>();
    for (const item of pending) {
      if (item.intent.kind !== 'departure' || !item.lifecycleId) continue;
      if (pendingClosureByLifecycle.has(item.lifecycleId)) return false;
      pendingClosureByLifecycle.set(item.lifecycleId, item);
    }
    const terminalById = new Map(
      terminal.map((item) => [item.intent.intentId, item] as const),
    );
    if (!this.#dependencyGraphOk(pendingById, terminalById)) return false;
    if (
      terminal.some(
        (record) =>
          record.intent.kind === 'departure' &&
          !this.#terminalClosurePairOk(record, terminalById),
      )
    )
      return false;
    const dormantClosures = lifecycles.filter(
      (lifecycle) => lifecycle.closureId === undefined,
    ).length;
    if (
      (value.nextOrdinal as number) < maximumOrdinal ||
      !ordinalHeadroom(value.nextOrdinal as number, dormantClosures, 0) ||
      pending.length + dormantClosures > this.#bounds.maxPendingIntents
    )
      return false;
    for (const lifecycle of lifecycles) {
      const announcement =
        pendingById.get(lifecycle.announcementId) ??
        terminalById.get(lifecycle.announcementId);
      if (
        announcement?.intent.kind !== 'announce' ||
        ('result' in announcement && announcement.result !== 'committed')
      )
        return false;
      if (
        announcement.actorId !== lifecycle.identity.actor.actorId ||
        announcement.intent.occurrenceId !== lifecycle.identity.occurrenceId
      )
        return false;
      if (
        lifecycle.state === 'announcing' &&
        !pendingById.has(lifecycle.announcementId)
      )
        return false;
      if (
        lifecycle.state === 'published' &&
        pendingById.has(lifecycle.announcementId)
      )
        return false;
      if (lifecycle.closureId) {
        const closure = pendingClosureByLifecycle.get(lifecycle.announcementId);
        if (
          closure?.intent.kind !== 'departure' ||
          closure.intent.intentId !== lifecycle.closureId ||
          closure.lifecycleId !== lifecycle.announcementId ||
          closure.afterIntentId !== lifecycle.announcementId
        )
          return false;
        if (
          closure.actorId !== lifecycle.identity.actor.actorId ||
          closure.intent.occurrenceId !== lifecycle.identity.occurrenceId
        )
          return false;
      } else if (
        lifecycle.state === 'closing' ||
        pendingClosureByLifecycle.has(lifecycle.announcementId)
      ) {
        return false;
      }
    }
    if (
      pending.some(
        (item) => item.lifecycleId && !lifecycleIds.has(item.lifecycleId),
      )
    )
      return false;
    if (
      terminal.some(
        (record) =>
          record.intent.kind === 'announce' &&
          record.result === 'committed' &&
          !terminal.some(
            (candidate) =>
              candidate.intent.kind === 'departure' &&
              candidate.afterIntentId === record.intent.intentId,
          ) &&
          !lifecycleIds.has(record.intent.intentId),
      )
    )
      return false;
    const replayAnnouncements = new Set<string>();
    for (const event of replay) {
      const record = terminalById.get(event.intentId)!;
      if (event.kind === 'announce') {
        replayAnnouncements.add(event.intentId);
        continue;
      }
      if (event.kind === 'departure') {
        if (
          !this.#terminalClosurePairOk(record, terminalById) ||
          !record.afterIntentId ||
          !replayAnnouncements.has(record.afterIntentId)
        )
          return false;
      }
    }
    if (missingPort) {
      this.#restoreUnavailable = true;
      return false;
    }
    this.#lastNow = Math.max(this.#lastNow, value.safeClock as number);
    this.#nextOrdinal = value.nextOrdinal as number;
    for (const item of pending) this.#pending.set(item.intent.intentId, item);
    for (const item of lifecycles) {
      this.#lifecycles.set(item.announcementId, item);
      this.#activeLifecycleByActor.set(
        item.identity.actor.actorId,
        item.announcementId,
      );
    }
    for (const item of terminal) this.#terminal.set(item.intent.intentId, item);
    this.#replay.push(...replay);
    this.#transitionTimes.push(...transitionTimes);
    this.#recoveryTimes.push(...recoveryTimes);
    this.#pendingBytes = pendingBytes;
    this.#reservedClosureBytes = reservationBytes;
    return true;
  }

  #dependencyGraphOk(
    pending: ReadonlyMap<string, Pending>,
    terminal: ReadonlyMap<string, TerminalIntent>,
  ): boolean {
    for (const record of pending.values()) {
      if (record.intent.kind === 'departure') {
        if (
          !record.lifecycleId ||
          record.afterIntentId !== record.lifecycleId ||
          record.afterIntentId === record.intent.intentId
        )
          return false;
        const dependency =
          pending.get(record.afterIntentId) ??
          terminal.get(record.afterIntentId);
        if (
          dependency?.intent.kind !== 'announce' ||
          ('result' in dependency && dependency.result !== 'committed')
        )
          return false;
      } else if (record.afterIntentId !== undefined) {
        return false;
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visited.has(id)) return true;
      if (visiting.has(id)) return false;
      visiting.add(id);
      const next = pending.get(id)?.afterIntentId;
      if (next && pending.has(next) && !visit(next)) return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    for (const id of pending.keys()) if (!visit(id)) return false;
    return true;
  }

  #terminalClosurePairOk(
    closure: TerminalIntent,
    terminal: ReadonlyMap<string, TerminalIntent>,
  ): boolean {
    if (closure.intent.kind !== 'departure' || !closure.afterIntentId)
      return false;
    const announcement = terminal.get(closure.afterIntentId);
    return (
      closure.lifecycleId === closure.afterIntentId &&
      announcement?.intent.kind === 'announce' &&
      (announcement.result === 'committed' ||
        (announcement.result === 'refused' && closure.result === 'refused')) &&
      announcement.lifecycleId === announcement.intent.intentId &&
      announcement.actorId === closure.actorId &&
      sameActor(announcement.intent.actor, closure.intent.actor) &&
      announcement.intent.occurrenceId === closure.intent.occurrenceId &&
      sameScope(announcement.intent.scope, closure.intent.scope)
    );
  }

  #parseRateLedger(
    value: unknown,
    capacity: number,
    safeClock: number,
  ): RateEntry[] | undefined {
    if (!Array.isArray(value) || value.length > capacity) return undefined;
    const parsed: RateEntry[] = [];
    let previous = -1;
    for (const item of value) {
      if (
        !plain(item) ||
        !only(item, ['principalId', 'at']) ||
        !this.#idOk(item.principalId) ||
        !this.#safeStoredTime(item.at) ||
        item.at < previous ||
        item.at > safeClock ||
        item.at <= safeClock - this.#bounds.rateWindowMs
      )
        return undefined;
      parsed.push({ principalId: item.principalId, at: item.at });
      previous = item.at;
    }
    return parsed;
  }

  #parseRecoveryPending(value: unknown): Pending | undefined {
    if (
      !plain(value) ||
      !only(value, [
        'intent',
        'port',
        'capability',
        'actorId',
        'lifecycleId',
        'afterIntentId',
      ]) ||
      (value.port !== 'history' && value.port !== 'revision') ||
      !capabilities.includes(value.capability as LiveWorkCapability) ||
      !this.#idOk(value.actorId) ||
      (value.lifecycleId !== undefined &&
        !this.#intentIdOk(value.lifecycleId)) ||
      (value.afterIntentId !== undefined &&
        !this.#intentIdOk(value.afterIntentId)) ||
      !this.#intentOk(value.intent, value.port)
    )
      return undefined;
    return {
      intent: clone(value.intent),
      port: value.port,
      capability: value.capability as LiveWorkCapability,
      actorId: value.actorId,
      ...(value.lifecycleId ? { lifecycleId: value.lifecycleId } : {}),
      ...(value.afterIntentId ? { afterIntentId: value.afterIntentId } : {}),
      bytes: this.#intentBytes(value.intent),
    };
  }

  #parseRecoveryTerminal(value: unknown): TerminalIntent | undefined {
    const kind =
      plain(value) && plain(value.intent) ? value.intent.kind : undefined;
    const terminalKeys =
      kind === 'departure'
        ? [
            'intent',
            'port',
            'capability',
            'actorId',
            'lifecycleId',
            'afterIntentId',
            'result',
          ]
        : kind === 'announce'
          ? ['intent', 'port', 'capability', 'actorId', 'lifecycleId', 'result']
          : kind === 'revision-reference'
            ? ['intent', 'port', 'capability', 'actorId', 'result']
            : [];
    if (
      !plain(value) ||
      !only(value, terminalKeys) ||
      (value.port !== 'history' && value.port !== 'revision') ||
      !capabilities.includes(value.capability as LiveWorkCapability) ||
      !this.#idOk(value.actorId) ||
      (value.lifecycleId !== undefined &&
        !this.#intentIdOk(value.lifecycleId)) ||
      (value.afterIntentId !== undefined &&
        !this.#intentIdOk(value.afterIntentId)) ||
      (value.result !== 'committed' && value.result !== 'refused') ||
      !this.#intentOk(value.intent, value.port)
    )
      return undefined;
    return {
      intent: clone(value.intent),
      port: value.port,
      capability: value.capability as LiveWorkCapability,
      actorId: value.actorId,
      ...(value.lifecycleId ? { lifecycleId: value.lifecycleId } : {}),
      ...(value.afterIntentId ? { afterIntentId: value.afterIntentId } : {}),
      result: value.result,
    };
  }

  #recordSemanticsOk(record: Pending | TerminalIntent): boolean {
    if (record.actorId !== record.intent.actor.actorId) return false;
    if (record.intent.kind === 'announce')
      return (
        record.port === 'history' &&
        record.capability === 'announce' &&
        record.lifecycleId === record.intent.intentId
      );
    if (record.intent.kind === 'departure')
      return (
        record.port === 'history' &&
        (record.capability === 'join' || record.capability === 'announce') &&
        this.#intentIdOk(record.lifecycleId) &&
        record.afterIntentId === record.lifecycleId
      );
    if (record.intent.kind === 'work-finished')
      return (
        record.port === 'history' &&
        record.capability === 'write' &&
        record.lifecycleId === undefined &&
        record.afterIntentId === undefined
      );
    return (
      record.port === 'revision' &&
      record.capability === 'write' &&
      record.lifecycleId === undefined
    );
  }

  #parseRecoveryLifecycle(value: unknown): Lifecycle | undefined {
    if (
      !plain(value) ||
      !only(value, [
        'announcementId',
        'identity',
        'announceRequestId',
        'reservedClosureBytes',
        'state',
        'closureId',
      ]) ||
      !this.#intentIdOk(value.announcementId) ||
      !this.#identityOk(value.identity) ||
      !this.#idOk(value.announceRequestId) ||
      !Number.isSafeInteger(value.reservedClosureBytes) ||
      (value.reservedClosureBytes as number) < 0 ||
      (value.state !== 'announcing' &&
        value.state !== 'published' &&
        value.state !== 'closing') ||
      (value.closureId !== undefined && !this.#intentIdOk(value.closureId))
    )
      return undefined;
    return clone(value) as unknown as Lifecycle;
  }

  #intentOk(value: unknown, port: Pending['port']): value is DurableIntent {
    const kind = plain(value) ? value.kind : undefined;
    const intentKeys =
      kind === 'revision-reference'
        ? [
            'kind',
            'intentId',
            'requestId',
            'occurrenceId',
            'ordinal',
            'scope',
            'actor',
            'work',
            'occurredAt',
            'revisionId',
          ]
        : kind === 'departure'
          ? [
              'kind',
              'intentId',
              'requestId',
              'occurrenceId',
              'ordinal',
              'scope',
              'actor',
              'work',
              'occurredAt',
              'presenceReason',
            ]
          : kind === 'work-finished'
            ? [
                'kind',
                'intentId',
                'requestId',
                'occurrenceId',
                'ordinal',
                'scope',
                'actor',
                'work',
                'occurredAt',
                'finishOutcome',
                'revisionId',
              ]
            : [
                'kind',
                'intentId',
                'requestId',
                'occurrenceId',
                'ordinal',
                'scope',
                'actor',
                'work',
                'occurredAt',
              ];
    if (
      !plain(value) ||
      !only(value, intentKeys) ||
      !this.#intentIdOk(value.intentId) ||
      !this.#idOk(value.requestId) ||
      !this.#idOk(value.occurrenceId) ||
      !Number.isSafeInteger(value.ordinal) ||
      (value.ordinal as number) < 1 ||
      !this.#scopeOk(value.scope) ||
      !sameScope(this.#scope, value.scope) ||
      !this.#actorOk(value.actor) ||
      !this.#workOk(value.work) ||
      value.work.sessionId !== this.#scope.sessionId ||
      !this.#safeStoredTime(value.occurredAt)
    )
      return false;
    if (
      port === 'history' &&
      value.kind !== 'announce' &&
      value.kind !== 'departure' &&
      value.kind !== 'work-finished'
    )
      return false;
    if (
      value.kind === 'departure' &&
      !['departed', 'withdrawn', 'expired'].includes(
        value.presenceReason as string,
      )
    )
      return false;
    if (
      value.kind === 'work-finished' &&
      (!['completed', 'failed', 'cancelled'].includes(
        value.finishOutcome as string,
      ) ||
        (value.revisionId !== undefined &&
          !this.#revisionIdOk(value.revisionId)))
    )
      return false;
    if (
      port === 'revision' &&
      (value.kind !== 'revision-reference' ||
        !this.#revisionIdOk(value.revisionId))
    )
      return false;
    const { intentId, ...material } = value;
    return value.kind === 'revision-reference'
      ? digestIntent(
          material as unknown as Omit<LiveWorkRevisionIntent, 'intentId'>,
        ) === intentId
      : digestIntent(
          material as unknown as Omit<LiveWorkHistoryIntent, 'intentId'>,
        ) === intentId;
  }

  #replayEventOk(value: unknown): value is LiveWorkReplayEvent {
    return this.#intentOk(value, 'history');
  }

  #identityOk(value: unknown): value is LiveWorkIdentity {
    return (
      plain(value) &&
      only(value, [
        'actor',
        'occurrenceId',
        'sessionId',
        'runId',
        'workName',
        'workState',
        'startedAt',
        'ttlClosureRequestId',
      ]) &&
      this.#actorOk(value.actor) &&
      this.#idOk(value.occurrenceId) &&
      this.#idOk(value.sessionId) &&
      (value.runId === undefined || this.#idOk(value.runId)) &&
      this.#textOk(value.workName, this.#bounds.maxLabelLength) &&
      (value.workState === 'working' ||
        value.workState === 'reviewing' ||
        value.workState === 'blocked') &&
      this.#safeStoredTime(value.startedAt) &&
      this.#idOk(value.ttlClosureRequestId)
    );
  }

  #workOk(value: unknown): value is LiveWorkHistoryIntent['work'] {
    return (
      plain(value) &&
      only(value, [
        'sessionId',
        'runId',
        'workName',
        'workState',
        'startedAt',
      ]) &&
      this.#idOk(value.sessionId) &&
      (value.runId === undefined || this.#idOk(value.runId)) &&
      this.#textOk(value.workName, this.#bounds.maxLabelLength) &&
      (value.workState === 'working' ||
        value.workState === 'reviewing' ||
        value.workState === 'blocked') &&
      this.#safeStoredTime(value.startedAt)
    );
  }

  #authOk(value: unknown): value is LiveWorkAuthorization {
    return (
      plain(value) &&
      only(value, ['actorId', 'scope', 'capabilities']) &&
      this.#idOk(value.actorId) &&
      this.#scopeOk(value.scope) &&
      value.capabilities instanceof Set &&
      [...value.capabilities].every((capability) =>
        capabilities.includes(capability),
      )
    );
  }

  #recoveryAuthOk(value: unknown): value is LiveWorkRecoveryAuthorization {
    return (
      plain(value) &&
      only(value, ['kind', 'recoveryId', 'scope']) &&
      value.kind === 'system' &&
      this.#idOk(value.recoveryId) &&
      this.#scopeOk(value.scope)
    );
  }

  #scopeOk(value: unknown): value is LiveWorkScope {
    return (
      plain(value) &&
      only(value, [
        'projectId',
        'taskId',
        'surfaceId',
        'sessionId',
        'channelId',
      ]) &&
      this.#idOk(value.projectId) &&
      this.#idOk(value.taskId) &&
      this.#idOk(value.surfaceId) &&
      this.#idOk(value.sessionId) &&
      this.#idOk(value.channelId)
    );
  }

  #actorOk(value: unknown): value is LiveWorkActor {
    return (
      plain(value) &&
      only(value, ['actorId', 'kind', 'label']) &&
      this.#idOk(value.actorId) &&
      (value.kind === 'human' || value.kind === 'agent') &&
      this.#textOk(value.label, this.#bounds.maxLabelLength)
    );
  }

  #validBounds(): boolean {
    return (
      (Object.keys(DEFAULT_LIVE_WORK_BOUNDS) as (keyof LiveWorkBounds)[]).every(
        (key) =>
          Number.isSafeInteger(this.#bounds[key]) &&
          this.#bounds[key] > 0 &&
          this.#bounds[key] <= ABSOLUTE[key],
      ) &&
      this.#bounds.maxTransitionsPerWindow <=
        this.#bounds.maxTransitionTimestamps &&
      this.#bounds.maxRecoveriesPerWindow <=
        this.#bounds.maxRecoveryTimestamps &&
      this.#bounds.maxReplayEvents >= this.#bounds.maxParticipants &&
      this.#bounds.maxTerminalIntents >=
        this.#bounds.maxPendingIntents + this.#bounds.maxReplayEvents
    );
  }

  #textOk(value: unknown, maximum: number): value is string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > maximum
    )
      return false;
    let bytes = 0;
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) return false;
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes > this.#bounds.maxStringBytes) return false;
    }
    return true;
  }

  #idOk(value: unknown): value is string {
    return this.#textOk(value, this.#bounds.maxIdLength);
  }

  #intentIdOk(value: unknown): value is string {
    return (
      typeof value === 'string' && /^live-work-v6:[0-9a-f]{64}$/.test(value)
    );
  }

  #revisionIdOk(value: unknown): value is EvidenceRevisionId {
    return (
      typeof value === 'string' &&
      /^revision-evidence-v1:[0-9a-f]{64}$/.test(value)
    );
  }

  #safeStoredTime(value: unknown): value is number {
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    );
  }

  #takeOrdinal(): number {
    this.#nextOrdinal += 1;
    return this.#nextOrdinal;
  }

  #ordinalCapacity(required: number): boolean {
    let reserved = 0;
    for (const lifecycle of this.#lifecycles.values())
      if (
        !lifecycle.closureId &&
        !this.#recoveryClosures.has(lifecycle.announcementId)
      )
        reserved += 1;
    return ordinalHeadroom(this.#nextOrdinal, reserved, required);
  }

  #intentBytes(intent: DurableIntent): number {
    return Buffer.byteLength(JSON.stringify(intent), 'utf8');
  }

  #expiry(now: number): number {
    return now + this.#bounds.ttlMs;
  }

  #pausedExpiry(now: number): number {
    return now + this.#bounds.pausedTtlMs;
  }

  #typingExpiry(now: number): number {
    return now + this.#bounds.typingTtlMs;
  }

  #paneCount(): number {
    let count = 0;
    for (const panes of this.#panes.values()) count += panes.size;
    return count;
  }

  #paneProjection(actorId: string): LiveWorkSnapshot['panes'] {
    return [...(this.#panes.get(actorId)?.entries() ?? [])].map(
      ([paneId, pane]) => ({
        actorId,
        paneId,
        state: pane.state,
        ...(pane.targetActorId ? { targetActorId: pane.targetActorId } : {}),
        ...(pane.reason ? { reason: pane.reason } : {}),
      }),
    );
  }
}

function recoveryPending(pending: Pending): RecoveryPending {
  return {
    intent: clone(pending.intent),
    port: pending.port,
    capability: pending.capability,
    actorId: pending.actorId,
    ...(pending.lifecycleId ? { lifecycleId: pending.lifecycleId } : {}),
    ...(pending.afterIntentId ? { afterIntentId: pending.afterIntentId } : {}),
  };
}

function workProjection(
  identity: LiveWorkIdentity,
): LiveWorkHistoryIntent['work'] {
  return clone({
    sessionId: identity.sessionId,
    ...(identity.runId ? { runId: identity.runId } : {}),
    workName: identity.workName,
    workState: identity.workState,
    startedAt: identity.startedAt,
  });
}

/**
 * Explicit length-prefixed scalar order. Object insertion order can never
 * influence an intent ID.
 */
function digestIntent(
  intent:
    | Omit<LiveWorkHistoryIntent, 'intentId'>
    | Omit<LiveWorkRevisionIntent, 'intentId'>,
): string {
  const canonical = canonicalIntent(intent);
  return `live-work-v6:${createHash('sha256').update(canonical).digest('hex')}`;
}

function canonicalIntent(
  intent:
    | Omit<LiveWorkHistoryIntent, 'intentId'>
    | Omit<LiveWorkRevisionIntent, 'intentId'>
    | DurableIntent,
): string {
  const values: readonly (string | number)[] = [
    6,
    intent.scope.projectId,
    intent.scope.taskId,
    intent.scope.surfaceId,
    intent.scope.sessionId,
    intent.scope.channelId,
    intent.actor.actorId,
    intent.actor.kind,
    intent.actor.label,
    intent.kind,
    intent.requestId,
    intent.occurrenceId,
    intent.ordinal,
    intent.work.sessionId,
    intent.work.runId ?? '',
    intent.work.workName,
    intent.work.workState,
    intent.work.startedAt,
    intent.occurredAt,
    intent.kind === 'revision-reference' ? intent.revisionId : '',
    intent.kind === 'departure' ? (intent.presenceReason ?? '') : '',
    intent.kind === 'work-finished' ? (intent.finishOutcome ?? '') : '',
    intent.kind === 'work-finished' ? (intent.revisionId ?? '') : '',
  ];
  return values
    .map((value) => {
      const text = String(value);
      return `${Buffer.byteLength(text, 'utf8')}:${text}`;
    })
    .join('|');
}

function sameIntent(left: DurableIntent, right: DurableIntent): boolean {
  return (
    left.intentId === right.intentId &&
    canonicalIntent(left) === canonicalIntent(right)
  );
}

function sameIdentity(
  left: LiveWorkIdentity,
  right: LiveWorkIdentity,
): boolean {
  return (
    left.actor.actorId === right.actor.actorId &&
    left.actor.kind === right.actor.kind &&
    left.actor.label === right.actor.label &&
    left.occurrenceId === right.occurrenceId &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.workName === right.workName &&
    left.workState === right.workState &&
    left.startedAt === right.startedAt
  );
}

function sameActor(left: LiveWorkActor, right: LiveWorkActor): boolean {
  return (
    left.actorId === right.actorId &&
    left.kind === right.kind &&
    left.label === right.label
  );
}

/** Every accepted state can still export dormant closures and announce once. */
function ordinalHeadroom(
  nextOrdinal: number,
  dormantClosures: number,
  allocations: number,
): boolean {
  return (
    nextOrdinal <= Number.MAX_SAFE_INTEGER - dormantClosures - allocations - 2
  );
}

function sameScope(left: LiveWorkScope, right: LiveWorkScope): boolean {
  return (
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.surfaceId === right.surfaceId &&
    left.sessionId === right.sessionId &&
    left.channelId === right.channelId
  );
}
