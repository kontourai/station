import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertExistingSecurityDirectory } from '@kontourai/station-shared/environment-security-record';
import {
  acquireFileMutationLeaseAsync,
  type FileMutationLease,
  type PreparedFileMutationOwner,
  prepareFileMutationOwner,
} from '@kontourai/station-shared/lifecycle-events';

export class HomeWriterUnavailableError extends Error {
  constructor(
    readonly reason:
      | 'busy'
      | 'cleanup-required'
      | 'identity-unavailable'
      | 'borrow-unavailable',
    readonly operationRan = false,
    options?: ErrorOptions,
  ) {
    super('Station home writer is unavailable', options);
    this.name = 'HomeWriterUnavailableError';
  }
}

type Core = {
  home: string;
  lock: string;
  homeIdentity: Stats;
  securityIdentity: Stats;
  prepared: PreparedFileMutationOwner;
  holders: Set<Holder>;
};
type Holder = {
  core: Core;
  lease: FileMutationLease;
  active: boolean;
  releasing?: Promise<void>;
};
type Span = { lease: FileMutationLease; active: boolean };
const homeWriterLeaseBrand = Symbol('HomeWriterLease');
export interface HomeWriterLease {
  readonly [homeWriterLeaseBrand]: true;
  assertCurrent(): void;
  release(): Promise<void>;
}
const cores = new Map<string, Promise<Core>>();
const leases = new WeakMap<HomeWriterLease, Holder>();
const spans = new AsyncLocalStorage<ReadonlyMap<Core, Span>>();

function releaseHolder(holder: Holder): Promise<void> {
  holder.active = false;
  if (holder.releasing) return holder.releasing;
  holder.releasing = holder.lease
    .release()
    .then(() => {
      holder.core.holders.delete(holder);
    })
    .finally(() => {
      holder.releasing = undefined;
    });
  return holder.releasing;
}

function sameDirectory(current: Stats, captured: Stats): boolean {
  return (
    current.isDirectory() &&
    !current.isSymbolicLink() &&
    current.ino === captured.ino &&
    current.dev === captured.dev
  );
}

function assertCore(core: Core): void {
  if (
    !sameDirectory(lstatSync(core.home), core.homeIdentity) ||
    !sameDirectory(
      assertExistingSecurityDirectory(join(core.home, 'security')),
      core.securityIdentity,
    )
  )
    throw new HomeWriterUnavailableError('identity-unavailable');
}

function synchronous<T>(body: () => T): T {
  const result = body();
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    'then' in result &&
    typeof result.then === 'function'
  )
    throw new TypeError('Home writer spans must be synchronous');
  return result;
}

/** One resource domain per existing home; grants no credential or execution authority. */
export class HomeWriterOwner {
  readonly #core: Core;
  readonly #reference: string;

  private constructor(core: Core, reference: string) {
    this.#core = core;
    this.#reference = reference;
  }

  static async forHome(homeDir: string): Promise<HomeWriterOwner> {
    const reference = resolve(homeDir);
    const home = realpathSync(reference);
    let pending = cores.get(home);
    if (!pending) {
      pending = (async () => {
        const homeIdentity = lstatSync(home);
        if (!homeIdentity.isDirectory() || homeIdentity.isSymbolicLink())
          throw new HomeWriterUnavailableError('identity-unavailable');
        const securityIdentity = assertExistingSecurityDirectory(
          join(home, 'security'),
        );
        const lock = join(home, 'security', '.home-writer.mutation');
        const prepared = await prepareFileMutationOwner(lock);
        const core: Core = {
          home,
          lock,
          homeIdentity,
          securityIdentity,
          prepared,
          holders: new Set(),
        };
        assertCore(core);
        return core;
      })();
      cores.set(home, pending);
      const own = pending;
      pending.catch(() => {
        if (cores.get(home) === own) cores.delete(home);
      });
    }
    const owner = new HomeWriterOwner(await pending, reference);
    owner.assertCurrent();
    return owner;
  }

  get homeDir(): string {
    return this.#core.home;
  }

