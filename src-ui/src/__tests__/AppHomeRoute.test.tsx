/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, Suspense, useEffect } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import App from '../App';
import { bannerStore } from '../contexts/banner-store';
import { openChatsStore } from '../contexts/open-chats-store';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { DEFAULT_DEVICE_REGION_ARRANGEMENT } from '../regions/region-model';

vi.mock('../contexts/open-chats-store', () => ({
  openChatsStore: {
    focus: vi.fn(),
    openCollection: vi.fn(),
    registerNavigation: ({ focus }: any) => {
      openChatsStore.focus = focus;
      return vi.fn();
    },
  },
  useOpenChats: () => [],
}));

interface QueryState<T> {
  data?: T;
  isLoading?: boolean;
  isError?: boolean;
}

interface ProjectFixture {
  slug: string;
  name?: string;
}

interface LayoutFixture {
  slug: string;
}

interface SelectedLayoutFixture {
  type?: string;
  config?: Record<string, unknown>;
  catalogContribution?: {
    id: string;
    version: string;
    sourceIdentity: { id: string; kind: 'builtin' | 'local' | 'remote' };
    provenance: { origin: 'builtin' | 'plugin' | 'mcp'; pluginId?: string };
  };
}

const {
  hooks,
  homeConnection,
  authenticatedFetch,
  connectionState,
  coreUpdateStatus,
  invalidateQueries,
  navigate,
  showSurface,
  setDockMode,
  setLayout,
  showToast,
  chatControllerAction,
  registerRegionSurfaceHost,
} = vi.hoisted(() => ({
  hooks: {
    projects: { data: [], isLoading: false, isError: false } as QueryState<
      ProjectFixture[]
    >,
    layouts: { data: [], isLoading: false, isError: false } as QueryState<
      LayoutFixture[]
    >,
    layout: {
      data: undefined,
      isLoading: false,
    } as QueryState<SelectedLayoutFixture>,
    navigation: {
      lastProject: null as string | null,
      lastProjectLayout: null as string | null,
      dockMode: 'bottom' as const,
    },
    // `null` is the legacy no-provider mount every other test in this file
    // uses. A test that needs App's region wiring supplies a stub instead.
    regionModel: null as Record<string, unknown> | null,
  },
  homeConnection: {
    id: 'home-connection',
    environmentId: 'home-environment',
  },
  authenticatedFetch: vi.fn(),
  connectionState: {
    status: 'connected',
    reason: null as string | null,
  },
  coreUpdateStatus: {
    data: undefined as
      | {
          updateAvailable: boolean;
          installKind?: 'source-checkout' | 'desktop-bundle' | 'unknown';
          applyMethod?: 'git-pull' | 'reinstall' | 'self-update';
          behind?: number;
          channel?: string;
        }
      | undefined,
  },
  invalidateQueries: vi.fn(),
  navigate: vi.fn(),
  showSurface: vi.fn(),
  setDockMode: vi.fn(),
  setLayout: vi.fn(),
  showToast: vi.fn(),
  chatControllerAction: vi.fn(),
  registerRegionSurfaceHost: vi.fn(() => () => undefined),
}));

vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch,
  useSystemStatusForApiBaseQuery: () => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
  }),
  useProjectsQuery: () => hooks.projects,
  useProjectLayoutsQuery: () => hooks.layouts,
  useProjectLayoutQuery: () => hooks.layout,
  useCoreUpdateStatusQuery: () => coreUpdateStatus,
  useQueryClient: () => ({ invalidateQueries }),
  // App raises OS alerts for blocking requests (#1912); this route's subject
  // is navigation, so an empty notification list keeps it silent.
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: () => ({ data: [] }),
}));
// The SDK mock above covers the ROOT BARREL only. Query domains that ship as
// dedicated subpath exports (to keep them out of the entry bundle's hoisted
// graph) are separate module specifiers and are NOT covered by it — an
// unmocked one reaches real react-query and throws "No QueryClient set",
// which this route's deferred overlays render as a second role="alert" and
// which reads here as an unrelated query failure. Mock the subpath too.
vi.mock('@kontourai/station-sdk/resource-posture', () => ({
  useResourcePostureQuery: () => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
  }),
}));
// `connectionFailureCopy` is deliberately the REAL implementation: the
// per-reason unavailable test below asserts the copy the user actually reads,
// so a stub would let App wire the reason to nothing and still pass
// (archive#3711).
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  connectionFailureCopy: (
    await importOriginal<typeof import('@kontourai/station-connect')>()
  ).connectionFailureCopy,
  useConnections: () => ({
    activeConnection: homeConnection,
  }),
  useConnectionStatus: () => ({
    status: connectionState.status,
    reason: connectionState.reason,
  }),
}));

