import { describe, expect, test, vi } from 'vitest';
import { DrainableWorker } from '../drainable-worker.js';

describe('DrainableWorker', () => {
  test('processes enqueued items in FIFO order', async () => {
    const processed: number[] = [];
    const worker = new DrainableWorker<number>(async (item) => {
      processed.push(item);
    });
    worker.enqueue(1);
    worker.enqueue(2);
    worker.enqueue(3);
    await worker.drain();
    expect(processed).toEqual([1, 2, 3]);
  });

  test('drain() resolves only once the queue is empty AND the in-flight handler has completed', async () => {
    let releaseHandler: () => void = () => {};
    const started = vi.fn();
    const worker = new DrainableWorker<number>(async () => {
      started();
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
    });

    worker.enqueue(1);
    let drained = false;
    const drainPromise = worker.drain().then(() => {
      drained = true;
    });

    // Let the handler actually start (it should, since the item was enqueued).
    await Promise.resolve();
    expect(started).toHaveBeenCalledTimes(1);
    // drain() must still be pending while the handler is in flight.
    expect(drained).toBe(false);

    releaseHandler();
    await drainPromise;
    expect(drained).toBe(true);
  });

  test('drain() waits for both the in-flight handler and everything still queued behind it', async () => {
    const releases: Array<() => void> = [];
    const processed: number[] = [];
    const worker = new DrainableWorker<number>(async (item) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      processed.push(item);
    });

    worker.enqueue(1);
    worker.enqueue(2);
    const drainPromise = worker.drain();

    await Promise.resolve();
    expect(processed).toEqual([]);

    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(processed).toEqual([1]);
    expect(processed).not.toContain(2);

    releases[1]();
    await drainPromise;
    expect(processed).toEqual([1, 2]);
  });

  test('marker() completes only after every item enqueued before it, and never waits on items enqueued after it', async () => {
    const order: string[] = [];
    const worker = new DrainableWorker<number>(async (item) => {
      order.push(`start:${item}`);
      await Promise.resolve();
      order.push(`end:${item}`);
    });

    worker.enqueue(1);
    worker.enqueue(2);
    worker.enqueue(3);
    const markerPromise = worker.marker(() => order.push('marker'));

    await markerPromise;
    const markerIndex = order.indexOf('marker');
    expect(order.slice(0, markerIndex)).toEqual([
      'start:1',
      'end:1',
      'start:2',
      'end:2',
      'start:3',
      'end:3',
    ]);

    // Enqueued only now, proving the marker never needed these to resolve.
    worker.enqueue(4);
    await worker.drain();
    expect(order).toContain('end:4');
  });

  test('a thrown/rejected handler is surfaced via onError and does not break subsequent processing or drain', async () => {
    const processed: number[] = [];
    const onError = vi.fn();
    const worker = new DrainableWorker<number>(
      async (item) => {
        if (item === 2) throw new Error('boom');
        processed.push(item);
      },
      { onError },
    );

    worker.enqueue(1);
    worker.enqueue(2);
    worker.enqueue(3);
    await worker.drain();

    expect(processed).toEqual([1, 3]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][1]).toBe(2);
  });

  test('a throwing onError does not escape as an unhandled rejection, and the loop keeps processing', async () => {
    const processed: number[] = [];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const worker = new DrainableWorker<number>(
        async (item) => {
          if (item === 2) throw new Error('boom');
          processed.push(item);
        },
        {
          onError: () => {
            throw new Error('onError itself throws');
          },
        },
      );

      worker.enqueue(1);
      worker.enqueue(2);
      worker.enqueue(3);
      await worker.drain();

      // Give any unhandledRejection a chance to fire before asserting it didn't.
      await new Promise((resolve) => setImmediate(resolve));

      expect(processed).toEqual([1, 3]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('an onError that returns a rejecting promise does not escape as an unhandled rejection, and the loop keeps processing', async () => {
    const processed: number[] = [];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const worker = new DrainableWorker<number>(
        async (item) => {
          if (item === 2) throw new Error('boom');
          processed.push(item);
        },
        {
          onError: async () => {
            throw new Error('onError rejects asynchronously');
          },
        },
      );

      worker.enqueue(1);
      worker.enqueue(2);
      worker.enqueue(3);
      await worker.drain();

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(processed).toEqual([1, 3]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('stop()/dispose() rejects further enqueues and resolves once drained', async () => {
    const processed: number[] = [];
    const worker = new DrainableWorker<number>(async (item) => {
      processed.push(item);
    });
    worker.enqueue(1);
    await worker.stop();
    expect(processed).toEqual([1]);
    expect(() => worker.enqueue(2)).toThrow();
  });

  test('size reflects queued items plus an in-flight handler', async () => {
    const releases: Array<() => void> = [];
    const worker = new DrainableWorker<number>(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
    });
    worker.enqueue(1);
    worker.enqueue(2);
    await Promise.resolve();
    expect(worker.size).toBe(2); // one in flight, one queued

    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.size).toBe(1); // the second item is now in flight

    releases[1]();
    await worker.drain();
    expect(worker.size).toBe(0);
  });
});
