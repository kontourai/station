import { randomUUID } from 'node:crypto';
import type {
  ConnectionRecoveryIntent,
  ConnectionRecoveryOutcome,
  ConnectionRecoveryProjection,
} from '@kontourai/station-contracts/connection-recovery';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';

/** Input accepted when a runtime error arms one durable recovery decision. */
export type RecoveryIntentInput = Omit<
  ConnectionRecoveryIntent,
  'attempts' | 'resumedTurnId'
>;

/** Caller-visible state deliberately excludes settlement credentials. */
export type RecoveryIntentSnapshot = Readonly<ConnectionRecoveryIntent>;

/** Private SQLite record; opaque dispatch identities never cross the Interface. */
type RecoveryIntentRecord = ConnectionRecoveryIntent & {
  dispatchAttemptId?: string;
  recoveryCorrelationId?: string;
};

/** Every durable compare-and-set reports whether it changed storage. */
export type RecoveryTransition =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

/**
 * The recovery state machine at the orchestration Seam.
 *
 * Callers arm an intent, inspect immutable redacted state, and claim a single
 * opaque dispatch capability. A claim can be released only before invocation;
 * after that it can accept provider evidence or become indeterminate. Startup
 * reconciliation makes abandoned prepared claims non-retryable. SQLite,
 * settlement credentials, and compare-and-set keys stay inside this Module.
 */
export interface RecoveryLedger {
  arm(input: RecoveryIntentInput): RecoveryIntentSnapshot;
  find(fingerprint: string): RecoveryIntentSnapshot | null;
  latestProjection(threadId: string): ConnectionRecoveryProjection | undefined;
  pending(): RecoveryIntentSnapshot[];
  compensationSnapshot(): RecoveryIntentSnapshot[];
  claim(input: {
    fingerprint: string;
    kind: 'due' | 'profile';
    now: string;
  }): { kind: 'owner'; attempt: RecoveryClaim } | { kind: 'unavailable' };
  observe(input: {
    recoveryCorrelationId: string;
    turnId: string;
    now: string;
  }): RecoveryIntentSnapshot | null;
  /** Changes only still-prepared attempts and returns exactly those winners. */
  reconcilePrepared(
    now: string,
    kind?: 'due' | 'profile',
    /** Legacy profile rows have no exact credential receipt authority. */
    unlinkedOnly?: boolean,
  ): RecoveryIntentSnapshot[];
  /**
   * Startup-only exact credential settlement work. Prepared rows are changed
   * to indeterminate before returning; accepted rows retain their provider
   * truth so the credential Module can terminalize an adopted receipt.
   */
  reconcilePreparedCredentials(now: string): RecoveryCredentialStartupHandle[];
  terminal(
    fingerprint: string,
    outcome: Extract<
      ConnectionRecoveryOutcome,
      'succeeded' | 'failed' | 'canceled'
    >,
    now: string,
  ): RecoveryTransition;
  compensationRequired(
    fingerprint: string,
    now: string,
    expectedOutcome?: 'resumed' | 'canceled' | 'indeterminate',
  ): RecoveryTransition;
  resolveCompensation(fingerprint: string, now: string): RecoveryTransition;
  cancel(fingerprint: string, now: string): RecoveryTransition;
  /** Startup repair: source-terminal events remain authoritative after a canceled write fault. */
  cancelSourceTerminated(now: string): RecoveryTransition;
  cancelShutdownRequested(now: string): RecoveryTransition;
}

/**
 * Startup-only capability for one already-fenced credential receipt. The
 * attempt key stays in this closure; the credential Adapter may use it only
 * while executing the supplied exact operation.
 */
