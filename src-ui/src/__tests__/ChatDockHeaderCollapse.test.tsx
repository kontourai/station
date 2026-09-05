/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const setDockState = vi.fn();
const onNewChat = vi.fn();
const onDockSnap = vi.fn();
let isDockOpen = true;
let isDockMaximized = true;
let dockMode: 'left' | 'bottom' | 'right' = 'bottom';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    isDockOpen,
    isDockMaximized,
    setDockState,
    dockMode,
    pathname: '/',
  }),
}));

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '',
}));

import { ChatDockHeader } from '../components/chat-dock/ChatDockHeader';

function renderHeader({
  fullscreen = false,
  chatIdentity,
  projectContext,
}: {
  fullscreen?: boolean;
  chatIdentity?: ReactNode;
  projectContext?: ReactNode;
} = {}) {
  return render(
    <ChatDockHeader
      chatIdentity={chatIdentity}
      projectContext={projectContext}
      chatControls={{
        sessions: [],
        unreadCount: 0,
        focusSession: vi.fn(),
        onNewChat,
        setShowChatSettings: vi.fn(),
      }}
      isDragging={false}
      onDockSnap={onDockSnap}
      availableDockSlotPlacements={['left', 'bottom', 'right']}
      effectiveDockSlotPlacement={dockMode}
      onDockPlacementChange={vi.fn()}
      fullscreen={fullscreen}
      regionVisible={isDockOpen}
      shellMaximized={isDockMaximized}
    />,
  );
}

describe('ChatDockHeader collapse/maximize reconciliation (#795)', () => {
  beforeEach(() => {
    setDockState.mockClear();
    onNewChat.mockClear();
    onDockSnap.mockClear();
    window.localStorage.clear();
    isDockOpen = true;
    isDockMaximized = true;
    dockMode = 'bottom';
  });

  // `is-collapsed` and `is-maximized` are independent classes. Carrying the
  // maximized flag through a collapse left the dock at full height with an
  // emptied body — a blank full-screen shell that only Restore or a reload
  // recovered.
  test('collapsing a maximized dock clears the maximized flag', () => {
    renderHeader();

    fireEvent.click(screen.getByTitle('Hide dock region'));

    expect(onDockSnap).toHaveBeenCalledWith('collapsed');
  });

  test('expanding does not invent a maximized dock when the last size was not Full', () => {
    isDockOpen = false;
    isDockMaximized = false;
    window.localStorage.setItem('station.chatDock.snap', 'half');
    renderHeader();

    fireEvent.click(screen.getByTitle('Show dock region'));

    expect(onDockSnap).toHaveBeenCalledWith('half');
  });

  // archive#795: the reopened dock takes its height from the persisted snap,
  // so expanding after a Full-height collapse used to come back full height
  // with its own Maximize button still reading "Maximize".
  test('expanding restores Maximized when the persisted size was Full', () => {
    isDockOpen = false;
    isDockMaximized = false;
    window.localStorage.setItem('station.chatDock.snap', 'full');
    renderHeader();

    fireEvent.click(screen.getByTitle('Show dock region'));

    expect(onDockSnap).toHaveBeenCalledWith('full');
  });
});

