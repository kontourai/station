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
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));
/**
 * A SPY model rather than the `null` this returned before #2158: a chip's
 * "Open in <region>" menu calls `openSurfaceInRegion`, and with no model
 * `useSidebarPillRegions` reports no regions — every placement assertion below
 * would then pass for the wrong reason.
 */
const openSurfaceInRegion = vi.hoisted(() => vi.fn());
const regionModel = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => regionModel.value,
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

/**
 * Real ids, in the shape the server mints them (`randomUUID()`), because
 * #2158's pane id is `layout:<projectId>/<layoutId>` and both halves must
 * parse or the chip offers no placement rows. The `p1`/`l1` shorthand these
 * fixtures used before is a legacy record's shape, and it now has a case of
 * its own rather than being the silent default for every case here.
 */
const DEMO_PROJECT_ID = '9f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const CODING_LAYOUT_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PROJECTS = [{ id: DEMO_PROJECT_ID, slug: 'demo', name: 'Demo' }];

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
/**
 * `useIsMobile` only. The dock-placement half of this module decides whether a
 * chip has placement rows at all (#2158 D4), so it stays REAL and the cases
 * below drive it through `window.innerWidth`, the input it reads.
 */
vi.mock('../hooks/useIsMobile', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));
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
import { DEFAULT_DEVICE_REGION_ARRANGEMENT } from '../regions/region-model';

regionModel.value = {
  regions: DEFAULT_DEVICE_REGION_ARRANGEMENT,
  openSurfaceInRegion,
  toggleSurface: vi.fn(),
};

/** jsdom's own default, restated so the one narrow case cannot leak. */
const DESKTOP_WIDTH = 1024;
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    value: width,
    configurable: true,
    writable: true,
  });
}

/**
 * The fixture the Chat chip is built from. Declared as the layout record the
 * server returns so the assertion below can hand the SAME object to
 * `rendersChatWorkspaceLayout` — the derivation App suspends the ambient
 * regions on. A fixture typed 'chat' that the derivation rejected would make
 * the routing assertion below prove nothing about the chat placement.
 */