export interface RecoveryCredentialStartupHandle {
  readonly intent: RecoveryIntentSnapshot;
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
export interface RecoveryCredentialStartupOperations {
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

interface RecoveryLedgerCoordinator {
  arm(input: RecoveryIntentInput): RecoveryIntentRecord;
  find(fingerprint: string): RecoveryIntentRecord | null;
  latestProjection(threadId: string): ConnectionRecoveryProjection | undefined;
  pending(): RecoveryIntentRecord[];
  compensationSnapshot(): RecoveryIntentRecord[];
  claim(input: {
    fingerprint: string;
    kind: 'due' | 'profile';
    dispatchAttemptId: string;
    recoveryCorrelationId: string;
    owner: RecoveryOwner;
    now: string;
  }): RecoveryIntentRecord | null;
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
  ): RecoveryIntentRecord | null;
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
    intent: RecoveryIntentRecord;
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
  }): RecoveryIntentRecord | null;
  terminal(
    fingerprint: string,
    outcome: Extract<
      ConnectionRecoveryOutcome,
      'succeeded' | 'failed' | 'canceled'
    >,
    now: string,
  ): RecoveryTransition;
  compensationRequired(
    fingerprint: string,
    now: string,
    expectedOutcome: 'resumed' | 'canceled' | 'indeterminate',
  ): RecoveryTransition;
  resolveCompensation(fingerprint: string, now: string): RecoveryTransition;
  cancel(fingerprint: string, now: string): RecoveryTransition;
  cancelSourceTerminated(now: string): RecoveryTransition;
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

const defaultProcessIdentity: RecoveryLedgerProcessIdentity = {
  exact: exactProcessIdentity,
  probe: probeExactProcessIdentity,
};

function snapshot(intent: RecoveryIntentRecord): RecoveryIntentSnapshot {
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

export function createRecoveryLedger(options: {
  coordinator: RecoveryLedgerCoordinator;
  /** Process identity fences startup reconciliation from a still-live owner. */
  processIdentity?: RecoveryLedgerProcessIdentity;
  /** EventStore owns one stable process owner across its ledger views. */
  owner?: RecoveryOwner;
  credentialStartup?: RecoveryCredentialStartupOperations;
}): RecoveryLedger {
  const processIdentity = options.processIdentity ?? defaultProcessIdentity;
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
    claim: ({ fingerprint, kind, now }) => {
      const id = randomUUID();
      const correlationId = randomUUID();
      let claimed: ConnectionRecoveryIntent | null;
      try {
        claimed = options.coordinator.claim({
          fingerprint,
          kind,
          dispatchAttemptId: id,
          recoveryCorrelationId: correlationId,
          owner,
          now,
        });
      } catch {
        return { kind: 'unavailable' };
      }
      if (!claimed) return { kind: 'unavailable' };
      let intent:
        | { kind: 'release'; outcome: 'armed' | 'manual'; now: string }
        | { kind: 'accept'; turnId: string; now: string }
        | { kind: 'indeterminate'; now: string }
        | undefined;
      let settled: RecoveryTransition | undefined;
      let credential:
        | { attemptId: string; now: string; linked: boolean }
        | undefined;
      const transition = (
        next: NonNullable<typeof intent>,
        apply: () => RecoveryTransition,
      ): RecoveryTransition => {
        if (intent && JSON.stringify(intent) !== JSON.stringify(next))
          return { kind: 'invalid' };
        if (settled) return settled;
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
      try {
        const reconciled: RecoveryIntentSnapshot[] = [];
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
        return reconciled;
      } catch {
        return [];
      }
    },
    reconcilePreparedCredentials: (now) => {
      try {
        const reconciled: RecoveryCredentialStartupHandle[] = [];
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
        return reconciled;
      } catch {
        return [];
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
    cancel: (fingerprint, now) => {
      try {
        return options.coordinator.cancel(fingerprint, now);
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
  if (releasedOwners.has(ownerId)) return false;
  if (ownerPid === process.pid && activeOwners.has(ownerId)) return true;
  const observed = processIdentity.probe(ownerPid);
  if (observed.state === 'dead') return false;
  if (observed.state === 'unavailable') return true;
  // An unverified owner cannot safely be reclaimed while its PID is live.
  return (
    ownerIdentityKind !== 'exact' ||
    !ownerBirth ||
    observed.identity.start === ownerBirth
  );
}
