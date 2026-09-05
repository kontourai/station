/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const setDockState = vi.fn();
const onNewChat = vi.fn();
const onDockSnap = vi.fn();
const setShowChatSettings = vi.fn();
let isDockOpen = true;
let isDockMaximized = true;
let dockMode: 'left' | 'bottom' | 'right' = 'bottom';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    isDockOpen,
    isDockMaximized,
    setDockState,
    dockMode,
    // station#520: `DockOccupantPicker` now reads `pathname` (its onChoose
    // seam) — a real string so `resolveViewFromPath` doesn't see `undefined`.
    pathname: '/',
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
        setShowChatSettings,
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
    setShowChatSettings.mockClear();
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
    setShowChatSettings.mockClear();
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

  test('the region visibility control carries an accessible name, and Chat settings is a named row of the More menu', () => {
    isDockOpen = false;
    renderHeader();

    expect(screen.getByLabelText('Show dock region')).toBeTruthy();
    // #1536 F: the gear left the bar. The command did not.
    expect(screen.queryByLabelText('Chat settings')).toBeNull();
    fireEvent.click(screen.getByLabelText('More dock actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
    expect(setShowChatSettings).toHaveBeenCalledTimes(1);
  });

  /**
   * #1536 F: the bar carried two bare keycap spans — a ⌘D beside the settings
   * gear and a ⌘M inside Maximize — as visible chrome. Every other shortcut in
   * this bar lives in its control's tooltip, which is where these are now.
   */
  test('renders no bare keycap chrome, keeping the chords in tooltips', () => {
    const { container } = renderHeader();

    expect(container.querySelector('.chat-dock__toggle-shortcut')).toBeNull();
    expect(
      container.querySelectorAll('.chat-dock__header .chat-dock__subtitle'),
    ).toHaveLength(0);
    // The chord is still announced — `useShortcutDisplay` is stubbed to '' in
    // this file, so `withShortcutHint` yields the bare label here; what this
    // pins is that the visibility control's TOOLTIP is the channel.
    expect(screen.getByLabelText('Hide dock region').title).toBe(
      'Hide dock region',
    );
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

// archive#4460: Chat's header carried no occupant switcher at all — only
// Home/Activity's `.dock-slot__header` did. `ChatDockHeader` is the SAME
// component every ambient occupant (Chat included) now renders through, so
// this is the direct proof that Chat gets the picker too, without needing
// to mount the full `ChatWorkspacePane` data-fetching stack.
describe('occupant picker (station#4460)', () => {
  beforeEach(() => {
    setDockState.mockClear();
    onNewChat.mockClear();
    onDockSnap.mockClear();
    setShowChatSettings.mockClear();
    isDockOpen = true;
    isDockMaximized = false;
    dockMode = 'bottom';
  });

  test('renders when supplied, naming the current occupant', () => {
    // archive#4460: `occupantPicker` is a PRE-RENDERED node (built
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
        regionVisible={isDockOpen}
        shellMaximized={isDockMaximized}
        occupantPicker={
          <DockOccupantPicker
            current={{ id: 'pane:builtin:chat', name: 'Chat' } as never}
            onChoose={vi.fn()}
            onChooseAsOnlyContent={vi.fn()}
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
        regionVisible={isDockOpen}
        shellMaximized={isDockMaximized}
        fullscreen
        occupantPicker={
          <DockOccupantPicker
            current={{ id: 'pane:builtin:chat', name: 'Chat' } as never}
            onChoose={vi.fn()}
            onChooseAsOnlyContent={vi.fn()}
          />
        }
      />,
    );

    expect(screen.queryByRole('button', { name: /^Docked pane:/ })).toBeNull();
  });
});
