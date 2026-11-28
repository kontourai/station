// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useBackgroundStatusReconciliation } from '../useBackgroundStatusReconciliation';

afterEach(() => {
  vi.useRealTimers();
});

describe('useBackgroundStatusReconciliation', () => {
  test('waits for the grace period, backs off, and marks exhausted only after all scheduled checks stay pending', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => 'pending' as const);

    const { result } = renderHook(() =>
      useBackgroundStatusReconciliation({
        active: true,
        check,
        initialDelayMs: 2_500,
        intervalsMs: [2_000, 4_000],
      }),
    );

    expect(check).not.toHaveBeenCalled();
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_499);
    });
    expect(check).not.toHaveBeenCalled();
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(check).toHaveBeenCalledTimes(3);
    expect(result.current.exhausted).toBe(true);

    // Bounded: no further scheduled polls after exhaustion.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(check).toHaveBeenCalledTimes(3);
  });

  test('stops scheduling immediately once a check settles', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => 'settled' as const);

    const { result } = renderHook(() =>
      useBackgroundStatusReconciliation({
        active: true,
        check,
        initialDelayMs: 1_500,
        intervalsMs: [2_000, 4_000],
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(result.current.exhausted).toBe(false);
  });

  test('coalesces overlapping checks and ignores stale completions after resetKey changes', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: 'pending') => void;
    const check = vi.fn(
      () =>
        new Promise<'pending'>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ resetKey }) =>
        useBackgroundStatusReconciliation({
          active: true,
          resetKey,
          check,
          initialDelayMs: 1_000,
          intervalsMs: [],
        }),
      { initialProps: { resetKey: 'req-1' } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(result.current.checking).toBe(true);

    // Concurrent manual check joins the in-flight call instead of overlapping.
    void result.current.checkNow();
    expect(check).toHaveBeenCalledTimes(1);

    // Changing resetKey invalidates the in-flight generation.
    rerender({ resetKey: 'req-2' });
    expect(result.current.checking).toBe(false);
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      resolveFirst('pending');
      await Promise.resolve();
    });
    expect(result.current.exhausted).toBe(false);
  });

  test('rechecks on online, visibilitychange, and debounced focus in event-only mode', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const check = vi.fn(async () => 'pending' as const);

    renderHook(() =>
      useBackgroundStatusReconciliation({
        active: true,
        check,
        initialDelayMs: null,
        recheckOnVisible: true,
        recheckOnOnline: true,
        recheckOnFocus: true,
        eventDebounceMs: 1_500,
      }),
    );

    expect(check).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(1);

    // Rapid second focus inside debounce window is ignored.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(1);

    // Online bypasses debounce and checks immediately.
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(2);

    // Becoming visible after the debounce window triggers a check.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(3);
  });
});
