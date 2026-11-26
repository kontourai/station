import {
  abortError,
  raceWithSignal,
  throwIfAborted,
} from '../../utils/bounded-async.js';

/** Race only preparation. Once the provider is invoked, preserve its outcome custody. */
export async function withEngineStartPreparation<T>(
  signal: AbortSignal | undefined,
  prepare: (
    invokeProvider: (effect: () => Promise<T>) => Promise<T>,
  ) => Promise<T>,
): Promise<T> {
  const preparation = new AbortController();
  const cancelPreparation = () => preparation.abort(abortError(signal));
  signal?.addEventListener('abort', cancelPreparation, { once: true });
  try {
    throwIfAborted(signal);
    return await raceWithSignal(
      prepare((effect) => {
        throwIfAborted(signal);
        signal?.removeEventListener('abort', cancelPreparation);
        return effect();
      }),
      preparation.signal,
    );
  } finally {
    signal?.removeEventListener('abort', cancelPreparation);
  }
}
