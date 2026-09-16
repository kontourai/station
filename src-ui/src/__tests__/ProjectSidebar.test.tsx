/**
 * @vitest-environment jsdom
 */

/**
 * archive#1300: (3) the WORK list under Home used to render the first three
 * open chats with no heading; (4) "New Project" used to be a full-width
 * "+ New Project" row instead of a `+` on the PROJECTS section header. Both
 * covered here against the real `ProjectSidebar` composition (mirrors
 * `ProjectSidebarReturnFocus.test.tsx`'s mock shape).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { openChatsStore } from '../contexts/open-chats-store';

// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));
// #928 C2a: the Home row's active state reads `main`'s occupant. `null`
// is the no-provider mount every other test here uses.
const sidebarRegion = vi.hoisted(() => ({
  mainOccupant: undefined as string | null | undefined,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () =>
    sidebarRegion.mainOccupant === undefined
      ? null
      : {
          // The full arrangement: `ProjectSidebarNav` reads the dock regions
          // for its `regionSurface` rows.
          regions: {
            main: {
              visible: true,
              size: 0,
              panes: sidebarRegion.mainOccupant
                ? [sidebarRegion.mainOccupant]
                : [],
              occupant: sidebarRegion.mainOccupant,
            },
            left: { visible: false, size: 400, panes: [], occupant: null },
            right: { visible: false, size: 400, panes: [], occupant: null },
            bottom: {
              visible: false,
              size: 320,
              panes: ['chat'],
              occupant: 'chat',
            },
          },
        },
}));

vi.mock('../build-info', () => ({
  buildInfo: { version: '0.1.2', commit: 'test' },
}));

const {
  chats,
  agents,
  navigate,
  setProject,
  setLayout,
  projects,
  sessions,
  boards,
  boardCreateSpy,
  platformProfile,
  branding,
} = vi.hoisted(() => ({
  chats: {} as Record<string, unknown>,
  agents: [] as Array<{ slug: string; name: string }>,
  navigate: vi.fn(),
  setProject: vi.fn(),
  setLayout: vi.fn(),
  projects: [] as Array<{ id: string; slug: string; name: string }>,
  sessions: [] as Array<Record<string, unknown>>,
  boards: [] as Array<{ slug: string; name: string }>,
  /** Shared, so a test can observe the section acting while it renders nothing. */
  boardCreateSpy: vi.fn(),
  platformProfile: {
    isTauri: false,
    productName: undefined as string | undefined,
    channel: undefined as 'stable' | 'beta' | 'nightly' | 'dev' | undefined,
  },
  branding: { appName: 'Station' },
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects, isLoading: false }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agents,
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => chats,
}));
vi.mock('../contexts/open-chats-store', () => ({
  useOpenChats: () =>
    Object.entries(chats).map(([id, chat]: [string, any]) => ({
      id,
      chatSessionId: id,
      kind: 'chat',
      title: chat.title ?? 'Task',
      projectLabel: chat.projectLabel ?? 'Station',
      agentLabel:
        agents.find((agent) => agent.slug === chat.agentSlug)?.name ??
        chat.agentSlug,
      modelLabel: chat.model ?? 'Model not reported',
      lifecycleLabel: 'Recent',
      updatedAt: 0,
    })),
  openChatsStore: {
    focus: vi.fn(),
    openCollection: vi.fn(),
    registerNavigation: ({ openCollection }: any) => {
      openChatsStore.openCollection = openCollection;
      return vi.fn();
    },
  },
}));
vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({
    selectedProject: null,
    selectedProjectLayout: null,
    navigate,
    setProject,
    setLayout,
    pathname: '/',
  });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => branding,
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platformProfile,
}));
// #1858 gave the lazy Open chats rows file intake (`FileDropRow`), so the
// section now reads the host request authority scope from ApiBaseContext,
// which throws outside a ConnectionsProvider. The scope itself is not under
// test here — no assertion drops files — so the read is stubbed the same way
// ChatDockBoundaryDialogsOnDemand stubs it, keeping this harness a sidebar
// harness rather than a connections one.
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
/**
 * `useIsMobile` only. A bare factory here replaced the WHOLE module, including
 * the dock-placement half (`useDockSlotDevice`, `availablePlacements`) that
 * `ProjectSidebarBoards` reads since #2158 — the section then threw on mount
 * and this file's lazy-boundary case saw the error alert it exists to refuse.
 */
