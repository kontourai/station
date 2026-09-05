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
  // By prefix: the trigger's name carries a running-task count when there is
  // one (M2), so an exact match would silently stop finding it.
  fireEvent.click(screen.getByRole('button', { name: /^More dock actions/ }));
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
   * M2: folding this row into the menu took its running-count badge off the bar
   * with it, and a count that exists only inside a CLOSED menu is not a signal —
   * nothing on screen said work was running. It rides the trigger now, in both
   * channels: a painted badge and the trigger's own accessible name (the badge
   * is `aria-hidden`, so the name is what a screen reader gets).
   */
  test('surfaces the running count on the closed menu’s trigger, in both channels', () => {
    renderHeader({
      workspaceControls: workspaceControls({
        backgroundTasksRunningCount: 3,
      }),
    });

    const trigger = screen.getByRole('button', {
      name: 'More dock actions — 3 background tasks running',
    });
    expect(trigger.querySelector('.chat-dock__more-badge')?.textContent).toBe(
      '3',
    );
    // Closed: the count is readable without opening anything.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('a single running task is not pluralised, and zero shows no badge at all', () => {
    const { unmount } = renderHeader({
      workspaceControls: workspaceControls({
        backgroundTasksRunningCount: 1,
      }),
    });
    expect(
      screen.getByRole('button', {
        name: 'More dock actions — 1 background task running',
      }),
    ).toBeTruthy();
    unmount();

    renderHeader({ workspaceControls: workspaceControls() });
    const trigger = screen.getByRole('button', { name: 'More dock actions' });
    // An empty "0" is worse than nothing.
    expect(trigger.querySelector('.chat-dock__more-badge')).toBeNull();
  });

  /**
   * M1: the inventory's host arrives with a lazily loaded chunk and can fail to
   * arrive at all. `toggleSessionInventoryOccurrence` refuses without its
   * registration, and the header used to discard that boolean — so the row
   * looked pressable and silently did nothing. It is disabled until the
   * registration exists, derived from the registration itself.
   */
  test('the session inventory row refuses to look pressable before its host registers', () => {
    renderHeader({
      workspaceControls: workspaceControls({
        sessionInventory: {
          hostId: 'session-inventory:test',
          chatStoreId: 'chat-1',
          executionId: 'exec-1',
          executionRead: 'present',
          mountRef: createRef<HTMLDivElement>(),
          dockMode: 'bottom',
          fullscreen: false,
        },
      }),
    });
    openMoreMenu();

    // The label says why, rather than leaving a dead row to guess at. The host
    // never registers here: this suite's `useHostRequestAuthorityScope` stub
    // returns undefined, which is also the real "no authority yet" case.
    const row = screen.getByRole('menuitem', {
      name: 'Session inventory — loading',
    });
    expect(row.hasAttribute('disabled')).toBe(true);
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

    expect(screen.queryByTitle('Open Conversation')).toBeNull();
    expect(screen.queryByTitle('New Chat')).toBeNull();
    // With every pane command gone, Chat settings — the dock's own command, not
    // the pane's — is the only one left to fold, so there is no ⋯ at all and it
    // renders inline (D2). That is also why the two rows below are absent from
    // a menu that no longer exists.
    expect(
      screen.queryByRole('button', { name: /^More dock actions/ }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Chat settings' })).toBeTruthy();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'Collapse chat list' }),
    ).toBeNull();
    expect(
      screen.queryByRole('menuitem', { name: 'Background tasks' }),
    ).toBeNull();
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

  /**
   * H3: the two early returns in `ChatDockHeaderMoreMenu` (no rows, one row
   * rendered inline) unmount the portal without clearing the open state. A
   * collapse takes every pane command away and leaves Chat settings alone, so
   * the real 3→1→3 sequence — ⌘D with the menu open, then re-expand — used to
   * come back with a menu nobody pressed, anchored to a rect measured before the
   * collapse. Driven through the real component, because the defect is in the
   * interaction between its state and its branches, not in either alone.
   */
  test('collapsing with the menu open does not re-open it on the way back', async () => {
    const controls = workspaceControls();
    const { rerender, props } = renderHeader({ workspaceControls: controls });

    openMoreMenu();
    expect(
      screen.getByRole('menu', { name: 'More dock actions' }),
    ).toBeTruthy();

    // The collapse: `ChatDock` stops passing `workspaceControls` while the pane
    // is closed, which leaves Chat settings as the only folded command.
    rerender(<ChatDockHeader {...props} workspaceControls={undefined} />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Chat settings' })).toBeTruthy();

    // And back. Nothing pressed the trigger, so nothing should be open.
    rerender(<ChatDockHeader {...props} workspaceControls={controls} />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: /^More dock actions/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  /**
   * The open-pane half of #928 C2b's control-set pin (the collapsed half is in
   * `ChatDockHeaderCollapse.test.tsx`). Two deletions meet in this row —
   * C2b's occupant picker and #1536 F's gear plus two keycaps — and "one
   * control per state" is what five buttons were traded for, so the set is
   * pinned by accessible name rather than left to be eroded a control at a time.
   *
   * aria-label OR text content: an icon-only control is named by its label and a
   * text control by its text.
   */
  test('an open pane offers exactly these controls, by accessible name', async () => {
    renderHeader({ workspaceControls: workspaceControls() });
    await screen.findByTitle('Open Conversation');

    expect(
      screen
        .getAllByRole('button')
        .map(
          (button) =>
            button.getAttribute('aria-label') ?? button.textContent ?? '',
        ),
    ).toEqual([
      'Move the dock',
      // Open/New are labelled by their visible text; their chords are in the
      // tooltips ("Open Conversation", "New Chat"), which is where every
      // shortcut in this bar lives since #1536 F retired the keycap spans.
      'Open',
      'New',
      'More dock actions',
      'Expand dock region to workspace',
      'Hide dock region',
    ]);
    // The gear is a row of that one menu now, not a control of its own.
    expect(screen.queryByRole('button', { name: 'Chat settings' })).toBeNull();
  });

  test('renders the context meter beside identity when supplied', () => {
    renderHeader({
      contextMeter: <span data-testid="meter">42%</span>,
    });
    expect(screen.getByTestId('meter')).toBeTruthy();
    expect(document.querySelector('.chat-dock__header-meter')).not.toBeNull();
  });
});
