import { CompletionTracker } from './completion-tracker.js';

export interface DrainableWorkerOptions {
  /**
   * Called when the handler throws or rejects. The worker loop keeps
   * running regardless — a bad item never wedges the queue and never leaves
   * `drain()` unresolved.
   */
  onError?: (error: unknown, item: unknown) => void;
}

/**
 * DrainableWorker — a single-consumer async FIFO queue with a deterministic
 * idle signal.
 *
 * `enqueue()` never blocks; items run one at a time, strictly in enqueue
 * order, through the caller-supplied async `handler`. `drain()` is the
 * primitive tests should await instead of sleeping: it resolves once every
 * item enqueued at (or before) the call — including whichever item is
 * currently in flight — has finished, whether that finish was success or a
 * caught handler error. Items enqueued after `drain()` is called never
 * block that promise.
 */
export class DrainableWorker<T> {
  private readonly queue: Array<{ item: T; id: number }> = [];
  private readonly tracker = new CompletionTracker();
  private inFlight = false;
  private stopped = false;

  constructor(
    private readonly handler: (item: T) => Promise<void>,
    private readonly options: DrainableWorkerOptions = {},
  ) {}

  /** Number of items queued plus (1 if a handler is currently running). */
  get size(): number {
    return this.queue.length + (this.inFlight ? 1 : 0);
  }

  enqueue(item: T): void {
    if (this.stopped) {
      throw new Error(
        'DrainableWorker: cannot enqueue after stop()/dispose().',
      );
    }
    const id = this.tracker.begin();
    this.queue.push({ item, id });
    this.pump();
  }

  /** Resolves once the queue is empty AND the in-flight handler (if any) has completed. */
  drain(): Promise<void> {
    return this.tracker.waitForCurrent();
  }

  /**
   * An ordering-safe marker checkpoint. This does not literally enqueue a
   * sentinel into the internal array queue — it snapshots the
   * `CompletionTracker` ids outstanding at call time and waits for all of
   * them to complete. `callback` (if provided) runs, and the returned
   * promise resolves, only after every item enqueued strictly before this
   * call has finished — it can never overtake prior work, even under
   * bursty enqueue load. Items enqueued after the marker never block it.
   */
  marker(callback?: () => void): Promise<void> {
    return this.tracker.waitForCurrent().then(() => {
      callback?.();
    });
  }

  /** Stop accepting new work, then wait for the queue and in-flight handler to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.drain();
  }

  /** Alias for `stop()` matching this repo's service-lifecycle naming. */
  dispose(): Promise<void> {
    return this.stop();
  }

  private pump(): void {
    if (this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = true;
    void this.run(next.item, next.id);
  }

  private async run(item: T, id: number): Promise<void> {
    try {
      await this.handler(item);
    } catch (error) {
      // onError is caller-supplied and may itself throw, or (despite the
      // `void`-typed signature) return a promise that later rejects; this
      // `run()` is invoked fire-and-forget (`void this.run(...)`), so an
      // escaping error here becomes an unhandled rejection that crashes the
      // process on Node's default settings. There is no further error
      // channel to report it on, so both cases are deliberately swallowed.
      try {
        const result = this.options.onError?.(error, item);
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
      this.inFlight = false;
      this.tracker.complete(id);
      this.pump();
    }
  }
}
