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
type HomeScopeInput = {
  owner: HomeWriterOwner;
  current(): undefined;
};
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface ReportRoundsScope {
  readonly owner: HomeWriterOwner;
  readonly lease: HomeWriterLease;
  current(): undefined;
}

export interface ReportRoundsPublication {
  assertCurrent(): undefined;
  withHome<T>(
    input: HomeScopeInput,
    body: (scope: ReportRoundsScope) => Promise<T>,
  ): Promise<T>;
  transactionOwner(
    input: HomeScopeInput & {
      groupId: string;
      build(scope: ReportRoundsScope): ScopedFacades;
    },
  ): DelegationRoundsTransactionOwner;
}

async function finish<T>(
  outcome: Outcome<T>,
  release: () => Promise<void>,
): Promise<T> {
  try {
    await release();
  } catch (error) {
    throw new DelegationRoundsTransactionUncertainError(
      outcome.ok ? 'returned-cleanup-unknown' : 'publication-unknown',
      outcome.ok ? [error] : [outcome.error, error],
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
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
  const acquireHome = async (options: HomeScopeInput) => {
    current();
    const { owner, current: sourceCurrent } = options;
    participant.assertHome(owner.homeDir);
    const child = parent.borrow();
    let lease: HomeWriterLease | undefined;
    let scopeActive = true;
    let cleanup: (() => Promise<void>) | undefined;
    const release = (): Promise<void> => {
      scopeActive = false;
      if (!cleanup) {
        const ownedCleanup: () => Promise<void> = participant.retainCleanup(
          async () => {
            if (lease) await lease.release();
            await owner.settlePendingCleanup();
            child.release();
            retiredScopes.delete(ownedCleanup);
          },
        );
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
      return { scope: { owner, lease, current: assertCurrent }, release };
    } catch (error) {
      return finish<never>({ ok: false, error }, release);
    }
  };
  const publication: ReportRoundsPublication = Object.freeze({
    assertCurrent: current,
    withHome: async <Value>(
      options: HomeScopeInput,
      work: (scope: ReportRoundsScope) => Promise<Value>,
    ): Promise<Value> => {
      const held = await acquireHome(options);
      let returned = false;
      let outcome: Outcome<Value>;
      try {
        const value = await work(held.scope);
        returned = true;
        held.scope.current();
        outcome = { ok: true, value };
      } catch (error) {
        outcome = {
          ok: false,
          error: returned
            ? new DelegationRoundsTransactionUncertainError(
                'returned-cleanup-unknown',
                [error],
              )
            : error,
        };
      }
      return finish(outcome, held.release);
    },
    transactionOwner: (
      options: Parameters<ReportRoundsPublication['transactionOwner']>[0],
    ) => {
      participant.assertHome(options.owner.homeDir);
      current();
      const { groupId, build } = options;
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
          const held = await acquireHome(options);
          try {
            const facades = build(held.scope);
            held.scope.current();
            return {
              ...facades,
              assertCurrent: held.scope.current,
              release: held.release,
            };
          } catch (error) {
            return finish<never>({ ok: false, error }, held.release);
          }
        },
      };
    },
  });
  let outcome: Outcome<T>;
  try {
    outcome = { ok: true, value: await body(publication) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  active = false;
  return finish(
    outcome,
    participant.retainCleanup(async () => {
      for (const retire of retiredScopes) await retire();
      parent.release();
    }),
  );
}
