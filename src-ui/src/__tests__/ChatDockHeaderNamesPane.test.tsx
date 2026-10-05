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
  'dock.newChat': '⌘T',
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
 * title. Its one verb, New, gives up its word for a name and a tooltip that
 * carries the chord. There is no Open (the inbox sits beside Chat) and no
 * session count (the inbox enumerates the chats).
 */
describe('ChatDockHeader in a bar that names the pane', () => {
  test('joins the bar, omits its identity, and keeps New as a named icon with a tipped shortcut, with no Open and no session count', async () => {
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
      // No session count anywhere in the bar: the inbox enumerates them.
      expect(trailing.textContent).not.toMatch(/sessions?/i);
      // The title is the bar's: the identity is not repeated.
      expect(leading.textContent).not.toContain('Dev Agent Chat');
      expect(leading.textContent).toContain('Dev');

      // The verbs arrive with a lazily loaded chunk; a cold transform of it
      // can take seconds in this runner.
      const create = await within(trailing).findByRole(
        'button',
        { name: 'New chat' },
        { timeout: 15_000 },
      );
      // The shared creation action, icon-only: no word, a name and a tip.
      expect(create.classList).toContain('new-chat-action');
      expect(create.textContent).toBe('');
      const tip = (button: HTMLElement) =>
        button.parentElement?.querySelector('[role="tooltip"]')?.textContent;
      expect(tip(create)).toBe('New chat (⌘T)');
      // One verb, not two: no Open beside it.
      expect(
        within(trailing).queryByRole('button', { name: /^Open/ }),
      ).toBeNull();
      expect(document.body.textContent).not.toMatch(/\bsessions?\b/i);
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
      // The bar's one labelled action; Open is a row of its ⋯ menu.
      expect(screen.queryByText('Open')).toBeNull();
    } finally {
      leading.remove();
      trailing.remove();
    }
  });
});
