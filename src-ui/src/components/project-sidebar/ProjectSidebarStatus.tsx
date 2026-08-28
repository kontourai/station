import { useRef, useState } from 'react';
import { buildLabel, buildTitle } from '../../build-info';
import { useAgents } from '../../contexts/AgentsContext';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { openChatsStore, useOpenChats } from '../../contexts/open-chats-store';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { chatTaskSessionId } from '../../views/home/home-view-model';
import '../chat/chat.css';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';
import './ProjectSidebarStatus.css';

/**
 * Bottom-of-sidebar status line: open-chat count (clickable — opens a
 * popover listing the sessions), build identity, and a subtle ⌘K chip for
 * the command palette (desktop only — the chip advertises a keyboard
 * shortcut). Replaces the retired fixed bottom status bar
 * (`statusbar--app`), which forced the chat dock to lift itself above it.
 * Hidden entirely when the sidebar is collapsed (shared
 * `.sidebar--collapsed` rules).
 *
 * archive#1300: the count used to render as an inert "N active" span with
 * only a tooltip explaining it. It is what the WORK list's rows already are
 * (open chat sessions, archive#1097/#1053 sessionStorage-backed store), so
 * the popover uses the shared open-chat navigation action.
 */
export function ProjectSidebarStatus() {
  const commandPaletteShortcut = useShortcutDisplay('command-palette');
  const agents = useAgents();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openChats = useOpenChats(agents);
  const sessionCount = openChats.length;
  const sessionsLabel = `${sessionCount} open ${sessionCount === 1 ? 'chat' : 'chats'}`;

  const close = () => setIsOpen(false);

  return (
    <div className="sidebar__status">
      <div className="sidebar__status-meta">
        <span className="sidebar__status-dot" aria-hidden="true" />
        <button
          ref={triggerRef}
          type="button"
          className="sidebar__status-sessions"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          title="Open chats"
          onClick={() => setIsOpen((value) => !value)}
        >
          {sessionsLabel}
        </button>
        {isOpen && (
          <ResponsiveDialogSurface
            ariaLabel="Open chats"
            onClose={close}
            historyMode="entry"
            returnFocusTarget={triggerRef.current}
            anchorRef={triggerRef}
            overlayClassName="composer-popover-overlay composer-popover-overlay--start"
            panelClassName="composer-popover-panel"
          >
            <ResponsiveDialogHeader
              title="Open chats"
              closeLabel="Close open chats"
              onClose={close}
            />
            <div
              className="composer-actions-menu__list"
              role="menu"
              aria-label="Open chats"
            >
              {openChats.length === 0 ? (
                <Empty variant="compact" label="All chats are settled" />
              ) : (
                openChats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    role="menuitem"
                    className="composer-actions-menu__item"
                    onClick={() => {
                      close();
                      openChatsStore.focus({
                        sessionId: chatTaskSessionId(chat),
                      });
                    }}
                  >
                    {chat.title}
                    <span
                      className="composer-actions-menu__item-hint"
                      aria-hidden="true"
                    >
                      {chat.agentLabel} · {chat.modelLabel}
                    </span>
                  </button>
                ))
              )}
            </div>
          </ResponsiveDialogSurface>
        )}
        <span
          className="sidebar__status-version"
          title={buildTitle}
          data-testid="sidebar-build-version"
        >
          {buildLabel}
        </span>
        <button
          type="button"
          className="sidebar__status-palette"
          aria-label="Command palette"
          data-first-run-anchor="command-palette"
          title={withShortcutHint(
            'Open command palette',
            'command-palette',
            () => commandPaletteShortcut,
          )}
          onClick={() =>
            window.dispatchEvent(new CustomEvent('open-command-palette'))
          }
        >
          ⌘K
        </button>
      </div>
    </div>
  );
}
