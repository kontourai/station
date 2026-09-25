/**
 * @vitest-environment jsdom
 */

import { fireEvent, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type ChatDockMobileDockToggle,
  ChatDockMobileHeader,
  type ChatDockMobileProjectSwitcher,
} from '../components/chat-dock/ChatDockMobileHeader';
import { renderWithIsolatedConnections } from './renderWithIsolatedConnections';

// The sheet's project picker and connection control mount inside this bar's
// tree; `useIsMobile`/`useNavigation` are mocked so neither needs a real
// `matchMedia` breakpoint or router.
const mobileFlag = vi.hoisted(() => ({ isMobile: false }));
vi.mock('../hooks/useIsMobile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useIsMobile')>();
  return { ...actual, useIsMobile: () => mobileFlag.isMobile };
});
const pathnameFlag = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    get pathname() {
      return pathnameFlag.pathname;
    },
  }),
}));

// archive#3297 put a live connection indicator in this bar, so the header now
// mounts through the same connection boundary the app uses. Nothing here
// asserts on probe results; the stub only keeps the shared health coordinator
// from reaching the network.
beforeEach(() => {
  mobileFlag.isMobile = false;
  pathnameFlag.pathname = '/';
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

const PROJECTS = [
  {
    id: 'p-kontour',
    slug: 'kontour-ai',
    name: 'Kontour AI',
    hasWorkingDirectory: false,
    layoutCount: 0,
    hasKnowledge: false,
  },
];

function renderHeader(
  overrides: {
    onClear?: ReturnType<typeof vi.fn<() => void>>;
    onNewChat?: ReturnType<typeof vi.fn<() => void>>;
    onOpenTaskSwitcher?: ReturnType<typeof vi.fn<() => void>>;
    projectSwitcher?: ChatDockMobileProjectSwitcher | null;
    dockToggle?: ChatDockMobileDockToggle | null;
    projectScope?: { name: string; onClear: () => void } | null;
    agentIdentity?: { name: string; slug: string; icon?: string } | null;
    branchLabel?: string | null;
    onOpenProject?: (() => void) | null;
    openProjectName?: string | null;
    showConnection?: boolean;
    regionPanes?: { id: string; title: string; selected: boolean }[];
    onSelectRegionPane?: ReturnType<typeof vi.fn<(id: string) => void>>;
    onOpenBackgroundTasks?: ReturnType<typeof vi.fn<() => void>>;
    backgroundTasksRunningCount?: number;
  } = {},
) {
  const onClear = overrides.onClear ?? vi.fn<() => void>();
  renderWithIsolatedConnections(
    <ChatDockMobileHeader
      showDrawerToggle={false}
      showConnection={overrides.showConnection ?? true}
      sessionTitle="New chat"
      projectScope={
        overrides.projectScope === null
          ? undefined
          : (overrides.projectScope ?? { name: 'Kontour AI', onClear })
      }
      dockToggle={
        overrides.dockToggle !== undefined
          ? overrides.dockToggle
          : {
              state: 'open',
              onExpand: vi.fn(),
              onCollapse: vi.fn(),
            }
      }
      projectSwitcher={
        overrides.projectSwitcher !== undefined
          ? overrides.projectSwitcher
          : {
              projectSlug: 'kontour-ai',
              projectName: 'Kontour AI',
              projects: PROJECTS,
              onOpenProject: vi.fn(),
              onSwitchProject: vi.fn(),
            }
      }
      agentIdentity={
        overrides.agentIdentity !== undefined
          ? overrides.agentIdentity
          : { name: 'Codex', slug: 'codex' }
      }
      branchLabel={overrides.branchLabel ?? null}
      activeCount={0}
      unreadCount={0}
      taskSwitcherTriggerRef={createRef<HTMLButtonElement>()}
      onOpenTaskSwitcher={overrides.onOpenTaskSwitcher ?? vi.fn()}
      onToggleSidebar={vi.fn()}
      onDragPointerDown={vi.fn()}
      onDragClickCapture={vi.fn()}
      onNewChat={overrides.onNewChat ?? vi.fn()}
      overflow={{
        onOpenConversation: vi.fn(),
        onToggleHistory: vi.fn(),
        onOpenChatSettings: vi.fn(),
        onOpenProject: overrides.onOpenProject ?? null,
        openProjectName: overrides.openProjectName ?? null,
        onOpenProfile: vi.fn(),
        onOpenAppSettings: vi.fn(),
        onCollapseDock: vi.fn(),
        onExpandDock: vi.fn(),
        onRestoreDock: vi.fn(),
        isDockMaximized: false,
        regionPanes: overrides.regionPanes,
        onSelectRegionPane: overrides.onSelectRegionPane,
        onOpenBackgroundTasks: overrides.onOpenBackgroundTasks,
        backgroundTasksRunningCount: overrides.backgroundTasksRunningCount,
      }}
    />,
  );
  return onClear;
}

// Component tests own action wiring; browser smoke owns lazy-chunk loading.
// Resolve the large lazy modules before assertion timeouts start.
beforeAll(async () => {
  await Promise.all([
    import('../components/chat-dock/ChatDockMobileOverflowSheet'),
    import('../components/chat-dock/ChatDockProjectSwitcherSheet'),
  ]);
});

async function openActions() {
  fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
  await screen.findByRole('menu');
  return screen.getByRole('dialog', { name: 'Chat actions' });
}

describe('mobile conversation focus', () => {
  test('keeps project and conversation switching directly reachable with readable context', () => {
    const onOpenTaskSwitcher = vi.fn();
    renderHeader({
      onOpenTaskSwitcher,
    });
    const identity = screen.getByRole('button', { name: /^Switch task/ });
    expect(identity.textContent).toContain('New chat');
    expect(identity.textContent).toContain('Codex');
    // The visible title ellipsizes on narrow widths; the full text rides
    // along for hover, long-press, and assistive tech.
    expect(
      identity
        .querySelector('.chat-dock__mobile-title-text')
        ?.getAttribute('title'),
    ).toBe('New chat');
    fireEvent.click(identity);
    expect(onOpenTaskSwitcher).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: 'Switch project — Kontour AI' })
        .textContent,
    ).toContain('Kontour AI');
    expect(screen.getByRole('button', { name: 'Chat actions' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^Switch project/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Switch task/ })).toBeTruthy();
  });
  test('keeps New chat callable from the actions sheet', async () => {
    const onNewChat = vi.fn();
    renderHeader({ onNewChat });
    await openActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });
  test('chat overflow is chats and dock chrome, not Profile or a second conversation list', async () => {
    renderHeader();
    await openActions();
    expect(screen.getByRole('menuitem', { name: 'Chats' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'New chat' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Profile' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).toBeNull();
    expect(
      screen.queryByRole('menuitem', { name: 'Open conversation' }),
    ).toBeNull();
    expect(
      screen.queryByRole('menuitem', { name: 'Session inventory' }),
    ).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Activity' })).toBeNull();
  });
  test('keeps project scope and branch context in the sheet', async () => {
    const onClear = renderHeader({ branchLabel: 'feature/chat' });
    await openActions();
    expect(screen.getByText('feature/chat')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Clear project chat scope' }),
    );
    expect(onClear).toHaveBeenCalledOnce();
  });
  test('opens the shared project picker and preserves project action wiring', async () => {
    const onOpenProject = vi.fn();
    renderHeader({
      projectSwitcher: {
        projectSlug: 'kontour-ai',
        projectName: 'Kontour AI',
        projects: PROJECTS,
        onOpenProject,
        onSwitchProject: vi.fn(),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Switch project/ }));
    await screen.findByRole('dialog', { name: 'Switch project' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Kontour AI' }));
    expect(onOpenProject).toHaveBeenCalledWith('kontour-ai');
  });
  test('opening a project preserves the active conversation binding', async () => {
    const onOpenProject = vi.fn();
    const onSwitchProject = vi.fn();
    renderHeader({
      projectSwitcher: {
        projectSlug: 'kontour-ai',
        projectName: 'Kontour AI',
        projects: PROJECTS,
        onOpenProject,
        onSwitchProject,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Switch project/ }));
    await screen.findByRole('dialog', { name: 'Switch project' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Kontour AI' }));
    expect(onOpenProject).toHaveBeenCalledWith('kontour-ai');
    expect(onSwitchProject).not.toHaveBeenCalled();
  });
  test('shows live connection state and a visible management label on request', async () => {
    renderHeader();
    await openActions();
    const indicator = screen.getByTestId('chat-dock-mobile-connection');
    expect(indicator.dataset.connectionState).toBeTruthy();
    expect(indicator.textContent).toBeTruthy();
    const listener = vi.fn();
    window.addEventListener('station:open-connections-modal', listener);
    fireEvent.click(indicator);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('station:open-connections-modal', listener);
  });
  test('does not duplicate connection management while the app toolbar owns it', async () => {
    renderHeader({ showConnection: false });
    await openActions();
    expect(screen.queryByTestId('chat-dock-mobile-connection')).toBeNull();
  });
  test('collapsed dock can expand without a gesture', () => {
    const onExpand = vi.fn();
    renderHeader({
      dockToggle: { state: 'collapsed', onExpand, onCollapse: vi.fn() },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand chat' }));
    expect(onExpand).toHaveBeenCalledOnce();
  });
  test('does not invent attribution or geometry for an unbound fullscreen pane', () => {
    renderHeader({
      agentIdentity: null,
      dockToggle: null,
      projectSwitcher: null,
    });
    expect(
      screen.getByRole('button', { name: 'Switch task' }).textContent,
    ).toBe('New chat');
    expect(screen.queryByRole('button', { name: 'Collapse chat' })).toBeNull();
  });
});

/** #928 C2b retires occupant switching; primary context actions remain direct. */
describe('the mobile dock bar control set (#928 C2b)', () => {
  test('an open bar exposes navigation, primary context actions, and secondary actions', () => {
    renderHeader();
    for (const name of [
      'Collapse chat',
      'Switch project — Kontour AI',
      'Switch task — Codex',
      'Chat actions',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  test('the ⋯ sheet offers no occupant switch item', async () => {
    renderHeader();
    await openActions();
    await screen.findByRole('menuitem', { name: 'Chat settings' });
    expect(screen.queryByRole('menuitem', { name: /^Switch to/ })).toBeNull();
  });

  /**
   * #2046 2b: a coarse device has no tab strip, so the sheet is where a pane
   * sharing Chat's region is switched to — one row per OTHER pane, from the
   * chrome's `regionPanes` (D2). The selected pane (Chat, here) gets no row:
   * a "switch to" the pane on screen would be a control that does nothing.
   * Reverting the rows fails the first assertion; listing every pane fails
   * the second.
   */
  test('the ⋯ sheet lists the region’s other panes as switch rows', async () => {
    const onSelectRegionPane = vi.fn<(id: string) => void>();
    renderHeader({
      regionPanes: [
        { id: 'chat', title: 'Chat', selected: true },
        { id: 'activity', title: 'Activity', selected: false },
      ],
      onSelectRegionPane,
    });
    await openActions();
    const row = await screen.findByRole('menuitem', {
      name: 'Switch to Activity',
    });
    expect(
      screen.queryByRole('menuitem', { name: 'Switch to Chat' }),
    ).toBeNull();
    fireEvent.click(row);
    expect(onSelectRegionPane).toHaveBeenCalledWith('activity');
    // The sheet closes with the switch, as every row does.
    expect(screen.queryByRole('dialog', { name: 'Chat actions' })).toBeNull();
  });
});

/**
 * #2510: on a phone the dock's desktop "Background tasks" row does not
 * render, so the ⋯ sheet carries it. The row calls the handler ChatDock
 * routes through `showBackgroundTasks` (the sheet on a bottom-only device)
 * and carries the desktop row's label shape. Removing the row fails the
 * first two tests; rendering it with no handler fails the third.
 */
describe('the ⋯ sheet’s Background tasks row (#2510)', () => {
  test('names the running count and opens background tasks', async () => {
    const onOpenBackgroundTasks = vi.fn<() => void>();
    renderHeader({ onOpenBackgroundTasks, backgroundTasksRunningCount: 2 });
    await openActions();
    const row = await screen.findByRole('menuitem', {
      name: 'Background tasks — 2 running',
    });
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(row);
    expect(onOpenBackgroundTasks).toHaveBeenCalledOnce();
    // The sheet dismisses itself so the Background tasks sheet is on top.
    expect(screen.queryByRole('dialog', { name: 'Chat actions' })).toBeNull();
  });
  test('reads plainly when nothing is running', async () => {
    renderHeader({
      onOpenBackgroundTasks: vi.fn<() => void>(),
      backgroundTasksRunningCount: 0,
    });
    await openActions();
    expect(
      await screen.findByRole('menuitem', { name: 'Background tasks' }),
    ).toBeTruthy();
  });
  test('offers no row without a handler to open the surface', async () => {
    renderHeader();
    await openActions();
    await screen.findByRole('menuitem', { name: 'Chat settings' });
    expect(
      screen.queryByRole('menuitem', { name: /^Background tasks/ }),
    ).toBeNull();
  });
});
