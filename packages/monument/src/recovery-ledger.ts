import { randomUUID } from 'node:crypto';
import {
  decideRecoveryTransition,
  type RecoveryTransition,
  type RecoveryTransitionIntent,
} from './decisions/recovery.js';

export type { RecoveryTransition } from './decisions/recovery.js';
export { SqliteRecoveryStorage } from './sqlite-recovery.js';

import { ownerLivenessFromProbe } from './owner.js';

/** Minimal durable fields the recovery protocol needs from its host record. */
export interface RecoveryIntentShape {
  fingerprint: string;
  provider: string;
  outcome:
    | 'armed'
    | 'manual'
    | 'resumed'
    | 'compensation-required'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'unsupported'
    | 'indeterminate';
  dispatchSettlement?: 'prepared' | 'accepted';
}
export type RecoveryIntentInput<I extends RecoveryIntentShape> = Omit<
  I,
  'attempts' | 'resumedTurnId'
>;
type RecoveryIntentRecord<I extends RecoveryIntentShape> = I & {
  dispatchAttemptId?: string;
  recoveryCorrelationId?: string;
};
type RecoveryIntentSnapshot<I extends RecoveryIntentShape> = Readonly<
  Omit<RecoveryIntentRecord<I>, 'dispatchAttemptId' | 'recoveryCorrelationId'>
>;

/**
 * One startup obligation read. `available` with no obligations proves storage
 * holds none; `unavailable` proves nothing, so a caller must never treat it as
 * an empty sweep (#2823). For the two credential scans, rows already fenced
 * before a mid-scan failure stay durable and are read again by the next scan.
 * A partial scan carries any already-fenced due rows so their outcomes can be
 * recorded even though the remainder must be retried.
 */
export type RecoveryObligationScan<T> =
  | { kind: 'available'; obligations: T[] }
  | { kind: 'unavailable'; obligations?: T[] };

/**
 * The recovery state machine at the orchestration Seam.
 *
 * Callers arm an intent, inspect immutable redacted state, and claim a single
 * opaque dispatch capability. A claim can be released only before invocation;
 * after that it can accept provider evidence or become indeterminate. Startup
 * reconciliation makes abandoned prepared claims non-retryable. SQLite,
 * settlement credentials, and compare-and-set keys stay inside this Module.
 */
export interface RecoveryLedger<
  I extends RecoveryIntentShape,
  P,
  Reason extends string,
> {
  arm(input: RecoveryIntentInput<I>): RecoveryIntentSnapshot<I>;
  find(fingerprint: string): RecoveryIntentSnapshot<I> | null;
  latestProjection(threadId: string): P | undefined;
  pending(): RecoveryIntentSnapshot<I>[];
  compensationSnapshot(): RecoveryIntentSnapshot<I>[];
  claim(input: {
    fingerprint: string;
    kind: 'due' | 'profile';
    /** #3157: a user's "Resume now" on a usage-limit intent, before its due time. */
    immediate?: boolean;
    now: string;
  }): { kind: 'owner'; attempt: RecoveryClaim } | { kind: 'unavailable' };
  observe(input: {
    recoveryCorrelationId: string;
    turnId: string;
    now: string;
  }): RecoveryIntentSnapshot<I> | null;
  /** Changes only still-prepared attempts and returns exactly those winners. */
  reconcilePrepared(
    now: string,
    kind?: 'due' | 'profile',
    /** Legacy profile rows have no exact credential receipt authority. */
    unlinkedOnly?: boolean,
  ): RecoveryObligationScan<RecoveryIntentSnapshot<I>>;
  /**
   * Startup-only exact credential settlement work. Prepared rows are changed
   * to indeterminate before returning; accepted rows retain their provider
   * truth so the credential Module can terminalize an adopted receipt.
   */
  reconcilePreparedCredentials(
    now: string,
  ): RecoveryObligationScan<RecoveryCredentialStartupHandle<I>>;
  terminal(
    fingerprint: string,
    outcome: Extract<I['outcome'], 'succeeded' | 'failed' | 'canceled'>,
    now: string,
  ): RecoveryTransition;
  compensationRequired(
    fingerprint: string,
    now: string,
    expectedOutcome?: 'resumed' | 'canceled' | 'indeterminate',
  ): RecoveryTransition;
  resolveCompensation(fingerprint: string, now: string): RecoveryTransition;
  cancel(fingerprint: string, now: string, reason?: Reason): RecoveryTransition;
  /**
   * #3157: settles a still-waiting intent (armed, or a usage-limit intent left
   * to the user as `manual`; never claimed) without a dispatch, recording
   * why. A claimed intent is `stale` here.
   */
  retireWaiting(input: {
    fingerprint: string;
    outcome: 'manual' | 'canceled';
    reason: Reason;
    now: string;
  }): RecoveryTransition;
  /** #3157: usage-limit intents left to the user (`manual`), never claimed. */
  awaitingUser(): RecoveryIntentSnapshot<I>[];
  /** Startup repair: source-terminal events remain authoritative after a canceled write fault. */
  cancelSourceTerminated(now: string): RecoveryTransition;
  /**
   * #3563: the startup repair's rule for one intent, checked when its timer
   * fires. `applied` canceled it; `stale` lets dispatch proceed.
   */
  cancelIfSourceTerminated(
    fingerprint: string,
    now: string,
  ): RecoveryTransition;
  cancelShutdownRequested(now: string): RecoveryTransition;
}