const CHAT_LAYOUT = {
  id: '2b3c4d5e-6f7a-4b8c-89da-1e2f3a4b5c6d',
  slug: 'chat',
  name: 'Chat',
  type: 'chat',
};
const CODING_LAYOUT = {
  id: CODING_LAYOUT_ID,
  slug: 'code',
  name: 'Coding',
  type: 'coding',
};
const TASKS_LAYOUT = {
  id: '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f',
  slug: 'tasks',
  name: 'Tasks',
  type: 'tasks',
};

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
    openSurfaceInRegion.mockClear();
    setViewportWidth(DESKTOP_WIDTH);
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

  /**
   * #2158 — a project Layout chip opens into a dock region.
   *
   * Driven through the real `ProjectSidebar` for the reason this file's own
   * header gives: the chip's dock id is built by `ProjectSidebarRow` from
   * `project.id` and `layout.id`, so a harness that mounted `ProjectLayoutChips`
   * with a hand-written `dockSurfaceId` would prove the menu renders while
   * proving nothing about the ids the panel actually produces.
   *
   * The menu is behind a `LazyBoundary` (it is 307 B of entry chunk otherwise),
   * so every case awaits the chunk the way `ProjectSidebarBoards.test.tsx`
   * awaits the Boards section.
   */
  describe('a Layout chip opens into a region (#2158)', () => {
    /**
     * The menu's chunk, in the module cache before the first right-click.
     *
     * `LazyBoundary` resolves an import that is ALREADY cached in a single
     * microtask; an uncached one takes however long the loader takes. Without
     * this the flush below would be a wait with a guessed length, and a case
     * asserting NO menu would be asserting "not yet" — the absence-as-success
     * shape. With it, one flush is enough for every case, so "no menu" means
     * the boundary never mounted.
     */
    beforeAll(async () => {
      await import('../components/project-sidebar/ProjectLayoutChipMenu');
    });

    async function openChipMenu(name: string): Promise<HTMLButtonElement> {
      const target = chip(name);
      await act(async () => {
        fireEvent.contextMenu(target);
      });
      // `React.lazy` settles its (already resolved) promise.
      await act(async () => {});
      return target;
    }

    function menu(): HTMLElement | null {
      return screen.queryByRole('menu');
    }

    function tabStops(): string[] {
      return Array.from(chipRow().querySelectorAll('button'))
        .filter((button) => button.tabIndex === 0)
        .map((button) => button.textContent ?? '');
    }

    test('right-clicking a chip offers the regions, and Right opens that Layout there', async () => {
      renderSidebar(<ProjectSidebar />);

      await openChipMenu('Coding');
      const surface = menu();
      expect(surface?.getAttribute('aria-label')).toBe('Coding actions');
      expect(
        Array.from(surface?.querySelectorAll('[role="menuitem"]') ?? []).map(
          (row) => row.textContent,
        ),
      ).toEqual(['Open in Left', 'Open in Right', 'Open in Bottom']);

      act(() => {
        fireEvent.click(
          screen.getByRole('menuitem', { name: 'Open in Right' }),
        );
      });
      // The id carries its project, which is why a region can hold another
      // project's Layout (#2157). Both halves are the server's own ids.
      expect(openSurfaceInRegion).toHaveBeenCalledWith(
        `layout:${DEMO_PROJECT_ID}/${CODING_LAYOUT_ID}`,
        { region: 'right' },
      );
      expect(menu()).toBeNull();
    });

    /**
     * D5. The strip is a `role="toolbar"` composite widget — ONE tab stop, arrow
     * keys inside it — and a `role="menu"` mounted inside it would put a second
     * focusable structure in that widget and its rows in the strip's own
     * Left/Right order. The menu is therefore a SIBLING, and the two properties
     * the toolbar promises are re-read here while it is open.
     */
    test('the menu is a sibling of the strip, and the strip keeps its single tab stop', async () => {
      renderSidebar(<ProjectSidebar />);
      expect(tabStops()).toEqual(['Coding']);

      await openChipMenu('Tasks');
      const surface = menu();
      expect(surface).not.toBeNull();
      expect(chipRow().contains(surface)).toBe(false);
      // The right-click moved the stop onto the chip it focused — still exactly
      // one, which is the property `role="toolbar"` asserts.
      expect(tabStops()).toEqual(['Tasks']);
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name: 'Open in Left' }),
      );
    });

    test('Escape closes the menu and returns focus to the chip', async () => {
      renderSidebar(<ProjectSidebar />);
      const target = await openChipMenu('Coding');

      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, {
          key: 'Escape',
        });
      });

      expect(menu()).toBeNull();
      // Not stranded on `<body>`: the chip is where the user was, and it is the
      // control the gesture reopens.
      expect(document.activeElement).toBe(target);
      expect(openSurfaceInRegion).not.toHaveBeenCalled();
    });

    /**
     * D3. The synthesized Board chip is the project's SESSION board, which is a
     * route: #2157 declares panes for Boards and project Layouts only. So it has
     * no `dockSurfaceId`, and its `contextmenu` is left to the platform rather
     * than swallowed by a menu with nothing in it.
     */
    test('the Session Board chip has no placement rows', async () => {
      boardAvailability.data = { hasBuilderRun: true };
      renderSidebar(<ProjectSidebar />);

      await openChipMenu('Board');
      expect(menu()).toBeNull();
      // The chip beside it does have them, so this is the Board chip's own
      // answer rather than the menu being broken for every chip.
      await openChipMenu('Coding');
      expect(menu()).not.toBeNull();
    });

    /** D2, for a chip: a legacy record's ids do not parse, so no rows render. */
    test('a Layout whose ids are not UUIDs has no placement rows', async () => {
      // `l1` beside a real record: the legacy chip offers nothing and the one
      // next to it still does, so the absence belongs to the id rather than to
      // a menu that stopped working for this case.
      layouts.data = [
        { id: 'l1', slug: 'code', name: 'Coding', type: 'coding' },
        TASKS_LAYOUT,
      ];
      renderSidebar(<ProjectSidebar />);

      await openChipMenu('Coding');
      expect(menu()).toBeNull();
      expect(openSurfaceInRegion).not.toHaveBeenCalled();

      await openChipMenu('Tasks');
      expect(menu()).not.toBeNull();
    });

    /**
     * D4: one dock region on this device, so there is nothing to choose.
     *
     * The control for this one is the first case in this block — the SAME chip
     * and the same gesture at the desktop width `beforeEach` restores — rather
     * than a second chip here, because at 500px nothing in the rail is
     * dockable and a sibling would prove only that the fold is total.
     */
    test('a device with one dock region has no placement rows', async () => {
      setViewportWidth(500);
      renderSidebar(<ProjectSidebar />);

      await openChipMenu('Coding');
      expect(menu()).toBeNull();
    });

    test('a plain click still selects the layout', async () => {
      renderSidebar(<ProjectSidebar />);
      await openChipMenu('Coding');
      act(() => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Left' }));
      });
      // The menu ran its own command and nothing else: opening a Layout in a
      // region is not also a navigation away from where the reader is.
      expect(setLayout).not.toHaveBeenCalled();

      fireEvent.click(chip('Coding'));
      expect(setLayout).toHaveBeenCalledWith('demo', 'code');
    });
  });
});
