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

    // Inside the grace the status stays hidden.
    expect(result.current).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(2500);
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

describe('useChatStreamStatus — no flashing on brief outages', () => {
  /** Step fake time in 100ms slices, recording the status label each time. */
  function sample(
    read: () => string | undefined,
    ms: number,
    into: (string | undefined)[],
  ) {
    for (let t = 0; t < ms; t += 100) {
      act(() => {
        vi.advanceTimersByTime(100);
      });
      into.push(read());
    }
  }

  test('a drop that comes back within one reconnect cycle never shows anything', () => {
    vi.useFakeTimers();
    const apiBase = 'https://stream-status-blip.test';
    setStreamConnectionState(apiBase, 'caught-up');
    const { result } = renderHook(() => useChatStreamStatus(apiBase));
    const seen: (string | undefined)[] = [];
    act(() => {
      setStreamConnectionState(apiBase, 'interrupted');
    });
    // Measured: a 600ms network drop keeps the stream down ~2s (1s retry,
    // reconnect, catch-up).
    sample(() => result.current?.label, 1600, seen);
    act(() => {
      setStreamConnectionState(apiBase, 'receiving');
    });
    sample(() => result.current?.label, 500, seen);
    act(() => {
      setStreamConnectionState(apiBase, 'caught-up');
    });
    sample(() => result.current?.label, 3000, seen);
    expect(seen.every((label) => label === undefined)).toBe(true);
  });

  test('one outage across reconnect and catch-up is one continuous status, then a brief restored', () => {
    vi.useFakeTimers();
    const apiBase = 'https://stream-status-outage.test';
    setStreamConnectionState(apiBase, 'caught-up');
    const { result } = renderHook(() => useChatStreamStatus(apiBase));
    const seen: (string | undefined)[] = [];
    act(() => {
      setStreamConnectionState(apiBase, 'interrupted');
    });
    sample(() => result.current?.label, 1200, seen);
    // Catching up starts before the grace ran out: it must not restart it.
    act(() => {
      setStreamConnectionState(apiBase, 'receiving');
    });
    sample(() => result.current?.label, 2500, seen);
    act(() => {
      setStreamConnectionState(apiBase, 'caught-up');
    });
    sample(() => result.current?.label, 2000, seen);

    const first = seen.findIndex((label) => label !== undefined);
    const last =
      seen.length -
      1 -
      [...seen].reverse().findIndex((label) => label !== undefined);
    // Shown 2.5s after the outage began (slice 25), not 1s after each phase.
    expect(first).toBe(24);
    // Never off while shown: no gap between the phases.
    expect(seen.slice(first, last + 1).includes(undefined)).toBe(false);
    expect(new Set(seen.filter(Boolean))).toEqual(
      new Set(['Catching up…', 'Live updates restored']),
    );
    // Cleared after the hold.
    expect(seen.at(-1)).toBeUndefined();
  });

  test('a drop inside the restored hold is shown at once, not after a gap', () => {
    vi.useFakeTimers();
    const apiBase = 'https://stream-status-flap.test';
    setStreamConnectionState(apiBase, 'caught-up');
    const { result } = renderHook(() => useChatStreamStatus(apiBase));
    act(() => {
      setStreamConnectionState(apiBase, 'interrupted');
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      setStreamConnectionState(apiBase, 'caught-up');
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current?.kind).toBe('restored');
    act(() => {
      setStreamConnectionState(apiBase, 'interrupted');
    });
    expect(result.current?.label).toBe('Reconnecting live updates…');
  });
});
