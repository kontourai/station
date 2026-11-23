/**
 * @vitest-environment jsdom
 */

/**
 * The quiet sidebar behind the `quiet-sidebar` Feature Preview
 * (`docs/design/first-release-navigation.md`, `navigation-06`, `-07`, `-10`,
 * `-11`; `docs/design/first-release-apps.md`, `apps-01`, `apps-02`). Drives the
 * real `ProjectSidebar` with the preview read from the same previews query the
 * app reads, so each case reaches the branch the preview selects. With the
 * preview off, the existing sidebar suites (`ProjectSidebar.test.tsx` and its
 * siblings) are the proof that nothing changed; the first case here pins the
 * seam they cannot see: the quiet rows are absent while the preview is off.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Ada Lovelace' } }),
}));
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
  useShowSurfacePage: () => showSurfaceStub,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));

const state = vi.hoisted(() => ({
  /** `undefined` is a read that is pending or failed with nothing cached. */
  previews: [] as Array<{ id: string; enabled: boolean }> | undefined,
  pathname: '/',
  selectedProject: null as string | null,
  projects: [] as Array<{ id: string; slug: string; name: string }>,
  boards: [] as Array<{ id: string; slug: string; name: string }>,
  engines: [] as unknown[],
  tools: [] as unknown[],
  knowledge: undefined as unknown,
  isMobile: false,
}));
const navigate = vi.hoisted(() => vi.fn());
const setProject = vi.hoisted(() => vi.fn());
const setDockState = vi.hoisted(() => vi.fn());

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: state.projects, isLoading: false }),
}));
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({
    selectedProject: state.selectedProject,
    selectedProjectLayout: null,
    navigate,
    setProject,
    setLayout: vi.fn(),
    setDockState,
    pathname: state.pathname,
  });
  return {
    useNavigation: (
      selector?: (value: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => ({ appName: 'Station' }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('../contexts/ManagedPolicyContext', () => ({
  useManagedPolicySummary: () => undefined,
}));
vi.mock('../hooks/useIsMobile', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => state.isMobile,
}));
vi.mock('../hooks/useConnectedServerUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../hooks/useConnectedServerUpdateContext')
  >()),
  useConnectedServerUpdateContext: () => ({
    apiBase: '',
    scopeKey: 'quiet-sidebar-test',
    connectionName: 'Test Station',
    kind: 'remote-server',
    reachability: 'unknown',
    identity: null,
    identityReady: false,
    identitySettled: false,
    nativeObservationPending: false,
    claimedOwnerUnresolved: false,
    isCurrent: () => false,
  }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => ({ data: state.previews }),
  useOrchestrationSessionsQuery: () => ({ data: [] }),
  useCoreUpdateStatusQuery: () => ({ data: undefined }),
  useProjectLayoutsQuery: () => ({ data: [] }),
  useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
  useBoardAvailabilityQuery: () => ({ data: undefined }),
  useAttentionQuery: () => ({ data: { pendingCount: 0 } }),
  // The open project's channel list (`ProjectConversationList`).
  useTasksQuery: () => ({ data: [] }),
  useReadMarkerSummaryQuery: () => ({ data: undefined }),
  usePersonalLayoutsQuery: () => ({ data: state.boards }),
  useCreatePersonalLayoutMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdatePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  useDeletePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  usePromotePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  // The Customize dot's reads, in the shapes the server returns
  // (`useCustomizeGroups` over `useConnectionSectionSignals`).
  useAgentsQuery: () => ({ data: [] }),
  useSkillsQuery: () => ({ data: [] }),
  useModelConnectionsQuery: () => ({ data: [] }),
  useEngineConnectionsQuery: () => ({ data: state.engines }),
  useIntegrationsQuery: () => ({ data: state.tools }),
  useGlobalKnowledgeStatusQuery: () => ({ data: state.knowledge }),
  useACPConnectionsQuery: () => ({ data: [] }),
  useACPConnectionRegistryQuery: () => ({ data: [] }),
}));

import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';
import {
  KeyboardShortcutsProvider,
  useShortcutRegistry,
} from '../contexts/KeyboardShortcutsContext';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { OPEN_NEW_CHAT_EVENT } from '../lib/newChatIntent';

const QUIET_ON = [{ id: 'quiet-sidebar', enabled: true }];
const LAST_KNOWN_KEY = 'station.quietSidebar.lastKnown';

/** Registers the dock's New chat shortcut the way the dock does, and hands
 *  the registry's rebinding to the test. */
