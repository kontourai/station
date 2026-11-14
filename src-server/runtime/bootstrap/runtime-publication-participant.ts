import {
  assertStationHomeRuntimeProof,
  type StationHomeRuntimeProof,
} from '@kontourai/station-shared/station-home-lifecycle';

const owners = new WeakSet<object>();
class RuntimePublicationUnavailable extends Error {
  readonly code = 'runtime_publication_unavailable';
  constructor() {
    super('Runtime publication is unavailable or still pending.');
  }
}
class RuntimePublicationPending extends Error {
  readonly code = 'runtime_publication_pending';
  constructor() {
    super(
      'Runtime publication remains pending; shutdown retained its dependencies.',
    );
  }
}
export interface RuntimePublicationLease {
  assertCurrent(): void;
  assertReleasable(): void;
  borrow(homeDir?: string): { assertCurrent(): void; release(): void };
  release(): void;
}

/** A bootstrap-held lifetime; the home proof comes only from the lease owner. */
export class RuntimePublicationParticipant {
  #stopping = false;
  #pending = new Set<object>();
  #waiters = new Set<() => void>();
  #cleanups = new Set<() => Promise<void>>();
  constructor(private readonly home: StationHomeRuntimeProof) {
    assertStationHomeRuntimeProof(home);
    owners.add(this);
  }
  assertHome(homeDir: string): void {
    if (!owners.has(this)) throw new RuntimePublicationUnavailable();
    assertStationHomeRuntimeProof(this.home, homeDir);
  }
  acquire(): RuntimePublicationLease {
    if (!owners.has(this) || this.#stopping)
      throw new RuntimePublicationUnavailable();
    assertStationHomeRuntimeProof(this.home);
    const token = {};
    this.#pending.add(token);
    let released = false;
    let closing = false;
    const children = new Set<object>();
    const current = (homeDir?: string) => {
      if (released || !this.#pending.has(token))
        throw new RuntimePublicationUnavailable();
      assertStationHomeRuntimeProof(this.home, homeDir);
    };
    const releasable = () => {
      current();
      closing = true;
      if (children.size) throw new RuntimePublicationUnavailable();
    };
    return Object.freeze({
      assertCurrent: () => current(),
      assertReleasable: releasable,
      borrow: (homeDir?: string) => {
        current(homeDir);
        if (closing) throw new RuntimePublicationUnavailable();
        const child = {};
        children.add(child);
        let childReleased = false;
        return Object.freeze({
          assertCurrent: () => {
            if (childReleased || !children.has(child))
              throw new RuntimePublicationUnavailable();
            current();
          },
          release: () => {
            if (!childReleased) {
              childReleased = true;
              children.delete(child);
            }
          },
        });
      },
      release: () => {
        if (released) return;
        releasable();
        released = true;
        this.#pending.delete(token);
        if (!this.#pending.size) {
          for (const wake of this.#waiters) wake();
          this.#waiters.clear();
        }
      },
    });
  }
  async run<T>(
    body: (lease: RuntimePublicationLease) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquire();
    let result: T;
    try {
      result = await body(lease);
    } catch (error) {
      try {
        lease.release();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'Publication and release failed',
        );
      }
      throw error;
    }
    lease.release();
    return result;
  }
  stop(): void {
    this.#stopping = true;
  }
  retainCleanup(cleanup: () => Promise<void>): () => Promise<void> {
    if (!owners.has(this)) throw new RuntimePublicationUnavailable();
    let running: Promise<void> | undefined;
    const retry = () => {
      running ??= cleanup()
        .then(() => {
          this.#cleanups.delete(retry);
        })
        .finally(() => {
          running = undefined;
        });
      return running;
    };
    this.#cleanups.add(retry);
    return retry;
  }
  async drain(timeoutMs: number): Promise<void> {
    if (!this.#stopping) throw new RuntimePublicationUnavailable();
    for (const cleanup of this.#cleanups) {
      // A failed or stalled cleanup keeps its admission for a later retry.
      void cleanup().catch(() => {});
    }
    if (!this.#pending.size) return;
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(wake);
        reject(new RuntimePublicationPending());
      }, timeoutMs);
      this.#waiters.add(wake);
    });
  }
}
export function isRuntimePublicationParticipant(
  value: unknown,
): value is RuntimePublicationParticipant {
  return typeof value === 'object' && value !== null && owners.has(value);
}
