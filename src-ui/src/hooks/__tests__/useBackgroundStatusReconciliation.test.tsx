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

  test('coalesces overlapping checks and serializes across resetKey changes without accepting stale results', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: 'pending' | 'settled') => void> = [];
    const check = vi.fn(
      () =>
        new Promise<'pending' | 'settled'>((resolve) => {
          resolvers.push(resolve);
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

    // Changing resetKey invalidates the in-flight generation without allowing overlap.
    rerender({ resetKey: 'req-2' });
    expect(result.current.checking).toBe(false);
    expect(result.current.exhausted).toBe(false);

    // While the prior request is still running, advancing into the new schedule does not overlap it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(check).toHaveBeenCalledTimes(1);

    // Once the stale request finishes, req-2 starts its own fresh check instead of exhausting on req-1's result.
    await act(async () => {
      resolvers[0]?.('pending');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      resolvers[1]?.('settled');
      await Promise.resolve();
    });
    expect(result.current.exhausted).toBe(false);
  });

  test('stops event-triggered checks after a check settles', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const check = vi.fn(async () => 'settled' as const);

    renderHook(() =>
      useBackgroundStatusReconciliation({
        active: true,
        check,
        initialDelayMs: 1_000,
        intervalsMs: [2_000],
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(check).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(2_000);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledTimes(1);
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