vi.mock('../hooks/useIsMobile', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({ data: sessions }),
  useProjectLayoutsQuery: () => ({ data: [] }),
  useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
  // archive#3313 routed the sidebar's visibility flags through
  // useSurfaceVisibilityFlags, which reads enabled previews from here. A
  // hand-rolled module mock owes every export its subject reaches, so this
  // file went red on main the moment that hook was added.
  useFeaturePreviewsQuery: () => ({ data: [] }),
  // archive#3780 gave ProjectSidebarRow the Board-availability read, and this
  // file went red again for exactly the reason recorded above — the same
  // hazard, one hook later. `undefined` is the honest shape while no row is
  // expanded: the row's read is gated `enabled: expanded && !collapsed`, so
  // the server is never asked, and nothing here asserts a Board entry.
  useBoardAvailabilityQuery: () => ({ data: undefined }),
  // #2059: the lazy panel footer reads the attention projection for its bell
  // badge. Same hazard as the two recorded above, one hook later.
  useAttentionQuery: () => ({ data: { pendingCount: 0 } }),
  // #2062: the Boards section reaches five personal-layout hooks. FOURTH
  // instance of the hazard recorded three times above, and the first whose
  // symptom was not a red test — the section is mounted through a
  // LazyBoundary, so a missing export threw inside the lazy chunk and the
  // boundary rendered its "Unable to load this part of Station." alert INSIDE
  // the panel while every assertion here still passed. `rendersTheBoardsSection`
  // below is what makes this block load-bearing rather than decorative.
  usePersonalLayoutsQuery: () => ({ data: boards }),
  useCreatePersonalLayoutMutation: () => ({
    mutate: boardCreateSpy,
    isPending: false,
  }),
  useUpdatePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  useDeletePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  usePromotePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
}));

import { requestNewBoard } from '../components/project-sidebar/new-board-events';
import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { deviceSettingsStore } from '../lib/device-settings-store';

