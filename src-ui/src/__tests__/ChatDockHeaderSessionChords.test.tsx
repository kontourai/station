/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

/**
 * The activity dropdown's per-session keycaps (#1649).
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
      surfaceTitle="Chat"
      chatControls={{
        sessions,
        unreadCount: 0,
        focusSession: vi.fn(),
        onNewChat: vi.fn(),
        setShowChatSettings: vi.fn(),
      }}
      isDragging={false}
      onDockSnap={vi.fn()}
      availableDockSlotPlacements={['left', 'bottom', 'right']}
      effectiveDockSlotPlacement="bottom"
      onDockPlacementChange={vi.fn()}
      regionVisible={true}
      shellMaximized={false}
    />,
  );
}

const active = (id: string, title: string) => ({
  id,
  title,
  status: 'sending',
});

describe('activity dropdown per-session chords (#1649)', () => {
  test('each row shows the chord the registry reports, not a Mac keycap', () => {
    const { container } = renderHeader([
      active('a', 'First'),
      active('b', 'Second'),
    ]);

    const badges = Array.from(
      container.querySelectorAll(
        '.chat-dock__activity-item .chat-dock__subtitle',
      ),
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
    const { container } = renderHeader([
      active('a', 'First'),
      active('b', 'Second'),
      active('c', 'Third'),
    ]);

    const badges = Array.from(
      container.querySelectorAll(
        '.chat-dock__activity-item .chat-dock__subtitle',
      ),
    ).map((node) => node.textContent);

    expect(badges).toEqual(['Ctrl+1', 'Ctrl+2', '']);
  });

  test('every active session gets a row', () => {
    // Guards the assertions above against silently measuring zero rows.
    renderHeader([active('a', 'First'), active('b', 'Second')]);
    expect(screen.getAllByText(/First|Second/)).toHaveLength(2);
  });
});
