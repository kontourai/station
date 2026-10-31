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
  check<T>(body: () => T): T;
}

export interface ReportRoundsPublication {
  assertCurrent(): undefined;
  withHome<T>(
    input: HomeScopeInput,
    body: (scope: ReportRoundsScope) => Promise<T>,
  ): Promise<T>;
  invokeCurrent<Value>(
    input: HomeScopeInput,
    invoke: (check: <Result>(work: () => Result) => Result) => Promise<Value>,
  ): Promise<Value>;
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
    if (!active) throw new HomeWriterUnavailableError('borrow-unavailable');
    signal.throwIfAborted();
    const { owner, current: sourceCurrent } = options;
    const child = parent.borrow(owner.homeDir);
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
      if (!active || !scopeActive || !lease)
        throw new HomeWriterUnavailableError('borrow-unavailable');
      child.assertCurrent();
      signal.throwIfAborted();
      return owner.runWithLease(lease, sourceCurrent);
    };
    try {
      lease = await owner.acquire(signal);
      assertCurrent();
      const held = lease;
      const check = <Value>(body: () => Value): Value => {
        assertCurrent();
        const value = owner.runWithLease(held, body);
        assertCurrent();
        return value;
      };
      return {
        scope: { owner, lease: held, current: assertCurrent, check },
        release,
      };
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
    invokeCurrent: async <Value>(
      options: HomeScopeInput,
      invoke: (check: <Result>(work: () => Result) => Result) => Promise<Value>,
    ): Promise<Value> => {
      const held = await acquireHome(options);
      let effect: ReturnType<typeof parent.borrow>;
      try {
        held.scope.current();
        effect = parent.borrow();
      } catch (error) {
        return finish<never>({ ok: false, error }, held.release);
      }
      let work: Promise<Value>;
      try {
        held.scope.current();
        // Only the synchronous guard borrows home. Startup inherits no home span.
        work = invoke(held.scope.check);
      } catch (error) {
        effect.release();
        return finish<never>({ ok: false, error }, held.release);
      }
      const join: () => Promise<void> = participant.retainCleanup(async () => {
        await work.then(
          () => undefined,
          () => undefined,
        );
        effect.release();
        retiredScopes.delete(join);
      });
      retiredScopes.add(join);
      // Call release immediately, before the startup Promise can resume.
      try {
        await held.release();
      } catch (error) {
        throw new DelegationRoundsTransactionUncertainError(
          'returned-cleanup-unknown',
          [error],
        );
      }
      let outcome: Outcome<Value>;
      try {
        outcome = { ok: true, value: await work };
      } catch (error) {
        outcome = { ok: false, error };
      }
      return finish(outcome, join);
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
