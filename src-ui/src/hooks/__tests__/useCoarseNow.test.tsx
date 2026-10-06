// @vitest-environment jsdom

/**
 * `useCoarseNow`: one coarse clock per list. A fresh mount reads the clock
 * once and renders once (re-setting it a millisecond later re-rendered the
 * sidebar and every row under it, caught by
 * `NavigationContext-consumer-render-cost`); every later start of ticking
 * catches up at once, however long the clock stood still.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCoarseNow } from '../useCoarseNow';

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const INTERVAL = 30_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderClock(initial: { enabled?: boolean; supplied?: number } = {}) {
  let renders = 0;
  const view = renderHook(
    ({ enabled, supplied }: { enabled?: boolean; supplied?: number }) => {
      renders += 1;
      return useCoarseNow(supplied, { intervalMs: INTERVAL, enabled });
    },
    { initialProps: initial },
  );
  return { ...view, renders: () => renders };
}

describe('useCoarseNow', () => {
  it('a fresh mount renders once and ticks on the interval', () => {
    const clock = renderClock();
    expect(clock.result.current).toBe(T0);
    // No catch-up re-render after mount, even once the clock has moved on.
    act(() => {
      vi.advanceTimersByTime(INTERVAL - 1);
    });
    expect(clock.renders()).toBe(1);
    expect(clock.result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(clock.result.current).toBe(T0 + INTERVAL);
    expect(clock.renders()).toBe(2);
  });

  it('re-enabling catches up at once, not at the next tick', () => {
    const clock = renderClock({ enabled: false });
    expect(clock.result.current).toBe(T0);
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    // Disabled: nothing ticks.
    expect(clock.result.current).toBe(T0);
    clock.rerender({ enabled: true });
    expect(clock.result.current).toBe(T0 + 29_000);
    // And the interval runs from the re-enable, not from the mount.
    act(() => {
      vi.advanceTimersByTime(INTERVAL);
    });
    expect(clock.result.current).toBe(T0 + 29_000 + INTERVAL);
  });

  it('a long gap while disabled is caught up in full', () => {
    const clock = renderClock({ enabled: true });
    clock.rerender({ enabled: false });
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(clock.result.current).toBe(T0);
    clock.rerender({ enabled: true });
    expect(clock.result.current).toBe(T0 + 5 * 60_000);
  });

  it('an injected clock wins and starts no interval; withdrawing it catches up', () => {
    const clock = renderClock({ supplied: T0 - 60_000 });
    expect(clock.result.current).toBe(T0 - 60_000);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(clock.result.current).toBe(T0 - 60_000);
    clock.rerender({ supplied: undefined });
    expect(clock.result.current).toBe(T0 + 45_000);
    expect(vi.getTimerCount()).toBe(1);
  });
});
