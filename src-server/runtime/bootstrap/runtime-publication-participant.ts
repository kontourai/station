import {
  assertStationHomeRuntimeProof,
  type StationHomeRuntimeProof,
} from '@kontourai/station-shared/station-home-lifecycle';

const owners = new WeakSet<object>();
export class RuntimePublicationUnavailable extends Error {
  readonly code = 'runtime_publication_unavailable';
  constructor() {
    super('Runtime publication is unavailable or still pending.');
  }
}
export class RuntimePublicationPending extends Error {
  readonly code = 'runtime_publication_pending';
  constructor() {
    super(
      'Runtime publication remains pending; shutdown retained its dependencies.',
    );
  }
}
export interface RuntimePublicationLease {
  assertCurrent(): void;
  borrow(): { assertCurrent(): void; release(): void };
  release(): void;
}

/** A bootstrap-held lifetime; the home proof comes only from the lease owner. */
export class RuntimePublicationParticipant {
  #stopping = false;
  #pending = new Set<object>();
  #waiters = new Set<() => void>();
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
    const children = new Set<object>();
    const current = () => {
      if (released || !this.#pending.has(token))
        throw new RuntimePublicationUnavailable();
      assertStationHomeRuntimeProof(this.home);
    };
    return Object.freeze({
      assertCurrent: current,
      borrow: () => {
        current();
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
        if (children.size) throw new RuntimePublicationUnavailable();
        current();
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
  async drain(timeoutMs: number): Promise<void> {
    if (!this.#stopping) throw new RuntimePublicationUnavailable();
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
