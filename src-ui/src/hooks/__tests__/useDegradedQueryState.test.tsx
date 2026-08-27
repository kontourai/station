/** @vitest-environment jsdom */

import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEGRADED_QUERY_TIMEOUT_MS,
  useDegradedQueryState,
} from '../useDegradedQueryState';

function Probe({ isPending }: { isPending: boolean }) {
  const state = useDegradedQueryState({ isPending });
  return <output>{state}</output>;
}

describe('useDegradedQueryState', () => {
  afterEach(() => vi.useRealTimers());

  test('changes a still-pending query from loading to degraded at the named timeout', () => {
    vi.useFakeTimers();
    render(<Probe isPending />);
    expect(screen.getByText('loading')).toBeTruthy();

    act(() => vi.advanceTimersByTime(DEGRADED_QUERY_TIMEOUT_MS));
    expect(screen.getByText('degraded')).toBeTruthy();
  });

  test('returns to settled when data arrives after degraded loading', () => {
    vi.useFakeTimers();
    const view = render(<Probe isPending />);
    act(() => vi.advanceTimersByTime(DEGRADED_QUERY_TIMEOUT_MS));
    view.rerender(<Probe isPending={false} />);
    expect(screen.getByText('settled')).toBeTruthy();
  });

  test('bumping resetKey returns a degraded query to loading with a fresh window (sol finding 1)', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ resetKey }: { resetKey: number }) =>
        useDegradedQueryState({ isPending: true, resetKey }),
      { initialProps: { resetKey: 0 } },
    );
    act(() => vi.advanceTimersByTime(DEGRADED_QUERY_TIMEOUT_MS + 1));
    expect(result.current).toBe('degraded');

    rerender({ resetKey: 1 });
    expect(result.current).toBe('loading');
    act(() => vi.advanceTimersByTime(DEGRADED_QUERY_TIMEOUT_MS + 1));
    expect(result.current).toBe('degraded');
  });

  test('a fresh pending after success gets a fresh timer', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isPending }: { isPending: boolean }) =>
        useDegradedQueryState({ isPending }),
      { initialProps: { isPending: true } },
    );
    act(() => vi.advanceTimersByTime(DEGRADED_QUERY_TIMEOUT_MS + 1));
    expect(result.current).toBe('degraded');
    rerender({ isPending: false });
    expect(result.current).toBe('settled');
    rerender({ isPending: true });
    expect(result.current).toBe('loading');
  });

  test('unmount cancels the pending timer', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() =>
      useDegradedQueryState({ isPending: true }),
    );
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
