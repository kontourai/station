import { describe, expect, test, vi } from 'vitest';
import { AsyncEventQueue } from '../async-event-queue.js';

describe('AsyncEventQueue', () => {
  test('observes accepted enqueues before consumption and detaches retired consumers', async () => {
    const queue = new AsyncEventQueue<string>(1);
    const controller = new AbortController();
    const observe = vi.fn();
    const iterator = queue
      .iterable({ signal: controller.signal, onEnqueue: observe })
      [Symbol.asyncIterator]();
    expect(queue.push('buffered')).toBe(true);
    expect(observe.mock.calls).toEqual([['buffered']]);
    expect(queue.push('overflow')).toBe(false);
    expect(observe).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(queue.push('after-abort')).toBe(true);
    expect(observe).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });

    const nextObserver = vi.fn();
    const next = queue
      .iterable({ onEnqueue: nextObserver })
      [Symbol.asyncIterator]();
    await next.next();
    const waiting = next.next();
    expect(queue.push('waiting')).toBe(true);
    expect(nextObserver.mock.calls).toEqual([['waiting']]);
    await expect(waiting).resolves.toEqual({ value: 'waiting', done: false });
    await next.return?.();
    queue.push('after-return');
    expect(nextObserver).toHaveBeenCalledTimes(1);
    queue.close();
    expect(queue.push('closed')).toBe(false);
  });

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
