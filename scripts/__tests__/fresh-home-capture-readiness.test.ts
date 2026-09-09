import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  countVisibleLoadingMarkers,
  settlePageReason,
} from '../../tests/live/helpers/station-instance.mjs';

function pageFixture({ text = 'Content', dialog = false, pending = [0] } = {}) {
  let index = 0;
  const observation = () => pending[Math.min(index, pending.length - 1)];
  return {
    locator: (selector: string) => ({
      first: () => ({ waitFor: async () => {} }),
      filter: () => ({
        count: async () => (selector === '.route-pending' ? observation() : 0),
        allTextContents: async () => {
          index++;
          return [text];
        },
      }),
    }),
    getByText: () => ({ count: async () => 0 }),
    getByRole: () => ({
      filter: () => ({ count: async () => (dialog ? 1 : 0) }),
    }),
  };
}
afterEach(() => vi.useRealTimers());
describe('fresh-home capture readiness', () => {
  test('an empty main with no dialog is not a ready route', async () => {
    expect(await countVisibleLoadingMarkers(pageFixture({ text: '' }))).toBe(1);
    expect(
      await countVisibleLoadingMarkers(pageFixture({ text: '', dialog: true })),
    ).toBe(0);
  });
  test('a transient clear frame before a loading remount does not pass', async () => {
    vi.useFakeTimers();
    let settled = false;
    const result = settlePageReason(
      pageFixture({ pending: [0, 1, 0, 0, 0] }),
      5000,
    ).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeNull();
  });
  test('persistent loading produces a failure reason', async () => {
    vi.useFakeTimers();
    const result = settlePageReason(pageFixture({ pending: [1] }), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toContain('still visible');
  });
});
