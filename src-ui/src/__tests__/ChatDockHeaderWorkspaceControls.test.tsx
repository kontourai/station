/**
 * @vitest-environment jsdom
 *
 * archive#3309: the tab strip (`ChatDockTabBar`) is retired on
 * desktop and its controls fold into `ChatDockHeader` behind the optional
 * `workspaceControls` prop. These tests carry forward the strip's pinned
 * contracts (archive#1064: the chevron-affordance names and the
 * Background-tasks button behavior) against their new host, and pin the new
 * one-bar rule: no controls while the pane is collapsed.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    isDockOpen: true,
    isDockMaximized: false,
    setDockState: vi.fn(),
    dockMode: 'bottom',
  }),
}));

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '',
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => undefined,
}));

import {
  ChatDockHeader,
  type ChatDockWorkspaceControls as WorkspaceControls,
} from '../components/chat-dock/ChatDockHeader';

function workspaceControls(
  overrides: Partial<WorkspaceControls> = {},
): WorkspaceControls {
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
    ...overrides,
  };
}

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof ChatDockHeader>> = {},
) {
  const props: React.ComponentProps<typeof ChatDockHeader> = {
    chatControls: {
      sessions: [],
      unreadCount: 0,
      focusSession: vi.fn(),
      onNewChat: vi.fn(),
      setShowChatSettings: vi.fn(),
    },
    isDragging: false,
    onDockSnap: vi.fn(),
    availableDockSlotPlacements: ['left', 'bottom', 'right'],
    effectiveDockSlotPlacement: 'bottom',
    onDockPlacementChange: vi.fn(),
    regionVisible: true,
    shellMaximized: false,
    ...overrides,
  };
  return {
    ...render(<ChatDockHeader {...props} />),
    props,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

/**
 * #1536 F: these two panel toggles were icon buttons in the header row, two of
 * the thirteen controls a 40px bar was carrying. They are rows of the More menu
 * now. Their CONTRACTS — the two-state name, the state an assistive technology
 * reads, the running-count variant, the right-mode gate — are unchanged, so
 * these carry forward against the new host.
 */
function openMoreMenu() {
  fireEvent.click(screen.getByLabelText('More dock actions'));
  return screen.getByRole('menu', { name: 'More dock actions' });
}

describe('header inbox toggle (from #1064 AC1/AC2)', () => {
  test('open state renders "Collapse chat list" checked', async () => {
    const controls = workspaceControls();
    renderHeader({ workspaceControls: controls });
    openMoreMenu();

    const row = await screen.findByRole('menuitemcheckbox', {
      name: 'Collapse chat list',
    });
    expect(row.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(row);
    expect(controls.onToggleInbox).toHaveBeenCalledTimes(1);
  });

  test('collapsed state renders "Expand chat list" unchecked', async () => {
    renderHeader({
      workspaceControls: workspaceControls({ isInboxOpen: false }),
    });
    openMoreMenu();

    const row = await screen.findByRole('menuitemcheckbox', {
      name: 'Expand chat list',
    });
    expect(row.getAttribute('aria-checked')).toBe('false');
  });

  test('offers no chat-list row when showInboxToggle is false (right-mode gate)', () => {
    renderHeader({
      workspaceControls: workspaceControls({ showInboxToggle: false }),
    });
    openMoreMenu();

    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'Collapse chat list' }),
    ).toBeNull();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'Expand chat list' }),
    ).toBeNull();
    // Its neighbours are still there, so an empty menu cannot pass this.
    expect(
      screen.getByRole('menuitem', { name: 'Background tasks' }),
    ).toBeTruthy();
  });
});

describe('header background tasks button (from #1064 AC3)', () => {
  test('keeps its label and the dialog semantics its row promises', async () => {
    const controls = workspaceControls({ isBackgroundTasksOpen: true });
    renderHeader({ workspaceControls: controls });
    openMoreMenu();

    const row = await screen.findByRole('menuitem', {
      name: 'Background tasks',
    });
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(row);
    expect(controls.onToggleBackgroundTasks).toHaveBeenCalledTimes(1);
  });

  test('shows the running-count variant label when tasks are running', async () => {
    renderHeader({
      workspaceControls: workspaceControls({
        backgroundTasksRunningCount: 3,
      }),
    });
    openMoreMenu();

    expect(
      await screen.findByRole('menuitem', {
        name: 'Background tasks — 3 running',
      }),
    ).toBeTruthy();
  });

  /**
   * The sheet anchors to the control that opened it. That used to be this
   * button; it is the More menu's trigger now, and an unpopulated ref sends
   * `ResponsiveDialogSurface` to its un-anchored fallback — a silently
   * mispositioned sheet, not an error.
   */
  test('adopts the caller\u2019s trigger ref so the sheet still anchors to the control that opened it', () => {
    const controls = workspaceControls();
    renderHeader({ workspaceControls: controls });

    expect(controls.backgroundTasksTriggerRef.current).toBe(
      screen.getByLabelText('More dock actions'),
    );
  });
});

