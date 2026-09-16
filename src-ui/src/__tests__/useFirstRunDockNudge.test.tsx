/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useFirstRunDockNudge } from '../components/chat-dock/useFirstRunDockNudge';

const FIRST_RUN_KEY = 'station.dockFirstRunSeen';

/**
 * #2151: the effect half of the nudge. `firstRunDockNudge` (pure) is pinned
 * in chat-dock-utils.test.ts; this file pins that the hook CONSUMES the
 * one-shot flag only when the decision says so, and calls `setDockState`
 * only on `open`.
 */
describe('useFirstRunDockNudge (#2151)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, 'webdriver', {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  const base = {
    isFullscreenPlacement: false,
    sessionsStatus: 'success' as const,
    sessionCount: 0,
    isDockOpen: false,
  };

  test('a pending inbox read consumes nothing and opens nothing', () => {
    const setDockState = vi.fn();
    renderHook(() =>
      useFirstRunDockNudge({
        ...base,
        sessionsStatus: 'pending',
        setDockState,
      }),
    );
    expect(setDockState).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(FIRST_RUN_KEY)).toBeNull();
  });

  test('a known-empty inbox consumes the flag and leaves the dock collapsed', () => {
    const setDockState = vi.fn();
    renderHook(() => useFirstRunDockNudge({ ...base, setDockState }));
    expect(setDockState).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(FIRST_RUN_KEY)).toBe('1');
  });

  test('a known non-empty inbox consumes the flag and opens the dock', () => {
    const setDockState = vi.fn();
    renderHook(() =>
      useFirstRunDockNudge({ ...base, sessionCount: 2, setDockState }),
    );
    expect(setDockState).toHaveBeenCalledExactlyOnceWith(true);
    expect(window.localStorage.getItem(FIRST_RUN_KEY)).toBe('1');
  });

  test('a dock the user already has open is left alone on open', () => {
    const setDockState = vi.fn();
    renderHook(() =>
      useFirstRunDockNudge({
        ...base,
        sessionCount: 2,
        isDockOpen: true,
        setDockState,
      }),
    );
    expect(setDockState).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(FIRST_RUN_KEY)).toBe('1');
  });

  test('the read settling from pending to non-empty still nudges, once', () => {
    const setDockState = vi.fn();
    const { rerender } = renderHook(
      (props: {
        sessionsStatus: 'pending' | 'success';
        sessionCount: number;
      }) => useFirstRunDockNudge({ ...base, ...props, setDockState }),
      { initialProps: { sessionsStatus: 'pending', sessionCount: 0 } },
    );
    expect(setDockState).not.toHaveBeenCalled();
    rerender({ sessionsStatus: 'success', sessionCount: 1 });
    expect(setDockState).toHaveBeenCalledExactlyOnceWith(true);
    // A later inbox change is not a second nudge: the flag is spent.
    rerender({ sessionsStatus: 'success', sessionCount: 3 });
    expect(setDockState).toHaveBeenCalledTimes(1);
  });

  test('an inbox that fills AFTER an empty settle does not reopen the dock', () => {
    // The user saw a collapsed dock and left it; a chat arriving later
    // (another device, an import) is the lifecycle's job to reveal
    // (`useActiveChatSessionLifecycle` sets the dock open on start), not the
    // one-shot nudge's.
    const setDockState = vi.fn();
    const { rerender } = renderHook(
      (props: { sessionCount: number }) =>
        useFirstRunDockNudge({ ...base, ...props, setDockState }),
      { initialProps: { sessionCount: 0 } },
    );
    expect(window.localStorage.getItem(FIRST_RUN_KEY)).toBe('1');
    rerender({ sessionCount: 1 });
    expect(setDockState).not.toHaveBeenCalled();
  });
});