/**
 * Startup-only capability for one already-fenced credential receipt. The
 * attempt key stays in this closure; the credential Adapter may use it only
 * while executing the supplied exact operation.
 */
interface RecoveryCredentialStartupHandle<I extends RecoveryIntentShape> {
  readonly intent: RecoveryIntentSnapshot<I>;
  inspect(): Promise<RecoveryCredentialReceiptOutcome>;
  settle(
    action: 'commit' | 'rollback',
  ): Promise<RecoveryCredentialReceiptOutcome>;
  acknowledge(): Promise<RecoveryTransition>;
}

export type RecoveryCredentialReceiptOutcome = {
  kind:
    | 'adopted'
    | 'already-adopted'
    | 'rolled-back'
    | 'already-rolled-back'
    | 'superseded'
    | 'staged'
    | 'unknown'
    | 'indeterminate';
};

/** Private composition Adapter: the opaque key never crosses RecoveryLedger's Interface. */
interface RecoveryCredentialStartupOperations {
  inspect(input: {
    provider: string;
    recoveryFingerprint: string;
    action: 'commit' | 'rollback';
  }): Promise<RecoveryCredentialReceiptOutcome>;
  settle(input: {
    provider: string;
    recoveryFingerprint: string;
    action: 'commit' | 'rollback';
  }): Promise<RecoveryCredentialReceiptOutcome>;
  acknowledge(input: {
    provider: string;
    recoveryFingerprint: string;
  }): Promise<RecoveryTransition>;
}

/** A claim-local capability. Its transition keys never come from callers. */
export interface RecoveryClaim {
  /** Adds the opaque correlation only to the provider Adapter's dispatch intent. */
  replay<T extends object>(input: T): T & { recoveryCorrelationId: string };
  /** Durably reserves one opaque registry application key before staging. */
  prepareCredential(
    now: string,
  ): { kind: 'owner'; attemptId: string } | { kind: 'unavailable' | 'invalid' };
  releaseBeforeInvocation(input: {
    outcome: 'armed' | 'manual';
    now: string;
  }): RecoveryTransition;
  acceptFromProvider(input: {
    turnId: string;
    now: string;
  }): RecoveryTransition;
  indeterminate(now: string): RecoveryTransition;
}

export interface RecoveryLedgerCoordinator<
  I extends RecoveryIntentShape,
  P,
  Reason extends string,
