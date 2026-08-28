/**
 * @vitest-environment jsdom
 *
 * kontourai/station#3309: the tab strip (`ChatDockTabBar`) is retired on
 * desktop and its controls fold into `ChatDockHeader` behind the optional
 * `workspaceControls` prop. These tests carry forward the strip's pinned
 * contracts (station#1064 slice B: the chevron-affordance names and the
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

import {
  ChatDockHeader,
  type ChatDockWorkspaceControls,
} from '../components/chat-dock/ChatDockHeader';
import { ChatDockWorkspaceChrome } from '../components/chat-dock/ChatDockWorkspaceControls';

function workspaceControls(
  overrides: Partial<ChatDockWorkspaceControls> = {},
): ChatDockWorkspaceControls {
  return {
    showInboxToggle: true,
    isInboxOpen: true,
    onToggleInbox: vi.fn(),
    backgroundTasksTriggerRef: createRef<HTMLButtonElement>(),
    backgroundTasksRunningCount: 0,
    isBackgroundTasksOpen: false,
    onToggleBackgroundTasks: vi.fn(),
    isSessionInventoryOpen: false,
    sessionInventoryControlsId: 'session-inventory-test',
    onToggleSessionInventory: vi.fn(),
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
    ...overrides,
  };
  const controls = props.workspaceControls;
  return {
    ...render(
      <>
        <ChatDockHeader {...props} workspaceControls={undefined} />
        {controls ? <ChatDockWorkspaceChrome {...controls} /> : null}
      </>,
    ),
    props,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('header inbox toggle (from #1064 AC1/AC2)', () => {
  test('open state renders "Collapse chat list" with aria-pressed=true', async () => {
    renderHeader({ workspaceControls: workspaceControls() });

    const toggle = await screen.findByRole('button', {
      name: 'Collapse chat list',
    });
    expect(toggle.getAttribute('title')).toBe('Collapse chat list');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.className).toContain('chat-dock__inbox-toggle');
  });

  test('collapsed state renders "Expand chat list" with aria-pressed=false', async () => {
    renderHeader({
      workspaceControls: workspaceControls({ isInboxOpen: false }),
    });

    const toggle = await screen.findByRole('button', {
      name: 'Expand chat list',
    });
    expect(toggle.getAttribute('title')).toBe('Expand chat list');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  test('renders no inbox toggle when showInboxToggle is false (right-mode gate)', () => {
    renderHeader({
      workspaceControls: workspaceControls({ showInboxToggle: false }),
    });

    expect(
      screen.queryByRole('button', { name: 'Collapse chat list' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Expand chat list' }),
    ).toBeNull();
  });
});

describe('header background tasks button (from #1064 AC3)', () => {
  test('keeps its label, aria-haspopup/aria-expanded, and the shared shell class', async () => {
    renderHeader({
      workspaceControls: workspaceControls({ isBackgroundTasksOpen: true }),
    });

    const button = await screen.findByRole('button', {
      name: 'Background tasks',
    });
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.className).toContain('chat-dock__inbox-toggle');
    expect(button.className).toContain('is-active');
  });

  test('shows the running-count variant label and badge when tasks are running', async () => {
    renderHeader({
      workspaceControls: workspaceControls({
        backgroundTasksRunningCount: 3,
      }),
    });

    expect(
      await screen.findByRole('button', {
        name: 'Background tasks — 3 running',
      }),
    ).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
});

describe('header Session inventory toggle', () => {
  test('exposes its real open state and controls relationship without claiming a popup', async () => {
    const controls = workspaceControls({ isSessionInventoryOpen: true });
    renderHeader({ workspaceControls: controls });

    const button = await screen.findByRole('button', {
      name: 'Session inventory',
    });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe('session-inventory-test');
    expect(button.hasAttribute('aria-haspopup')).toBe(false);
    fireEvent.click(button);
    expect(controls.onToggleSessionInventory).toHaveBeenCalledWith(button);
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

  test('a collapsed pane renders none of the workspace controls', () => {
    renderHeader();

    expect(
      screen.queryByRole('button', { name: 'Collapse chat list' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Background tasks' }),
    ).toBeNull();
    expect(screen.queryByTitle('Open Conversation')).toBeNull();
    expect(screen.queryByTitle('New Chat')).toBeNull();
  });

  test('renders the context meter beside identity when supplied', () => {
    renderHeader({
      contextMeter: <span data-testid="meter">42%</span>,
    });
    expect(screen.getByTestId('meter')).toBeTruthy();
    expect(document.querySelector('.chat-dock__header-meter')).not.toBeNull();
  });
});
