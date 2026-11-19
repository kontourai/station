/**
 * Runs async operations one at a time per key, in call order, which a dozen
 * src-server modules had each written as "previous-or-resolved, chain, store
 * the tail, delete the entry if it is still the tail".
 *
 * What a caller can rely on:
 *
 * - An operation never starts inside `run`: it starts on a later microtask,
 *   after every operation queued earlier for the same key has settled.
 * - A failed operation rejects only its own caller. The stored tail never
 *   rejects, so a failure neither blocks nor fails the next operation.
 * - The promise `run` returns is the operation's own outcome, and the queue
 *   observes it too: a caller that drops it does not get an unhandled
 *   rejection from here.
 * - A key's entry is released once its last queued operation has settled, a
 *   couple of microtasks AFTER that operation's caller can observe the
 *   result. A module that reads its queue map to decide "is this key busy"
 *   needs its own bookkeeping, not this.
 *
 * Deliberately not covered: lock-shaped queues that hand back a release
 * function (`config-loader-storage`, `plugin-public-server`), and queues that
 * log or swallow the operation's failure in the returned promise
 * (`turn-checkpoint-capture`, `host-image-turn-capture`).
 */
export interface KeyedSerialQueue<K = string> {
  run<T>(key: K, operation: () => Promise<T>): Promise<T>;
  /**
   * Forget every key. Operations already queued still run in order; work
   * queued afterwards does not wait for them.
   */
  clear(): void;
}

export function createKeyedSerialQueue<K = string>(): KeyedSerialQueue<K> {
  const tails = new Map<K, Promise<void>>();
  return {
    run<T>(key: K, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.then(operation);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        // A queued successor owns the entry and must not be removed here.
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    clear(): void {
      tails.clear();
    },
  };
}
