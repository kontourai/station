import { CompletionTracker } from './completion-tracker.js';

export interface KeyedCoalescingWorkerOptions<V> {
  /**
   * Combine a newly enqueued value with one already queued (not yet
   * started) for the same key. Defaults to "keep latest" — the new value
   * replaces the queued one.
   */
  merge?: (current: V, next: V) => V;
  /**
   * Batch newly-pending keys for up to this many ms before dispatching them
   * (in addition to the always-on per-key coalescing). Flushes early if
   * `maxBatch` is reached first. Omit for no time-based batching — a
   * synchronous burst of `enqueue()` calls still coalesces per key because
   * the flush is deferred to a microtask either way.
   */
  windowMs?: number;
  /** Force a flush once this many distinct keys are pending, even if `windowMs` hasn't elapsed. */
  maxBatch?: number;
  /**
   * Max number of handler invocations running concurrently, across all
   * keys. Default 1. Regardless of this setting, **the same key is never
   * dispatched concurrently with itself** — a key's next value only starts
   * once its previous dispatch has fully completed, so per-key ordering is
   * always preserved. Ordering across *different* keys is not guaranteed
   * once concurrency > 1.
   */
  concurrency?: number;
  onError?: (error: unknown, key: unknown, value: V) => void;
}

interface KeyState<V> {
  pending?: { value: V; id: number };
  inFlight: boolean;
}

/**
 * KeyedCoalescingWorker — per-key coalescing async worker.
 *
 * Enqueuing a value for a key that already has a queued-but-not-started
 * value merges the two via the configured `merge` function instead of
 * growing the queue; a burst of N values for one key therefore invokes the
 * handler once with the merged result. Optional `windowMs`/`maxBatch`
 * batching additionally holds newly-pending keys for a short window before
 * making them eligible to dispatch, to widen the coalescing opportunity for
 * enqueues that aren't perfectly synchronous.
 *
 * `drain()`/`drainKey()` are the deterministic idle signals tests should
 * await instead of sleeping: they force any open batch window to flush
 * immediately, then resolve once the (or every) key's queued value and
 * in-flight handler run have both completed. `marker()` gives an
 * ordering-safe checkpoint built on the same completion-tracking
 * mechanism (it also force-flushes any open batch window) — its callback
 * never fires before every value enqueued (for any key) strictly before
 * the call has finished.
 */
export class KeyedCoalescingWorker<K, V> {
  private readonly states = new Map<K, KeyState<V>>();
  private readonly tracker = new CompletionTracker();
  private readonly merge: (current: V, next: V) => V;
  private readonly windowMs?: number;
  private readonly maxBatch?: number;
  private readonly concurrency: number;

  private readonly batchKeys = new Set<K>();
  private batchScheduled = false;
  private batchTimerHandle: ReturnType<typeof setTimeout> | null = null;

  private readonly dispatchQueue: K[] = [];
  private readonly queuedKeySet = new Set<K>();
  private activeCount = 0;

  private readonly keyIdleWaiters = new Map<K, Array<() => void>>();
  private stopped = false;

  constructor(
    private readonly handler: (key: K, value: V) => Promise<void>,
    private readonly options: KeyedCoalescingWorkerOptions<V> = {},
  ) {
    this.merge = options.merge ?? ((_current, next) => next);
    this.windowMs = options.windowMs;
    this.maxBatch = options.maxBatch;
    this.concurrency = options.concurrency ?? 1;
    if (this.concurrency < 1) {
      throw new Error('KeyedCoalescingWorker: concurrency must be >= 1.');
    }
  }

  enqueue(key: K, value: V): void {
    if (this.stopped) {
      throw new Error(
        'KeyedCoalescingWorker: cannot enqueue after stop()/dispose().',
      );
    }
    let state = this.states.get(key);
    if (!state) {
      state = { inFlight: false };
      this.states.set(key, state);
    }
    if (state.pending) {
      state.pending.value = this.merge(state.pending.value, value);
      return;
    }
    const id = this.tracker.begin();
    state.pending = { value, id };
    this.scheduleFlush(key);
  }

  /**
   * Resolves once every key currently pending or in flight (after forcing
   * any open batch window to flush) has fully idled. Keys enqueued after
   * this call never block the returned promise.
   */
  drain(): Promise<void> {
    this.flushBatch();
    return this.tracker.waitForCurrent();
  }

