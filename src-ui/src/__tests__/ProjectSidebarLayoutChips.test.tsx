/**
 * @vitest-environment jsdom
 */

/**
 * #2063 (design record D3): a project's layouts are a chip row under the
 * project name, not a nested tree.
 *
 * Everything here drives the REAL `ProjectSidebar` composition — the same
 * mock shape as `ProjectSidebar.test.tsx` — because the claims under test are
 * about what a reader reaches from the panel: the chip row's accessible name,
 * its single tab stop, which chip is announced as current, and where the Chat
 * chip goes. A harness that mounted `ProjectLayoutChips` alone could satisfy
 * all four while the sidebar never rendered a chip.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));
vi.mock('../build-info', () => ({
  buildInfo: { version: '0.1.2', commit: 'test' },
}));

const {
  navState,
  navListeners,
  layouts,
  boardAvailability,
  navigate,
  setProject,
  setLayout,
} = vi.hoisted(() => ({
  navState: {
    selectedProject: null as string | null,
    selectedProjectLayout: null as string | null,
    pathname: '/',
  },
  /**
   * The navigation mock is a real subscription, not a per-render read, because
   * `ProjectSidebar` is `memo`'d with no props: re-rendering its element from a
   * test bails out of the memo, so a route change is only observable the way
   * the app makes it observable — the store notifying its subscribers.
   */
  navListeners: new Set<() => void>(),
  layouts: { data: [] as Array<Record<string, unknown>> },
  boardAvailability: {
    data: undefined as { hasBuilderRun: boolean } | undefined,
  },
  navigate: vi.fn(),
  setProject: vi.fn(),
  setLayout: vi.fn(),
}));

const PROJECTS = [{ id: 'p1', slug: 'demo', name: 'Demo' }];

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: PROJECTS, isLoading: false }),
}));
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => ({}),
}));
vi.mock('../contexts/open-chats-store', () => ({
  useOpenChats: () => [],
  openChatsStore: {
    focus: vi.fn(),
    openCollection: vi.fn(),
    registerNavigation: () => vi.fn(),
  },
}));
vi.mock('../contexts/NavigationContext', async () => {
  const { useSyncExternalStore } =
    await vi.importActual<typeof import('react')>('react');
  const subscribe = (onChange: () => void) => {
    navListeners.add(onChange);
    return () => navListeners.delete(onChange);
  };
  const routeSnapshot = () =>
    `${navState.selectedProject}|${navState.selectedProjectLayout}|${navState.pathname}`;
  const navigation = () => ({
    selectedProject: navState.selectedProject,
    selectedProjectLayout: navState.selectedProjectLayout,
    pathname: navState.pathname,
    navigate,
    setProject,
    setLayout,
  });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => {
      useSyncExternalStore(subscribe, routeSnapshot);
      return selector ? selector(navigation()) : navigation();
    },
    useNavigationActions: navigation,
  };
});

/** A route change from anywhere that is not this chip row. */
function routeTo(layoutSlug: string) {
  act(() => {
    navState.selectedProjectLayout = layoutSlug;
    navState.pathname = `/projects/demo/layouts/${layoutSlug}`;
    for (const listener of navListeners) listener();
  });
}
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => ({ appName: 'Station' }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({ data: [] }),
  useProjectLayoutsQuery: () => layouts,
  useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
  useFeaturePreviewsQuery: () => ({ data: [] }),
  useBoardAvailabilityQuery: () => boardAvailability,
  useAttentionQuery: () => ({ data: { pendingCount: 0 } }),
}));

import { rendersChatWorkspaceLayout } from '../app-shell/project-layout-kind';
import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { deviceSettingsStore } from '../lib/device-settings-store';

/**
 * The fixture the Chat chip is built from. Declared as the layout record the
 * server returns so the assertion below can hand the SAME object to
 * `rendersChatWorkspaceLayout` — the derivation App suspends the ambient
 * regions on. A fixture typed 'chat' that the derivation rejected would make
 * the routing assertion below prove nothing about the chat placement.
 */
const CHAT_LAYOUT = { slug: 'chat', name: 'Chat', type: 'chat' };
const CODING_LAYOUT = { slug: 'code', name: 'Coding', type: 'coding' };
const TASKS_LAYOUT = { slug: 'tasks', name: 'Tasks', type: 'tasks' };

function renderSidebar(ui: ReactElement) {
  return render(<KeyboardShortcutsProvider>{ui}</KeyboardShortcutsProvider>);
}

function chipRow() {
  return screen.getByRole('toolbar', { name: 'Demo layouts' });
}

