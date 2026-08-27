import { describe, expect, test } from 'vitest';
import { AsyncEventQueue } from '../async-event-queue.js';

describe('AsyncEventQueue', () => {
  test('settles a pending iterator read when its consumer is aborted', async () => {
    const queue = new AsyncEventQueue<string>();
    const controller = new AbortController();
    const iterator = queue
      .iterable({ signal: controller.signal })
      [Symbol.asyncIterator]();
    const pending = iterator.next();

    controller.abort(new Error('consumer retired'));

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  test('fails the affected consumer generation and accepts a replacement after overflow', async () => {
    const queue = new AsyncEventQueue<string>(1);
    const original = queue[Symbol.asyncIterator]();

    expect(queue.push('first')).toBe(true);
    expect(queue.push('second')).toBe(false);

    await expect(original.next()).rejects.toThrow('capacity exceeded');
    const replacement = queue[Symbol.asyncIterator]();
    expect(queue.push('third')).toBe(true);
    await expect(replacement.next()).resolves.toEqual({
      value: 'third',
      done: false,
    });
  });

  test('settles pending and future reads when the queue closes', async () => {
    const queue = new AsyncEventQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.close();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });
});
