import { afterEach, describe, expect, test, vi } from 'vitest';
import { KeyedCoalescingWorker } from '../keyed-coalescing-worker.js';

describe('KeyedCoalescingWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a burst of values for one key invokes the handler once with the merged value (keep-latest default)', async () => {
    const calls: Array<[string, number]> = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key, value) => {
        calls.push([key, value]);
      },
    );
    worker.enqueue('a', 1);
    worker.enqueue('a', 2);
    worker.enqueue('a', 3);
    await worker.drain();
    expect(calls).toEqual([['a', 3]]);
  });

  test('a caller-supplied merge function combines every value queued for a key before dispatch', async () => {
    const calls: Array<[string, number]> = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key, value) => {
        calls.push([key, value]);
      },
      { merge: (current, next) => current + next },
    );
    worker.enqueue('a', 1);
    worker.enqueue('a', 2);
    worker.enqueue('a', 3);
    await worker.drain();
    expect(calls).toEqual([['a', 6]]);
  });

  test('different keys in the same burst each get their own dispatch', async () => {
    const calls: Array<[string, number]> = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key, value) => {
        calls.push([key, value]);
      },
    );
    worker.enqueue('a', 1);
    worker.enqueue('b', 1);
    worker.enqueue('a', 2);
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual(['a', 2]);
    expect(calls).toContainEqual(['b', 1]);
  });

  test('drain() resolves only once every key has both no pending value AND no in-flight handler', async () => {
    let release: () => void = () => {};
    const started = vi.fn();
    const worker = new KeyedCoalescingWorker<string, number>(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    worker.enqueue('a', 1);
    let drained = false;
    const drainPromise = worker.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);

    release();
    await drainPromise;
    expect(drained).toBe(true);
  });

  test('drainKey() waits only for its own key, not for other in-flight keys', async () => {
    const releases = new Map<string, () => void>();
    const completed: string[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(async (key) => {
      await new Promise<void>((resolve) => releases.set(key, resolve));
      completed.push(key);
    });

    worker.enqueue('a', 1);
    worker.enqueue('b', 1);
    await Promise.resolve();
    await Promise.resolve();

    let aDrained = false;
    const aDrain = worker.drainKey('a').then(() => {
      aDrained = true;
    });

    releases.get('b')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(aDrained).toBe(false); // 'a' still in flight, 'b' finishing shouldn't resolve it

    releases.get('a')?.();
    await aDrain;
    expect(aDrained).toBe(true);
    expect(completed).toContain('a');
  });

  test('marker() completes only after every item enqueued before it (any key), and never waits on items enqueued after it', async () => {
    const order: string[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key, value) => {
        order.push(`start:${key}:${value}`);
        await Promise.resolve();
        order.push(`end:${key}:${value}`);
      },
      { concurrency: 1 },
    );

    worker.enqueue('a', 1);
    worker.enqueue('b', 1);
    const markerPromise = worker.marker(() => order.push('marker'));

    await markerPromise;
    const markerIndex = order.indexOf('marker');
    expect(order.slice(0, markerIndex)).toEqual([
      'start:a:1',
      'end:a:1',
      'start:b:1',
      'end:b:1',
    ]);

    // Enqueued only now, proving the marker never needed this to resolve.
    worker.enqueue('c', 1);
    await worker.drain();
    expect(order).toContain('end:c:1');
  });

  test('marker() under concurrency > 1 waits for every pre-existing dispatch even if they complete out of order', async () => {
    const releases = new Map<string, () => void>();
    const completions: string[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key) => {
        await new Promise<void>((resolve) => releases.set(key, resolve));
        completions.push(key);
      },
      { concurrency: 2 },
    );

    worker.enqueue('a', 1);
    worker.enqueue('b', 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(releases.has('a')).toBe(true);
    expect(releases.has('b')).toBe(true);

    let markerFired = false;
    const markerPromise = worker.marker(() => {
      markerFired = true;
    });
    worker.enqueue('c', 1); // enqueued after the marker; must never block it

    // Resolve 'b' first — out of creation order relative to 'a'.
    releases.get('b')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(markerFired).toBe(false); // 'a' (created before the marker) is still outstanding

    releases.get('a')?.();
    await markerPromise;
    expect(markerFired).toBe(true);
    expect(completions).toEqual(['b', 'a']);

    releases.get('c')?.();
    await worker.drain();
  });

  test('the same key is never dispatched concurrently with itself, and per-key order is preserved under concurrency > 1', async () => {
    const startOrder: string[] = [];
    const releases = new Map<string, () => void>();
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key, value) => {
        const token = `${key}:${value}`;
        startOrder.push(token);
        await new Promise<void>((resolve) => releases.set(token, resolve));
      },
      { concurrency: 2 },
    );

    worker.enqueue('a', 1);
    worker.enqueue('b', 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(startOrder).toEqual(['a:1', 'b:1']); // both keys dispatched concurrently

    worker.enqueue('a', 2); // arrives while a:1 is still in flight
    await Promise.resolve();
    await Promise.resolve();
    expect(startOrder).not.toContain('a:2'); // must wait for a:1, never run concurrently with it

    releases.get('a:1')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(startOrder).toContain('a:2');
    expect(startOrder.indexOf('a:2')).toBeGreaterThan(
      startOrder.indexOf('a:1'),
    );

    releases.get('b:1')?.();
    releases.get('a:2')?.();
    await worker.drain();
  });

  test('multi-key interleaving under concurrency has no cross-key ordering regression: each key sees its own values in enqueue order', async () => {
    const seenByKey: Record<string, number[]> = { a: [], b: [], c: [] };
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key, value) => {
        seenByKey[key].push(value);
      },
      { concurrency: 3, merge: (_current, next) => next },
    );

    // Interleave enqueues across keys, waiting for each round to fully
    // dispatch before the next so no round's values get coalesced away.
    worker.enqueue('a', 1);
    worker.enqueue('b', 1);
    worker.enqueue('c', 1);
    await worker.drain();

    worker.enqueue('b', 2);
    worker.enqueue('a', 2);
    await worker.drain();

    worker.enqueue('c', 2);
    worker.enqueue('a', 3);
    worker.enqueue('b', 3);
    await worker.drain();

    expect(seenByKey.a).toEqual([1, 2, 3]);
    expect(seenByKey.b).toEqual([1, 2, 3]);
    expect(seenByKey.c).toEqual([1, 2]);
  });

  test('handler throw does not break subsequent dispatches for other keys or drain', async () => {
    const processed: Array<[string, number]> = [];
    const onError = vi.fn();
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key, value) => {
        if (key === 'bad') throw new Error('boom');
        processed.push([key, value]);
      },
      { onError },
    );

    worker.enqueue('bad', 1);
    worker.enqueue('good', 2);
    await worker.drain();

    expect(processed).toEqual([['good', 2]]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][1]).toBe('bad');
    expect(onError.mock.calls[0][2]).toBe(1);
  });

  test('a key that throws recovers for its own next value too', async () => {
    const processed: number[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (_key, value) => {
        if (value === 1) throw new Error('boom');
        processed.push(value);
      },
      { onError: () => {} },
    );
    worker.enqueue('a', 1);
    await worker.drain();
    worker.enqueue('a', 2);
    await worker.drain();
    expect(processed).toEqual([2]);
  });

  test('a throwing onError does not escape as an unhandled rejection, and the loop keeps processing subsequent keys', async () => {
    const processed: Array<[string, number]> = [];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const worker = new KeyedCoalescingWorker<string, number>(
        async (key, value) => {
          if (key === 'bad') throw new Error('boom');
          processed.push([key, value]);
        },
        {
          onError: () => {
            throw new Error('onError itself throws');
          },
        },
      );

      worker.enqueue('bad', 1);
      worker.enqueue('good', 2);
      await worker.drain();

      // Give any unhandledRejection a chance to fire before asserting it didn't.
      await new Promise((resolve) => setImmediate(resolve));

      expect(processed).toEqual([['good', 2]]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('an onError that returns a rejecting promise does not escape as an unhandled rejection, and the loop keeps processing subsequent keys', async () => {
    const processed: Array<[string, number]> = [];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const worker = new KeyedCoalescingWorker<string, number>(
        async (key, value) => {
          if (key === 'bad') throw new Error('boom');
          processed.push([key, value]);
        },
        {
          onError: async () => {
            throw new Error('onError rejects asynchronously');
          },
        },
      );

      worker.enqueue('bad', 1);
      worker.enqueue('good', 2);
      await worker.drain();

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(processed).toEqual([['good', 2]]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('windowMs batches pending keys and flushes only once the window elapses', async () => {
    vi.useFakeTimers();
    const calls: Array<[string, number]> = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key, value) => {
        calls.push([key, value]);
      },
      { windowMs: 50 },
    );

    worker.enqueue('a', 1);
    worker.enqueue('b', 1);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toContainEqual(['a', 1]);
    expect(calls).toContainEqual(['b', 1]);
  });

  test('maxBatch forces an early flush once reached, before windowMs would elapse', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key) => {
        calls.push(key);
      },
      { windowMs: 10_000, maxBatch: 2 },
    );

    worker.enqueue('a', 1);
    worker.enqueue('b', 1); // reaches maxBatch=2 — flush now, no need to advance timers
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.sort()).toEqual(['a', 'b']);
  });

  test('drain() forces an open batch window to flush immediately instead of waiting on real/fake time', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key) => {
        calls.push(key);
      },
      { windowMs: 10_000 },
    );

    worker.enqueue('a', 1);
    await worker.drain();
    expect(calls).toEqual(['a']);
  });

  test('drainKey() forces only its own key out of an open batch window', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key) => {
        calls.push(key);
      },
      { windowMs: 10_000 },
    );

    worker.enqueue('a', 1);
    worker.enqueue('b', 1);
    await worker.drainKey('a');
    expect(calls).toEqual(['a']);
    expect(calls).not.toContain('b');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toContain('b');
  });

  test('marker() forces an open batch window to flush immediately instead of waiting on real/fake time', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (key) => {
        calls.push(key);
      },
      { windowMs: 10_000 },
    );

    worker.enqueue('a', 1);
    let markerFired = false;
    const markerPromise = worker.marker(() => {
      markerFired = true;
    });

    // No timer advance at all — marker() must have forced the flush itself.
    await markerPromise;
    expect(markerFired).toBe(true);
    expect(calls).toEqual(['a']);
  });

  test('constructor rejects a non-positive concurrency', () => {
    expect(
      () =>
        new KeyedCoalescingWorker<string, number>(async () => {}, {
          concurrency: 0,
        }),
    ).toThrow();
  });

  test('stop()/dispose() rejects further enqueues and resolves once every key has drained', async () => {
    const processed: number[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(
      async (_key, value) => {
        processed.push(value);
      },
    );
    worker.enqueue('a', 1);
    await worker.stop();
    expect(processed).toEqual([1]);
    expect(() => worker.enqueue('a', 2)).toThrow();
  });
});