> {
  arm(input: RecoveryIntentInput<I>): RecoveryIntentRecord<I>;
  find(fingerprint: string): RecoveryIntentRecord<I> | null;
  latestProjection(threadId: string): P | undefined;
  pending(): RecoveryIntentRecord<I>[];
  compensationSnapshot(): RecoveryIntentRecord<I>[];
  claim(input: {
    fingerprint: string;
    kind: 'due' | 'profile';
    immediate?: boolean;
    dispatchAttemptId: string;
    recoveryCorrelationId: string;
    owner: RecoveryOwner;
    now: string;
  }): RecoveryIntentRecord<I> | null;
  release(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    outcome: 'armed' | 'manual';
    now: string;
  }): RecoveryTransition;
  accept(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    turnId: string;
    now: string;
  }): RecoveryTransition;
  observe(
    recoveryCorrelationId: string,
    turnId: string,
    now: string,
  ): RecoveryIntentRecord<I> | null;
  indeterminate(
    fingerprint: string,
    dispatchAttemptId: string,
    now: string,
  ): RecoveryTransition;
  linkCredential(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    credentialAttemptId: string;
    now: string;
  }): RecoveryTransition;
  reconcilePrepared(
    kind?: 'due' | 'profile',
    unlinkedOnly?: boolean,
  ): Array<{
    intent: RecoveryIntentRecord<I>;
    ownerId: string | null;
    ownerPid: number | null;
    ownerBirth: string | null;
    ownerIdentityKind: string | null;
    credentialAttemptId: string | null;
  }>;
  indeterminatePrepared(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    recoveryCorrelationId: string;
    ownerId: string | null;
    ownerPid: number | null;
    now: string;
  }): RecoveryIntentRecord<I> | null;
  terminal(
    fingerprint: string,
    outcome: Extract<I['outcome'], 'succeeded' | 'failed' | 'canceled'>,
    now: string,
  ): RecoveryTransition;
  compensationRequired(
    fingerprint: string,
    now: string,
    expectedOutcome: 'resumed' | 'canceled' | 'indeterminate',
  ): RecoveryTransition;
  resolveCompensation(fingerprint: string, now: string): RecoveryTransition;
  cancel(fingerprint: string, now: string, reason?: Reason): RecoveryTransition;
  retireWaiting(input: {
    fingerprint: string;
    outcome: 'manual' | 'canceled';
    reason: Reason;
    now: string;
  }): RecoveryTransition;
  awaitingUser(): RecoveryIntentRecord<I>[];
  cancelSourceTerminated(now: string): RecoveryTransition;
  cancelIfSourceTerminated(
    fingerprint: string,
    now: string,
  ): RecoveryTransition;
  cancelShutdownRequested(now: string): RecoveryTransition;
}

export type RecoveryOwner =
  | { id: string; pid: number; birth: string; identityKind: 'exact' }
  | { id: string; pid: number; identityKind: 'unverified' };

export interface RecoveryLedgerProcessIdentity {
  exact(pid: number): { pid: number; start: string } | null;
  probe(
    pid: number,
  ):
    | { state: 'dead' }
    | { state: 'unavailable' }
    | { state: 'exact'; identity: { pid: number; start: string } };
}

function snapshot<I extends RecoveryIntentShape>(
  intent: RecoveryIntentRecord<I>,
): RecoveryIntentSnapshot<I> {
  const {
    dispatchAttemptId: _attempt,
    recoveryCorrelationId: _correlation,
    ...safe
  } = intent;
  return Object.freeze({ ...safe });
}

function unavailable(): RecoveryTransition {
  return { kind: 'unavailable' };
}

export function createRecoveryLedger<
  I extends RecoveryIntentShape,
  P,
  Reason extends string,
