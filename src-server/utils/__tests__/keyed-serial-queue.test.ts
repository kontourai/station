import { describe, expect, test } from 'vitest';
import { createKeyedSerialQueue } from '../keyed-serial-queue.js';

const drainEventLoop = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createKeyedSerialQueue', () => {
  test('never starts an operation inside run', async () => {
    const queue = createKeyedSerialQueue();
    let started = false;
    const pending = queue.run('a', async () => {
      started = true;
      return 1;
    });
    expect(started).toBe(false);
    await expect(pending).resolves.toBe(1);
    expect(started).toBe(true);
  });

  test('runs one key in call order, one operation at a time', async () => {
    const queue = createKeyedSerialQueue();
    const first = deferred<void>();
    const events: string[] = [];
    const one = queue.run('a', async () => {
      events.push('one:start');
      await first.promise;
      events.push('one:end');
      return 'one';
    });
    const two = queue.run('a', async () => {
      events.push('two:start');
      return 'two';
    });

    await drainEventLoop();
    expect(events).toEqual(['one:start']);

    first.resolve();
    await expect(one).resolves.toBe('one');
    await expect(two).resolves.toBe('two');
    expect(events).toEqual(['one:start', 'one:end', 'two:start']);
  });

  test('does not make one key wait for another', async () => {
    const queue = createKeyedSerialQueue();
    const blocked = deferred<void>();
    const held = queue.run('a', () => blocked.promise);
    await expect(queue.run('b', async () => 'free')).resolves.toBe('free');
    blocked.resolve();
    await held;
  });

  test('a failed operation rejects its caller and the next one still runs', async () => {
    const queue = createKeyedSerialQueue();
    const failure = new Error('first failed');
    const failed = queue.run('a', async () => {
      throw failure;
    });
    const next = queue.run('a', async () => 'after');
    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBe('after');
  });

  test('a synchronous throw becomes that caller rejection', async () => {
    const queue = createKeyedSerialQueue();
    const failure = new Error('threw before returning a promise');
    const failed = queue.run('a', () => {
      throw failure;
    });
    await expect(failed).rejects.toBe(failure);
    await expect(queue.run('a', async () => 'after')).resolves.toBe('after');
  });

  test('a dropped rejected result is not an unhandled rejection', async () => {
    const queue = createKeyedSerialQueue();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (rejection: unknown) => {
      unhandledRejections.push(rejection);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      void queue.run('a', async () => {
        throw new Error('nobody is listening');
      });
      await drainEventLoop();
      await drainEventLoop();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('work queued after clear does not wait for work queued before it', async () => {
    const queue = createKeyedSerialQueue();
    const blocked = deferred<void>();
    const events: string[] = [];
    const held = queue.run('a', async () => {
      await blocked.promise;
      events.push('held');
    });
    await drainEventLoop();

    queue.clear();
    await queue.run('a', async () => {
      events.push('after-clear');
    });
    expect(events).toEqual(['after-clear']);

    blocked.resolve();
    await held;
    expect(events).toEqual(['after-clear', 'held']);
  });

  test('accepts non-string keys by identity', async () => {
    const queue = createKeyedSerialQueue<symbol>();
    const key = Symbol('session');
    const blocked = deferred<void>();
    const events: string[] = [];
    const first = queue.run(key, async () => {
      await blocked.promise;
      events.push('first');
    });
    const second = queue.run(key, async () => {
      events.push('second');
    });
    blocked.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first', 'second']);
  });
});
