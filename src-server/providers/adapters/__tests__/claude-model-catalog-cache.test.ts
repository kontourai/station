import { describe, expect, test } from 'vitest';
import { KeyedCatalogSingleFlight } from '../claude-model-catalog-cache.js';

/**
 * A discovery that settles only when told to, and that reacts to its own
 * abort the way a real probe does: asynchronously, after tearing down.
 */
function slowToAbortDiscovery() {
  const calls: Array<{ resolve: (value: string) => void }> = [];
  const discover = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ resolve });
      signal.addEventListener('abort', () => {
        setTimeout(() => reject(signal.reason ?? new Error('aborted')), 5);
      });
    });
  return { calls, discover };
}

const ticks = async (count: number) => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

describe('KeyedCatalogSingleFlight (#2482)', () => {
  test('a reader arriving while an abandoned discovery unwinds starts its own, not the doomed one', async () => {
    const cache = new KeyedCatalogSingleFlight<string>({
      ttlMs: 30_000,
      timeoutMs: 60_000,
      timeoutMessage: 'timed out',
    });
    const { calls, discover } = slowToAbortDiscovery();

    const leaving = new AbortController();
    const first = cache.read('K', discover, leaving.signal);
    first.catch(() => undefined);
    await ticks(1);
    leaving.abort(new Error('first reader left'));
    await ticks(3);

    // Arrives inside the doomed discovery's unwind window, with no signal.
    const second = cache.read('K', discover);
    await ticks(1);

    expect(calls).toHaveLength(2);
    calls[1]!.resolve('fresh catalog');
    await expect(second).resolves.toBe('fresh catalog');
    await expect(first).rejects.toThrow('first reader left');
  });

  test('a discovery that never answers ends at the timeout, and nothing is cached', async () => {
    const cache = new KeyedCatalogSingleFlight<string>({
      ttlMs: 30_000,
      timeoutMs: 20,
      timeoutMessage: 'catalog discovery timed out',
    });
    let spawned = 0;
    const hung = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        spawned += 1;
        signal.addEventListener('abort', () => reject(signal.reason));
      });

    await expect(cache.read('K', hung)).rejects.toThrow(
      'catalog discovery timed out',
    );
    // The timed-out flight is not served again: a later read spawns anew.
    const answering = (_signal: AbortSignal) => {
      spawned += 1;
      return Promise.resolve('catalog');
    };
    await expect(cache.read('K', answering)).resolves.toBe('catalog');
    expect(spawned).toBe(2);
  });
});