function chip(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

describe('project layout chips in the real sidebar (#2063)', () => {
  beforeEach(() => {
    navState.selectedProject = 'demo';
    navState.selectedProjectLayout = null;
    navState.pathname = '/projects/demo';
    layouts.data = [CODING_LAYOUT, TASKS_LAYOUT, CHAT_LAYOUT];
    boardAvailability.data = { hasBuilderRun: false };
    navigate.mockClear();
    setProject.mockClear();
    setLayout.mockClear();
    window.localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
  });

  test('the layouts render as one labelled chip row naming their project', () => {
    renderSidebar(<ProjectSidebar />);

    const row = chipRow();
    // The label names the project, so a reader landing on the row from
    // anywhere in a panel of several projects knows whose layouts these are.
    expect(row.getAttribute('aria-label')).toBe('Demo layouts');
    expect(
      Array.from(row.querySelectorAll('button')).map((b) => b.textContent),
    ).toEqual(['Coding', 'Tasks', 'Chat']);
  });

  test('the nested layout tree and its expand control are gone', () => {
    const { container } = renderSidebar(<ProjectSidebar />);

    expect(container.querySelector('.sidebar__layouts')).toBeNull();
    expect(container.querySelector('.sidebar__layout-btn')).toBeNull();
    expect(container.querySelector('.sidebar__chevron')).toBeNull();
    expect(screen.queryByRole('button', { name: /Demo layouts$/ })).toBeNull();
  });

  test('the row is one tab stop and arrow keys move between the chips', () => {
    renderSidebar(<ProjectSidebar />);

    // Exactly one chip is tabbable; the rest are reachable only by arrowing.
    const tabbable = Array.from(chipRow().querySelectorAll('button')).filter(
      (button) => button.tabIndex === 0,
    );
    expect(tabbable.map((button) => button.textContent)).toEqual(['Coding']);

    chip('Coding').focus();
    fireEvent.keyDown(chipRow(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(chip('Tasks'));
    expect(chip('Tasks').tabIndex).toBe(0);
    expect(chip('Coding').tabIndex).toBe(-1);

    fireEvent.keyDown(chipRow(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(chip('Coding'));

    // Wrapping, so End/Home are not the only way to the ends.
    fireEvent.keyDown(chipRow(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(chip('Chat'));

    fireEvent.keyDown(chipRow(), { key: 'Home' });
    expect(document.activeElement).toBe(chip('Coding'));
    fireEvent.keyDown(chipRow(), { key: 'End' });
    expect(document.activeElement).toBe(chip('Chat'));
  });

  test('the routed layout is announced as current and holds the tab stop', () => {
    navState.selectedProjectLayout = 'tasks';
    navState.pathname = '/projects/demo/layouts/tasks';
    renderSidebar(<ProjectSidebar />);

    expect(chip('Tasks').getAttribute('aria-current')).toBe('page');
    expect(chip('Coding').getAttribute('aria-current')).toBeNull();
    expect(chip('Chat').getAttribute('aria-current')).toBeNull();
    // Tab lands on the layout the reader is looking at, not on the first chip.
    expect(chip('Tasks').tabIndex).toBe(0);
    expect(chip('Coding').tabIndex).toBe(-1);
  });

  /**
   * The moved tab stop is the reader's, but it describes where they are, and
   * the route can move without them touching the row — the header's layout
   * picker, the command palette, a link. If a stale moved stop kept winning,
   * Tab would land on the layout the reader arrowed past some navigations ago
   * while a different chip was announced as current, which is the opposite of
   * the claim the test above makes.
   */
  test('the tab stop follows the current layout when the route changes elsewhere', () => {
    navState.selectedProjectLayout = 'code';
    navState.pathname = '/projects/demo/layouts/code';
    renderSidebar(<ProjectSidebar />);

    // The reader arrows away from the routed chip, taking the stop with them.
    chip('Coding').focus();
    fireEvent.keyDown(chipRow(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(chip('Tasks'));
    expect(chip('Tasks').tabIndex).toBe(0);

    // Now the app routes to Chat by some other means entirely — no click and
    // no key reaches this row, only a new current chip.
    routeTo('chat');

    expect(chip('Chat').getAttribute('aria-current')).toBe('page');
    expect(
      Array.from(chipRow().querySelectorAll('button'))
        .filter((button) => button.tabIndex === 0)
        .map((button) => button.textContent),
    ).toEqual(['Chat']);
  });

  /**
   * The acceptance claim: Chat is one chip, and selecting it reaches the same
   * place the nested Chat row reached — `setLayout(project, layout)`, which
   * routes to `/projects/demo/layouts/chat`. The ambient-region suspension in
   * App is derived from the layout that route resolves to, so binding the
   * chip's target to `rendersChatWorkspaceLayout` is what makes this a claim
   * about the chat placement rather than about a string.
   */
  test('the Chat chip selects the chat layout, the one App suspends ambient regions for', () => {
    renderSidebar(<ProjectSidebar />);

    fireEvent.click(chip('Chat'));

    expect(setLayout).toHaveBeenCalledWith('demo', 'chat');
    // Not the project page, and not a route composed here.
    expect(setProject).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(rendersChatWorkspaceLayout(CHAT_LAYOUT)).toBe(true);
  });

  test('a plain layout chip selects its own layout', () => {
    renderSidebar(<ProjectSidebar />);

    fireEvent.click(chip('Coding'));
    expect(setLayout).toHaveBeenCalledWith('demo', 'code');
  });

  /** The synthesized Board entry keeps its place, now as a chip. */
  test('the Board shortcut joins the chips when the server reports a Builder run', () => {
    boardAvailability.data = { hasBuilderRun: true };
    renderSidebar(<ProjectSidebar />);

    expect(
      Array.from(chipRow().querySelectorAll('button')).map(
        (b) => b.textContent,
      ),
    ).toEqual(['Board', 'Coding', 'Tasks', 'Chat']);

    fireEvent.click(chip('Board'));
    expect(navigate).toHaveBeenCalledWith('/projects/demo/session-board');
  });

  test('the Board chip is current on the Board route', () => {
    boardAvailability.data = { hasBuilderRun: true };
    navState.pathname = '/projects/demo/session-board';
    renderSidebar(<ProjectSidebar />);

    expect(chip('Board').getAttribute('aria-current')).toBe('page');
  });

  test('a project with no layouts renders no chip row at all', () => {
    layouts.data = [];
    renderSidebar(<ProjectSidebar />);

    expect(screen.queryByRole('toolbar', { name: 'Demo layouts' })).toBeNull();
  });
});
