import { describe, expect, test, vi } from 'vitest';
import { sleep } from '../sleep.js';

describe('sleep', () => {
  test('resolves only after the requested delay has elapsed', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = sleep(50).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('resolves with undefined', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  test('an abort resolves it early and clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let settled = false;
      const pending = sleep(10_000, controller.signal).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      controller.abort();
      await pending;
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an already-aborted signal resolves at once without arming a timer', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();
      await sleep(10_000, controller.signal);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