/**
 * A route chunk this file can hold open, so the navigation tests below can
 * observe what App's own `setCurrentView` does to a route that is not ready
 * yet. Only `schedule` suspends; every other route in this file renders
 * synchronously, so the `<Suspense>` wrapper added to the mock is transparent
 * to the tests that were here before it.
 */
const scheduleChunk = vi.hoisted(() => {
  const state = { arrived: false };
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      state.arrived = true;
      resolve();
    };
  });
  return { state, promise, release: () => release() };
});

vi.mock('../app-shell/AppViewContent', () => ({
  AppViewContent: ({
    currentView,
    onNavigate,
    onShowHome,
  }: {
    currentView: unknown;
    onNavigate: (view: unknown) => void;
    onShowHome: () => void;
  }) => (
    <>
      {/* Mirrors the real component's structure: the route body sits inside a
          Suspense boundary that AppViewContent owns, so whether a fallback
          replaces the departing body is decided by the PRIORITY of the update
          App dispatches — which is what the navigation-urgency tests read. */}
      <Suspense
        fallback={<div data-testid="route-pending-stub">route pending</div>}
      >
        <RouteBody currentView={currentView} />
      </Suspense>
      {(currentView as { type?: string }).type === 'layout' && (
        <ChatLayoutController />
      )}
      <button type="button" onClick={() => onNavigate({ type: 'schedule' })}>
        Go to Schedule
      </button>
      {/* The real not-found view's "Go home" (`AppViewContent.test.tsx` pins
          that it calls `onShowHome`); this fixture reads what App hands it. */}
      <button type="button" onClick={onShowHome}>
        Go home
      </button>
    </>
  ),
}));

function RouteBody({ currentView }: { currentView: unknown }) {
  if (
    (currentView as { type?: string }).type === 'schedule' &&
    !scheduleChunk.state.arrived
  ) {
    throw scheduleChunk.promise;
  }
  return (
    <div data-testid="app-view-content">{JSON.stringify(currentView)}</div>
  );
}

function ChatLayoutController() {
  useEffect(() => {
    const unregister = openChatsStore.registerNavigation({
      focus: () => chatControllerAction('fullscreen:focus'),
      openCollection: vi.fn(),
    });
    const onNewChat = () => chatControllerAction('fullscreen:new');
    window.addEventListener('station:open-new-chat', onNewChat);
    return () => {
      unregister();
      window.removeEventListener('station:open-new-chat', onNewChat);
    };
  }, []);
  return <div data-testid="fullscreen-chat-controller" />;
}

