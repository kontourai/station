import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../contexts/DeviceSettingsContext';

interface UseChatDockStateOptions {
  defaultFontSize: number;
  isDockOpen: boolean;
  isDockMaximized: boolean;
  activeSessionCount?: number;
  /**
   * Invoked when the idle timer fires. The dock is driven to its collapsed
   * (bar-only) state by the caller — the bar and its drag/resize handle stay
   * mounted and on-screen. Nothing is ever translated off-screen.
   */
  onAutoCollapse?: () => void;
}

const AUTO_COLLAPSE_DELAY_MS = 5000;

/**
 * Occupant-owned Chat display preferences and transient UI state — font
 * size, reasoning/tool-details visibility, the idle auto-collapse timer, and
 * the panel-open flags for settings/session-picker/new-chat. None of this has
 * meaning outside a Chat pane.
 *
 * Dock CHROME (geometry, dragging, snap, placement, `dock.toggle` /
 * `dock.maximize`) moved to `useDockShellChrome` (station#4460): that state
 * has to survive an ambient occupant switch, so it is owned by the
 * persistent `DockShell`/full-screen placement, never by the occupant that
 * unmounts.
 */
export function useChatDockState({
  defaultFontSize,
  isDockOpen,
  isDockMaximized,
  activeSessionCount = 0,
  onAutoCollapse,
}: UseChatDockStateOptions) {
  const settings = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();

  // Device-scope chat display preferences (station#settings-revamp slice 4,
  // docs/design/settings-architecture.md §3 S4 "Chat/session", §6 slice 4).
  // Read LIVE every render via `useDeviceSettings()` (`useSyncExternalStore`
  // under the hood) rather than seeded once into local `useState` — a
  // review finding (slice 4 review) caught that a one-time seed misses an
  // external store change while this hook stays mounted (Settings → Import,
  // or a cross-tab write): the toggle would keep showing the pre-import
  // value, and clicking it would then write the OPPOSITE of what's
  // displayed. `autoHideEnabled` below already used the correct live-read
  // pattern; reasoning/tool-details now match it exactly (no local state
  // wrapper at all — same-value writes are already a no-op inside the store,
  // so there is nothing else to preserve).
  const {
    chatDockAutoHide: autoHideEnabled,
    chatShowReasoning: showReasoning,
    chatShowToolDetails: showToolDetails,
    chatFontSize: deviceChatFontSize,
  } = settings;
  const setAutoHideEnabled = useCallback(
    (value: boolean) => setDeviceSetting('chatDockAutoHide', value),
    [setDeviceSetting],
  );
  const setShowReasoning = useCallback(
    (show: boolean) => setDeviceSetting('chatShowReasoning', show),
    [setDeviceSetting],
  );
  const setShowToolDetails = useCallback(
    (show: boolean) => setDeviceSetting('chatShowToolDetails', show),
    [setDeviceSetting],
  );

  // Font size keeps its documented per-session URL-override semantics, but
  // the "device setting" leg of that precedence must also be LIVE (the same
  // review finding as above) — so only the SESSION's own explicit change is
  // tracked in local state; the URL param is read once (a session-scoped,
  // never-reactive input by design); the live device-scope value flows
  // straight from `useDeviceSettings()`. Resolution order, pinned by tests
  // (docs/design/settings-architecture.md §6 slice 4):
  // sessionOverride > urlParam > the LIVE device setting > the Station-
  // configured default. An explicit in-session change (the A−/A+/reset
  // controls) both pins the display for the rest of this session AND writes
  // through to the device store (last-set-wins-across-sessions) — so it
  // keeps winning even if a later external store change arrives mid-session.
  const [urlFontSizeOverride] = useState<number | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const querySize = params.get('fontSize');
    return querySize ? parseInt(querySize, 10) : null;
  });
  const [sessionFontSizeOverride, setSessionFontSizeOverride] = useState<
    number | null
  >(null);
  const chatFontSize =
    sessionFontSizeOverride ??
    urlFontSizeOverride ??
    deviceChatFontSize ??
    defaultFontSize;
  const setChatFontSize = useCallback(
    (updater: (prev: number) => number) => {
      const next = updater(chatFontSize);
      setSessionFontSizeOverride(next);
      setDeviceSetting('chatFontSize', next);
    },
    [chatFontSize, setDeviceSetting],
  );

  const [showStatsPanel, setShowStatsPanel] = useState(false);
  const [showChatSettings, setShowChatSettings] = useState(false);
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);

  // Session state
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Auto-collapse state. When enabled, an idle expanded dock collapses to the
  // (still-visible) Collapsed bar — it never hides or translates off-screen.
  const autoCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Keep the collapse callback in a ref so the idle timer effect doesn't churn
  // (and reset itself) whenever the caller passes a fresh closure.
  const onAutoCollapseRef = useRef(onAutoCollapse);
  useEffect(() => {
    onAutoCollapseRef.current = onAutoCollapse;
  }, [onAutoCollapse]);

  // Idle timer: after the delay, collapse an open, non-maximized, idle dock to
  // the Collapsed bar. Skipped while the dock is already collapsed, maximized,
  // or has active sessions.
  useEffect(() => {
    if (
      !autoHideEnabled ||
      !isDockOpen ||
      isDockMaximized ||
      activeSessionCount > 0
    ) {
      if (autoCollapseTimerRef.current) {
        clearTimeout(autoCollapseTimerRef.current);
        autoCollapseTimerRef.current = null;
      }
      return;
    }
    autoCollapseTimerRef.current = setTimeout(() => {
      onAutoCollapseRef.current?.();
    }, AUTO_COLLAPSE_DELAY_MS);
    return () => {
      if (autoCollapseTimerRef.current) {
        clearTimeout(autoCollapseTimerRef.current);
        autoCollapseTimerRef.current = null;
      }
    };
  }, [autoHideEnabled, isDockOpen, isDockMaximized, activeSessionCount]);

  // Resets the idle timer (call on dock interaction: hover/focus/pointer/scroll)
  const resetAutoHide = useCallback(() => {
    if (!autoHideEnabled || !isDockOpen || isDockMaximized) return;
    if (autoCollapseTimerRef.current) {
      clearTimeout(autoCollapseTimerRef.current);
      autoCollapseTimerRef.current = null;
    }
    autoCollapseTimerRef.current = setTimeout(() => {
      onAutoCollapseRef.current?.();
    }, AUTO_COLLAPSE_DELAY_MS);
  }, [autoHideEnabled, isDockOpen, isDockMaximized]);

  return {
    chatFontSize,
    setChatFontSize,
    showStatsPanel,
    setShowStatsPanel,
    showReasoning,
    setShowReasoning,
    showToolDetails,
    setShowToolDetails,
    showChatSettings,
    setShowChatSettings,
    showNewChatModal,
    setShowNewChatModal,
    showSessionPicker,
    setShowSessionPicker,
    activeSessionId,
    setActiveSessionId,
    autoHideEnabled,
    setAutoHideEnabled,
    resetAutoHide,
  };
}
