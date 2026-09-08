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
});
