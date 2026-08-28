// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useLatestDeferredFocus } from '../components/chat-dock/useLatestDeferredFocus';

describe('useLatestDeferredFocus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('spends only the latest rapid rebind', () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const { result } = renderHook(() => useLatestDeferredFocus(focus));

    act(() => {
      result.current.schedule('session-alpha');
      result.current.schedule('session-beta');
      vi.runAllTimers();
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith('session-beta');
  });

  test('cancels a pending focus on unmount', () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const { result, unmount } = renderHook(() => useLatestDeferredFocus(focus));

    act(() => result.current.schedule('session-stale'));
    unmount();
    act(() => vi.runAllTimers());

    expect(focus).not.toHaveBeenCalled();
  });
});
