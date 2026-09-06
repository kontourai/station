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
    pathname: '/',
  }),
}));

// A real chord string, not '': `withShortcutHint` returns the bare label for an
// empty display, so a stub of '' makes every tooltip assertion in this file
// vacuous — including the one that pins the tooltip as the channel the retired
// keycap spans left behind (#1536 F).
const SHORTCUT_DISPLAY: Record<string, string> = {
  'dock.toggle': '⌘D',
  'dock.maximize': '⌃⌘M',
};
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: (id: string) => SHORTCUT_DISPLAY[id] ?? '',
}));

import {
  ChatDockHeader,
  type ChatDockWorkspaceControls,
} from '../components/chat-dock/ChatDockHeader';

function renderHeader({
  fullscreen = false,
  chatIdentity,
  projectContext,
  workspaceControls,
  surfaceTitle,
  restoreSnap,
}: {
  fullscreen?: boolean;
  chatIdentity?: ReactNode;
  projectContext?: ReactNode;
  workspaceControls?: ChatDockWorkspaceControls;
  surfaceTitle?: string;
  restoreSnap?: 'collapsed' | 'half' | 'full';
} = {}) {
  return render(
    <ChatDockHeader
      surfaceTitle={surfaceTitle}
      restoreSnap={restoreSnap}
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
      workspaceControls={workspaceControls}
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

    fireEvent.click(screen.getByLabelText('Hide dock region'));

    expect(onDockSnap).toHaveBeenCalledWith('collapsed');
  });

  test('expanding does not invent a maximized dock when the last size was not Full', () => {
    isDockOpen = false;
    isDockMaximized = false;
    window.localStorage.setItem('station.chatDock.snap', 'half');
    renderHeader();

    fireEvent.click(screen.getByLabelText('Show dock region'));

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

    fireEvent.click(screen.getByLabelText('Show dock region'));

    expect(onDockSnap).toHaveBeenCalledWith('full');
  });

  // #1385 review: `station.chatDock.snap` is Chat's key. A non-Chat shell
  // reopens to ITS chrome's snap, so Chat having collapsed from Full cannot
  // maximize Activity when its own collapsed bar is expanded.
  test('a non-Chat shell reopens to its own snap, never to Chat’s persisted Full', () => {
    isDockOpen = false;
    isDockMaximized = false;
    window.localStorage.setItem('station.chatDock.snap', 'full');
    renderHeader({ surfaceTitle: 'Activity', restoreSnap: 'half' });

    // The accessible name is the contract; since #1552 the title also carries
    // the chord hint, the way the sibling assertions above read it.
    fireEvent.click(screen.getByLabelText('Show Activity'));

    expect(onDockSnap).toHaveBeenCalledWith('half');
    expect(onDockSnap).not.toHaveBeenCalledWith('full');
  });

  test('a non-Chat shell that collapsed from its own Full reopens Full', () => {
    isDockOpen = false;
    isDockMaximized = false;
    window.localStorage.setItem('station.chatDock.snap', 'half');
    renderHeader({ surfaceTitle: 'Activity', restoreSnap: 'full' });

    fireEvent.click(screen.getByLabelText('Show Activity'));

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

  test('the region visibility control carries an accessible name, and Chat settings is still one press', () => {
    isDockOpen = false;
    renderHeader();

    expect(screen.getByLabelText('Show dock region')).toBeTruthy();
    // #1536 F: the unlabelled gear left the bar. The command did not — and with
    // no pane open Chat settings is the ONLY folded command, so it renders as
    // its own labelled button rather than behind a ⋯ that would open a list of
    // one (D2).
    expect(
      screen.queryByRole('button', { name: /^More dock actions/ }),
    ).toBeNull();
    const settings = screen.getByRole('button', { name: 'Chat settings' });
    expect(settings.textContent).toBe('Chat settings');
    fireEvent.click(settings);
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
    // Every keycap in the bar, not just the one the retired span carried: the
    // activity dropdown's own ⌘1…⌘9 rows use this class too and are the only
    // remaining consumer, so an empty count here is only meaningful because the
    // dropdown is present but has no active sessions in this fixture.
    expect(
      container.querySelectorAll('.chat-dock__header .chat-dock__subtitle'),
    ).toHaveLength(0);
    // And the chords moved rather than vanished — the tooltip is the channel,
    // with a real display string so this cannot pass on an empty one.
    expect(screen.getByLabelText('Hide dock region').title).toBe(
      'Hide dock region (⌘D)',
    );
    // This describe's fixture opens maximized, so the extent control reads
    // Restore; the point is the same — its chord is in the tooltip.
    expect(screen.getByLabelText('Restore dock region size').title).toBe(
      'Restore dock region size (⌃⌘M)',
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

/**
 * #928 C2b deleted the dock header's occupant picker (the trigger named the
 * docked pane) with the docked-Home path it switched to. This pins the header's
 * remaining control set BY ACCESSIBLE NAME, in order, for the open desktop
 * dock, so a header that loses (or gains, or renames) a control reds here by
 * name instead of shipping as a quiet chrome regression.
 *
 * #1536 F emptied the same row from the other side, and the list carries both
 * deletions now: the unlabelled chat-settings gear and the bare ⌘D keycap left
 * with the pane commands that joined them in the More menu, and with no pane
 * open Chat settings is the only folded command — so it renders as its own
 * labelled button rather than behind a ⋯ that would open a list of one. What
 * remains is the placement grab, that one command, and the two region controls.
 *
 * Projected as aria-label OR text content, not aria-label alone: an
 * icon-only control is named by its label and a text control by its text, and
 * reading only the first scored the labelled text button as `''` — a set with a
 * hole in it still "matched" as long as the hole stayed the same size.
 */
describe('the dock header control set (#928 C2b)', () => {
  beforeEach(() => {
    setDockState.mockClear();
    onNewChat.mockClear();
    onDockSnap.mockClear();
    setShowChatSettings.mockClear();
    isDockOpen = true;
    isDockMaximized = false;
    dockMode = 'bottom';
  });

  const controlNames = () =>
    screen
      .getAllByRole('button')
      .map(
        (button) =>
          button.getAttribute('aria-label') ?? button.textContent ?? '',
      );

  test('an open bottom dock offers exactly these controls, by accessible name', () => {
    renderHeader();
    expect(controlNames()).toEqual([
      'Move the dock',
      'Chat settings',
      'Expand dock region to workspace',
      'Hide dock region',
    ]);
  });

  /**
   * The open-pane half of this set — the ⋯ replacing that single command, plus
   * the pane's Open/New pair — lives in
   * `ChatDockHeaderWorkspaceControls.test.tsx`, whose harness already mocks what
   * the lazily loaded Open/New pair needs.
   */
});
