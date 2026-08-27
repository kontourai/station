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
  }),
}));

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '',
}));

import { ChatDockHeader } from '../components/chat-dock/ChatDockHeader';
import { DockOccupantPicker } from '../workspace-panes/DockOccupantPicker';

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

    fireEvent.click(screen.getByTitle('Collapse'));

    expect(onDockSnap).toHaveBeenCalledWith('collapsed');
  });

  test('expanding does not invent a maximized dock when the last size was not Full', () => {
    isDockOpen = false;
    isDockMaximized = false;
    window.localStorage.setItem('station.chatDock.snap', 'half');
    renderHeader();

    fireEvent.click(screen.getByTitle('Expand'));

    expect(onDockSnap).toHaveBeenCalledWith('half');
  });

  // #795 review: the reopened dock takes its height from the persisted snap,
  // so expanding after a Full-height collapse used to come back full height
  // with its own Maximize button still reading "Maximize".
  test('expanding restores Maximized when the persisted size was Full', () => {
    isDockOpen = false;
    isDockMaximized = false;
    window.localStorage.setItem('station.chatDock.snap', 'full');
    renderHeader();

    fireEvent.click(screen.getByTitle('Expand'));

    expect(onDockSnap).toHaveBeenCalledWith('full');
  });
});

// #800: this label read "Start a chat" and carried a pointer cursor, but was
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

  // #800 review: the header renders unconditionally, so without an open-state
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

  test('the collapse/expand chevron and settings control carry accessible names', () => {
    isDockOpen = false;
    renderHeader();

    expect(screen.getByLabelText('Expand chat dock')).toBeTruthy();
    expect(screen.getByLabelText('Chat settings')).toBeTruthy();
  });

  test('mirrors the collapse direction for a left-side dock', () => {
    dockMode = 'left';
    isDockOpen = true;
    renderHeader();

    const collapse = screen.getByLabelText('Collapse chat dock');
    expect(collapse.querySelector('svg')?.classList).toContain('is-left-open');
  });

  test('routes explicit maximize and restore through the persisted Full/Half snap owner', () => {
    isDockOpen = true;
    isDockMaximized = false;
    renderHeader();

    fireEvent.click(screen.getByLabelText('Maximize chat dock'));
    expect(onDockSnap).toHaveBeenCalledWith('full');

    isDockMaximized = true;
    // Re-rendering represents navigation state after the snap owner applies Full.
    renderHeader();
    fireEvent.click(screen.getByLabelText('Restore chat dock'));
    expect(onDockSnap).toHaveBeenLastCalledWith('half');
  });

  test('keeps ambient dock controls out of the full-screen pane placement', () => {
    renderHeader({ fullscreen: true });

    expect(screen.queryByLabelText('Maximize chat dock')).toBeNull();
    expect(screen.queryByLabelText('Restore chat dock')).toBeNull();
    expect(screen.queryByLabelText('Collapse chat dock')).toBeNull();
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

// station#4460: Chat's header carried no occupant switcher at all — only
// Home/Activity's `.dock-slot__header` did. `ChatDockHeader` is the SAME
// component every ambient occupant (Chat included) now renders through, so
// this is the direct proof that Chat gets the picker too, without needing
// to mount the full `ChatWorkspacePane` data-fetching stack.
describe('occupant picker (station#4460)', () => {
  beforeEach(() => {
    setDockState.mockClear();
    onNewChat.mockClear();
    onDockSnap.mockClear();
    isDockOpen = true;
    isDockMaximized = false;
    dockMode = 'bottom';
  });

  test('renders when supplied, naming the current occupant', () => {
    // station#4460 review M4: `occupantPicker` is a PRE-RENDERED node (built
    // by the ambient host's lazy chunk), not `{current, onChoose}` data —
    // this test constructs the real `DockOccupantPicker` element itself,
    // the same way the host does.
    render(
      <ChatDockHeader
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
        occupantPicker={
          <DockOccupantPicker
            current={{ id: 'pane:builtin:chat', name: 'Chat' } as never}
            onChoose={vi.fn()}
          />
        }
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Docked pane: Chat' }),
    ).toBeTruthy();
  });

  test('is absent for the full-screen placement, which has no ambient occupant to switch away from', () => {
    render(
      <ChatDockHeader
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
        fullscreen
        occupantPicker={
          <DockOccupantPicker
            current={{ id: 'pane:builtin:chat', name: 'Chat' } as never}
            onChoose={vi.fn()}
          />
        }
      />,
    );

    expect(screen.queryByRole('button', { name: /^Docked pane:/ })).toBeNull();
  });
});