  /** Same as `drain()`, scoped to a single key. */
  drainKey(key: K): Promise<void> {
    if (this.batchKeys.has(key)) {
      this.batchKeys.delete(key);
      this.markReadyIfEligible(key);
      if (this.batchKeys.size === 0) this.cancelBatchTimer();
    }
    const state = this.states.get(key);
    if (!state || (!state.pending && !state.inFlight)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.keyIdleWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.keyIdleWaiters.set(key, waiters);
    });
  }

  /**
   * An ordering-safe marker checkpoint. This does not literally enqueue a
   * sentinel through the dispatch pipeline — it forces any open batch
   * window to flush immediately (same as `drain()`/`drainKey()`, so it
   * never idles waiting on a `windowMs` timer that hasn't been advanced),
   * then snapshots the `CompletionTracker` ids outstanding at that point
   * and waits for all of them to complete. `callback` (if provided) runs,
   * and the returned promise resolves, only after every value enqueued for
   * any key strictly before this call has finished — including a value
   * that was itself merged away into another dispatch, since a merge keeps
   * the original tracker id. It never overtakes earlier work; later
   * enqueues never block it.
   */
  marker(callback?: () => void): Promise<void> {
    this.flushBatch();
    return this.tracker.waitForCurrent().then(() => {
      callback?.();
    });
  }

  /** Stop accepting new work, then wait for every key to fully idle. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.drain();
  }

  /** Alias for `stop()` matching this repo's service-lifecycle naming. */
  dispose(): Promise<void> {
    return this.stop();
  }

  private scheduleFlush(key: K): void {
    this.batchKeys.add(key);
    if (this.maxBatch && this.batchKeys.size >= this.maxBatch) {
      this.flushBatch();
      return;
    }
    if (this.batchScheduled) return;
    this.batchScheduled = true;
    if (this.windowMs && this.windowMs > 0) {
      this.batchTimerHandle = setTimeout(
        () => this.flushBatch(),
        this.windowMs,
      );
      // Review fix (CRITICAL, archive#1093 Part B): a batch timer must
      // never hold the process open by itself — it's an internal
      // scheduling detail, not something a caller waits on directly
      // (`drain()`/`marker()` force-flush past it). Consumers that DO need
      // to keep the process alive already do so through their own
      // explicit means.
      this.batchTimerHandle.unref?.();
    } else {
      // No configured window: still defer by a microtask so a synchronous
      // burst of enqueue() calls for one key finishes coalescing before the
      // first dispatch actually starts running the handler.
      queueMicrotask(() => this.flushBatch());
    }
  }

  private cancelBatchTimer(): void {
    this.batchScheduled = false;
    if (this.batchTimerHandle) {
      clearTimeout(this.batchTimerHandle);
      this.batchTimerHandle = null;
    }
  }

  private flushBatch(): void {
    if (!this.batchScheduled && this.batchKeys.size === 0) return;
    this.cancelBatchTimer();
    const keys = Array.from(this.batchKeys);
    this.batchKeys.clear();
    for (const key of keys) {
      this.markReadyIfEligible(key);
    }
  }

  private markReadyIfEligible(key: K): void {
    const state = this.states.get(key);
    if (!state?.pending || state.inFlight) return;
    if (!this.queuedKeySet.has(key)) {
      this.queuedKeySet.add(key);
      this.dispatchQueue.push(key);
    }
    this.pumpDispatchQueue();
  }

  private pumpDispatchQueue(): void {
    while (
      this.activeCount < this.concurrency &&
      this.dispatchQueue.length > 0
    ) {
      const key = this.dispatchQueue.shift() as K;
      this.queuedKeySet.delete(key);
      const state = this.states.get(key);
      if (!state?.pending || state.inFlight) continue;
      const { value, id } = state.pending;
      state.pending = undefined;
      state.inFlight = true;
      this.activeCount++;
      void this.run(key, value, id, state);
    }
  }

  private async run(
    key: K,
    value: V,
    id: number,
    state: KeyState<V>,
  ): Promise<void> {
    try {
      await this.handler(key, value);
    } catch (error) {
      // onError is caller-supplied and may itself throw, or (despite the
      // `void`-typed signature) return a promise that later rejects; this
      // `run()` is invoked fire-and-forget (`void this.run(...)`), so an
      // escaping error here becomes an unhandled rejection that crashes the
      // process on Node's default settings. There is no further error
      // channel to report it on, so both cases are deliberately swallowed.
      try {
        const result = this.options.onError?.(error, key, value);
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        ) {
          Promise.resolve(result).catch(() => {
            // swallowed — see comment above.
          });
        }
      } catch {
        // swallowed — see comment above.
      }
    } finally {
      state.inFlight = false;
      this.activeCount--;
      this.tracker.complete(id);
      if (state.pending) {
        if (!this.queuedKeySet.has(key)) {
          this.queuedKeySet.add(key);
          this.dispatchQueue.push(key);
        }
      } else {
        this.states.delete(key);
        this.resolveKeyIdleWaiters(key);
      }
      this.pumpDispatchQueue();
    }
  }

  private resolveKeyIdleWaiters(key: K): void {
    const waiters = this.keyIdleWaiters.get(key);
    if (!waiters) return;
    this.keyIdleWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }
}
