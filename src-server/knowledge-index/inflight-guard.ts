/**
 * Keyed in-flight guard (SEC-2 / code-review HIGH-1, `s201-knowledge-retrieval`
 * remediation pass) — a fail-fast async mutex, not a queue. `run(key, fn)` executes
 * `fn` immediately if `key` isn't already active; a second concurrent call for the
 * same `key` throws `RebuildInProgressError` rather than waiting for the first to
 * finish. This is deliberately fail-fast (surfaced as HTTP 409 by the route layer)
 * rather than queueing — index rebuild/migration is a rare, explicit admin action,
 * not a hot path, so rejecting a racing second caller and asking it to retry is
 * simpler and more honest than silently serializing work behind the scenes.
 *
 * No new dependency: a `Set<string>` of active keys is the entire implementation
 * (the "Map<string, Promise>" pattern the finding suggested, minus actually needing
 * to hand back someone else's in-flight promise, since we never await it — we just
 * reject immediately if the key is already taken).
 *
 * Single-writer expectation: callers that mutate shared, derived state keyed by a
 * root id or a fixed global key (`SqliteVecIndexProvider.rebuildRoot`,
 * `migratePreIndexKnowledge`, the shared `vec0` table's dimension-change rebuild)
 * MUST run their mutation through this guard with a stable key for that resource —
 * see each call site's own doc comment for its chosen key.
 */
export class RebuildInProgressError extends Error {
  constructor(public readonly key: string) {
    super(`rebuild already in progress for ${key}`);
    this.name = 'RebuildInProgressError';
  }
}

export class KeyedInFlightGuard {
  private readonly active = new Set<string>();

  isLocked(key: string): boolean {
    return this.active.has(key);
  }

  /** Synchronous acquire for call sites that can't restructure around `run()`'s
   * async boundary (e.g. a lock taken partway through an already-synchronous
   * method). Throws `RebuildInProgressError` if `key` is already active; callers
   * MUST release in a `finally` block. */
  acquireSync(key: string): void {
    if (this.active.has(key)) {
      throw new RebuildInProgressError(key);
    }
    this.active.add(key);
  }

  release(key: string): void {
    this.active.delete(key);
  }

  /** Run `fn` under `key`'s lock. Throws `RebuildInProgressError` without invoking
   * `fn` at all if `key` is already active. Always releases the key afterward,
   * success or failure. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.acquireSync(key);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }
}