vi.mock('../components/chat-dock/ChatDock', () => ({
  ChatDock: () => {
    useEffect(() => {
      const unregister = openChatsStore.registerNavigation({
        focus: () => chatControllerAction('dock:focus'),
        openCollection: vi.fn(),
      });
      const onNewChat = () => chatControllerAction('dock:new');
      window.addEventListener('station:open-new-chat', onNewChat);
      return () => {
        unregister();
        window.removeEventListener('station:open-new-chat', onNewChat);
      };
    }, []);
    return <div data-testid="ambient-chat-controller" />;
  },
}));
vi.mock('../components/CommandPalette', () => ({
  CommandPalette: () => null,
}));
// #928 C2a: the Activity shell is what `main` renders when Activity occupies
// it. Stubbed: its content (the sessions surface) is not this route's
// subject; WHICH shell the outlet mounts, and with which region, is.
vi.mock('../app-shell/ActivityRegionShell', () => ({
  ActivityRegionShell: ({ regionId }: { regionId: string }) => (
    <div data-testid="activity-region-shell">{regionId}</div>
  ),
}));
vi.mock('../components/header/Header', () => ({ Header: () => null }));
vi.mock('../components/notifications/ConnectionBannerSource', () => ({
  ConnectionBannerSource: () => null,
}));
vi.mock('../components/project-sidebar/ProjectSidebar', () => ({
  ProjectSidebar: () => null,
}));
vi.mock('../components/ShortcutsCheatsheet', () => ({
  ShortcutsCheatsheet: () => null,
}));
vi.mock('../components/voice/VoicePill', () => ({ VoicePill: () => null }));
// Both hooks, because EnginesStep calls `useAgentsLoaded` and this route
// renders it. Spreading the real module instead would pull the real
// AgentsContext, which reaches the SDK and needs a second, larger mock —
// so this stays a bare factory and simply has to stay complete. That is
// the standing hazard: the next export added here fails in a file whose
// author never opened this one (archive#3112).
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => true,
  useAgentsSettled: () => true,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => ({ defaultModel: 'codex-mini' }),
  useConfigActions: () => ({ updateConfig: vi.fn() }),
}));
vi.mock('../contexts/ModelsContext', () => ({ useModels: () => [] }));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    lastProject: hooks.navigation.lastProject,
    lastProjectLayout: hooks.navigation.lastProjectLayout,
    dockMode: hooks.navigation.dockMode,
    setLayout,
    setDockMode,
    navigate,
  }),
}));
vi.mock('../contexts/ProjectsContext', () => ({
  ProjectsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => hooks.regionModel,
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}));
vi.mock('../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({ settings: { voiceS2SEnabled: false } }),
}));
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: vi.fn(),
}));
vi.mock('../hooks/useServerEvents', () => ({ useServerEvents: vi.fn() }));
vi.mock('../hooks/useQueryCacheReconnectSync', () => ({
  useQueryCacheReconnectSync: vi.fn(),
}));
vi.mock('../hooks/useOutboundQueueFlush', () => ({
  useOutboundQueueFlush: vi.fn(),
}));
vi.mock('../lib/apiClient', () => ({ setAuthCallback: vi.fn() }));

function resetHooks() {
  hooks.projects = { data: [], isLoading: false, isError: false };
  hooks.layouts = { data: [], isLoading: false, isError: false };
  hooks.layout = { data: undefined, isLoading: false, isError: false };
  hooks.navigation = {
    lastProject: null,
    lastProjectLayout: null,
    dockMode: 'bottom',
  };
  hooks.regionModel = null;
  registerRegionSurfaceHost.mockClear();
  coreUpdateStatus.data = undefined;
  window.history.replaceState({}, '', '/');
  invalidateQueries.mockClear();
  navigate.mockClear();
  showSurface.mockClear();
  setDockMode.mockClear();
  setLayout.mockClear();
  showToast.mockClear();
  chatControllerAction.mockClear();
  vi.mocked(useKeyboardShortcut).mockClear();
}

