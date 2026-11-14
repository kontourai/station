import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertExistingSecurityDirectory } from '@kontourai/station-shared/environment-security-record';
import {
  acquireFileMutationLeaseAsync,
  type FileMutationLease,
  type PreparedFileMutationLease,
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
  admissions: Array<{ enter(): void }>;
  notifications: Array<() => void>;
};
type Holder = {
  core: Core;
  lease: PreparedFileMutationLease;
  active: boolean;
  retireAdmission(): void;
  releasing?: Promise<void>;
};
type Span = { lease: FileMutationLease; active: boolean };
type Lifetime = { lease: HomeWriterLease; active: boolean };
const homeWriterLeaseBrand = Symbol('HomeWriterLease');
export interface HomeWriterLease {
  readonly [homeWriterLeaseBrand]: true;
  assertCurrent(): void;
  release(): Promise<void>;
}
const synchronousSpanWitnessBrand = Symbol('HomeSynchronousSpanWitness');
export interface HomeSynchronousSpanWitness {
  readonly [synchronousSpanWitnessBrand]: true;
}
const synchronousSpanWitnesses = new WeakMap<
  HomeSynchronousSpanWitness,
  {
    owner: HomeWriterOwner;
    core: Core;
    span: Span;
  }
>();
const cores = new Map<string, Promise<Core>>();
const leases = new WeakMap<HomeWriterLease, Holder>();
const spans = new AsyncLocalStorage<ReadonlyMap<Core, Span>>();
const lifetimes = new AsyncLocalStorage<ReadonlyMap<Core, Lifetime>>();

function releaseHolder(holder: Holder): Promise<void> {
  holder.active = false;
  if (holder.releasing) return holder.releasing;
  if (holder.lease.tryRelease() === 'released') {
    holder.core.holders.delete(holder);
    holder.retireAdmission();
    return Promise.resolve();
  }
  holder.releasing = holder.lease
    .release()
    .then(() => {
      holder.core.holders.delete(holder);
      holder.retireAdmission();
    })
    .finally(() => {
      holder.releasing = undefined;
    });
  return holder.releasing;
}

function flushNotifications(core: Core): void {
  if (core.holders.size || core.admissions.length) return;
  const notifications = core.notifications.splice(0);
  spans.exit(() => {
    for (const notify of notifications) {
      try {
        notify();
      } catch {}
    }
  });
}

const HOME_ACQUISITION_WAIT_MS = 10_000;

/** Local ordering grants no lease: each admitted writer still takes the physical lock. */
function queueAdmission(core: Core, signal?: AbortSignal) {
  const deadline = performance.now() + HOME_ACQUISITION_WAIT_MS;
  let entered = false;
  let retired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake!: () => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, refuse) => {
    wake = resolve;
    reject = refuse;
  });
  void ready.catch(() => {});
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  };
  const entry = {
    enter: () => {
      if (entered || retired) return;
      entered = true;
      clear();
      wake();
    },
  };
  const release = () => {
    if (retired) return;
    retired = true;
    clear();
    const index = core.admissions.indexOf(entry);
    core.admissions.splice(index, 1);
    if (index === 0) core.admissions[0]?.enter();
    flushNotifications(core);
  };
  const cancel = (error: unknown) => {
    if (entered || retired) return;
    reject(error);
    release();
  };
  const abort = () => cancel(signal?.reason);
  core.admissions.push(entry);
  if (core.admissions.length === 1) entry.enter();
  else {
    timer = setTimeout(
      () => cancel(new HomeWriterUnavailableError('busy')),
      HOME_ACQUISITION_WAIT_MS,
    );
    signal?.addEventListener('abort', abort, { once: true });
  }
  return { ready, deadline, release };
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