let rebind: ((key: string) => void) | undefined;
function DockShortcut() {
  useKeyboardShortcut('dock.newChat', 't', ['cmd'], 'New chat', () => {});
  const { setBinding } = useShortcutRegistry();
  rebind = (key) => setBinding('dock.newChat', { key, modifiers: ['cmd'] });
  return null;
}

/** An engine row in the shape `/api/connections/agents` returns. */
function engine(id: string, name: string, overrides = {}) {
  return {
    id,
    kind: 'agent',
    type: id,
    name,
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready', detected: true, configured: true },
    ...overrides,
  };
}

function renderSidebar(ui: ReactElement = <ProjectSidebar />) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>{ui}</KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

/** The quiet sidebar has mounted: its footer's Settings row is the last part. */
const settingsRow = () => screen.findByRole('button', { name: 'Settings' });

/** Every sidebar control that claims to be the current page. */
function currentRows(): string[] {
  return Array.from(
    document.querySelectorAll('#mobile-navigation [aria-current="page"]'),
  ).map((node) => node.getAttribute('aria-label') ?? node.textContent ?? '');
}

beforeEach(() => {
  state.previews = QUIET_ON;
  state.pathname = '/';
  state.selectedProject = null;
  state.projects = [];
  state.boards = [];
  state.engines = [];
  state.tools = [];
  state.knowledge = undefined;
  state.isMobile = false;
  navigate.mockClear();
  setProject.mockClear();
  setDockState.mockClear();
  showSurfaceStub.mockClear();
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
});

