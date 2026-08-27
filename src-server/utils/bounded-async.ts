export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error('Operation aborted.');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

export async function raceWithSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // The operation may later reject in response to the same signal. Observe
    // it before preserving the immediate abort rejection so it cannot orphan.
    void operation.catch(() => undefined);
  }
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function awaitSettlementWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = operation.then(
    () => true,
    () => true,
  );
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
  options?: {
    settleInFlightOnAbort?: boolean;
    onFirstFailure?: (error: unknown) => void;
  },
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  if (!options?.settleInFlightOnAbort) {
    async function runFailFast(): Promise<void> {
      while (true) {
        throwIfAborted(signal);
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await raceWithSignal(
          worker(items[index]!, index),
          signal,
        );
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, concurrency), items.length) },
        () => runFailFast(),
      ),
    );
    return results;
  }

  const noFailure = Symbol('no-failure');
  let firstFailure: unknown | typeof noFailure = noFailure;

  async function run(): Promise<void> {
    try {
      while (firstFailure === noFailure) {
        throwIfAborted(signal);
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    } catch (error) {
      if (firstFailure === noFailure) {
        firstFailure = error;
        options?.onFirstFailure?.(error);
      }
    }
  }

  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => run(),
  );
  await Promise.all(runners);
  if (firstFailure !== noFailure) throw firstFailure;
  return results;
}

export async function settleConcurrentWork<T extends readonly unknown[]>(
  operations: { [K in keyof T]: Promise<T[K]> },
  onFirstFailure?: (error: unknown) => void,
): Promise<T> {
  const noFailure = Symbol('no-failure');
  let firstFailure: unknown | typeof noFailure = noFailure;
  const guarded = operations.map(async (operation) => {
    try {
      return await operation;
    } catch (error) {
      if (firstFailure === noFailure) {
        firstFailure = error;
        onFirstFailure?.(error);
      }
      throw error;
    }
  });
  const settled = await Promise.allSettled(guarded);
  if (firstFailure !== noFailure) throw firstFailure;
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }) as unknown as T;
}
