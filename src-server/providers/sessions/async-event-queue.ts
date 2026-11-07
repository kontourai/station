export class AsyncEventQueueConsumerConflictError extends Error {
  readonly code = 'async_event_queue_consumer_conflict';
  constructor() {
    super('Async event queue already has an active consumer.');
    this.name = 'AsyncEventQueueConsumerConflictError';
  }
}

interface EventWaiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
  generation: number;
}

export interface AsyncEventStreamOptions<T = unknown> {
  signal?: AbortSignal;
  /** Synchronous notification of accepted pushes; does not acknowledge consumption or persistence. */
  onEnqueue?: (value: T) => void;
}

/**
 * Default capacity of an {@link AsyncEventQueue}. Exceeding it clears the
 * buffer and rejects the iterator, so any producer that can push a burst
 * synchronously must keep that burst below this.
 */
export const ASYNC_EVENT_QUEUE_DEFAULT_CAPACITY = 4096;

/** Bounded event queue with iterator-scoped cancellation and explicit close. */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: EventWaiter<T>[] = [];
  private readonly enqueueObservers = new Set<(value: T) => void>();
  private releaseConsumer?: () => IteratorResult<T>;
  private closed = false;
  private failure: Error | null = null;
  private generation = 0;
  private lastOverflowError: Error | null = null;

  constructor(private readonly maxItems = ASYNC_EVENT_QUEUE_DEFAULT_CAPACITY) {
    if (!Number.isInteger(maxItems) || maxItems < 1) {
      throw new Error('AsyncEventQueue maxItems must be a positive integer.');
    }
  }

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.settle(waiter, { value, done: false });
      for (const observe of this.enqueueObservers) observe(value);
      return true;
    }
    if (this.items.length >= this.maxItems) {
      const error = new Error('Async event queue capacity exceeded.');
      this.items.length = 0;
      this.lastOverflowError = error;
      this.generation += 1;
      while (this.waiters.length > 0) {
        this.reject(this.waiters.shift()!, error);
      }
      return false;
    }
    this.items.push(value);
    for (const observe of this.enqueueObservers) observe(value);
    return true;
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error ?? null;
    if (error) this.items.length = 0;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (error) {
        this.reject(waiter, error);
      } else {
        this.settle(waiter, { value: undefined as never, done: true });
      }
    }
  }

  iterable(options: AsyncEventStreamOptions<T> = {}): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: () => this.createIterator(options),
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.createIterator();
  }

  private createIterator({
    signal,
    onEnqueue,
  }: AsyncEventStreamOptions<T> = {}): AsyncIterator<T> {
    if (this.releaseConsumer && !signal?.aborted)
      throw new AsyncEventQueueConsumerConflictError();
    let closed = signal?.aborted ?? false;
    let pending: EventWaiter<T> | undefined;
    const generation = this.generation;

    const close = (): IteratorResult<T> => {
      closed = true;
      if (this.releaseConsumer === close) this.releaseConsumer = undefined;
      if (onEnqueue) this.enqueueObservers.delete(onEnqueue);
      signal?.removeEventListener('abort', close);
      if (pending) {
        const waiter = pending;
        pending = undefined;
        this.removeWaiter(waiter);
        this.settle(waiter, { value: undefined as never, done: true });
      }
      return { value: undefined as never, done: true };
    };

    if (!closed) {
      this.releaseConsumer = close;
      if (onEnqueue) this.enqueueObservers.add(onEnqueue);
      signal?.addEventListener('abort', close, { once: true });
    }

    return {
      next: () => {
        if (closed || signal?.aborted) return Promise.resolve(close());
        if (generation !== this.generation) {
          close();
          return Promise.reject(
            this.lastOverflowError ??
              new Error('Async event queue consumer was superseded.'),
          );
        }
        if (this.items.length > 0) {
          const queued = this.items.shift()!;
          return Promise.resolve({ value: queued, done: false });
        }
        if (this.failure) {
          close();
          return Promise.reject(this.failure);
        }
        if (this.closed) return Promise.resolve(close());
        if (pending) {
          return Promise.reject(
            new Error(
              'Concurrent reads from one event iterator are unsupported.',
            ),
          );
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          const waiter: EventWaiter<T> = {
            resolve,
            reject,
            signal,
            generation,
          };
          if (signal) {
            waiter.onAbort = () => close();
            signal.addEventListener('abort', waiter.onAbort, { once: true });
          }
          pending = waiter;
          this.waiters.push(waiter);
        }).finally(() => {
          pending = undefined;
        });
      },
      return: async () => close(),
    };
  }

  private removeWaiter(waiter: EventWaiter<T>): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private settle(waiter: EventWaiter<T>, result: IteratorResult<T>): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(result);
  }

  private reject(waiter: EventWaiter<T>, error: Error): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.reject(error);
  }
}
