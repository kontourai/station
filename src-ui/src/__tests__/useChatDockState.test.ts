/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { useChatDockState as UseChatDockStateFn } from '../hooks/useChatDockState';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ dockMode: 'bottom' }),
}));

const HEADER_HEIGHT = 38;
const TOOLBAR_HEIGHT = 46;

const defaultOptions = {
  defaultFontSize: 14,
  isDockOpen: true,
  isDockMaximized: false,
};

/**
 * `chatDockAutoHide` now lives in the device-settings store, a module-level
 * singleton whose one-time prior-key import runs at first import (mirrors
 * `active-chats-store.test.ts`'s pattern for its own singleton store) — so
 * a scenario that depends on that migration (or on a clean store per test)
 * re-imports the hook fresh after `vi.resetModules`.
 */
async function freshUseChatDockState(): Promise<typeof UseChatDockStateFn> {
  vi.resetModules();
  const mod = await import('../hooks/useChatDockState');
  return mod.useChatDockState;
}

describe('useChatDockState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (prop: string) => {
        if (prop === '--chat-dock-header-height') return String(HEADER_HEIGHT);
        if (prop === '--app-toolbar-height') return String(TOOLBAR_HEIGHT);
        return '';
      },
    } as unknown as CSSStyleDeclaration);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  describe('default state', () => {
    test('autoHideEnabled defaults to false when no prior key or override is present', async () => {
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));
      expect(result.current.autoHideEnabled).toBe(false);
    });
  });

  describe('device-settings persistence', () => {
    // Proves the one-time migration path for this consumer's setting: a
    // pre-unification browser's raw `chatDockAutoHide` localStorage key is
    // picked up on first read through the new store.
    test('imports autoHideEnabled=true from the prior localStorage key on first read', async () => {
      localStorage.setItem('chatDockAutoHide', 'true');
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));
      expect(result.current.autoHideEnabled).toBe(true);
    });

    test('persists autoHideEnabled=true through the device-settings store when enabled', async () => {
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      act(() => {
        result.current.setAutoHideEnabled(true);
      });

      expect(result.current.autoHideEnabled).toBe(true);
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') || '{}',
      );
      expect(envelope.values.chatDockAutoHide).toBe(true);
    });

    test('persists autoHideEnabled=false through the device-settings store when disabled', async () => {
      localStorage.setItem('chatDockAutoHide', 'true');
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));
      expect(result.current.autoHideEnabled).toBe(true);

      act(() => {
        result.current.setAutoHideEnabled(false);
      });

      expect(result.current.autoHideEnabled).toBe(false);
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') || '{}',
      );
      expect(envelope.values.chatDockAutoHide).toBe(false);
    });
  });

  describe('device-settings persistence: showReasoning/showToolDetails/chatFontSize (station#settings-revamp slice 4)', () => {
    test('showReasoning/showToolDetails default to true with no prior device setting', async () => {
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      expect(result.current.showReasoning).toBe(true);
      expect(result.current.showToolDetails).toBe(true);
    });

    test('setShowReasoning(false) persists through the device-settings store', async () => {
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      act(() => {
        result.current.setShowReasoning(false);
      });

      expect(result.current.showReasoning).toBe(false);
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') || '{}',
      );
      expect(envelope.values.chatShowReasoning).toBe(false);
    });

    test('setShowToolDetails(false) persists through the device-settings store', async () => {
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      act(() => {
        result.current.setShowToolDetails(false);
      });

      expect(result.current.showToolDetails).toBe(false);
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') || '{}',
      );
      expect(envelope.values.chatShowToolDetails).toBe(false);
    });

    test('showReasoning/showToolDetails persist across a simulated reload (fresh store read)', async () => {
      const firstMount = await freshUseChatDockState();
      const first = renderHook(() => firstMount(defaultOptions));
      act(() => {
        first.result.current.setShowReasoning(false);
        first.result.current.setShowToolDetails(false);
      });
      first.unmount();

      // Simulate a reload: fresh hook import, fresh render, same localStorage.
      const secondMount = await freshUseChatDockState();
      const second = renderHook(() => secondMount(defaultOptions));

      expect(second.result.current.showReasoning).toBe(false);
      expect(second.result.current.showToolDetails).toBe(false);
    });

    test('chatFontSize precedence: no URL param, no device setting → the Station-configured default', async () => {
      window.history.replaceState({}, '', '/');
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      expect(result.current.chatFontSize).toBe(defaultOptions.defaultFontSize);
    });

    test('chatFontSize precedence: no URL param, a device setting is present → the device setting wins', async () => {
      window.history.replaceState({}, '', '/');
      const seed = await freshUseChatDockState();
      const seedHook = renderHook(() => seed(defaultOptions));
      act(() => {
        seedHook.result.current.setChatFontSize(() => 20);
      });
      seedHook.unmount();

      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      expect(result.current.chatFontSize).toBe(20);
    });

    test('chatFontSize precedence: a URL param wins over a present device setting, and does NOT write it back', async () => {
      const seed = await freshUseChatDockState();
      const seedHook = renderHook(() => seed(defaultOptions));
      act(() => {
        seedHook.result.current.setChatFontSize(() => 20);
      });
      seedHook.unmount();

      window.history.replaceState({}, '', '/?fontSize=16');
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      expect(result.current.chatFontSize).toBe(16);
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') || '{}',
      );
      // The URL-seeded value was never written back — the device setting
      // from the earlier explicit session-2 change (20) is untouched.
      expect(envelope.values.chatFontSize).toBe(20);

      window.history.replaceState({}, '', '/');
    });

    test('an explicit setChatFontSize() call during a URL-seeded session still writes through to the device store', async () => {
      window.history.replaceState({}, '', '/?fontSize=16');
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));
      expect(result.current.chatFontSize).toBe(16);

      act(() => {
        result.current.setChatFontSize((prev) => prev + 1);
      });

      expect(result.current.chatFontSize).toBe(17);
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') || '{}',
      );
      expect(envelope.values.chatFontSize).toBe(17);

      window.history.replaceState({}, '', '/');
    });
  });

  describe('mounted-hook live-read (slice 4 review finding 1: a one-time useState seed misses an external store change while the hook stays mounted)', () => {
    test('showReasoning/showToolDetails/chatFontSize update live when the device store changes while the hook stays mounted (e.g. Settings → Import)', async () => {
      window.history.replaceState({}, '', '/');
      const useChatDockState = await freshUseChatDockState();
      const { deviceSettingsStore } = await import(
        '../lib/device-settings-store'
      );
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      expect(result.current.showReasoning).toBe(true);
      expect(result.current.showToolDetails).toBe(true);
      expect(result.current.chatFontSize).toBe(defaultOptions.defaultFontSize);

      act(() => {
        // Simulates importEnvelope/merge — a write this hook instance
        // never triggered itself.
        deviceSettingsStore.set('chatShowReasoning', false);
        deviceSettingsStore.set('chatShowToolDetails', false);
        deviceSettingsStore.set('chatFontSize', 22);
      });

      expect(result.current.showReasoning).toBe(false);
      expect(result.current.showToolDetails).toBe(false);
      expect(result.current.chatFontSize).toBe(22);
    });

    test('a cross-tab storage event for the device envelope updates the rendered reasoning/tool-details/font-size', async () => {
      window.history.replaceState({}, '', '/');
      const useChatDockState = await freshUseChatDockState();
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      const externalEnvelope = {
        version: 2,
        values: {
          chatShowReasoning: false,
          chatShowToolDetails: false,
          chatFontSize: 22,
        },
      };
      act(() => {
        localStorage.setItem(
          'station-device-settings-v1',
          JSON.stringify(externalEnvelope),
        );
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'station-device-settings-v1',
            newValue: JSON.stringify(externalEnvelope),
            storageArea: localStorage,
          }),
        );
      });

      expect(result.current.showReasoning).toBe(false);
      expect(result.current.showToolDetails).toBe(false);
      expect(result.current.chatFontSize).toBe(22);
    });

    test('an interaction after an external store change writes the opposite of the NEW displayed value, not the stale pre-change one', async () => {
      window.history.replaceState({}, '', '/');
      const useChatDockState = await freshUseChatDockState();
      const { deviceSettingsStore } = await import(
        '../lib/device-settings-store'
      );
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      act(() => {
        deviceSettingsStore.set('chatShowReasoning', false); // external, while mounted
      });
      expect(result.current.showReasoning).toBe(false);

      act(() => {
        // The panel toggles off the CURRENTLY DISPLAYED value — must flip
        // false → true, never re-derive from a stale pre-import snapshot.
        result.current.setShowReasoning(!result.current.showReasoning);
      });

      expect(result.current.showReasoning).toBe(true);
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') || '{}',
      );
      expect(envelope.values.chatShowReasoning).toBe(true);
    });

    test('an explicit in-session font-size change keeps winning over a LATER external store change (session override pins for the rest of the session)', async () => {
      window.history.replaceState({}, '', '/');
      const useChatDockState = await freshUseChatDockState();
      const { deviceSettingsStore } = await import(
        '../lib/device-settings-store'
      );
      const { result } = renderHook(() => useChatDockState(defaultOptions));

      act(() => {
        result.current.setChatFontSize(() => 18);
      });
      expect(result.current.chatFontSize).toBe(18);

      act(() => {
        deviceSettingsStore.set('chatFontSize', 22); // e.g. a later cross-tab write
      });

      expect(result.current.chatFontSize).toBe(18);
    });
  });

  describe('auto-collapse timer', () => {
    test('fires after 5 seconds and invokes onAutoCollapse', async () => {
      const useChatDockState = await freshUseChatDockState();
      const onAutoCollapse = vi.fn();
      const { result } = renderHook(() =>
        useChatDockState({ ...defaultOptions, onAutoCollapse }),
      );
      act(() => {
        result.current.setAutoHideEnabled(true);
      });
      expect(onAutoCollapse).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(onAutoCollapse).toHaveBeenCalledTimes(1);
    });

    test('does not fire before 5 seconds', async () => {
      const useChatDockState = await freshUseChatDockState();
      const onAutoCollapse = vi.fn();
      const { result } = renderHook(() =>
        useChatDockState({ ...defaultOptions, onAutoCollapse }),
      );
      act(() => {
        result.current.setAutoHideEnabled(true);
      });
      act(() => {
        vi.advanceTimersByTime(4999);
      });
      expect(onAutoCollapse).not.toHaveBeenCalled();
    });

    test('does not fire when activeSessionCount > 0', async () => {
      const useChatDockState = await freshUseChatDockState();
      const onAutoCollapse = vi.fn();
      const { result } = renderHook(() =>
        useChatDockState({
          ...defaultOptions,
          activeSessionCount: 1,
          onAutoCollapse,
        }),
      );
      act(() => {
        result.current.setAutoHideEnabled(true);
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(onAutoCollapse).not.toHaveBeenCalled();
    });

    test('does not fire when isDockMaximized', async () => {
      const useChatDockState = await freshUseChatDockState();
      const onAutoCollapse = vi.fn();
      const { result } = renderHook(() =>
        useChatDockState({
          ...defaultOptions,
          isDockMaximized: true,
          onAutoCollapse,
        }),
      );
      act(() => {
        result.current.setAutoHideEnabled(true);
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(onAutoCollapse).not.toHaveBeenCalled();
    });

    test('does not fire when dock is already collapsed', async () => {
      const useChatDockState = await freshUseChatDockState();
      const onAutoCollapse = vi.fn();
      const { result } = renderHook(() =>
        useChatDockState({
          ...defaultOptions,
          isDockOpen: false,
          onAutoCollapse,
        }),
      );
      act(() => {
        result.current.setAutoHideEnabled(true);
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(onAutoCollapse).not.toHaveBeenCalled();
    });

    test('does not fire when autoHide is disabled', async () => {
      const useChatDockState = await freshUseChatDockState();
      const onAutoCollapse = vi.fn();
      renderHook(() => useChatDockState({ ...defaultOptions, onAutoCollapse }));
      // autoHideEnabled stays false — timer should never start
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(onAutoCollapse).not.toHaveBeenCalled();
    });
  });

  describe('resetAutoHide', () => {
    test('restarts the timer so collapse fires later, not at the original time', async () => {
      const useChatDockState = await freshUseChatDockState();
      const onAutoCollapse = vi.fn();
      const { result } = renderHook(() =>
        useChatDockState({ ...defaultOptions, onAutoCollapse }),
      );
      act(() => {
        result.current.setAutoHideEnabled(true);
      });
      // Advance partway, then reset before the timer fires.
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      act(() => {
        result.current.resetAutoHide();
      });
      // The original deadline passes with no fire (timer was restarted).
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onAutoCollapse).not.toHaveBeenCalled();
      // A full delay after the reset, it fires once.
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(onAutoCollapse).toHaveBeenCalledTimes(1);
    });

    test('is a no-op when autoHide is disabled', async () => {
      const useChatDockState = await freshUseChatDockState();
      const onAutoCollapse = vi.fn();
      const { result } = renderHook(() =>
        useChatDockState({ ...defaultOptions, onAutoCollapse }),
      );
      expect(result.current.autoHideEnabled).toBe(false);
      act(() => {
        result.current.resetAutoHide();
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(onAutoCollapse).not.toHaveBeenCalled();
    });
  });
});
