import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readWithStallWatchdog } from '../stall-watchdog.js';

class FakeStallError extends Error {
  constructor(timeoutMs: number) {
    super(`stalled after ${timeoutMs}ms`);
    this.name = 'FakeStallError';
  }
}

describe('readWithStallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('rejects with the injected error when no chunk arrives before the timeout', async () => {
    const reader = {
      read: vi.fn(() => new Promise<never>(() => {})), // never resolves
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    const resultPromise = readWithStallWatchdog(
      reader,
      5_000,
      (ms) => new FakeStallError(ms),
    );
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).rejects.toBeInstanceOf(FakeStallError);
    // Review M2: both error classes embed the timeout in the user-visible
    // message; a mutation passing makeError(0) survived every suite while
    // shipping "no response for 0s". Pin the argument, not just the type.
    await expect(resultPromise).rejects.toMatchObject({
      message: expect.stringContaining('5000'),
    });
    await expect(resultPromise).rejects.toMatchObject({
      name: 'FakeStallError',
    });
  });

  test('resolves with the read result when a chunk arrives before the timeout, and clears its timer', async () => {
    const value = new Uint8Array([1, 2, 3]);
    const reader = {
      read: vi.fn(async () => ({ done: false, value })),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    const result = await readWithStallWatchdog(
      reader,
      5_000,
      (ms) => new FakeStallError(ms),
    );

    expect(result).toEqual({ done: false, value });

    // The timer must be cleared on success — advancing well past the
    // timeout afterwards must not throw or leave a dangling rejection.
    await vi.advanceTimersByTimeAsync(10_000);
    // Review L1: the trailing timer-advance has zero power (a late rejection
    // lands on a settled race). Counting live timers is what detects a leak.
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a chunk arriving just under the timeout resets the window for the next read', async () => {
    let callCount = 0;
    const reader = {
      read: vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve({ done: false, value: new Uint8Array([9]) });
        }
        return new Promise<never>(() => {}); // second read never resolves
      }),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    // First read resolves almost immediately (simulating it arriving just
    // under the timeout of a PRIOR call, which is out of scope here) —
    // the watchdog's own timer for this call must still be armed fresh.
    const first = await readWithStallWatchdog(
      reader,
      5_000,
      (ms) => new FakeStallError(ms),
    );
    expect(first).toEqual({ done: false, value: new Uint8Array([9]) });

    const second = readWithStallWatchdog(
      reader,
      5_000,
      (ms) => new FakeStallError(ms),
    );
    second.catch(() => {});
    // Advancing just under the fresh window must not trip it yet.
    await vi.advanceTimersByTimeAsync(4_999);
    await vi.advanceTimersByTimeAsync(1);

    await expect(second).rejects.toBeInstanceOf(FakeStallError);
  });

  test('propagates the reader.read() rejection when it rejects before the timeout', async () => {
    const readError = new Error('boom');
    const reader = {
      read: vi.fn(() => Promise.reject(readError)),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    await expect(
      readWithStallWatchdog(reader, 5_000, (ms) => new FakeStallError(ms)),
    ).rejects.toBe(readError);
  });
});