>(options: {
  coordinator: RecoveryLedgerCoordinator<I, P, Reason>;
  /** Process identity fences startup reconciliation from a still-live owner. */
  processIdentity: RecoveryLedgerProcessIdentity;
  /** EventStore owns one stable process owner across its ledger views. */
  owner?: RecoveryOwner;
  credentialStartup?: RecoveryCredentialStartupOperations;
}): RecoveryLedger<I, P, Reason> {
  const processIdentity = options.processIdentity;
  const identity = processIdentity.exact(process.pid);
  const owner: RecoveryOwner =
    options.owner ??
    (identity
      ? {
          id: randomUUID(),
          pid: process.pid,
          birth: identity.start,
          identityKind: 'exact',
        }
      : { id: randomUUID(), pid: process.pid, identityKind: 'unverified' });
  activeOwners.add(owner.id);
  return {
    arm: (input) => snapshot(options.coordinator.arm(input)),
    find: (fingerprint) => {
      const found = options.coordinator.find(fingerprint);
      return found ? snapshot(found) : null;
    },
    latestProjection: (threadId) =>
      options.coordinator.latestProjection(threadId),
    pending: () => options.coordinator.pending().map(snapshot),
    compensationSnapshot: () =>
      options.coordinator.compensationSnapshot().map(snapshot),
    claim: ({ fingerprint, kind, immediate, now }) => {
      const id = randomUUID();
      const correlationId = randomUUID();
      let claimed: I | null;
      try {
        claimed = options.coordinator.claim({
          fingerprint,
          kind,
          ...(immediate ? { immediate } : {}),
          dispatchAttemptId: id,
          recoveryCorrelationId: correlationId,
          owner,
          now,
        });
      } catch {
        return { kind: 'unavailable' };
      }
      if (!claimed) return { kind: 'unavailable' };
      let intent: RecoveryTransitionIntent | undefined;
      let settled: RecoveryTransition | undefined;
      let credential:
        | { attemptId: string; now: string; linked: boolean }
        | undefined;
      const transition = (
        next: NonNullable<typeof intent>,
        apply: () => RecoveryTransition,
      ): RecoveryTransition => {
        const decision = decideRecoveryTransition(intent, next, settled);
        if (decision.kind === 'return') return decision.result;
        intent = next;
        try {
          const result = apply();
          if (result.kind === 'applied') settled = result;
          return result;
        } catch {
          return unavailable();
        }
      };
      return {
        kind: 'owner',
        attempt: Object.freeze({
          replay: <T extends object>(input: T) =>
            Object.freeze({ ...input, recoveryCorrelationId: correlationId }),
          prepareCredential: (preparedAt: string) => {
            if (credential && credential.now !== preparedAt)
              return { kind: 'invalid' as const };
            credential ??= {
              attemptId: randomUUID(),
              now: preparedAt,
              linked: false,
            };
            if (credential.linked)
              return {
                kind: 'owner' as const,
                attemptId: credential.attemptId,
              };
            try {
              const result = options.coordinator.linkCredential({
                fingerprint,
                dispatchAttemptId: id,
                credentialAttemptId: credential.attemptId,
                now: preparedAt,
              });
              if (result.kind === 'applied') {
                credential.linked = true;
                return {
                  kind: 'owner' as const,
                  attemptId: credential.attemptId,
                };
              }
              return {
                kind: result.kind === 'invalid' ? 'invalid' : 'unavailable',
              } as const;
            } catch {
              return { kind: 'unavailable' as const };
            }
          },
          releaseBeforeInvocation: ({
            outcome,
            now: releasedAt,
          }: {
            outcome: 'armed' | 'manual';
            now: string;
          }) =>
            transition({ kind: 'release', outcome, now: releasedAt }, () =>
              options.coordinator.release({
                fingerprint,
                dispatchAttemptId: id,
                outcome,
                now: releasedAt,
              }),
            ),
          acceptFromProvider: ({
            turnId,
            now: acceptedAt,
          }: {
            turnId: string;
            now: string;
          }) =>
            transition({ kind: 'accept', turnId, now: acceptedAt }, () =>
              options.coordinator.accept({
                fingerprint,
                dispatchAttemptId: id,
                turnId,
                now: acceptedAt,
              }),
            ),
          indeterminate: (indeterminateAt: string) =>
            transition({ kind: 'indeterminate', now: indeterminateAt }, () =>
              options.coordinator.indeterminate(
                fingerprint,
                id,
                indeterminateAt,
              ),
            ),
        }),
      };
    },
    observe: ({ recoveryCorrelationId, turnId, now }) => {
      try {
        const observed = options.coordinator.observe(
          recoveryCorrelationId,
          turnId,
          now,
        );
        return observed ? snapshot(observed) : null;
      } catch {
        return null;
      }
    },
    reconcilePrepared: (now, kind, unlinkedOnly = false) => {
      const reconciled: RecoveryIntentSnapshot<I>[] = [];
      try {
        for (const prepared of options.coordinator.reconcilePrepared(
          kind,
          unlinkedOnly,
        )) {
          // Legacy rows have no dispatch identity to reclaim. Migration made
          // them indeterminate, and the caller owns the explicit legacy
          // cleanup decision rather than trying to manufacture a claim.
          if (
            prepared.intent.outcome === 'indeterminate' &&
            !prepared.intent.dispatchAttemptId &&
            !prepared.intent.recoveryCorrelationId
          ) {
            reconciled.push(snapshot(prepared.intent));
            continue;
          }
          if (
            ownerIsLive(
              prepared.ownerId,
              prepared.ownerPid,
              prepared.ownerBirth,
              prepared.ownerIdentityKind,
              processIdentity,
            )
          )
            continue;
          const intent = options.coordinator.indeterminatePrepared({
            fingerprint: prepared.intent.fingerprint,
            dispatchAttemptId: prepared.intent.dispatchAttemptId!,
            recoveryCorrelationId: prepared.intent.recoveryCorrelationId!,
            ownerId: prepared.ownerId,
            ownerPid: prepared.ownerPid,
            now,
          });
          if (intent) reconciled.push(snapshot(intent));
        }
        return { kind: 'available', obligations: reconciled };
      } catch {
        return {
          kind: 'unavailable',
          ...(reconciled.length ? { obligations: reconciled } : {}),
        };
      }
    },
    reconcilePreparedCredentials: (now) => {
      try {
        const reconciled: RecoveryCredentialStartupHandle<I>[] = [];
        for (const prepared of options.coordinator.reconcilePrepared(
          'profile',
        )) {
          if (
            !prepared.credentialAttemptId ||
            (prepared.intent.outcome !== 'succeeded' &&
              prepared.intent.outcome !== 'indeterminate' &&
              ownerIsLive(
                prepared.ownerId,
                prepared.ownerPid,
                prepared.ownerBirth,
                prepared.ownerIdentityKind,
                processIdentity,
              ))
          )
            continue;
          const intent =
            prepared.intent.outcome === 'succeeded' ||
            prepared.intent.outcome === 'indeterminate' ||
            prepared.intent.dispatchSettlement === 'accepted'
              ? prepared.intent
              : options.coordinator.indeterminatePrepared({
                  fingerprint: prepared.intent.fingerprint,
                  dispatchAttemptId: prepared.intent.dispatchAttemptId!,
                  recoveryCorrelationId: prepared.intent.recoveryCorrelationId!,
                  ownerId: prepared.ownerId,
                  ownerPid: prepared.ownerPid,
                  now,
                });
          if (intent) {
            const recoveryFingerprint = prepared.credentialAttemptId;
            reconciled.push(
              Object.freeze({
                intent: snapshot(intent),
                inspect: () =>
                  options.credentialStartup?.inspect({
                    provider: intent.provider,
                    recoveryFingerprint,
                    action: 'commit',
                  }) ?? Promise.resolve({ kind: 'indeterminate' as const }),
                settle: (action: 'commit' | 'rollback') =>
                  options.credentialStartup?.settle({
                    provider: intent.provider,
                    recoveryFingerprint,
                    action,
                  }) ?? Promise.resolve({ kind: 'indeterminate' as const }),
                acknowledge: () =>
                  options.credentialStartup?.acknowledge({
                    provider: intent.provider,
                    recoveryFingerprint,
                  }) ?? Promise.resolve({ kind: 'unavailable' as const }),
              }),
            );
          }
        }
        return { kind: 'available', obligations: reconciled };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    terminal: (fingerprint, outcome, now) => {
      try {
        return options.coordinator.terminal(fingerprint, outcome, now);
      } catch {
        return unavailable();
      }
    },
    compensationRequired: (fingerprint, now, expectedOutcome = 'resumed') => {
      try {
        return options.coordinator.compensationRequired(
          fingerprint,
          now,
          expectedOutcome,
        );
      } catch {
        return unavailable();
      }
    },
    resolveCompensation: (fingerprint, now) => {
      try {
        return options.coordinator.resolveCompensation(fingerprint, now);
      } catch {
        return unavailable();
      }
    },
    cancel: (fingerprint, now, reason) => {
      try {
        return options.coordinator.cancel(fingerprint, now, reason);
      } catch {
        return unavailable();
      }
    },
    awaitingUser: () => {
      try {
        return options.coordinator.awaitingUser().map(snapshot);
      } catch {
        return [];
      }
    },
    retireWaiting: (input) => {
      try {
        return options.coordinator.retireWaiting(input);
      } catch {
        return unavailable();
      }
    },
    cancelSourceTerminated: (now) => {
      try {
        return options.coordinator.cancelSourceTerminated(now);
      } catch {
        return unavailable();
      }
    },
    cancelIfSourceTerminated: (fingerprint, now) => {
      try {
        return options.coordinator.cancelIfSourceTerminated(fingerprint, now);
      } catch {
        return unavailable();
      }
    },
    cancelShutdownRequested: (now) => {
      try {
        return options.coordinator.cancelShutdownRequested(now);
      } catch {
        return unavailable();
      }
    },
  };
}

const activeOwners = new Set<string>();
const releasedOwners = new Set<string>();

/** EventStore closes this private owner registration before closing SQLite. */
export function releaseRecoveryLedgerOwner(ownerId: string): void {
  activeOwners.delete(ownerId);
  releasedOwners.add(ownerId);
}

function ownerIsLive(
  ownerId: string | null,
  ownerPid: number | null,
  ownerBirth: string | null,
  ownerIdentityKind: string | null,
  processIdentity: RecoveryLedgerProcessIdentity,
): boolean {
  if (!ownerId || !ownerPid) return false;
  const owner =
    ownerIdentityKind === 'exact' && ownerBirth
      ? {
          id: ownerId,
          pid: ownerPid,
          identityKind: 'exact' as const,
          birth: ownerBirth,
        }
      : { id: ownerId, pid: ownerPid, identityKind: 'unverified' as const };
  return (
    ownerLivenessFromProbe((pid) => processIdentity.probe(pid), {
      isReleased: (id) => releasedOwners.has(id),
      isLocallyLive: (id) => ownerPid === process.pid && activeOwners.has(id),
    })(owner) !== 'dead'
  );
}