// archive#800: this label read "Start a chat" and carried a pointer cursor, but was
// inert text — the click it appeared to offer only toggled the dock open (the
// header's own handler), leaving the user to hunt for "New".
describe('collapsed dock "Start a chat" affordance (#800)', () => {
  beforeEach(() => {
    setDockState.mockClear();
    onNewChat.mockClear();
    onDockSnap.mockClear();
    window.localStorage.clear();
    isDockOpen = true;
    isDockMaximized = true;
    dockMode = 'bottom';
  });

  test('is a real control that starts a chat', () => {
    isDockOpen = false;
    isDockMaximized = false;
    renderHeader();

    const control = screen.getByRole('button', { name: 'Start a chat' });
    fireEvent.click(control);

    expect(onNewChat).toHaveBeenCalledTimes(1);
    // Starting a chat must not double as a dock toggle.
    expect(setDockState).not.toHaveBeenCalled();
  });

  // archive#800: the header renders unconditionally, so without an open-state
  // guard the dock-open-and-empty state showed two identical "Start a chat"
  // controls — the header's and the body's — and any role-based query would
  // resolve to both.
  test('yields to the body CTA once the dock is open', () => {
    isDockOpen = true;
    isDockMaximized = false;
    renderHeader();

    expect(screen.queryByRole('button', { name: 'Start a chat' })).toBeNull();
    expect(screen.getByText('Start a chat')).toBeTruthy();
  });

  test('the region visibility and settings controls carry accessible names', () => {
    isDockOpen = false;
    renderHeader();

    expect(screen.getByLabelText('Show dock region')).toBeTruthy();
    expect(screen.getByLabelText('Chat settings')).toBeTruthy();
  });

  test('groups the dock shortcut directly with Chat settings', () => {
    const { container } = renderHeader();
    const settings = screen.getByLabelText('Chat settings');
    const shortcut = container.querySelector('.chat-dock__toggle-shortcut');

    expect(shortcut?.getAttribute('data-chrome-group')).toBe('chat-settings');
    expect(settings.nextElementSibling).toBe(shortcut);
  });

  test('mirrors the collapse direction for a left-side dock', () => {
    dockMode = 'left';
    isDockOpen = true;
    renderHeader();

    const collapse = screen.getByLabelText('Hide dock region');
    expect(collapse.querySelector('svg')?.classList).toContain('is-left-open');
  });

  test('routes explicit maximize and restore through the persisted Full/Half snap owner', () => {
    isDockOpen = true;
    isDockMaximized = false;
    renderHeader();

    fireEvent.click(screen.getByLabelText('Expand dock region to workspace'));
    expect(onDockSnap).toHaveBeenCalledWith('full');

    isDockMaximized = true;
    // Re-rendering represents navigation state after the snap owner applies Full.
    renderHeader();
    fireEvent.click(screen.getByLabelText('Restore dock region size'));
    expect(onDockSnap).toHaveBeenLastCalledWith('half');
  });

  test('keeps ambient dock controls out of the full-screen pane placement', () => {
    renderHeader({ fullscreen: true });

    expect(
      screen.queryByLabelText('Expand dock region to workspace'),
    ).toBeNull();
    expect(screen.queryByLabelText('Restore dock region size')).toBeNull();
    expect(screen.queryByLabelText('Hide dock region')).toBeNull();
  });

  test('names and depicts region extent separately from region visibility', () => {
    isDockOpen = true;
    isDockMaximized = false;
    renderHeader();

    const extent = screen.getByLabelText('Expand dock region to workspace');
    const visibility = screen.getByLabelText('Hide dock region');
    expect(extent.getAttribute('aria-label')).not.toBe(
      visibility.getAttribute('aria-label'),
    );
    expect(extent.querySelector('.chat-dock__extent-svg')).not.toBeNull();
    expect(visibility.querySelector('.chat-dock__chevron-svg')).not.toBeNull();
  });

  test('toggles from non-interactive project context and identity text', () => {
    renderHeader({
      chatIdentity: <span>Active conversation</span>,
      projectContext: <span>Project context</span>,
    });

    fireEvent.click(screen.getByText('Active conversation'));
    fireEvent.click(screen.getByText('Project context'));

    expect(onDockSnap).toHaveBeenCalledTimes(2);
    expect(onDockSnap).toHaveBeenCalledWith('collapsed');
  });

  test('does not toggle when a project-context link or identity button handles the click', () => {
    renderHeader({
      chatIdentity: <button type="button">Active conversation</button>,
      projectContext: (
        <a href="/projects/alpha" onClick={(event) => event.preventDefault()}>
          Project context
        </a>
      ),
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Active conversation' }),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Project context' }));

    expect(onDockSnap).not.toHaveBeenCalled();
  });
});

/**
 * #928 C2b deleted the dock header's occupant picker (the trigger named the
 * docked pane) with the docked-Home path it switched to. This pins the header's remaining
 * control set BY ACCESSIBLE NAME, in order, for the open desktop dock: the
 * deletion was meant to remove exactly one control, so a header that loses
 * (or gains, or renames) any other reds here by name instead of shipping as
 * a quiet chrome regression. Captured against the pre-C2b tree, minus the
 * picker.
 */
describe('the dock header control set (#928 C2b)', () => {
  beforeEach(() => {
    isDockOpen = true;
    isDockMaximized = false;
    dockMode = 'bottom';
  });

  test('an open bottom dock offers exactly these controls, by accessible name', () => {
    renderHeader();
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? ''),
    ).toEqual([
      'Move the dock',
      'Chat settings',
      'Expand dock region to workspace',
      'Hide dock region',
    ]);
  });
});
