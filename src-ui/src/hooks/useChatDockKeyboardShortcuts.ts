import { useCallback } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import { isTurnInFlight } from '../contexts/active-chats-state';
import { useNavigation } from '../contexts/NavigationContext';
import { describeStopTurnOutcome } from './useActiveChatSessionMessaging';
import { useCancelMessage } from './useActiveChatSessions';
import { useKeyboardShortcut } from './useKeyboardShortcut';

const DOCK_WHEN = { not: 'composerFocused' } as const;

function useDockShortcut(
  id: string,
  key: string,
  modifiers: ('cmd' | 'ctrl' | 'shift' | 'alt')[],
  description: string,
  handler: () => void,
) {
  useKeyboardShortcut(
    id,
    key,
    modifiers,
    description,
    handler,
    true,
    0,
    DOCK_WHEN,
  );
}

interface DerivedSession {
  id: string;
  abortController?: AbortController;
}

interface UseChatDockKeyboardShortcutsOptions {
  sessions: DerivedSession[];
  activeSessionId: string | null;
  activeSession: DerivedSession | null;
  setActiveSessionId: (id: string | null) => void;
  setShowSessionPicker: (v: boolean) => void;
  focusSession: (id: string) => void;
}

/**
 * Chat's OWN keyboard shortcuts — new chat, open conversation, close tab,
 * session switching, cancel. `dock.toggle` / `dock.maximize` moved to
 * `useDockShellChrome` (station#4460): they are dock CHROME, not a Chat
 * behavior, and Home/Activity need them working too.
 *
 * That hook's `registersDockShortcuts` flag (review round H1), not mount
 * exclusivity, is what keeps those two ids single-registered: the ambient
 * `DockShell` and a full-screen `ChatWorkspacePane` are NOT mutually
 * exclusive (a `workspace-pane` route can render its own full-screen Chat
 * pane while the ambient dock stays mounted, docked to any occupant,
 * alongside it) — each legitimately registers when it is the active
 * instance, and a DOCKED Chat's own local `useDockShellChrome` call passes
 * `registersDockShortcuts: false` so it never fights `DockShell`'s.
 */
export function useChatDockKeyboardShortcuts({
  sessions,
  activeSessionId,
  activeSession,
  setActiveSessionId,
  setShowSessionPicker,
  focusSession,
}: UseChatDockKeyboardShortcutsOptions) {
  const { selectedAgent, setActiveChat } = useNavigation();
  const { initChat, removeChat, addEphemeralMessage } = useActiveChatActions();
  const cancelMessage = useCancelMessage();

  useDockShortcut(
    'dock.newChat',
    't',
    ['cmd'],
    'New chat',
    useCallback(() => {
      if (selectedAgent) {
        const newSessionId = `session-${Date.now()}`;
        initChat(newSessionId, (selectedAgent as any) ?? undefined);
        setActiveSessionId(newSessionId);
        setActiveChat(null); // New chat, no conversation yet
      }
    }, [selectedAgent, initChat, setActiveSessionId, setActiveChat]),
  );

  useDockShortcut(
    'dock.openConversation',
    'o',
    ['cmd'],
    'Open conversation',
    useCallback(() => {
      setShowSessionPicker(true);
    }, [setShowSessionPicker]),
  );

  useDockShortcut(
    'dock.closeTab',
    'x',
    ['cmd'],
    'Close tab',
    useCallback(() => {
      if (activeSessionId && sessions.length > 1) {
        const currentIndex = sessions.findIndex(
          (s) => s.id === activeSessionId,
        );
        const nextSession =
          sessions[currentIndex + 1] || sessions[currentIndex - 1];
        if (nextSession) focusSession(nextSession.id);
        removeChat(activeSessionId);
      }
    }, [activeSessionId, sessions, focusSession, removeChat]),
  );

  // Session switching shortcuts (⌘1-9)
  useDockShortcut(
    'dock.session1',
    '1',
    ['cmd'],
    'Switch to session 1',
    useCallback(() => {
      if (sessions[0]) focusSession(sessions[0].id);
    }, [sessions, focusSession]),
  );
  useDockShortcut(
    'dock.session2',
    '2',
    ['cmd'],
    'Switch to session 2',
    useCallback(() => {
      if (sessions[1]) focusSession(sessions[1].id);
    }, [sessions, focusSession]),
  );
  useDockShortcut(
    'dock.session3',
    '3',
    ['cmd'],
    'Switch to session 3',
    useCallback(() => {
      if (sessions[2]) focusSession(sessions[2].id);
    }, [sessions, focusSession]),
  );
  useDockShortcut(
    'dock.session4',
    '4',
    ['cmd'],
    'Switch to session 4',
    useCallback(() => {
      if (sessions[3]) focusSession(sessions[3].id);
    }, [sessions, focusSession]),
  );
  useDockShortcut(
    'dock.session5',
    '5',
    ['cmd'],
    'Switch to session 5',
    useCallback(() => {
      if (sessions[4]) focusSession(sessions[4].id);
    }, [sessions, focusSession]),
  );
  useDockShortcut(
    'dock.session6',
    '6',
    ['cmd'],
    'Switch to session 6',
    useCallback(() => {
      if (sessions[5]) focusSession(sessions[5].id);
    }, [sessions, focusSession]),
  );
  useDockShortcut(
    'dock.session7',
    '7',
    ['cmd'],
    'Switch to session 7',
    useCallback(() => {
      if (sessions[6]) focusSession(sessions[6].id);
    }, [sessions, focusSession]),
  );
  useDockShortcut(
    'dock.session8',
    '8',
    ['cmd'],
    'Switch to session 8',
    useCallback(() => {
      if (sessions[7]) focusSession(sessions[7].id);
    }, [sessions, focusSession]),
  );
  useDockShortcut(
    'dock.session9',
    '9',
    ['cmd'],
    'Switch to session 9',
    useCallback(() => {
      if (sessions[8]) focusSession(sessions[8].id);
    }, [sessions, focusSession]),
  );

  useDockShortcut(
    'dock.cancel',
    'c',
    ['ctrl'],
    'Cancel request',
    useCallback(() => {
      // The same one derivation the composer's Stop control reads.
      if (!activeSession || !isTurnInFlight(activeSession)) return;
      const sessionId = activeSession.id;
      // Same derivation as the composer's Stop button (UX audit T1): report
      // what the stop settled as, never the intent that started it.
      void cancelMessage(sessionId).then((outcome) => {
        if (outcome.kind === 'not-running') return;
        addEphemeralMessage(sessionId, {
          role: 'system',
          content: describeStopTurnOutcome(outcome),
        });
      });
    }, [activeSession, cancelMessage, addEphemeralMessage]),
  );
}