describe('App home route resolution', () => {
  beforeEach(() => {
    bannerStore.reset();
    resetHooks();
    connectionState.status = 'connected';
    connectionState.reason = null;
    authenticatedFetch.mockReset();
  });

  test('loads the deferred launch update checker and presents its banner', async () => {
    coreUpdateStatus.data = {
      updateAvailable: true,
      installKind: 'source-checkout',
      applyMethod: 'git-pull',
      behind: 3,
    };

    render(<App />);

    expect((await screen.findByRole('status')).textContent).toContain(
      'Station update available — 3 commits behind.',
    );
  });

  test('renders pending root route without exposing stale restore state, then settles on Home without redirecting', async () => {
    hooks.navigation.lastProject = 'ghost-project';
    hooks.navigation.lastProjectLayout = 'ghost-layout';
    hooks.projects = { data: [], isLoading: true, isError: false };

    const { rerender } = render(<App />);
    await act(async () => undefined);

    expect(
      screen.getByRole('status', { name: /loading your workspace/i }),
    ).toBeTruthy();
    expect(screen.queryByTestId('app-view-content')).toBeNull();

    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.layouts = {
      data: [{ slug: 'code' }],
      isLoading: false,
      isError: false,
    };
    await act(async () => rerender(<App />));

    expect(screen.getByTestId('app-view-content').textContent).toBe(
      '{"type":"home"}',
    );
    expect(screen.getByTestId('app-view-content').textContent).not.toContain(
      'ghost-project',
    );
    expect(setLayout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  test('retrying a first-project layouts error invalidates projects and layout query keys', async () => {
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.layouts = { data: [], isLoading: false, isError: true };

    render(<App />);
    await act(async () => undefined);

    expect(screen.getByRole('alert').textContent).toContain(
      "Station could not load the first project's layouts.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ['projects'],
    });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ['projects', 'dev', 'layouts'],
    });
  });

  // archive#3711: the old state here claimed "offline" for EVERY
  // non-connected status — an auth rejection against a reachable Station
  // became a false device-network claim. With no reason yet derived, the copy
  // claims nothing beyond unavailability; with a typed reason, it renders
  // that reason's own actionable copy (#3297).
  test('renders an in-place unavailable workspace state without an impossible retry', async () => {
    connectionState.status = 'error';
    hooks.projects = { data: [], isLoading: false, isError: true };

    render(<App />);
    await act(async () => undefined);

    expect(
      screen.getByText('This Station is unavailable right now'),
    ).toBeTruthy();
    // The word the old state asserted must be gone: nothing here observed a
    // device network state.
    expect(screen.queryByText(/offline/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  // The reason-threading is caller wiring App.tsx owns (the resolver unit
  // tests cannot see it): replacing `connectionFailureReason` with null at
  // the resolveHomeSurface call site must redden THIS test.
  test('renders the per-reason copy when the connection layer has a verdict', async () => {
    connectionState.status = 'error';
    connectionState.reason = 'authentication-failed';
    hooks.projects = { data: [], isLoading: false, isError: true };

    render(<App />);
    await act(async () => undefined);

    // connectionFailureCopy('authentication-failed', host): the summary names
    // the host and the refusal; the action names re-pairing. Assert the
    // distinctive fragments rather than the full sentence so copy edits in
    // the connect package don't false-fail this wiring test.
    expect(screen.getByText(/isn't accepting this device/)).toBeTruthy();
    expect(screen.queryByText(/offline/i)).toBeNull();
  });

  // #928 slice C: App's `navigateToView` no longer intercepts an `activity`
  // view — the union has no such member. The producers that used to mint it
  // (Home's "View Activity", "Open Activity" and continue-work seams) call
  // `showSurface` themselves, and `HomeView.test.tsx` asserts that directly
  // against the real Home render rather than through a fixture button here.

  test('/?project=<name> pre-selects the matching project via setLayout, overriding lastProject, and strips the param', () => {
    // A persisted lastProject would normally win; the deep-link must override it.
    hooks.navigation.lastProject = 'persisted';
    hooks.navigation.lastProjectLayout = 'persisted-layout';
    hooks.projects = {
      data: [{ slug: 'persisted' }, { slug: 'target-slug', name: 'Target' }],
      isLoading: false,
      isError: false,
    };
    hooks.layouts = {
      data: [{ slug: 'code' }],
      isLoading: false,
      isError: false,
    };
    // Match by display name to prove slug/name matching (navigation uses slug).
    window.history.replaceState({}, '', '/?project=Target');

    render(<App />);

    expect(setLayout).toHaveBeenCalledWith('target-slug', 'code');
    expect(window.location.search).toBe('');
  });

  test('/?project=<name> falls back to auto-select when nothing matches, without erroring, and consumes the param', () => {
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.layouts = {
      data: [{ slug: 'code' }],
      isLoading: false,
      isError: false,
    };
    window.history.replaceState({}, '', '/?project=ghost-project');

    render(<App />);

    // No project matched: the deep-link applies nothing and the normal Home
    // route renders (the first-project continuation), never a navigation.
    expect(setLayout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('app-view-content').textContent).toBe(
      '{"type":"home"}',
    );
    expect(window.location.search).toBe('');
  });

  test('mounts one chat event owner for a full-screen chat layout', async () => {
    window.history.replaceState({}, '', '/projects/demo/layouts/chat');
    hooks.layout = { data: { type: 'chat' }, isLoading: false };

    render(<App />);
    await act(async () => undefined);

    expect(screen.getByTestId('fullscreen-chat-controller')).toBeTruthy();
    expect(screen.queryByTestId('ambient-chat-controller')).toBeNull();

    openChatsStore.focus({ sessionId: 'fixture' });
    window.dispatchEvent(new CustomEvent('station:open-new-chat'));

    expect(chatControllerAction).toHaveBeenCalledTimes(2);
    expect(chatControllerAction).toHaveBeenNthCalledWith(1, 'fullscreen:focus');
    expect(chatControllerAction).toHaveBeenNthCalledWith(2, 'fullscreen:new');
  });

  /**
   * #928. `RegionShells` is the only host that renders a region surface, and
   * App mounts it solely while `showAmbientChatDock` holds. That suppression
   * is why `showSurface` alone could not reveal anything from a Chat
   * workspace layout, so the host's own registration — what `useShowSurface`
   * reads to decide between commanding the model and navigating — is asserted
   * against App's real gate rather than against a restatement of it.
   */
  const regionModelStub = () => ({
    regions: DEFAULT_DEVICE_REGION_ARRANGEMENT,
    lastShownRegion: 'bottom',
    registerRegionSurfaceHost,
    placeSurface: vi.fn(),
  });

  /**
   * #1385 review: the mobile full-screen predicate reads the shell a coarse
   * device RENDERS — the folded dock region (`foldedDockRegion`, the same
   * expression `RegionShells` mounts by) — whatever its occupant, matching
   * its own docblock ("any occupant, not just Chat"). Navigation's flags are
   * absent from this file's mock, so a predicate reading them cannot pass
   * these; one reading Chat's region alone cannot pass the Activity case.
   */
  describe('the mobile full-screen dock follows the rendered shell (#1385)', () => {
    const MOBILE_MEDIA_QUERY =
      '(max-width: 768px), (max-height: 540px) and (pointer: coarse)';
    const appMain = () => document.querySelector('.app__main');
    const fullscreenClass = 'app__main--mobile-dock-fullscreen';

    function installMobileViewport() {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === MOBILE_MEDIA_QUERY,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }));
    }

    test.each([
      {
        name: 'Activity maximized as the folded occupant',
        regions: {
          ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
          right: {
            visible: true,
            size: 400,
            occupant: 'activity',
            maximized: true,
          },
        },
        lastShownRegion: 'right' as const,
        fullscreen: true,
      },
      {
        name: 'Chat maximized as the folded occupant (unchanged behaviour)',
        regions: {
          ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
          bottom: {
            visible: true,
            size: 320,
            occupant: 'chat',
            maximized: true,
          },
        },
        lastShownRegion: 'bottom' as const,
        fullscreen: true,
      },
      {
        name: 'Activity shown but not maximized',
        regions: {
          ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
          right: {
            visible: true,
            size: 400,
            occupant: 'activity',
            maximized: false,
          },
        },
        lastShownRegion: 'right' as const,
        fullscreen: false,
      },
    ])('$name', async ({ regions, lastShownRegion, fullscreen }) => {
      installMobileViewport();
      try {
        hooks.regionModel = {
          ...regionModelStub(),
          regions,
          lastShownRegion,
        };

        render(<App />);
        await act(async () => undefined);

        expect(appMain()).not.toBeNull();
        expect(appMain()?.classList.contains(fullscreenClass)).toBe(fullscreen);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  test('registers a region surface host on Home', async () => {
    hooks.regionModel = regionModelStub();

    render(<App />);
    await act(async () => undefined);

    expect(registerRegionSurfaceHost).toHaveBeenCalled();
  });

  /**
   * #928 C2a: `/` renders the `main` region's occupant, and with the default
   * arrangement (Home in `main`) that is the Home route. What these prove is
   * the outlet's STRUCTURE under the region model — the route body is the
   * direct child of `main#station-main > .content-view`, with no shell
   * wrapper around it, and each of the Home route's four states still
   * reaches `/`. They do not compare against the pre-C2a tree: that tree is
   * gone from this branch, so "identical to base" is a claim only a
   * cross-tree capture could make. The no-model mount is asserted against
   * the same structure, which is what "the shell adds nothing" reduces to.
   *
   * `HomeView`'s own root (`section.home-view`) is inside the mocked
   * `AppViewContent` here and is pinned by `HomeView.test.tsx`.
   */
  const outlet = () =>
    document.querySelector('main#station-main > .content-view');

  test('the default arrangement renders the Home route body as the direct child of the outlet', async () => {
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.layouts = {
      data: [{ slug: 'code' }],
      isLoading: false,
      isError: false,
    };
    expect(DEFAULT_DEVICE_REGION_ARRANGEMENT.main.occupant).toBe('home');

    for (const regionModel of [null, regionModelStub()]) {
      hooks.regionModel = regionModel;
      const rendered = render(<App />);
      await act(async () => undefined);

      const content = outlet();
      expect(content).not.toBeNull();
      // The mocked `AppViewContent` renders two siblings (the route body and
      // its navigation fixture button); the route body comes first, with no
      // element between the outlet and it.
      const body = screen.getByTestId('app-view-content');
      expect(body.parentElement).toBe(content);
      expect(content?.firstElementChild).toBe(body);
      expect(body.textContent).toBe('{"type":"home"}');
      expect(screen.queryByTestId('activity-region-shell')).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      rendered.unmount();
    }
  });

  test('the pending skeleton renders at / under the default arrangement', async () => {
    hooks.projects = { data: [], isLoading: true, isError: false };
    hooks.regionModel = regionModelStub();

    render(<App />);
    await act(async () => undefined);

    const status = screen.getByRole('status', {
      name: /loading your workspace/i,
    });
    expect(status.closest('main#station-main > .content-view')).toBe(outlet());
    expect(screen.queryByTestId('app-view-content')).toBeNull();
  });

  test('the host-unavailable state renders at / under the default arrangement', async () => {
    connectionState.status = 'error';
    hooks.projects = { data: [], isLoading: false, isError: true };
    hooks.regionModel = regionModelStub();

    render(<App />);
    await act(async () => undefined);

    const unavailable = screen.getByText(
      'This Station is unavailable right now',
    );
    expect(unavailable.closest('main#station-main > .content-view')).toBe(
      outlet(),
    );
    expect(screen.queryByTestId('app-view-content')).toBeNull();
  });

  test('the error state renders at / under the default arrangement', async () => {
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.layouts = { data: [], isLoading: false, isError: true };
    hooks.regionModel = regionModelStub();

    render(<App />);
    await act(async () => undefined);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      "Station could not load the first project's layouts.",
    );
    expect(alert.closest('main#station-main > .content-view')).toBe(outlet());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  test('with Activity in main, / renders the Activity shell for main and not Home', async () => {
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.regionModel = {
      ...regionModelStub(),
      regions: {
        ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
        main: { visible: true, size: 0, occupant: 'activity' },
      },
    };

    render(<App />);
    await act(async () => undefined);

    const shell = await screen.findByTestId('activity-region-shell');
    expect(shell.textContent).toBe('main');
    expect(shell.closest('main#station-main')).not.toBeNull();
    expect(screen.queryByTestId('app-view-content')).toBeNull();
    expect(screen.queryByRole('status', { name: /loading/i })).toBeNull();
  });

  test('a main occupant with no registered shell (a retired id) renders Home, not a blank outlet', async () => {
    // Orchestrator fault injection on the C2a branch: replacing the
    // `MainRegionSurface` fallback with `() => null` stayed green, so the
    // stale-id branch had no test. A persisted arrangement (slice D) can
    // name a surface a later build no longer registers; the outlet must
    // fall back to Home rather than render nothing.
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.regionModel = {
      ...regionModelStub(),
      regions: {
        ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
        main: { visible: true, size: 0, occupant: 'retired-surface' },
      },
    };

    render(<App />);
    await act(async () => undefined);

    const body = await screen.findByTestId('app-view-content');
    expect(body.closest('main#station-main')).not.toBeNull();
    expect(screen.queryByTestId('activity-region-shell')).toBeNull();
  });

  test('a routed view renders on another route while main keeps its occupant', async () => {
    window.history.replaceState({}, '', '/plugins');
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    const stub = {
      ...regionModelStub(),
      setRegion: vi.fn(),
      regions: {
        ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
        main: { visible: true, size: 0, occupant: 'activity' },
      },
    };
    hooks.regionModel = stub;

    render(<App />);
    await act(async () => undefined);

    expect(screen.getByTestId('app-view-content').textContent).toBe(
      '{"type":"plugins"}',
    );
    expect(screen.queryByTestId('activity-region-shell')).toBeNull();
    // Ignored, not cleared: App writes nothing to the model on a route change.
    expect(stub.placeSurface).not.toHaveBeenCalled();
    expect(stub.setRegion).not.toHaveBeenCalled();
    expect(stub.regions.main.occupant).toBe('activity');

    // Coming back to `/` shows the kept occupant.
    await act(async () => {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByTestId('activity-region-shell')).toBeTruthy();
    expect(screen.queryByTestId('app-view-content')).toBeNull();
  });

  /**
   * #1523. Since `/` renders `main`'s occupant, "go to `/`" and "show Home"
   * are different intents, and App holds one producer of each. Both are
   * driven with Activity in `main` — the arrangement where the two diverge.
   */
  const activityInMain = () => ({
    ...regionModelStub(),
    regions: {
      ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
      main: { visible: true, size: 0, occupant: 'activity' },
    },
  });

  test('the not-found view’s Go home reveals the Home surface, not whatever occupies main', async () => {
    window.history.replaceState({}, '', '/nowhere');
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.regionModel = activityInMain();

    render(<App />);
    await act(async () => undefined);
    expect(screen.getByTestId('app-view-content').textContent).toContain(
      '"type":"not-found"',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go home' }));

    // Home BY NAME: the Home surface is placed in `main` (the model navigates
    // to `/` itself). A bare `navigate('/')` would have shown Activity.
    expect(showSurface).toHaveBeenCalledTimes(1);
    expect(showSurface).toHaveBeenCalledWith('home');
    expect(navigate).not.toHaveBeenCalled();
  });

  test('the settings toggle’s return goes to the outlet, whatever occupies main, and NOT to the Home surface', async () => {
    window.history.replaceState({}, '', '/settings');
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
    hooks.regionModel = activityInMain();

    render(<App />);
    await act(async () => undefined);
    expect(screen.getByTestId('app-view-content').textContent).toContain(
      '"type":"settings"',
    );

    // ⌘, is registered through `useKeyboardShortcut` (mocked here); the last
    // registration holds the handler closed over the current view.
    const registration = vi
      .mocked(useKeyboardShortcut)
      .mock.calls.filter(([id]) => id === 'app.settings')
      .at(-1);
    if (!registration) throw new Error('app.settings chord not registered');
    const handler = registration[4] as () => void;
    act(() => {
      handler();
    });

    // A toggle returns to where the user was — `/` and its occupant,
    // Activity here — so it must not route through the Home reveal.
    expect(navigate).toHaveBeenCalledWith('/');
    expect(showSurface).not.toHaveBeenCalled();
  });

  // #1582 H3: Escape twice on Schedule with Add Job open landed on Home. The
  // dialog was never the problem — it consumes the first Escape correctly.
  // The second reached `app.escapeUp`, which App arms from
  // `getParentView(view) !== null`, and that used to fall back to Home for
  // every unlisted view, arming the "go up" shortcut on a page with nothing
  // above it. This asserts the production wiring, not the derivation alone:
  // the registration on Schedule must be disabled, while Settings — which
  // really is a full-page overlay of Home — keeps it.
  test.each([
    ['/schedule', false],
    ['/agents', false],
    ['/settings', true],
  ])(
    'arms app.escapeUp on %s only when the view has a parent',
    async (path, expectedEnabled) => {
      window.history.replaceState({}, '', path);
      hooks.projects = { data: [], isLoading: false, isError: false };

      render(<App />);
      await act(async () => undefined);

      const registration = vi
        .mocked(useKeyboardShortcut)
        .mock.calls.filter(([id]) => id === 'app.escapeUp')
        .at(-1);
      if (!registration) throw new Error('app.escapeUp was never registered');
      expect(registration[1]).toBe('Escape');
      expect(registration[5]).toBe(expectedEnabled);
    },
  );

  test('registers no region surface host for a full-screen chat layout', async () => {
    window.history.replaceState({}, '', '/projects/demo/layouts/chat');
    hooks.layout = { data: { type: 'chat' }, isLoading: false };
    hooks.regionModel = regionModelStub();

    render(<App />);
    await act(async () => undefined);

    expect(registerRegionSurfaceHost).not.toHaveBeenCalled();
  });

  /**
   * #1446. A plugin-contributed layout may carry `type: 'chat'` and still
   * render its own declared tabs through `LayoutView`; only the layout that
   * renders `ChatWorkspaceLayout` owns the whole viewport. The suppression
   * above must not fire on the word alone, or every installed example layout
   * loses its dock, Activity, and every region surface.
   */
  test('registers a region surface host for a plugin-contributed layout typed chat', async () => {
    window.history.replaceState({}, '', '/projects/demo/layouts/minimal');
    hooks.layout = {
      data: {
        type: 'chat',
        config: {
          tabs: [
            {
              id: 'workspace',
              component: {
                kind: 'plugin-component',
                name: 'minimal-workspace',
              },
            },
          ],
        },
        catalogContribution: {
          id: 'plugin:minimal-layout:minimal',
          version: '1.0.0',
          sourceIdentity: { id: 'minimal-layout', kind: 'local' },
          provenance: { origin: 'plugin', pluginId: 'minimal-layout' },
        },
      },
      isLoading: false,
    };
    hooks.regionModel = regionModelStub();

    render(<App />);
    await act(async () => undefined);

    expect(registerRegionSurfaceHost).toHaveBeenCalled();
    expect(screen.getByTestId('ambient-chat-controller')).toBeTruthy();
  });
});

/**
 * What #3660's "the placeholder replaces the departing body" rests on, asserted
 * against App's OWN navigation rather than against a hand-dispatched re-render.
 *
 * React replaces a Suspense boundary's committed children with its fallback
 * when an **urgent** update suspends, and keeps them revealed — rendering no
 * fallback at all — when the suspending update is a transition. Station's
 * navigation is urgent today: `navigateToView` and the `popstate` listener both
 * call a plain `setCurrentView`. Nothing in the type system says so, and the
 * placeholder work in `app-shell/RoutePendingSkeleton` is only honest while it
 * stays that way, so both entry points are driven here for real: wrapping
 * either `setCurrentView` in `startTransition` leaves the departing route on
 * screen and reddens these.
 */
/**
 * React does not unmount a Suspense boundary's committed children when an
 * update suspends — it keeps them mounted and hides them with an inline
 * `display: none`. So "the departing route left the screen" is a visibility
 * question, not a presence one, and `queryByTestId` cannot answer it.
 */
function hiddenByReact(element: HTMLElement): boolean {
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    if (node.style.display === 'none') return true;
  }
  return false;
}

describe('App navigation is urgent, so a slow route reveals its placeholder', () => {
  beforeEach(() => {
    bannerStore.reset();
    resetHooks();
    connectionState.status = 'connected';
    connectionState.reason = null;
    authenticatedFetch.mockReset();
    hooks.projects = {
      data: [{ slug: 'dev' }],
      isLoading: false,
      isError: false,
    };
  });

  test('back/forward: App’s popstate listener replaces the departing route', async () => {
    window.history.replaceState({}, '', '/plugins');
    render(<App />);
    await act(async () => undefined);
    expect(screen.getByTestId('app-view-content').textContent).toBe(
      '{"type":"plugins"}',
    );

    // The real path: App listens for popstate and calls setCurrentView itself.
    await act(async () => {
      window.history.pushState({}, '', '/schedule');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(screen.getByTestId('route-pending-stub')).toBeTruthy();
    expect(hiddenByReact(screen.getByTestId('app-view-content'))).toBe(true);
  });

  test('a click through navigateToView does the same', async () => {
    window.history.replaceState({}, '', '/plugins');
    render(<App />);
    await act(async () => undefined);
    expect(screen.getByTestId('app-view-content').textContent).toBe(
      '{"type":"plugins"}',
    );

    // The other real path: a view calls `onNavigate`, which is App's
    // `navigateToView`.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go to Schedule' }));
    });

    expect(screen.getByTestId('route-pending-stub')).toBeTruthy();
    expect(hiddenByReact(screen.getByTestId('app-view-content'))).toBe(true);

    // And the placeholder is only held while the route really is unresolved.
    await act(async () => {
      scheduleChunk.release();
      await scheduleChunk.promise;
    });
    const settled = screen.getByTestId('app-view-content');
    expect(settled.textContent).toBe('{"type":"schedule"}');
    expect(hiddenByReact(settled)).toBe(false);
    expect(screen.queryByTestId('route-pending-stub')).toBeNull();
  });
});
