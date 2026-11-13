import {
  type ContinuationPublicationLease,
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
import { assertSynchronous } from './delegation-group-wire-intent-store.js';

type ScopedFacades = Pick<
  DelegationRoundsTransactionScope,
  'store' | 'host' | 'authorityService'
>;
type HomeScopeInput = {
  owner: HomeWriterOwner;
  current(): undefined;
};
type PreparedHomeScopeInput = HomeScopeInput & {
  prepare?(scope: ReportRoundsScope): Promise<void>;
  assertPreparationCurrent?(scope: ReportRoundsScope): undefined;
};
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface ReportRoundsScope {
  readonly owner: HomeWriterOwner;
  readonly lease: HomeWriterLease;
  /** Publication/transaction lifetime only; does not admit Home or source use. */
  assertLifetimeCurrent(): undefined;
  current(): undefined;
  check<T>(body: () => T): T;
}

export interface ReportRoundsPublication {
  assertCurrent(): undefined;
  retainCleanup(cleanup: () => Promise<void>): () => Promise<void>;
  check<T>(input: HomeScopeInput, body: () => T): Promise<T>;
  withHome<T>(
    input: HomeScopeInput,
    body: (scope: ReportRoundsScope) => Promise<T>,
  ): Promise<T>;
  invokeCurrent<Value>(
    input: HomeScopeInput,
    invoke: (check: <Result>(work: () => Result) => Result) => Promise<Value>,
  ): Promise<Value>;
  acquireContinuationPublication(
    input: PreparedHomeScopeInput & { groupId: string },
  ): Promise<ContinuationPublicationLease>;
  transactionOwner(
    input: PreparedHomeScopeInput & {
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
    const assertLifetimeCurrent = (): undefined => {
      if (!active || !scopeActive)
        throw new HomeWriterUnavailableError('borrow-unavailable');
      child.assertCurrent();
      signal.throwIfAborted();
      return undefined;
    };
    const assertCurrent = (): undefined => {
      if (!lease) throw new HomeWriterUnavailableError('borrow-unavailable');
      assertLifetimeCurrent();
      return owner.runWithLease(lease, sourceCurrent);
    };
    try {
      lease = await owner.acquire(signal);
      assertCurrent();
      const held = lease;
      const check = <Value>(body: () => Value): Value =>
        owner.runWithLease(held, () => {
          assertLifetimeCurrent();
          assertSynchronous(sourceCurrent);
          const value = owner.runWithLease(held, body);
          assertCurrent();
          // The outer span must not inspect a caller-controlled then getter again.
          return { __proto__: null, value };
        }).value;
      return {
        scope: {
          owner,
          lease: held,
          assertLifetimeCurrent,
          current: assertCurrent,
          check,
        },
        release,
      };
    } catch (error) {
      return finish<never>({ ok: false, error }, release);
    }
  };
  const continuationParents = new WeakMap<
    ContinuationPublicationLease,
    {
      owner: HomeWriterOwner;
      groupId: string;
      sourceCurrent(): undefined;
      current(): undefined;
      borrow(): { scope: ReportRoundsScope; release(): Promise<void> };
    }
  >();
  const publication: ReportRoundsPublication = Object.freeze({
    assertCurrent: current,
    retainCleanup: (cleanup: () => Promise<void>) => {
      current();
      const child = parent.borrow();
      const retire: () => Promise<void> = participant.retainCleanup(
        async () => {
          await cleanup();
          child.release();
          retiredScopes.delete(retire);
        },
      );
      retiredScopes.add(retire);
      return retire;
    },
    check: async <Value>(
      options: HomeScopeInput,
      body: () => Value,
    ): Promise<Value> => {
      current();
      const { owner, current: sourceCurrent } = options;
      const child = parent.borrow(owner.homeDir);
      let returned = false;
      const work = owner.runRequest(signal, () => {
        current();
        child.assertCurrent();
        sourceCurrent();
        const value = body();
        returned = true;
        sourceCurrent();
        current();
        return value;
      });
      const join: () => Promise<void> = participant.retainCleanup(async () => {
        await work.then(
          () => undefined,
          () => undefined,
        );
        await owner.settlePendingCleanup();
        child.release();
        retiredScopes.delete(join);
      });
      retiredScopes.add(join);
      let outcome: Outcome<Value>;
      try {
        const value = await work;
        current();
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
      return finish(outcome, join);
    },
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
    acquireContinuationPublication: async (
      options: PreparedHomeScopeInput & { groupId: string },
    ): Promise<ContinuationPublicationLease> => {
      current();
      participant.assertHome(options.owner.homeDir);
      const held = await acquireHome(options);
      let parentActive = true;
      let prepared = false;
      let closing = false;
      const children = new Set<object>();
      const assertParentActive = () => {
        if (!parentActive || closing)
          throw new DelegationRoundsTransactionParentError();
      };
      const assertLifetimeCurrent = (): undefined => {
        assertParentActive();
        return held.scope.assertLifetimeCurrent();
      };
      const assertCurrent = (): undefined => {
        assertParentActive();
        held.scope.current();
        const checkPreparation = options.assertPreparationCurrent;
        if (prepared && checkPreparation)
          held.scope.check(() => checkPreparation(held.scope));
        return undefined;
      };
      const borrow = () => {
        assertCurrent();
        const child = {};
        children.add(child);
        let childActive = true;
        const assertChildActive = () => {
          if (!childActive || !children.has(child))
            throw new DelegationRoundsTransactionParentError();
        };
        const childCurrent = (): undefined => {
          assertChildActive();
          return assertCurrent();
        };
        const scope: ReportRoundsScope = {
          owner: held.scope.owner,
          lease: held.scope.lease,
          assertLifetimeCurrent: () => {
            assertChildActive();
            return assertLifetimeCurrent();
          },
          current: childCurrent,
          check: <Value>(work: () => Value): Value => {
            childCurrent();
            const value = held.scope.check(work);
            childCurrent();
            return value;
          },
        };
        return {
          scope,
          release: async () => {
            childActive = false;
            children.delete(child);
          },
        };
      };
      let token: ContinuationPublicationLease;
      const retire: () => Promise<void> = participant.retainCleanup(
        async () => {
          // Shutdown cannot close a parent while its operation or children use it.
          if ((active && !closing) || children.size)
            throw new DelegationRoundsTransactionParentError();
          parentActive = false;
          await held.release();
          continuationParents.delete(token);
          retiredScopes.delete(retire);
        },
      );
      retiredScopes.add(retire);
      token = Object.freeze({
        assertCurrent,
        flowAdmission: {
          acquire: async () => {
            const child = borrow();
            return {
              assertCurrent: child.scope.current,
              release: child.release,
            };
          },
        },
        release: async () => {
          if (children.size) throw new DelegationRoundsTransactionParentError();
          closing = true;
          await retire();
        },
      });
      continuationParents.set(token, {
        owner: options.owner,
        groupId: options.groupId,
        sourceCurrent: options.current,
        current: assertCurrent,
        borrow,
      });
      try {
        await options.prepare?.(held.scope);
        prepared = true;
        assertCurrent();
        return token;
      } catch (error) {
        return finish<never>({ ok: false, error }, token.release);
      }
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
          let held: Awaited<ReturnType<typeof acquireHome>>;
          if (request.publicationLease) {
            const continuation = continuationParents.get(
              request.publicationLease,
            );
            if (
              !continuation ||
              continuation.groupId !== groupId ||
              request.groupId !== groupId ||
              continuation.owner !== options.owner ||
              continuation.sourceCurrent !== options.current
            )
              throw new DelegationRoundsTransactionParentError();
            continuation.current();
            const child = continuation.borrow();
            held = { scope: child.scope, release: child.release };
          } else {
            if (request.groupId !== groupId)
              throw new HomeWriterUnavailableError('identity-unavailable');
            held = await acquireHome(options);
          }
          try {
            await options.prepare?.(held.scope);
            const checkPreparation = options.assertPreparationCurrent;
            const assertPrepared = (): undefined => {
              held.scope.current();
              if (checkPreparation)
                held.scope.check(() => checkPreparation(held.scope));
              return undefined;
            };
            let storeReturned = false;
            const assertCurrent = (): undefined =>
              storeReturned ? assertPrepared() : held.scope.current();
            assertPrepared();
            const facades = build(held.scope);
            assertPrepared();
            const store: typeof facades.store = checkPreparation
              ? {
                  ...facades.store,
                  transact: async (id, body) => {
                    const value = await facades.store.transact(id, body);
                    storeReturned = true;
                    return value;
                  },
                }
              : facades.store;
            return {
              ...facades,
              store,
              assertCurrent,
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