/** Completion validation only; callers separately own physical Home admission. */
export function runSynchronousHomeCallback<T>(body: () => T): T {
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
          admissions: [],
          notifications: [],
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

  /** Identity capture only; this makes no currentness or permission decision. */
  captureSynchronousSpan(): HomeSynchronousSpanWitness {
    const witness: HomeSynchronousSpanWitness = Object.freeze({
      [synchronousSpanWitnessBrand]: true as const,
    });
    const span = spans.getStore()?.get(this.#core);
    if (span)
      synchronousSpanWitnesses.set(witness, {
        owner: this,
        core: this.#core,
        span,
      });
    return witness;
  }

  assertSynchronous(witness?: HomeSynchronousSpanWitness): void {
    this.assertCurrent();
    const span = spans.getStore()?.get(this.#core);
    if (witness !== undefined) this.assertSynchronousSpanIdentity(witness);
    if (!span?.active)
      throw new HomeWriterUnavailableError('borrow-unavailable');
    span.lease.assertCurrent();
  }

  /** Identity only. Callers must separately retain their fresh physical guard. */
  assertSynchronousSpanIdentity(witness: HomeSynchronousSpanWitness): void {
    const captured = synchronousSpanWitnesses.get(witness);
    const span = spans.getStore()?.get(this.#core);
    if (
      !captured ||
      captured.owner !== this ||
      captured.core !== this.#core ||
      captured.span !== span ||
      !captured.span.active
    )
      throw new HomeWriterUnavailableError('borrow-unavailable');
  }

  #span<T>(lease: FileMutationLease, body: () => T): T {
    this.assertCurrent();
    lease.assertCurrent();
    const existing = spans.getStore()?.get(this.#core);
    if (existing) {
      if (!existing.active || existing.lease !== lease)
        throw new HomeWriterUnavailableError('borrow-unavailable');
      return runSynchronousHomeCallback(body);
    }
    const span: Span = { lease, active: true };
    const current = new Map(spans.getStore());
    current.set(this.#core, span);
    try {
      return spans.run(current, () => {
        const result = runSynchronousHomeCallback(body);
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
    const inherited = spans.getStore()?.get(this.#core);
    if (inherited?.active) return this.#span(inherited.lease, body);
    this.assertCurrent();
    if (inherited) throw new HomeWriterUnavailableError('borrow-unavailable');
    const lifetime = lifetimes.getStore()?.get(this.#core);
    if (lifetime) {
      if (!lifetime.active)
        throw new HomeWriterUnavailableError('borrow-unavailable');
      return this.runWithLease(lifetime.lease, body);
    }
    if (this.#core.holders.size || this.#core.admissions.length)
      throw new HomeWriterUnavailableError('busy');
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
    flushNotifications(this.#core);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  runWithLease<T>(lease: HomeWriterLease, body: () => T): T {
    const holder = leases.get(lease);
    if (!holder || holder.core !== this.#core || !holder.active)
      throw new HomeWriterUnavailableError('borrow-unavailable');
    return this.#span(holder.lease, body);
  }

  async withLeaseLifetime<T>(
    lease: HomeWriterLease,
    body: () => Promise<T>,
  ): Promise<T> {
    const holder = leases.get(lease);
    if (!holder || holder.core !== this.#core || !holder.active)
      throw new HomeWriterUnavailableError('borrow-unavailable');
    lease.assertCurrent();
    const existing = lifetimes.getStore()?.get(this.#core);
    if (existing) {
      if (!existing.active || existing.lease !== lease)
        throw new HomeWriterUnavailableError('borrow-unavailable');
    }
    const lifetime: Lifetime = { lease, active: true };
    const current = new Map(lifetimes.getStore());
    current.set(this.#core, lifetime);
    try {
      const result = await lifetimes.run(current, body);
      if (existing && !existing.active)
        throw new HomeWriterUnavailableError('borrow-unavailable');
      lease.assertCurrent();
      return result;
    } finally {
      lifetime.active = false;
    }
  }

  async runLifetime<T>(body: () => Promise<T>): Promise<T> {
    const existing = lifetimes.getStore()?.get(this.#core);
    if (existing) {
      if (!existing.active)
        throw new HomeWriterUnavailableError('borrow-unavailable');
      return this.withLeaseLifetime(existing.lease, body);
    }
    const lease = await this.acquire();
    let result: T;
    try {
      result = await this.withLeaseLifetime(lease, body);
    } catch (error) {
      try {
        await lease.release();
      } catch (releaseError) {
        throw new HomeWriterUnavailableError('cleanup-required', true, {
          cause: new AggregateError([error, releaseError]),
        });
      }
      throw error;
    }
    try {
      await lease.release();
    } catch (error) {
      throw new HomeWriterUnavailableError('cleanup-required', true, {
        cause: error,
      });
    }
    return result;
  }

  /** Own a bounded asynchronous transaction without lending it to descendants. */
  async runOwnedLease<T>(
    signal: AbortSignal,
    body: (lease: HomeWriterLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(signal);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      signal.throwIfAborted();
      outcome = { ok: true, value: await body(lease) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      await lease.release();
    } catch (error) {
      throw new HomeWriterUnavailableError('cleanup-required', true, {
        cause: outcome.ok ? error : new AggregateError([outcome.error, error]),
      });
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  afterRelease(notify: () => void): void {
    this.assertSynchronous();
    this.#core.notifications.push(notify);
  }

  async runExclusive<T>(body: () => T, within?: HomeWriterLease): Promise<T> {
    const lease = within ?? (await this.acquire());
    let ran = false;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = {
        ok: true,
        value: this.runWithLease(lease, () => {
          ran = true;
          return body();
        }),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (!within) {
      try {
        await lease.release();
      } catch (error) {
        throw new HomeWriterUnavailableError('cleanup-required', ran, {
          cause: error,
        });
      }
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Admit one request-bound synchronous check after acquiring the home. */
  async runRequest<T>(signal: AbortSignal, body: () => T): Promise<T> {
    signal.throwIfAborted();
    if (
      spans.getStore()?.has(this.#core) ||
      lifetimes.getStore()?.has(this.#core)
    )
      throw new HomeWriterUnavailableError('borrow-unavailable');
    let entered = false;
    try {
      return this.runSynchronous(() => {
        signal.throwIfAborted();
        entered = true;
        const value = body();
        signal.throwIfAborted();
        return value;
      });
    } catch (error) {
      if (
        entered ||
        !(error instanceof HomeWriterUnavailableError) ||
        error.operationRan ||
        (error.reason !== 'busy' && error.reason !== 'cleanup-required')
      )
        throw error;
    }
    const lease = await this.acquire(signal);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    let ran = false;
    try {
      outcome = {
        ok: true,
        value: this.runWithLease(lease, () => {
          signal.throwIfAborted();
          ran = true;
          const value = body();
          signal.throwIfAborted();
          return value;
        }),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      await lease.release();
    } catch (error) {
      throw new HomeWriterUnavailableError('cleanup-required', ran, {
        cause: outcome.ok ? error : new AggregateError([outcome.error, error]),
      });
    }
    if (!outcome.ok) throw outcome.error;
    signal.throwIfAborted();
    return outcome.value;
  }

  /** Retire only failed cleanup; this never releases an active sibling lease. */
  async settlePendingCleanup(): Promise<void> {
    this.assertCurrent();
    await this.#core.prepared.settlePendingCleanup();
    for (const holder of this.#core.holders)
      if (!holder.active) {
        await releaseHolder(holder);
      }
    if (!this.#core.holders.size) flushNotifications(this.#core);
  }

  async acquire(signal?: AbortSignal): Promise<HomeWriterLease> {
    this.assertCurrent();
    signal?.throwIfAborted();
    if (spans.getStore()?.has(this.#core))
      throw new HomeWriterUnavailableError('borrow-unavailable');
    const admission = queueAdmission(this.#core, signal);
    let registered = false;
    try {
      await this.settlePendingCleanup();
      await admission.ready;
      signal?.throwIfAborted();
      this.assertCurrent();
      const remaining = Math.ceil(admission.deadline - performance.now());
      if (remaining <= 0) throw new HomeWriterUnavailableError('busy');
      let base: PreparedFileMutationLease;
      try {
        base = await acquireFileMutationLeaseAsync(this.#core.lock, {
          timeoutMs: remaining,
        });
      } catch (error) {
        throw new HomeWriterUnavailableError('busy', false, { cause: error });
      }
      const holder: Holder = {
        core: this.#core,
        lease: base,
        active: true,
        retireAdmission: admission.release,
      };
      this.#core.holders.add(holder);
      registered = true;
      const lease: HomeWriterLease = Object.freeze({
        [homeWriterLeaseBrand]: true as const,
        assertCurrent: () => {
          if (!holder.active)
            throw new HomeWriterUnavailableError('borrow-unavailable');
          this.assertCurrent();
          base.assertCurrent();
        },
        release: () => releaseHolder(holder),
      });
      leases.set(lease, holder);
      try {
        signal?.throwIfAborted();
        lease.assertCurrent();
        for (const other of this.#core.holders)
          if (other !== holder && !other.active) await releaseHolder(other);
        return lease;
      } catch (error) {
        await lease.release();
        throw error;
      }
    } catch (error) {
      if (!registered) admission.release();
      throw error;
    }
  }
}