describe('the quiet sidebar preview', () => {
  test('is off by default: the current sidebar keeps its footer and none of the quiet rows', async () => {
    state.previews = [{ id: 'quiet-sidebar', enabled: false }];
    renderSidebar();
    await screen.findByText('Boards across Projects.');
    // The current footer's Customize is an icon button named by its label;
    // the quiet one is a labelled row. Automations, Discover and the
    // Settings row exist only in the quiet sidebar.
    expect(
      await screen.findByRole('button', { name: 'New Board' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discover' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    // Automations and Customize stay the current footer's icon buttons.
    for (const name of ['Automations', 'Customize']) {
      const button = await screen.findByRole('button', { name });
      expect(button.classList.contains('sidebar__footer-action')).toBe(true);
    }
    expect(document.querySelector('.sidebar__footer--quiet')).toBeNull();
  });

  test('puts New chat first, then only Home and Automations above Projects, then Apps, then Customize and Settings', async () => {
    state.projects = [{ id: 'p1', slug: 'notes-api', name: 'Notes API' }];
    state.boards = [
      { id: 'b1', slug: 'daily-brief', name: 'Daily brief' },
      { id: 'b2', slug: 'release-desk', name: 'Release desk' },
    ];
    renderSidebar();
    await settingsRow();
    await screen.findByRole('button', { name: 'Discover' });
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    // Document order is the reading and Tab order.
    const order = within(nav)
      .getAllByRole('button')
      .map(
        (button) =>
          button.getAttribute('aria-label') ??
          button.querySelector('.sidebar__project-name')?.textContent ??
          '',
      )
      .filter((name) =>
        [
          'New chat',
          'Home',
          'Automations',
          'New Project',
          'Notes API',
          'Daily brief',
          'Release desk',
          'Discover',
          'Customize',
          'Settings',
        ].includes(name),
      );
    expect(order).toEqual([
      'New chat',
      'Home',
      'Automations',
      'New Project',
      'Notes API',
      'Daily brief',
      'Release desk',
      'Discover',
      'Customize',
      'Settings',
    ]);
    // The Apps section header has no `+`: Discover is how apps are added.
    expect(screen.queryByRole('button', { name: 'New Board' })).toBeNull();
    expect(screen.getByText('Apps')).toBeTruthy();
    // The Customize and Settings rows are pinned in the footer, not the body.
    const footer = document.querySelector('.sidebar__footer--quiet')!;
    expect(
      within(footer as HTMLElement).getByRole('button', { name: 'Customize' }),
    ).toBeTruthy();
    expect(
      within(footer as HTMLElement).getByRole('button', { name: 'Settings' }),
    ).toBeTruthy();
    expect(
      within(footer as HTMLElement).getByRole('button', {
        name: 'Profile and settings: AL',
      }),
    ).toBeTruthy();
  });

  test('each app row carries its own icon', async () => {
    state.boards = [
      { id: 'b1', slug: 'daily-brief', name: 'Daily brief', icon: '☀' },
      { id: 'b2', slug: 'release-desk', name: 'Release desk' },
    ] as typeof state.boards;
    renderSidebar();
    await screen.findByRole('button', { name: 'Discover' });
    const glyph = (name: string) =>
      screen
        .getByText(name)
        .closest('button')!
        .querySelector('.sidebar__board-glyph');
    expect(glyph('Daily brief')?.textContent).toBe('☀');
    // No icon of its own: the shared app mark.
    expect(glyph('Release desk')?.querySelector('svg')).not.toBeNull();
  });

  test('a fresh install shows the Apps hint and Discover, and Customize has no dot', async () => {
    state.engines = [
      engine('claude-code', 'Claude Code'),
      engine('codex', 'Codex'),
    ];
    renderSidebar();
    expect(
      await screen.findByText('Apps you add get their own screen here.'),
    ).toBeTruthy();
    expect(screen.queryByText('Boards across Projects.')).toBeNull();
    expect(
      await screen.findByRole('button', { name: 'Discover' }),
    ).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Customize' }),
    ).toBeTruthy();
    expect(document.querySelector('.sidebar__quiet-dot')).toBeNull();
  });

  test('Customize carries a dot when an item inside needs attention, and says so', async () => {
    state.engines = [engine('codex', 'Codex', { enabled: false })];
    renderSidebar();
    const customize = await screen.findByRole('button', {
      name: 'Customize, needs attention',
    });
    expect(customize.querySelector('.sidebar__quiet-dot')).not.toBeNull();
    // The words are for assistive technology; the row still reads Customize.
    expect(customize.querySelector('.sidebar__project-name')?.textContent).toBe(
      'Customize',
    );
  });

  test('a failed tool probe also raises the Customize dot', async () => {
    state.tools = [
      {
        id: 'audit-echo',
        connected: false,
        probe: { ok: false, toolCount: 0 },
      },
    ];
    renderSidebar();
    expect(
      await screen.findByRole('button', { name: 'Customize, needs attention' }),
    ).toBeTruthy();
  });

  test.each([
    ['Automations', '/automations'],
    ['Discover', '/apps/discover'],
    ['Customize', '/customize'],
    ['Settings', '/settings'],
  ])('%s opens %s', async (name, path) => {
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name }));
    expect(navigate).toHaveBeenCalledWith(path);
  });

  test('an app row opens the app', async () => {
    state.boards = [{ id: 'b1', slug: 'daily-brief', name: 'Daily brief' }];
    renderSidebar();
    fireEvent.click(await screen.findByText('Daily brief'));
    expect(navigate).toHaveBeenCalledWith('/boards/daily-brief');
  });

  test.each([
    ['/automations', ['Automations']],
    ['/apps/discover', ['Discover']],
    ['/apps/library', ['Discover']],
    ['/customize', ['Customize']],
    // Each Customize item marks the Customize row.
    ['/agents', ['Customize']],
    ['/guidance', ['Customize']],
    ['/customize/engines', ['Customize']],
    ['/customize/providers', ['Customize']],
    ['/customize/tools', ['Customize']],
    ['/customize/knowledge', ['Customize']],
    ['/settings', ['Settings']],
    ['/boards/daily-brief', ['Daily brief']],
  ])('at %s exactly one row is current: %j', async (path, expected) => {
    state.pathname = path;
    state.boards = [{ id: 'b1', slug: 'daily-brief', name: 'Daily brief' }];
    renderSidebar();
    await settingsRow();
    await screen.findByRole('button', { name: 'Discover' });
    await screen.findByRole('button', { name: 'Automations' });
    expect(currentRows()).toEqual(expected);
  });

  test('a project page marks its project row and no quiet row', async () => {
    state.pathname = '/projects/notes-api';
    state.selectedProject = 'notes-api';
    state.projects = [{ id: 'p1', slug: 'notes-api', name: 'Notes API' }];
    renderSidebar();
    await settingsRow();
    await screen.findByRole('button', { name: 'Automations' });
    expect(currentRows()).toEqual([]);
    expect(
      screen
        .getByText('Notes API')
        .closest('button')!
        .classList.contains('sidebar__project-btn--active'),
    ).toBe(true);
  });

  test('Home is the current row at / and reveals Home', async () => {
    renderSidebar();
    await settingsRow();
    await screen.findByRole('button', { name: 'Automations' });
    expect(currentRows()).toEqual(['Home']);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(showSurfaceStub).toHaveBeenCalledWith('home');
  });

  test('the collapsed rail keeps Home, Automations, project initials, app icons, Discover, Customize with its dot and Settings', async () => {
    deviceSettingsStore.set('projectSidebarCollapsed', true);
    state.previews = [...QUIET_ON, { id: 'apps-library', enabled: true }];
    state.engines = [engine('codex', 'Codex', { enabled: false })];
    state.projects = [{ id: 'p1', slug: 'notes-api', name: 'Notes API' }];
    state.boards = [{ id: 'b1', slug: 'daily-brief', name: 'Daily brief' }];
    renderSidebar();
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(nav.classList.contains('sidebar--collapsed')).toBe(true);
    for (const name of [
      'New chat',
      'Home',
      'Automations',
      'Discover',
      'Settings',
    ]) {
      const row = await screen.findByRole('button', { name });
      // A rail row is named by its tooltip, since its label is hidden.
      if (name !== 'Home') expect(row.getAttribute('title')).toBe(name);
    }
    expect(
      screen.getByRole('button', { name: /^Notes API views/ }),
    ).toBeTruthy();
    // The app is its own rail row, not behind one Apps button.
    expect(screen.getByTitle('Daily brief')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apps' })).toBeNull();
    const customize = await screen.findByRole('button', {
      name: 'Customize, needs attention',
    });
    expect(customize.querySelector('.sidebar__quiet-dot')).not.toBeNull();
    // The Apps library's labelled button does not fit the icon column.
    expect(screen.queryByRole('button', { name: 'Browse apps' })).toBeNull();
    // No utilities popover: Customize and Settings are on the rail itself.
    expect(
      screen.queryByRole('button', { name: 'Sidebar utilities' }),
    ).toBeNull();
  });

  test('the phone drawer has the same structure, closes on a row and returns focus', async () => {
    state.isMobile = true;
    state.boards = [{ id: 'b1', slug: 'daily-brief', name: 'Daily brief' }];
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-controls', 'mobile-navigation');
    trigger.textContent = 'Open navigation';
    document.body.append(trigger);
    trigger.focus();
    renderSidebar();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('toggle-sidebar', { detail: { trigger } }),
      );
    });
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(nav.classList.contains('sidebar--expanded')).toBe(true);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Close navigation',
      ),
    );
    for (const name of [
      'New chat',
      'Home',
      'Automations',
      'Daily brief',
      'Discover',
      'Customize',
      'Settings',
    ]) {
      expect(await within(nav).findByText(name)).toBeTruthy();
    }
    const footer = nav.querySelector('.sidebar__footer--quiet') as HTMLElement;
    expect(
      within(footer).getByRole('button', { name: 'Settings' }),
    ).toBeTruthy();
    fireEvent.click(within(footer).getByRole('button', { name: 'Customize' }));
    expect(navigate).toHaveBeenCalledWith('/customize');
    expect(nav.classList.contains('sidebar--expanded')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  test('the Customize row is the first-run tour anchor, as the old footer control was', async () => {
    renderSidebar();
    const customize = await screen.findByRole('button', { name: 'Customize' });
    expect(customize.getAttribute('data-first-run-anchor')).toBe('customize');
    expect(
      document.querySelectorAll('[data-first-run-anchor="customize"]'),
    ).toHaveLength(1);
  });

  test('with the Apps library preview also on, Discover is the only add path', async () => {
    state.previews = [...QUIET_ON, { id: 'apps-library', enabled: true }];
    renderSidebar();
    await screen.findByRole('button', { name: 'Discover' });
    expect(screen.queryByRole('button', { name: 'Browse apps' })).toBeNull();
  });

  test('an app row whose name is cut off carries it as a tooltip, and only then', async () => {
    state.boards = [
      { id: 'b1', slug: 'release-desk', name: 'Release desk for the quarter' },
    ];
    renderSidebar();
    const row = (
      await screen.findByText('Release desk for the quarter')
    ).closest('button')!;
    const name = row.querySelector('.sidebar__project-name')!;
    Object.defineProperty(name, 'clientWidth', {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(name, 'scrollWidth', {
      configurable: true,
      value: 180,
    });
    fireEvent.pointerEnter(row);
    expect(row.getAttribute('title')).toBe('Release desk for the quarter');
    Object.defineProperty(name, 'scrollWidth', {
      configurable: true,
      value: 100,
    });
    fireEvent.pointerEnter(row);
    expect(row.getAttribute('title')).toBe('');
  });
});

describe('the quiet sidebar before the previews read answers', () => {
  async function quietMounted() {
    await settingsRow();
    await screen.findByRole('button', { name: 'Automations' });
    // The old sidebar's Boards `+` and footer icon buttons never mounted.
    expect(screen.queryByRole('button', { name: 'New Board' })).toBeNull();
    expect(document.querySelector('.sidebar__footer-actions')).toBeNull();
    expect(document.querySelector('.sidebar__footer--quiet')).not.toBeNull();
  }

  test('a pending read with the preview last known on draws the quiet sidebar at once', async () => {
    window.localStorage.setItem(LAST_KNOWN_KEY, 'on');
    state.previews = undefined;
    renderSidebar();
    await quietMounted();
  });

  test('a failed read with nothing cached does the same', async () => {
    window.localStorage.setItem(LAST_KNOWN_KEY, 'on');
    state.previews = undefined;
    renderSidebar();
    await quietMounted();
    // Still quiet after the boundary settles: nothing swaps it back.
    await waitFor(() =>
      expect(document.querySelector('.sidebar__footer--quiet')).not.toBeNull(),
    );
  });

  test('with no remembered answer a pending read draws the old sidebar', async () => {
    state.previews = undefined;
    renderSidebar();
    expect(
      await screen.findByRole('button', { name: 'New Board' }),
    ).toBeTruthy();
    expect(document.querySelector('.sidebar__footer--quiet')).toBeNull();
  });

  test('the remembered answer follows the read, on and off', async () => {
    const view = renderSidebar();
    await settingsRow();
    expect(window.localStorage.getItem(LAST_KNOWN_KEY)).toBe('on');
    view.unmount();
    state.previews = [{ id: 'quiet-sidebar', enabled: false }];
    renderSidebar();
    await screen.findByRole('button', { name: 'New Board' });
    expect(window.localStorage.getItem(LAST_KNOWN_KEY)).toBe('off');
  });
});

describe('the quiet sidebar New chat row', () => {
  test('asks the dock for a new chat and is never current', async () => {
    const accept = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(OPEN_NEW_CHAT_EVENT, accept);
    try {
      renderSidebar();
      const row = await screen.findByRole('button', { name: 'New chat' });
      expect(row.getAttribute('aria-current')).toBeNull();
      fireEvent.click(row);
      expect(accept).toHaveBeenCalledTimes(1);
      expect(setDockState).not.toHaveBeenCalled();
      expect(currentRows()).not.toContain('New chat');
    } finally {
      window.removeEventListener(OPEN_NEW_CHAT_EVENT, accept);
    }
  });

  test('with no dock listening it shows the chat dock instead', async () => {
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }));
    expect(setDockState).toHaveBeenCalledWith(true);
  });

  test('its hint is the dock shortcut as bound now', async () => {
    renderSidebar(
      <>
        <DockShortcut />
        <ProjectSidebar />
      </>,
    );
    const row = await screen.findByRole('button', { name: 'New chat' });
    await waitFor(() =>
      expect(row.querySelector('.sidebar__quiet-hint')?.textContent).toMatch(
        /T$/,
      ),
    );
    act(() => rebind?.('y'));
    await waitFor(() =>
      expect(row.querySelector('.sidebar__quiet-hint')?.textContent).toMatch(
        /Y$/,
      ),
    );
  });

  test('on the rail it is an icon row whose tooltip carries the hint', async () => {
    deviceSettingsStore.set('projectSidebarCollapsed', true);
    renderSidebar(
      <>
        <DockShortcut />
        <ProjectSidebar />
      </>,
    );
    const row = await screen.findByRole('button', { name: 'New chat' });
    await waitFor(() =>
      expect(row.getAttribute('title')).toMatch(/^New chat \(.*T\)$/),
    );
    expect(row.querySelector('.sidebar__quiet-hint')).toBeNull();
  });

  test('in the phone drawer it closes the drawer, then asks for the chat, with no hint', async () => {
    state.isMobile = true;
    const order: string[] = [];
    const accept = (event: Event) => {
      order.push(
        document
          .querySelector('#mobile-navigation')!
          .classList.contains('sidebar--expanded')
          ? 'requested while open'
          : 'requested after close',
      );
      event.preventDefault();
    };
    window.addEventListener(OPEN_NEW_CHAT_EVENT, accept);
    try {
      renderSidebar(
        <>
          <DockShortcut />
          <ProjectSidebar />
        </>,
      );
      act(() => {
        window.dispatchEvent(new CustomEvent('toggle-sidebar'));
      });
      const row = await screen.findByRole('button', { name: 'New chat' });
      expect(row.querySelector('.sidebar__quiet-hint')).toBeNull();
      fireEvent.click(row);
      expect(order).toEqual(['requested after close']);
    } finally {
      window.removeEventListener(OPEN_NEW_CHAT_EVENT, accept);
    }
  });
});
