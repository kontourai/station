import { randomUUID } from 'node:crypto';
import type { OrchestrationCommandReceipt } from '@kontourai/station-contracts/orchestration';
import type { ProviderSession } from '@kontourai/station-contracts/provider';

/** A durable, recoverable reservation for one attached-session continuation. */
export interface AdoptionReservation {
  sourceThreadId: string;
  targetThreadId: string;
  ownerId: string;
  ownerPid: number;
  /** Opaque fencing fact. It changes on every successful reclaim. */
  ownerToken: string;
  provider: ProviderSession['provider'];
  sourceSessionId: string;
  sourceKind: string;
  cwd: string;
  projectRoot: string;
  idempotencyKey?: string;
  status: 'pending' | 'forking' | 'rollback-pending';
  providerResumeCursor?: unknown;
  providerCleanupComplete: boolean;
  flowRunId?: string;
  flowRunResumed?: boolean;
  flowCleanupComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AdoptionReservationInput = Omit<
  AdoptionReservation,
  | 'ownerToken'
  | 'status'
  | 'providerResumeCursor'
  | 'providerCleanupComplete'
  | 'flowRunId'
  | 'flowRunResumed'
  | 'flowCleanupComplete'
>;

export type AdoptionTransition =
  | { kind: 'applied'; reservation: Readonly<AdoptionReservation> }
  | { kind: 'ownership-lost' }
  | {
      kind: 'invalid-transition';
      reason:
        | 'already-settled'
        | 'must-fork-before-provider-cursor'
        | 'provider-cursor-conflict'
        | 'flow-binding-must-precede-fork'
        | 'rollback-is-terminal'
        | 'cleanup-requires-rollback'
        | 'cleanup-is-incomplete'
        | 'retry-must-match-failed-transition'
        | 'commit-requires-fork'
        | 'commit-requires-provider-cursor'
        | 'commit-child-mismatch';
    };

/**
 * A commit Adapter can prove its transaction rolled back, or report that
 * durability is uncertain. Only the former releases a capability's exact
 * retry latch so callers may begin durable compensation.
 */
export class AdoptionCommitFailure extends Error {
  constructor(
    readonly certainty: 'rolled-back' | 'unknown',
    cause: unknown,
  ) {
    super(
      certainty === 'rolled-back'
        ? 'Adoption commit rolled back.'
        : 'Adoption commit durability is unknown.',
    );
    this.cause = cause;
  }
}

/**
 * The owner capability for one reservation. Its claim identity is captured in
 * private closures, never taken from its publicly readable snapshot. Every
 * transition is total: `ownership-lost` and invalid state are returned;
 * Adapter I/O failures throw and leave the capability retryable.
 */
export interface OwnedAdoption {
  readonly reservation: Readonly<AdoptionReservation>;
  markForking(): AdoptionTransition;
  recordProviderCursor(providerResumeCursor: unknown): AdoptionTransition;
  recordFlowRun(flowRunId: string, resumed: boolean): AdoptionTransition;
  markRollbackPending(): AdoptionTransition;
  markProviderCleanupComplete(): AdoptionTransition;
  markFlowCleanupComplete(): AdoptionTransition;
  /** Atomically persists the child and receipt, then removes this reservation. */
  commit(
    child: ProviderSession,
    receipt?: OrchestrationCommandReceipt,
  ): AdoptionTransition;
  /** Removes this reservation only after both cleanup facts are durable. */
  completeCleanup(): AdoptionTransition;
}

/**
 * Adoption's behavioral Interface. It owns durable contention, claim-local
 * ownership, legal transitions, atomic commit, and restart recovery. The
 * SQLite implementation is deliberately private to its composition seam.
 *
 * A reservation begins `pending`, then may advance once to `forking`. Only forking
 * reservations may record a provider cursor; that cursor is write-once,
 * except for an idempotent repeat of the same JSON value. `rollback-pending`
 * is terminal: cleanup facts may be recorded only there, and removal requires
 * both facts. Commit requires a forking reservation with a provider cursor;
 * its child/adapter/cursor must agree and it atomically removes the reservation.
 * Flow fields and transitions remain solely to compensate reservations left by
 * the retired pre-#189 adoption path after a process restart.
 *
 * Every operation returns contention, ownership loss, or an invalid-transition
 * result rather than treating those outcomes as success. Only a durable
 * Adapter failure throws; its claim remains usable for retry. Snapshots are
 * frozen copies and cannot alter a capability's captured claim identity.
 */
export interface AdoptionLedger {
  reserve(
    input: AdoptionReservationInput,
  ): { kind: 'owner'; adoption: OwnedAdoption } | { kind: 'contended' };
  reservations(): ReadonlyArray<Readonly<AdoptionReservation>>;
  /** Atomically fences an abandoned snapshot; stale or duplicate attempts contend. */
  reclaim(input: {
    reservation: Readonly<AdoptionReservation>;
    ownerId: string;
    ownerPid: number;
  }): { kind: 'owner'; adoption: OwnedAdoption } | { kind: 'contended' };
  reservesProviderCursor(
    provider: ProviderSession['provider'],
    providerResumeCursor: unknown,
  ): boolean;
}

interface AdoptionClaim {
  sourceThreadId: string;
  ownerId: string;
  ownerPid: number;
  ownerToken: string;
}

/** Implementation-only coordinator contract, satisfied by EventStore's SQLite adapter. */
export interface AdoptionLedgerCoordinator {
  reserve(reservation: AdoptionReservation): boolean;
  replaceOwner(input: {
    expected: AdoptionClaim;
    next: AdoptionClaim;
  }): AdoptionReservation | undefined;
  updateOwned(input: {
    claim: AdoptionClaim;
    next: AdoptionReservation;
  }): AdoptionReservation | undefined;
  commitOwned(input: {
    claim: AdoptionClaim;
    child: ProviderSession;
    receipt?: OrchestrationCommandReceipt;
  }): boolean;
  completeCleanupOwned(input: { claim: AdoptionClaim }): boolean;
  reservations(): AdoptionReservation[];
  reservesProviderCursor(
    provider: ProviderSession['provider'],
    providerResumeCursor: unknown,
  ): boolean;
}

function snapshot(
  reservation: AdoptionReservation,
): Readonly<AdoptionReservation> {
  return deepFreeze(structuredClone(reservation));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function claimFor(reservation: AdoptionReservation): AdoptionClaim {
  return Object.freeze({
    sourceThreadId: reservation.sourceThreadId,
    ownerId: reservation.ownerId,
    ownerPid: reservation.ownerPid,
    ownerToken: reservation.ownerToken,
  });
}

export function createAdoptionLedger(options: {
  coordinator: AdoptionLedgerCoordinator;
}): AdoptionLedger {
  const owned = (initial: AdoptionReservation): OwnedAdoption => {
    const claim = claimFor(initial);
    let current = snapshot(initial) as AdoptionReservation;
    let settled = false;
    let failedIntent: string | undefined;
    const invalid = (
      reason: Extract<
        AdoptionTransition,
        { kind: 'invalid-transition' }
      >['reason'],
    ): AdoptionTransition => ({ kind: 'invalid-transition', reason });
    const attempt = <T>(intent: unknown, operation: () => T): T | undefined => {
      const encoded = JSON.stringify(intent);
      if (failedIntent && failedIntent !== encoded) return undefined;
      // A durable Adapter error leaves this assignment in place because the
      // throw skips the clear below; exact retry is then the only safe action.
      failedIntent ??= encoded;
      const result = operation();
      failedIntent = undefined;
      return result;
    };
    const retryMismatch = (): AdoptionTransition =>
      invalid('retry-must-match-failed-transition');
    const update = (
      operation: string,
      next: AdoptionReservation,
    ): AdoptionTransition => {
      if (settled) return invalid('already-settled');
      const updated = attempt({ operation, next }, () =>
        options.coordinator.updateOwned({ claim, next }),
      );
      if (updated === undefined && failedIntent) return retryMismatch();
      if (!updated) return { kind: 'ownership-lost' };
      current = snapshot(updated) as AdoptionReservation;
      return { kind: 'applied', reservation: snapshot(current) };
    };
    return {
      get reservation() {
        return snapshot(current);
      },
      markForking: () => {
        if (settled) return invalid('already-settled');
        if (current.status === 'rollback-pending')
          return invalid('rollback-is-terminal');
        if (current.status === 'forking') {
          return { kind: 'applied', reservation: snapshot(current) };
        }
        return update('mark-forking', { ...current, status: 'forking' });
      },
      recordProviderCursor: (providerResumeCursor) => {
        if (settled) return invalid('already-settled');
        if (current.status !== 'forking') {
          return invalid('must-fork-before-provider-cursor');
        }
        if (current.providerResumeCursor !== undefined) {
          return JSON.stringify(current.providerResumeCursor) ===
            JSON.stringify(providerResumeCursor)
            ? { kind: 'applied', reservation: snapshot(current) }
            : invalid('provider-cursor-conflict');
        }
        return update('record-provider-cursor', {
          ...current,
          providerResumeCursor,
        });
      },
      recordFlowRun: (flowRunId, resumed) => {
        if (settled) return invalid('already-settled');
        if (current.status !== 'pending') {
          return invalid(
            current.status === 'rollback-pending'
              ? 'rollback-is-terminal'
              : 'flow-binding-must-precede-fork',
          );
        }
        return update('record-flow-run', {
          ...current,
          flowRunId,
          flowRunResumed: resumed,
          flowCleanupComplete: resumed,
        });
      },
      markRollbackPending: () => {
        if (settled) return invalid('already-settled');
        if (current.status === 'rollback-pending') {
          return { kind: 'applied', reservation: snapshot(current) };
        }
        return update('mark-rollback-pending', {
          ...current,
          status: 'rollback-pending',
        });
      },
      markProviderCleanupComplete: () => {
        if (settled) return invalid('already-settled');
        if (current.status !== 'rollback-pending') {
          return invalid('cleanup-requires-rollback');
        }
        if (current.providerCleanupComplete) {
          return { kind: 'applied', reservation: snapshot(current) };
        }
        return update('mark-provider-cleanup-complete', {
          ...current,
          providerCleanupComplete: true,
        });
      },
      markFlowCleanupComplete: () => {
        if (settled) return invalid('already-settled');
        if (current.status !== 'rollback-pending') {
          return invalid('cleanup-requires-rollback');
        }
        if (current.flowCleanupComplete) {
          return { kind: 'applied', reservation: snapshot(current) };
        }
        return update('mark-flow-cleanup-complete', {
          ...current,
          flowCleanupComplete: true,
        });
      },
      commit: (child, receipt) => {
        if (settled) return invalid('already-settled');
        if (current.status !== 'forking')
          return invalid('commit-requires-fork');
        if (current.providerResumeCursor === undefined) {
          return invalid('commit-requires-provider-cursor');
        }
        if (
          child.threadId !== current.targetThreadId ||
          child.provider !== current.provider ||
          child.continuationSourceThreadId !== current.sourceThreadId ||
          JSON.stringify(child.resumeCursor) !==
            JSON.stringify(current.providerResumeCursor)
        ) {
          return invalid('commit-child-mismatch');
        }
        let committed: boolean | undefined;
        try {
          committed = attempt({ operation: 'commit', child, receipt }, () =>
            options.coordinator.commitOwned({
              claim,
              child,
              receipt,
            }),
          );
        } catch (error) {
          if (
            error instanceof AdoptionCommitFailure &&
            error.certainty === 'rolled-back'
          ) {
            failedIntent = undefined;
          }
          throw error;
        }
        if (committed === undefined && failedIntent) return retryMismatch();
        if (!committed) {
          return { kind: 'ownership-lost' };
        }
        settled = true;
        return { kind: 'applied', reservation: snapshot(current) };
      },
      completeCleanup: () => {
        if (settled) return invalid('already-settled');
        if (current.status !== 'rollback-pending') {
          return invalid('cleanup-requires-rollback');
        }
        if (!current.flowCleanupComplete || !current.providerCleanupComplete) {
          return invalid('cleanup-is-incomplete');
        }
        const complete = attempt({ operation: 'complete-cleanup' }, () =>
          options.coordinator.completeCleanupOwned({ claim }),
        );
        if (complete === undefined && failedIntent) return retryMismatch();
        if (!complete) {
          return { kind: 'ownership-lost' };
        }
        settled = true;
        return { kind: 'applied', reservation: snapshot(current) };
      },
    };
  };
  return {
    reserve: (input) => {
      const reservation: AdoptionReservation = {
        ...input,
        ownerToken: randomUUID(),
        status: 'pending',
        providerCleanupComplete: false,
        flowCleanupComplete: true,
      };
      return options.coordinator.reserve(reservation)
        ? { kind: 'owner', adoption: owned(reservation) }
        : { kind: 'contended' };
    },
    reservations: () => options.coordinator.reservations().map(snapshot),
    reclaim: ({ reservation, ownerId, ownerPid }) => {
      const expected = claimFor(reservation as AdoptionReservation);
      const next = Object.freeze({
        sourceThreadId: expected.sourceThreadId,
        ownerId,
        ownerPid,
        ownerToken: randomUUID(),
      });
      const claimed = options.coordinator.replaceOwner({ expected, next });
      return claimed
        ? { kind: 'owner', adoption: owned(claimed) }
        : { kind: 'contended' };
    },
    reservesProviderCursor: (provider, providerResumeCursor) =>
      options.coordinator.reservesProviderCursor(
        provider,
        providerResumeCursor,
      ),
  };
}
