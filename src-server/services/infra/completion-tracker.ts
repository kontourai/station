/**
 * CompletionTracker — tracks a set of in-flight "dispatch" tokens and lets
 * callers snapshot everything currently outstanding, then get a promise that
 * resolves once every token in that snapshot has completed — regardless of
 * the order completions actually arrive in (dispatches for different keys
 * can finish out of creation order under concurrency > 1).
 *
 * This is the shared idle/marker primitive behind DrainableWorker's
 * `drain()`/`marker()` and KeyedCoalescingWorker's
 * `drain()`/`drainKey()`/`marker()`: "resolve once every unit of work that
 * existed at call time has finished" without caring how many new units show
 * up afterward.
 */
export class CompletionTracker {
  private nextId = 0;
  private readonly outstanding = new Set<number>();
  private waiters: Array<{ remaining: Set<number>; resolve: () => void }> = [];

  /** Register a new outstanding dispatch and return its token id. */
  begin(): number {
    const id = this.nextId++;
    this.outstanding.add(id);
    return id;
  }

  /** Mark a dispatch complete, resolving any waiter whose snapshot is now fully drained. */
  complete(id: number): void {
    this.outstanding.delete(id);
    if (this.waiters.length === 0) return;
    const stillWaiting: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      waiter.remaining.delete(id);
      if (waiter.remaining.size === 0) {
        waiter.resolve();
      } else {
        stillWaiting.push(waiter);
      }
    }
    this.waiters = stillWaiting;
  }

  /** True when there is no outstanding dispatch at all right now. */
  get isIdle(): boolean {
    return this.outstanding.size === 0;
  }

  /** Number of dispatches registered via `begin()` but not yet `complete()`d. */
  get outstandingCount(): number {
    return this.outstanding.size;
  }

  /**
   * Resolves once every dispatch outstanding at call time has completed.
   * Dispatches begun after this call never block the returned promise.
   */
  waitForCurrent(): Promise<void> {
    if (this.outstanding.size === 0) return Promise.resolve();
    const remaining = new Set(this.outstanding);
    return new Promise((resolve) => {
      this.waiters.push({ remaining, resolve });
    });
  }
}