describe('one-bar rule (#3309)', () => {
  test('Open/New live in the header while the pane is open', async () => {
    const controls = workspaceControls();
    renderHeader({ workspaceControls: controls });

    fireEvent.click(await screen.findByTitle('Open Conversation'));
    expect(controls.onOpenConversation).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByTitle('New Chat'));
    expect(controls.onNewChat).toHaveBeenCalledTimes(1);
  });

  test('keeps left workspace controls before identity and Open/New in right actions', async () => {
    renderHeader({
      chatIdentity: <span data-testid="chat-identity">Identity</span>,
      workspaceControls: workspaceControls(),
    });
    const header = document.querySelector('.chat-dock__header')!;
    const left = header.querySelector('.chat-dock__title')!;
    const right = header.querySelector('.chat-dock__header-actions')!;
    expect(left.contains(await screen.findByTitle('Open Conversation'))).toBe(
      false,
    );
    expect(left.contains(screen.getByTestId('chat-identity'))).toBe(true);
    expect(right.contains(await screen.findByTitle('Open Conversation'))).toBe(
      true,
    );
    expect(right.contains(screen.getByTitle('New Chat'))).toBe(true);
    // #1536 F: the folded commands' one control belongs to the actions cluster
    // too, not to the identity's side of the bar.
    expect(right.contains(screen.getByLabelText('More dock actions'))).toBe(
      true,
    );
  });

  test('a collapsed pane offers none of the workspace controls', () => {
    renderHeader();
    openMoreMenu();

    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'Collapse chat list' }),
    ).toBeNull();
    expect(
      screen.queryByRole('menuitem', { name: 'Background tasks' }),
    ).toBeNull();
    expect(screen.queryByTitle('Open Conversation')).toBeNull();
    expect(screen.queryByTitle('New Chat')).toBeNull();
    // Chat settings is the dock's own command, not the pane's, so it survives
    // a collapse — which is also what keeps the menu from being empty here.
    expect(
      screen.getByRole('menuitem', { name: 'Chat settings' }),
    ).toBeTruthy();
  });

  /**
   * #1536 F: "1 session" is the state you are always in with one chat open — a
   * count that never counts anything, in a bar that could not fit the
   * conversation's own title. The rail enumerates sessions either way.
   */
  test('shows no session count for a single session, and a real one above that', () => {
    const session = (id: string) => ({ id, title: id, status: 'idle' });

    const { unmount } = renderHeader({
      chatControls: {
        sessions: [session('a')],
        unreadCount: 0,
        focusSession: vi.fn(),
        onNewChat: vi.fn(),
        setShowChatSettings: vi.fn(),
      },
    });
    expect(document.querySelector('.chat-dock__counter')).toBeNull();
    unmount();

    renderHeader({
      chatControls: {
        sessions: [session('a'), session('b')],
        unreadCount: 0,
        focusSession: vi.fn(),
        onNewChat: vi.fn(),
        setShowChatSettings: vi.fn(),
      },
    });
    expect(document.querySelector('.chat-dock__counter')?.textContent).toBe(
      '2 sessions',
    );
  });

  /**
   * The zero case is a CTA, not a count, and it has two forms — a real button
   * while the pane is collapsed (archive#800) and inert text once the body's
   * own CTA is on screen. Neither is what the count rule above removed.
   */
  test('keeps the empty-state CTA, which is not a count', () => {
    renderHeader({ regionVisible: false });
    expect(screen.getByRole('button', { name: 'Start a chat' })).toBeTruthy();
  });

  test('renders the context meter beside identity when supplied', () => {
    renderHeader({
      contextMeter: <span data-testid="meter">42%</span>,
    });
    expect(screen.getByTestId('meter')).toBeTruthy();
    expect(document.querySelector('.chat-dock__header-meter')).not.toBeNull();
  });
});
