import {
  applyReturnFocus,
  captureReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type DeviceSettingsActions,
  useDeviceSettings,
} from '../../contexts/DeviceSettingsContext';
import { useExitTransition } from '../../hooks/useExitTransition';
import type { ActiveWorkPanel } from './ActiveWorkContextFrame';
import { CHAT_DOCK_INBOX_EXIT_MS } from './chat-dock-utils';
import type { MobileTaskSwitcherMode } from './MobileTaskSwitcher';

/**
 * The dock's overlay open flags and the toggles that drive them: history,
 * inbox, the composer's command/delegation launchers, the active-work panel,
 * the mobile task switcher and the background-tasks sheet, plus the
 * new-chat request epoch.
 *
 * This is state the dock owns and threads into `ChatDockHeader`,
 * `ChatDockMobileHeader` and `ChatDockContentArea` unchanged. The reset
 * effect keyed on `activeSessionId` deliberately stays at the call site: it
 * reads the active session, which this hook does not.
 */
export function useChatDockOverlays({
  isMobile,
  composerMenuTriggerRef,
  setDeviceSetting,
  setShowNewChatModalState,
}: {
  isMobile: boolean;
  composerMenuTriggerRef: RefObject<HTMLButtonElement | null>;
  setDeviceSetting: DeviceSettingsActions['setDeviceSetting'];
  setShowNewChatModalState: (open: boolean) => void;
}) {
  const [newChatRequestEpoch, setNewChatRequestEpoch] = useState(0);
  const setShowNewChatModal = useCallback(
    (open: boolean) => {
      if (open) setNewChatRequestEpoch((epoch) => epoch + 1);
      setShowNewChatModalState(open);
    },
    [setShowNewChatModalState],
  );

  const [inboxDetailSessionId, setInboxDetailSessionId] = useState<
    string | null
  >(null);
  // An inbox click opens visible chat details; Activity navigation is explicit.
  const onOpenInboxSession = useCallback(
    (threadId: string) => setInboxDetailSessionId(threadId),
    [],
  );
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // Persisted via the device-settings store (station#settings-revamp
  // slice 2 — previously its own raw `station.inbox.open` localStorage key).
  const { inboxOpen: isInboxOpen } = useDeviceSettings();
  // station#3309: keep the panel mounted for its exit beat so collapsing gives
  // its column back as it leaves, instead of deleting it between two frames.
  // The hook, not the CSS, owns the reduced-motion case — that branch has to
  // decline to keep the element mounted at all.
  const inboxPresence = useExitTransition(isInboxOpen, CHAT_DOCK_INBOX_EXIT_MS);
  const [isCommandLauncherOpen, setIsCommandLauncherOpen] = useState(false);
  const [isDelegationLauncherOpen, setIsDelegationLauncherOpen] =
    useState(false);
  const [activeWorkPanel, setActiveWorkPanel] =
    useState<ActiveWorkPanel | null>(null);
  const [isTaskSwitcherOpen, setIsTaskSwitcherOpen] = useState(false);
  // Which entry point opened the switcher — the chat-title chevron (full list)
  // or the header's activity button (running / just-finished first).
  const [taskSwitcherMode, setTaskSwitcherMode] =
    useState<MobileTaskSwitcherMode>('tasks');
  const activityTriggerRef = useRef<HTMLButtonElement>(null);
  // station#1301 slice 1: one shared open/close boolean for the Background
  // tasks sheet, opened from either entry point (desktop tab-bar button,
  // mobile activity-switcher row, or the transcript banner tap target).
  // `backgroundTasksTriggerRef` is the desktop anchor; on mobile it is never
  // populated (the button that owns it doesn't render there), so
  // `ResponsiveDialogSurface` falls back to its un-anchored bottom sheet.
  const [isBackgroundTasksOpen, setIsBackgroundTasksOpen] = useState(false);
  const backgroundTasksTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMobile) setIsTaskSwitcherOpen(false);
  }, [isMobile]);

  /**
   * station#1259. `DelegationLauncher`'s `onClose` restores focus itself, but
   * it is not the only way the launcher goes away: delegating successfully
   * closes it, and so does switching task. Both left focus on `<body>`
   * (station#1126). `CommandLauncher` restores on its own close path only, so
   * the task-switch route past it had the same hole.
   *
   * The trigger is read live inside the frame rather than captured on open —
   * the composer survives both of these, so a snapshot would be strictly worse
   * (station#1259 assessment of the `onClose` restore). Routing through
   * `applyReturnFocus` is what is new: it declines when the new session's own
   * initial focus has already claimed the frame (station#1206 gap 1) and
   * verifies the focus actually landed.
   */
  const restoreComposerMenuFocus = useCallback(() => {
    requestAnimationFrame(() =>
      applyReturnFocus(captureReturnFocus(composerMenuTriggerRef.current)),
    );
  }, [composerMenuTriggerRef]);

  const openCommandLauncher = useCallback(() => {
    setActiveWorkPanel(null);
    setIsCommandLauncherOpen(true);
  }, []);

  const openDelegationLauncher = useCallback(() => {
    setActiveWorkPanel(null);
    setIsCommandLauncherOpen(false);
    setIsDelegationLauncherOpen(true);
  }, []);

  // Stable callback identities for the memoized dock subtree (
  // ChatDockProjectContext / ChatDockContentArea): the dock re-renders every
  // rAF-coalesced frame while a resize drag is live, and inline arrow props
  // would defeat React.memo by changing identity on every one of those
  // renders even though the callbacks themselves never change behavior.
  const toggleHistory = useCallback(() => setIsHistoryOpen((v) => !v), []);
  const toggleInbox = useCallback(
    () => setDeviceSetting('inboxOpen', !isInboxOpen),
    [isInboxOpen, setDeviceSetting],
  );
  const openInboxHistory = useCallback(() => setIsHistoryOpen(true), []);
  const closeHistory = useCallback(() => setIsHistoryOpen(false), []);

  return {
    inboxDetailSessionId,
    setInboxDetailSessionId,
    onOpenInboxSession,
    newChatRequestEpoch,
    setShowNewChatModal,
    isHistoryOpen,
    toggleHistory,
    openInboxHistory,
    closeHistory,
    isInboxOpen,
    inboxPresence,
    toggleInbox,
    isCommandLauncherOpen,
    setIsCommandLauncherOpen,
    openCommandLauncher,
    isDelegationLauncherOpen,
    setIsDelegationLauncherOpen,
    openDelegationLauncher,
    activeWorkPanel,
    setActiveWorkPanel,
    isTaskSwitcherOpen,
    setIsTaskSwitcherOpen,
    taskSwitcherMode,
    setTaskSwitcherMode,
    activityTriggerRef,
    isBackgroundTasksOpen,
    setIsBackgroundTasksOpen,
    backgroundTasksTriggerRef,
    restoreComposerMenuFocus,
  };
}
