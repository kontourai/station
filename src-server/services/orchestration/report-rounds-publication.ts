import {
  type DelegationRoundsTransactionOwner,
  DelegationRoundsTransactionParentError,
  type DelegationRoundsTransactionScope,
  DelegationRoundsTransactionUncertainError,
} from '@kontourai/flow-agents/delegation-group-rounds';
import {
  isRuntimePublicationParticipant,
  type RuntimePublicationParticipant,
} from '../../runtime/bootstrap/runtime-publication-participant.js';
import {
  type HomeWriterLease,
  type HomeWriterOwner,
  HomeWriterUnavailableError,
} from '../ssh/home-writer-owner.js';

type ScopedFacades = Pick<
  DelegationRoundsTransactionScope,
  'store' | 'host' | 'authorityService'
>;

export interface ReportRoundsScope {
  readonly owner: HomeWriterOwner;
  readonly lease: HomeWriterLease;
  current(): undefined;
}

export interface ReportRoundsPublication {
  assertCurrent(): undefined;
  transactionOwner(input: {
    groupId: string;
    owner: HomeWriterOwner;
    current(): undefined;
    build(scope: ReportRoundsScope): ScopedFacades;
  }): DelegationRoundsTransactionOwner;
}

/** Runtime admission spans the operation; home custody spans each transaction. */
export async function withReportRoundsPublication<T>(
  input: {
    participant: RuntimePublicationParticipant;
    home: string;
    signal: AbortSignal;
  },
  body: (publication: ReportRoundsPublication) => Promise<T>,
): Promise<T> {
  const { participant, home, signal } = input;
  if (!isRuntimePublicationParticipant(participant))
    throw new HomeWriterUnavailableError('identity-unavailable');
  participant.assertHome(home);
  signal.throwIfAborted();
  const parent = participant.acquire();
  let active = true;
  const retiredScopes = new Set<() => Promise<void>>();
  const current = (): undefined => {
    if (!active) throw new HomeWriterUnavailableError('borrow-unavailable');
    parent.assertCurrent();
    signal.throwIfAborted();
    return undefined;
  };
  const publication: ReportRoundsPublication = Object.freeze({
    assertCurrent: current,
    transactionOwner: (
      options: Parameters<ReportRoundsPublication['transactionOwner']>[0],
    ) => {
      participant.assertHome(options.owner.homeDir);
      current();
      const { groupId, owner, build, current: sourceCurrent } = options;
      return {
        acquire: async (
          request: Parameters<DelegationRoundsTransactionOwner['acquire']>[0],
        ) => {
          current();
          // Continuation borrowing needs its exact authenticated parent mapping.
          if (request.publicationLease)
            throw new DelegationRoundsTransactionParentError();
          if (request.groupId !== groupId)
            throw new HomeWriterUnavailableError('identity-unavailable');
          const child = parent.borrow();
          let lease: HomeWriterLease | undefined;
          let scopeActive = true;
          let cleanup: (() => Promise<void>) | undefined;
          const release = (): Promise<void> => {
            scopeActive = false;
            if (!cleanup) {
              const ownedCleanup: () => Promise<void> =
                participant.retainCleanup(async () => {
                  if (lease) await lease.release();
                  await owner.settlePendingCleanup();
                  child.release();
                  retiredScopes.delete(ownedCleanup);
                });
              cleanup = ownedCleanup;
              retiredScopes.add(ownedCleanup);
            }
            return cleanup();
          };
          const assertCurrent = (): undefined => {
            current();
            if (!scopeActive || !lease)
              throw new HomeWriterUnavailableError('borrow-unavailable');
            child.assertCurrent();
            return owner.runWithLease(lease, sourceCurrent);
          };
          try {
            lease = await owner.acquire(signal);
            assertCurrent();
            const facades = build({ owner, lease, current: assertCurrent });
            assertCurrent();
            return { ...facades, assertCurrent, release };
          } catch (error) {
            try {
              await release();
            } catch (cleanupError) {
              throw new DelegationRoundsTransactionUncertainError(
                'publication-unknown',
                [error, cleanupError],
              );
            }
            throw error;
          }
        },
      };
    },
  });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body(publication) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  active = false;
  const cleanup = participant.retainCleanup(async () => {
    for (const retire of retiredScopes) await retire();
    parent.release();
  });
  try {
    await cleanup();
  } catch (error) {
    throw new DelegationRoundsTransactionUncertainError(
      outcome.ok ? 'returned-cleanup-unknown' : 'publication-unknown',
      outcome.ok ? [error] : [outcome.error, error],
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
