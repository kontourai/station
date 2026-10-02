/** @vitest-environment jsdom */

import { render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    isDockOpen: true,
    isDockMaximized: false,
    setDockState: vi.fn(),
    dockMode: 'bottom',
    pathname: '/',
  }),
}));
const SHORTCUT_DISPLAY: Record<string, string> = {
  'dock.openConversation': '⌘O',
  'dock.newChat': '⌘N',
};
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: (id: string) => SHORTCUT_DISPLAY[id] ?? '',
  useShortcutDisplayLookup: () => (id: string) => SHORTCUT_DISPLAY[id] ?? '',
}));

import { ChatDockHeader } from '../components/chat-dock/ChatDockHeader';
import { RegionChromeSlotsContext } from '../workspace-panes/RegionChromeSlots';

function workspaceControls() {
  return {
    showInboxToggle: true,
    isInboxOpen: true,
    onToggleInbox: vi.fn(),
    backgroundTasksTriggerRef: createRef<HTMLButtonElement>(),
    backgroundTasksRunningCount: 0,
    isBackgroundTasksOpen: false,
    onToggleBackgroundTasks: vi.fn(),
    onOpenConversation: vi.fn(),
    onNewChat: vi.fn(),
  };
}

/**
 * #3046: a bar that names the pane (the Coding layout's breadcrumb) takes
 * the full-screen Chat's toolbar into its slots — no second bar, no second
 * title — and the two verbs give up their words for a name and a tooltip
 * that carries the chord.
 */
describe('ChatDockHeader in a bar that names the pane', () => {
  test('joins the bar, omits its identity, and keeps Open/New as named icons with tipped shortcuts', async () => {
    const leading = document.createElement('span');
    const trailing = document.createElement('span');
    document.body.append(leading, trailing);
    try {
      const { container } = render(
        <RegionChromeSlotsContext.Provider
          value={{ leading, trailing, namesPane: true }}
        >
          <ChatDockHeader
            fullscreen
            chatIdentity={<span>Dev Agent Chat</span>}
            projectContext={<span>Dev</span>}
            chatControls={{
              sessions: [
                { id: 'a', title: 'One', status: 'idle' },
                { id: 'b', title: 'Two', status: 'idle' },
              ],
              unreadCount: 0,
              focusSession: vi.fn(),
              onNewChat: vi.fn(),
              setShowChatSettings: vi.fn(),
            }}
            workspaceControls={workspaceControls()}
            regionVisible
          />
        </RegionChromeSlotsContext.Provider>,
      );
      expect(container.querySelector('.chat-dock__header')).toBeNull();
      // The session count is not loose text in the bar: it rides the Open
      // icon as its badge and tooltip.
      expect(trailing.textContent).not.toContain('sessions');
      // The title is the bar's: the identity is not repeated.
      expect(leading.textContent).not.toContain('Dev Agent Chat');
      expect(leading.textContent).toContain('Dev');

      // The verbs arrive with a lazily loaded chunk; a cold transform of it
      // can take seconds in this runner.
      const open = await within(trailing).findByRole(
        'button',
        { name: 'Open conversation, 2 sessions' },
        { timeout: 15_000 },
      );
      const create = within(trailing).getByRole('button', { name: 'New chat' });
      expect(open.querySelector('.chat-dock__new-count')?.textContent).toBe(
        '2',
      );
      expect(create.textContent).toBe('');
      const tip = (button: HTMLElement) =>
        button.parentElement?.querySelector('[role="tooltip"]')?.textContent;
      expect(tip(open)).toBe('Open conversation — 2 sessions (⌘O)');
      expect(tip(create)).toBe('New chat (⌘N)');
      // The dock's own menu still rides the bar.
      expect(
        within(trailing).getByRole('button', { name: 'More dock actions' }),
      ).toBeTruthy();
    } finally {
      leading.remove();
      trailing.remove();
    }
  });

  test('a region bar that does not name the pane leaves a full-screen Chat its own bar and its words', async () => {
    const leading = document.createElement('span');
    const trailing = document.createElement('span');
    document.body.append(leading, trailing);
    try {
      const { container } = render(
        <RegionChromeSlotsContext.Provider value={{ leading, trailing }}>
          <ChatDockHeader
            fullscreen
            chatIdentity={<span>Dev Agent Chat</span>}
            workspaceControls={workspaceControls()}
            regionVisible
          />
        </RegionChromeSlotsContext.Provider>,
      );
      expect(container.querySelector('.chat-dock__header')).not.toBeNull();
      expect(container.textContent).toContain('Dev Agent Chat');
      expect(
        await screen.findByText('New', {}, { timeout: 15_000 }),
      ).toBeTruthy();
      expect(screen.getByText('Open')).toBeTruthy();
    } finally {
      leading.remove();
      trailing.remove();
    }
  });
});