  assertCurrent(): void {
    try {
      if (realpathSync(this.#reference) !== this.#core.home)
        throw new HomeWriterUnavailableError('identity-unavailable');
      assertCore(this.#core);
    } catch (error) {
      if (error instanceof HomeWriterUnavailableError) throw error;
      throw new HomeWriterUnavailableError('identity-unavailable', false, {
        cause: error,
      });
    }
  }

  assertSynchronous(): void {
    this.assertCurrent();
    const span = spans.getStore()?.get(this.#core);
    if (!span?.active)
      throw new HomeWriterUnavailableError('borrow-unavailable');
    span.lease.assertCurrent();
  }

  #span<T>(lease: FileMutationLease, body: () => T): T {
    this.assertCurrent();
    lease.assertCurrent();
    const existing = spans.getStore()?.get(this.#core);
    if (existing) {
      if (!existing.active || existing.lease !== lease)
        throw new HomeWriterUnavailableError('borrow-unavailable');
      return synchronous(body);
    }
    const span: Span = { lease, active: true };
    const current = new Map(spans.getStore());
    current.set(this.#core, span);
    try {
      return spans.run(current, () => {
        const result = synchronous(body);
        try {
          this.assertCurrent();
          lease.assertCurrent();
        } catch (error) {
          throw new HomeWriterUnavailableError(
            error instanceof HomeWriterUnavailableError
              ? error.reason
              : 'identity-unavailable',
            true,
            { cause: error },
          );
        }
        return result;
      });
    } finally {
      span.active = false;
    }
  }

  runSynchronous<T>(body: () => T): T {
    this.assertCurrent();
    const inherited = spans.getStore()?.get(this.#core);
    if (inherited) {
      if (!inherited.active)
        throw new HomeWriterUnavailableError('borrow-unavailable');
      return this.#span(inherited.lease, body);
    }
    if (this.#core.holders.size) throw new HomeWriterUnavailableError('busy');
    const attempt = this.#core.prepared.tryAcquire();
    if (attempt.kind !== 'acquired')
      throw new HomeWriterUnavailableError(
        attempt.kind === 'busy' ? 'busy' : 'cleanup-required',
      );
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    let ran = false;
    try {
      outcome = {
        ok: true,
        value: this.#span(attempt.lease, () => {
          ran = true;
          return body();
        }),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (attempt.lease.tryRelease() !== 'released')
      throw new HomeWriterUnavailableError(
        'cleanup-required',
        ran,
        outcome.ok ? undefined : { cause: outcome.error },
      );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  runWithLease<T>(lease: HomeWriterLease, body: () => T): T {
    const holder = leases.get(lease);
    if (!holder || holder.core !== this.#core || !holder.active)
      throw new HomeWriterUnavailableError('borrow-unavailable');
    return this.#span(holder.lease, body);
  }

  async acquire(signal?: AbortSignal): Promise<HomeWriterLease> {
    this.assertCurrent();
    signal?.throwIfAborted();
    if (spans.getStore()?.has(this.#core))
      throw new HomeWriterUnavailableError('borrow-unavailable');
    await this.#core.prepared.settlePendingCleanup();
    for (const holder of this.#core.holders)
      if (!holder.active) {
        await releaseHolder(holder);
      }
    const base = await acquireFileMutationLeaseAsync(this.#core.lock);
    const holder: Holder = { core: this.#core, lease: base, active: true };
    this.#core.holders.add(holder);
    const lease: HomeWriterLease = Object.freeze({
      [homeWriterLeaseBrand]: true as const,
      assertCurrent: () => {
        if (!holder.active)
          throw new HomeWriterUnavailableError('borrow-unavailable');
        this.assertCurrent();
        base.assertCurrent();
      },
      release: () => {
        return releaseHolder(holder);
      },
    });
    leases.set(lease, holder);
    try {
      signal?.throwIfAborted();
      lease.assertCurrent();
      for (const other of this.#core.holders)
        if (other !== holder && !other.active) {
          await releaseHolder(other);
        }
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }
}
