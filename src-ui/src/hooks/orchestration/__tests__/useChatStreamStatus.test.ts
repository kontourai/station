/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { setStreamConnectionState } from '../streamConnectionState';
import { useChatStreamStatus } from '../useChatStreamStatus';

afterEach(() => {
  vi.useRealTimers();
});

describe('useChatStreamStatus', () => {
  test('an interrupted stream names live updates, not the whole Station', () => {
    vi.useFakeTimers();
    const apiBase = 'https://stream-status-interrupted.test';
    setStreamConnectionState(apiBase, 'interrupted');
    const { result } = renderHook(() => useChatStreamStatus(apiBase));

    // Inside the 1s grace the status stays hidden.
    expect(result.current).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // The header presence dot may still say Connected while this stream
    // is down, so the label must name its subject — a bare
    // "Reconnecting" reads as contradicting that dot.
    expect(result.current?.label).toBe('Reconnecting live updates…');
    expect(result.current?.blocked).toBe(false);
  });

  test('a closed stream asks for attention', () => {
    const apiBase = 'https://stream-status-closed.test';
    setStreamConnectionState(apiBase, 'closed');
    const { result } = renderHook(() => useChatStreamStatus(apiBase));

    expect(result.current?.label).toBe('Connection needs attention');
    expect(result.current?.blocked).toBe(true);
  });
});