// #1765 routed the sidebar status row's command-palette keycap through
// `useShortcutDisplay`, which throws outside KeyboardShortcutsProvider; an
// unmount/remount loop around that crash took the Open chats section with
// it. Mounting the real provider keeps the status row in the tree instead
// of stubbing the hook out from under every other consumer.
// #2066's presence tray reads `useLiveActivityQuery`, so the real footer needs
// a QueryClient the way it already needs KeyboardShortcutsProvider. Without
// one the tray throws, the Boards LazyBoundary catches it, and the panel
// renders its error alert where the section belongs — which is how main went
// red: #2084 added the tray and #2095 added the test that mounts the real
// sidebar, each green alone. Retries are off so a failing fetch settles in one
// tick instead of holding the test open; the tray's own suites are where its
// error and capability states are asserted.
function renderSidebar(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>{ui}</KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

function resetState() {
  sidebarRegion.mainOccupant = undefined;
  for (const key of Object.keys(chats)) delete chats[key];
  agents.length = 0;
  projects.length = 0;
  sessions.length = 0;
  boards.length = 0;
  boardCreateSpy.mockClear();
  navigate.mockClear();
  setProject.mockClear();
  setLayout.mockClear();
  platformProfile.isTauri = false;
  platformProfile.productName = undefined;
  platformProfile.channel = undefined;
  branding.appName = 'Station';
  vi.mocked(openChatsStore.focus).mockClear();
  chatDraftsStore.clear('session-draft');
  window.localStorage.clear();
  // The device-settings singleton keeps in-memory state across tests;
  // clearing localStorage alone would leak a prior test's toggles.
  deviceSettingsStore.reloadFromStorage();
}

/**
 * #928 C2a: Home is a region surface whose only placement is `main`. Both
 * sidebar Home affordances (the header's app-name button and the Work list's
 * Home row) reveal it through `showSurface('home')`; navigating to `/` is the
 * region model's job once the placement lands, and a sidebar that navigated
 * itself would show whatever surface occupies `main`.
 */
describe('ProjectSidebar Home affordances reveal the Home surface (#928 C2a)', () => {
  test('the Work list Home row and the header home button call showSurface(home) and do not navigate', () => {
    resetState();
    showSurfaceStub.mockClear();
    renderSidebar(<ProjectSidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(showSurfaceStub).toHaveBeenCalledWith('home');
    expect(navigate).not.toHaveBeenCalled();

    showSurfaceStub.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Station home' }));
    expect(showSurfaceStub).toHaveBeenCalledWith('home');
    expect(navigate).not.toHaveBeenCalled();
  });

  test('the Home row is active at / only while main shows Home', () => {
    const homeRow = () => screen.getByRole('button', { name: 'Home' });
    const active = 'sidebar__project-btn--active';
    resetState();

    sidebarRegion.mainOccupant = 'activity';
    const withActivity = renderSidebar(<ProjectSidebar />);
    expect(homeRow().classList.contains(active)).toBe(false);
    withActivity.unmount();

    sidebarRegion.mainOccupant = 'home';
    const withHome = renderSidebar(<ProjectSidebar />);
    expect(homeRow().classList.contains(active)).toBe(true);
    withHome.unmount();

    // A null occupant is Home on screen (`MainRegionSurface`).
    sidebarRegion.mainOccupant = null;
    const withNull = renderSidebar(<ProjectSidebar />);
    expect(homeRow().classList.contains(active)).toBe(true);
    withNull.unmount();
    sidebarRegion.mainOccupant = undefined;
  });
});

describe('ProjectSidebar WORK list labeling (station#1300)', () => {
  test.each([
    ['Stable', 'unexpected package title', 'stable', undefined],
    ['Beta', 'unexpected package title', 'beta', 'beta'],
    ['Nightly', 'unexpected package title', 'nightly', 'nightly'],
    ['Dev', 'unexpected package title', 'dev', 'dev'],
  ])(
    'uses trusted %s release identity while presenting its channel as a readable badge',
    (_name, packageName, channel, badge) => {
      resetState();
      platformProfile.isTauri = true;
      platformProfile.productName = packageName;
      platformProfile.channel = channel as typeof platformProfile.channel;
      branding.appName = 'Remote Station';
      renderSidebar(<ProjectSidebar />);
      const home = screen.getByRole('button', {
        name: `Station${badge ? ` ${badge}` : ''} v0.1.2 Build timestamp unavailable. home`,
      });
      expect(
        home.querySelector('.sidebar__brand-name > span')?.textContent,
      ).toBe('Station');
      if (badge) {
        expect(home.querySelector('.sidebar__channel-badge')?.textContent).toBe(
          badge,
        );
      } else {
        expect(home.querySelector('.sidebar__channel-badge')).toBeNull();
      }
    },
  );

  test('retains web branding instead of a local package identity', () => {
    resetState();
    platformProfile.isTauri = false;
    platformProfile.productName = 'Station Nightly';
    platformProfile.channel = 'nightly';
    branding.appName = 'Acme Station';
    renderSidebar(<ProjectSidebar />);
    expect(
      screen.getByRole('button', { name: 'Acme Station home' }).textContent,
    ).toContain('Acme Station');
  });

  test('labels the open-chat rows with an "Open chats" heading', async () => {
    resetState();
    chats['session-a'] = { title: 'Fix login bug', agentSlug: 'a' };
    agents.push({ slug: 'a', name: 'Agent A' });

    renderSidebar(<ProjectSidebar />);
    expect(screen.getByText('Open chats')).toBeTruthy();
    // The mini-inbox rows are lazy-loaded (archive#3314) — await their chunk.
    expect(await screen.findByText('Fix login bug')).toBeTruthy();
  });

  test('hides the "Open chats" heading when there are none', () => {
    resetState();
    renderSidebar(<ProjectSidebar />);
    expect(screen.queryByText('Open chats')).toBeNull();
  });

  test('projects real non-empty drafts into the sidebar and focuses their owning chat', () => {
    resetState();
    chats['session-draft'] = {
      title: 'Finish release notes',
      agentSlug: 'writer',
    };
    renderSidebar(<ProjectSidebar />);

    act(() => chatDraftsStore.set('session-draft', '  Remember migration  '));
    expect(screen.getByText('Drafts')).toBeTruthy();
    const draft = screen.getByRole('button', {
      name: /finish release notes.*draft.*remember migration/i,
    });
    fireEvent.click(draft);
    expect(openChatsStore.focus).toHaveBeenCalledWith({
      sessionId: 'session-draft',
    });

    act(() => chatDraftsStore.clear('session-draft'));
    expect(screen.queryByText('Drafts')).toBeNull();

    act(() => chatDraftsStore.set('session-draft', '   '));
    expect(screen.queryByText('Drafts')).toBeNull();
  });
});

/**
 * archive#3314: "Open chats" is a mini-inbox — shared inbox rows
 * (compact variant), collapsible with the nav-group disclosure anatomy,
 * removable (device setting; restore lives in Settings → Appearance), with
 * the cap as a named constant and an "N more" affordance into the dock inbox.
 */
describe('ProjectSidebar Open chats mini-inbox (station#3314)', () => {
  function seedChats(count: number) {
    for (let index = 0; index < count; index += 1) {
      chats[`session-${index}`] = { title: `Chat ${index}`, agentSlug: 'a' };
    }
    agents.push({ slug: 'a', name: 'Agent A' });
  }

  test('rows render through the shared inbox row anatomy, and clicking focuses the chat', async () => {
    resetState();
    seedChats(1);
    renderSidebar(<ProjectSidebar />);

    const row = await screen.findByRole('button', {
      name: 'Chat 0, Station',
    });
    expect(row.classList).toContain('chat-dock-inbox__item');
    expect(document.querySelector('.chat-dock-inbox--compact')).not.toBeNull();
    fireEvent.click(row);
    expect(openChatsStore.focus).toHaveBeenCalledWith({
      sessionId: 'session-0',
    });
  });

  test('the section collapses through the shared disclosure anatomy and persists', async () => {
    resetState();
    seedChats(1);
    const first = renderSidebar(<ProjectSidebar />);

    const toggle = screen.getByRole('button', { name: 'Open chats' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('sidebar-open-chats');
    await screen.findByText('Chat 0');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      document.getElementById('sidebar-open-chats')?.hasAttribute('hidden'),
    ).toBe(true);

    // Persisted device-side: a fresh mount stays collapsed.
    first.unmount();
    renderSidebar(<ProjectSidebar />);
    expect(
      screen
        .getByRole('button', { name: 'Open chats' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('the section can be removed from the sidebar entirely', () => {
    resetState();
    seedChats(1);
    renderSidebar(<ProjectSidebar />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Open chats from sidebar' }),
    );
    expect(screen.queryByText('Open chats')).toBeNull();
    expect(deviceSettingsStore.get('sidebarSections').openChatsHidden).toBe(
      true,
    );
  });

  test('caps the list and offers "N more" that opens the dock inbox', async () => {
    resetState();
    seedChats(5);
    renderSidebar(<ProjectSidebar />);

    await screen.findByText('Chat 0');
    expect(screen.getByText('Chat 2')).toBeTruthy();
    // Capped at OPEN_CHATS_SIDEBAR_CAP (3): the 4th/5th fold behind N more.
    expect(screen.queryByText('Chat 3')).toBeNull();

    // archive#3314: this used to assert `inboxOpen === true` as proof of
    // a destination. That setting DEFAULTS to true, so the assertion passed on
    // a fresh store whether or not anything wrote it — no power at all, for a
    // button that led nowhere on mobile and in an edge placement.
    //
    // The destination guarantee now lives with the dock, which is the only
    // thing that knows which surface is mounted, and is proven exhaustively in
    // chat-dock-utils.test.ts ("every chrome reaches a destination that
    // mounts"). What the SIDEBAR owes is delegation: ask, never guess.
    deviceSettingsStore.set('inboxOpen', false);
    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(openChatsStore.openCollection).toHaveBeenCalledTimes(1);
    // The sidebar must NOT decide the destination itself — routing that from
    // here is what produced a dead end in the chromes it cannot see.
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
  });

  test('Drafts collapses and removes independently', () => {
    resetState();
    chats['session-draft'] = { title: 'Draft owner', agentSlug: 'a' };
    renderSidebar(<ProjectSidebar />);
    act(() => chatDraftsStore.set('session-draft', 'draft text'));

    const toggle = screen.getByRole('button', { name: 'Drafts' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Drafts from sidebar' }),
    );
    expect(screen.queryByText('Drafts')).toBeNull();
    expect(deviceSettingsStore.get('sidebarSections').draftsHidden).toBe(true);

    act(() => chatDraftsStore.clear('session-draft'));
  });
});

/**
 * #2059 (design record D3), the acceptance this slice is measured by: "Panel
 * order: header, Home, Activity, Projects, footer. No other destination rows."
 *
 * Asserted against the real `ProjectSidebar` composition in DOM order, not
 * against `ProjectSidebarNav` alone: Home is the sidebar's own row and
 * Activity is the nav's, so only the composition can say that the one follows
 * the other — and only an ORDERED inventory notices a row nobody meant to add.
 * The footer is lazy, so it is not in this synchronous tree; its own suite
 * (ProjectSidebarFooter.test.tsx) covers it.
 */
/**
 * #2062. The Boards section is mounted here through a `LazyBoundary`, which
 * catches whatever the chunk throws and renders an alert IN PLACE of the
 * section. That is why this file's other assertions could not see a missing
 * `@kontourai/station-sdk` export: the panel rendered "Unable to load this
 * part of Station." where Boards belongs and every other row was unaffected,
 * so a broken section read as a passing suite.
 *
 * These two assertions are what make the module mock above load-bearing. The
 * first fails for ANY throw inside the chunk (a hook this file forgot, a
 * context the section reaches, an import that moved); the second proves the
 * section actually rendered rather than merely declining to crash, which a
 * `null`-returning section would also do.
 */
describe('ProjectSidebar Boards section mounts (#2062)', () => {
  test("renders the section rather than the lazy boundary's error alert", async () => {
    resetState();
    boards.push({ slug: 'daily', name: 'Daily brief' });
    renderSidebar(<ProjectSidebar />);

    expect(await screen.findByText('Boards')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Daily brief' })).toBeTruthy();
    // Named separately from the positive assertion: a future change that
    // renders the section AND an alert somewhere else in the panel is still a
    // broken panel, and the positive check alone would not say so.
    expect(document.querySelector('.lazy-boundary__error')).toBeNull();
  });

  test('renders no Boards chrome — and no error alert — for a viewer with none', async () => {
    resetState();
    renderSidebar(<ProjectSidebar />);

    // The chunk still loads; it is the SECTION that returns null. Proving the
    // lazy work has SETTLED is the hard part of this case, because a section
    // rendering nothing offers nothing to wait for — and an earlier revision
    // awaited `Home`, which `ProjectSidebar` renders itself, so both negative
    // assertions ran before the chunk had resolved or rejected and this test
    // passed even with the module mock broken (#2062 review F3).
    //
    // The settle-proof is the section DOING something: answering the palette's
    // create request, which is the affordance that exists for precisely this
    // viewer. Only a mounted section can, so a chunk that threw cannot satisfy
    // it.
    // Let the dynamic import resolve and the section mount. Bounded and
    // re-dispatching, because the listener only exists once the chunk is in
    // the tree — and a flush count is a guess, whereas the spy is the fact.
    // This cannot manufacture a pass: the assertion below still requires the
    // section to have handled the request.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        requestNewBoard();
      });
      if (boardCreateSpy.mock.calls.length > 0) break;
    }
    expect(boardCreateSpy).toHaveBeenCalledWith({
      slug: 'untitled-board',
      name: 'Untitled Board',
    });

    expect(screen.queryByText('Boards')).toBeNull();
    expect(document.querySelector('.lazy-boundary__error')).toBeNull();
  });
});

describe('ProjectSidebar panel order (#2059)', () => {
  const panelRowLabels = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.sidebar__project-btn, .sidebar__nav-btn',
      ),
      // The label element, not the whole button: the Home row leads with an
      // aria-hidden `⌂` and the nav rows with an aria-hidden icon.
    ).map((button) =>
      (
        button.querySelector('.sidebar__project-name, .sidebar__nav-label') ??
        button
      ).textContent?.trim(),
    );

  test('lists header, Home, Activity, then the projects — and no other destination rows', () => {
    resetState();
    projects.push(
      { id: 'p1', slug: 'station', name: 'Station' },
      { id: 'p2', slug: 'ferry', name: 'Ferry' },
    );
    renderSidebar(<ProjectSidebar />);

    // The header is above the body and is its own control, so it anchors the
    // order rather than joining the row list.
    expect(screen.getByRole('button', { name: 'Station home' })).toBeTruthy();
    expect(panelRowLabels()).toEqual(['Home', 'Activity', 'Station', 'Ferry']);
  });

  test('removes every configuration destination and both group headers from the panel', () => {
    resetState();
    renderSidebar(<ProjectSidebar />);

    // Named one by one so a failure says WHICH one came back. The ordered
    // inventory above is what catches an unnamed addition.
    for (const label of [
      'Agents',
      'Connections',
      'Skills',
      'Registry',
      'Review',
      'Plugins',
      'Schedule',
      'Developer',
      'Notifications',
      'Settings',
      'Customize',
      'System',
    ]) {
      expect(
        screen.queryByRole('button', { name: label }),
        `${label} is still a panel row`,
      ).toBeNull();
    }
    // #2150: the panel lists places, and "Work" was a category label over
    // its two unlabelled places (Home, Activity) -- the one header the design
    // record (D3) does not draw. Asserted as text, not a button: it never was
    // a control, which is exactly why the row inventory above missed it.
    expect(screen.queryByText('Work')).toBeNull();
  });
});

/**
 * #2150: `LayoutIcon` falls back to a two-letter monogram for a project with
 * no icon. At the row's 18px that was a smudge, it landed in the accessible
 * name ("CA Campfit"), and the design record draws the accent bar beside it
 * for identity. An icon-less project now shows the bar alone; a project WITH
 * an icon keeps it, because that is identity the user chose. Both directions
 * are pinned so the gate cannot quietly become "never show an icon".
 */
describe('project row identity (#2150)', () => {
  test('an icon-less project shows no monogram and is named by its name alone', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'campfit', name: 'Campfit' });
    renderSidebar(<ProjectSidebar />);
    const row = screen.getByRole('button', { name: 'Campfit' });
    expect(row.textContent?.trim()).toBe('Campfit');
    expect(row.querySelector('.sidebar__project-accent')).toBeTruthy();
  });

  test('a project with an icon keeps it', () => {
    resetState();
    projects.push({
      id: 'p1',
      slug: 'campfit',
      name: 'Campfit',
      icon: '🏕️',
    } as (typeof projects)[number]);
    renderSidebar(<ProjectSidebar />);
    const row = screen.getByRole('button', { name: /Campfit/ });
    expect(row.textContent).toContain('🏕️');
  });
});

/**
 * archive#3202. The per-project badge used to fold the conversation INVENTORY
 * inline in `ProjectSidebar` and count, among other things, unseen finished
 * runs (archive#1781). It now counts one thing — this project's LIVE work,
 * the Sessions list's own "Needs you" + "Active now" lanes scoped to the
 * project (`project-live-work-model.ts`) — because that is exactly what the
 * project page's Live work section lists, and a badge whose destination shows
 * a different set is the defect archive#3202 was filed about.
 *
 * DISCLOSED CONSEQUENCE, pinned below rather than left to be discovered: a
 * finished-and-unopened run no longer contributes to THIS badge. That signal
 * still lives on Home / the chat dock inbox, whose lane model keeps a terminal
 * conversation in "Recently finished" until its rendered version is durably
 * acknowledged.
 */
function session(overrides: Record<string, unknown>) {
  return {
    threadId: 'thread-1',
    provider: 'claude',
    controlMode: 'managed',
    status: 'open',
    projectSlug: 'station',
    assignedAgentSlug: 'station',
    createdAt: '2026-08-02T19:00:00.000Z',
    updatedAt: '2026-08-02T20:00:00.000Z',
    answerability: { answerable: true },
    ...overrides,
  };
}

describe('ProjectSidebar live-work badge', () => {
  test('counts an answerable open request under Needs you', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    renderSidebar(<ProjectSidebar />);
    expect(
      screen.getByRole('button', { name: /station.*needs you: 1/i }),
    ).toBeTruthy();
  });

  test('counts a mid-flight turn under Active now, and says which is which', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
      session({
        threadId: 'running',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
    );

    const { container } = renderSidebar(<ProjectSidebar />);
    // The number and the sentence come from the same lanes, so the badge can
    // never total something its own explanation does not account for.
    expect(
      container.querySelector('.sidebar__project-live-count')?.textContent,
    ).toBe('2');
    expect(
      screen.getByRole('button', {
        name: /station.*needs you: 1 · active now: 1/i,
      }),
    ).toBeTruthy();
  });

  /**
   * archive#1781's narrowing survives the move: `answerability` still demotes
   * an open request nothing can answer. It lands in Active now as
   * 'Unanswerable' rather than claiming to be yours to act on, which is the
   * Sessions lane model's own rule.
   */
  test('an open request nothing can answer is not claimed as Needs you', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'dead',
        lifecycleState: 'needs_input',
        pendingReview: true,
        answerability: {
          answerable: false,
          qualification: 'provider_absent',
          observedBy: 'station-7f3a',
          observedAt: '2026-08-03T12:04:03.000Z',
        },
      }),
    );

    renderSidebar(<ProjectSidebar />);
    expect(screen.queryByText(/needs you: /i)).toBeNull();
    expect(
      screen.getByRole('button', { name: /station.*active now: 1/i }),
    ).toBeTruthy();
  });

  test('a finished run is not live work and no longer reaches this badge', () => {
    // The archive#1781 leg this change deliberately drops. Asserted, not
    // silently removed: if a later change re-adds finished runs to the badge
    // without re-adding them to the project page section, this reds.
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({ threadId: 'finished', lifecycleState: 'completed' }),
      session({ threadId: 'broken', lifecycleState: 'failed' }),
    );

    const { container } = renderSidebar(<ProjectSidebar />);
    expect(container.querySelector('.sidebar__project-live-count')).toBeNull();
  });

  test('a session in another project never reaches this project’s badge', () => {
    resetState();
    projects.push(
      { id: 'p1', slug: 'station', name: 'Station' },
      { id: 'p2', slug: 'beacon', name: 'Beacon' },
    );
    sessions.push(
      session({
        threadId: 'elsewhere',
        projectSlug: 'beacon',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    const { container } = renderSidebar(<ProjectSidebar />);
    const badges = container.querySelectorAll('.sidebar__project-live-count');
    expect(badges).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: /beacon.*needs you: 1/i }),
    ).toBeTruthy();
  });

  test('the badge is visible to a sighted reader, not only announced', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    const { container } = renderSidebar(<ProjectSidebar />);
    const count = container.querySelector('.sidebar__project-live-count');
    const label = container.querySelector('.sidebar__project-live-label');
    expect(count?.getAttribute('title')).toBe('Needs you: 1');
    expect(count?.getAttribute('title')).toBe(label?.textContent);
  });

  test('selecting the project is unchanged — the badge is not a separate target', () => {
    resetState();
    projects.push({ id: 'p1', slug: 'station', name: 'Station' });
    sessions.push(
      session({
        threadId: 'waiting',
        lifecycleState: 'needs_input',
        pendingReview: true,
      }),
    );

    const { container } = renderSidebar(<ProjectSidebar />);
    // Clicking the number is clicking the row: the badge stays decoration
    // inside the project button, and the project page it selects is where the
    // live sessions are now listed.
    fireEvent.click(
      container.querySelector('.sidebar__project-live-count') as Element,
    );
    expect(setProject).toHaveBeenCalledWith('station');
  });
});

describe('ProjectSidebar New Project affordance (station#1300)', () => {
  test('renders a "+" icon button on the Projects header instead of a full-width row', () => {
    resetState();
    renderSidebar(<ProjectSidebar />);

    const trigger = screen.getByRole('button', { name: 'New Project' });
    expect(trigger).toBeTruthy();
    expect(trigger.textContent?.trim()).toBe('');
    expect(screen.queryByText('+ New Project')).toBeNull();
  });

  test('clicking it navigates to /projects/new, same as before', () => {
    resetState();
    renderSidebar(<ProjectSidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
    expect(navigate).toHaveBeenCalledWith('/projects/new');
  });
});

describe('ProjectSidebar compact rail chat entry (#1348)', () => {
  test('keeps a named Open chats control inside the collapsed rail', () => {
    resetState();
    // archive#1348 was written against the raw pre-unification key; sidebar
    // collapse now lives in the device-settings envelope, so
    // seed through the store rather than the migrated-away legacy key.
    deviceSettingsStore.set('projectSidebarCollapsed', true);
    const listener = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus: vi.fn(),
      openCollection: listener,
    });

    renderSidebar(<ProjectSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }));

    expect(listener).toHaveBeenCalledOnce();
    unregister();
  });
});
