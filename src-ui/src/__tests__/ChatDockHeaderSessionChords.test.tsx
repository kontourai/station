/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

/**
 * The working chats' per-session keycaps (#1649). The rows were the bar's
 * "N chats working" dropdown; they are the first rows of the dock's one More
 * menu now, and the count rides the inbox toggle or that menu's trigger.
 *
 * These rows used to render a literal `⌘{n}`. `dock.session1`…`dock.session9`
 * are Cmd-N on macOS and Ctrl-N everywhere else, so on Windows and Linux the
 * row named a chord the user could not press — a false label rather than a
 * typography problem, and one no test could see because the only fixtures that
 * render this header carry no active sessions.
 */

const chords: Record<string, string> = {
  'dock.session1': 'Ctrl+1',
  'dock.session2': 'Ctrl+2',
};

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: (id: string) => chords[id] ?? '',
  useShortcutDisplayLookup: () => (id: string) => chords[id] ?? '',
}));

import {
  ChatDockHeader,
  type ChatDockHeaderChatControls,
} from '../components/chat-dock/ChatDockHeader';

function renderHeader(sessions: ChatDockHeaderChatControls['sessions']) {
  return render(
    <ChatDockHeader
      chatControls={{
        sessions,
        unreadCount: 0,
        focusSession: vi.fn(),
        onNewChat: vi.fn(),
        setShowChatSettings: vi.fn(),
      }}
      regionVisible={true}
    />,
  );
}

const active = (id: string, title: string) => ({
  id,
  title,
  status: 'sending',
});

const openMore = () =>
  fireEvent.click(screen.getByRole('button', { name: /^More dock actions/ }));

describe('working chat rows show per-session chords (#1649)', () => {
  test('each row shows the chord the registry reports, not a Mac keycap', () => {
    const { container } = renderHeader([
      active('a', 'First'),
      active('b', 'Second'),
    ]);

    openMore();
    const badges = Array.from(
      document.querySelectorAll('[role=menuitem] .action-overflow__shortcut'),
    ).map((node) => node.textContent);

    expect(badges).toEqual(['Ctrl+1', 'Ctrl+2']);
    // The literal this replaced. Asserting its absence is what makes the
    // assertion above a regression guard rather than a snapshot.
    expect(container.textContent).not.toContain('⌘');
  });

  test('a session index the registry has not bound renders an empty badge', () => {
    // `getDisplay` answers '' for an unregistered id — the dock's shortcuts
    // are registered by `ChatDock`, which a header rendered alone does not
    // have. `.chat-dock__subtitle:empty` is what hides the badge; the
    // contract this pins is that nothing invents a chord for it.
    renderHeader([
      active('a', 'First'),
      active('b', 'Second'),
      active('c', 'Third'),
    ]);

    openMore();
    const badges = Array.from(
      document.querySelectorAll('[role=menuitem] .action-overflow__shortcut'),
    ).map((node) => node.textContent);

    expect(badges).toEqual(['Ctrl+1', 'Ctrl+2']);
    expect(
      screen
        .getByRole('menuitem', { name: 'Third' })
        .getAttribute('aria-keyshortcuts'),
    ).toBeNull();
  });

  test('a background-only session counts as working and gets a row', () => {
    renderHeader([
      {
        id: 'background',
        title: 'Background research',
        status: 'idle',
        conversationActivity: {
          conversationId: 'background',
          asOfSequence: 4,
          runningChildWork: { count: 1, producers: ['engine-subagent'] },
        },
      },
    ]);
    // No inbox toggle in this harness (no workspace controls), so the count
    // rides the More trigger.
    expect(
      screen.getByRole('button', {
        name: 'More dock actions — 1 chat working',
      }),
    ).not.toBeNull();
    openMore();
    expect(
      screen.getByRole('menuitem', { name: 'Background research' }),
    ).toBeTruthy();
  });
});
