import {
  type ConnectionFailureReason,
  connectionFailureCopy,
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import {
  useProjectLayoutQuery,
  useProjectLayoutsQuery,
  useProjectsQuery,
  useQueryClient,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppViewContent } from './app-shell/AppViewContent';
import { HomeRoutePendingSkeleton } from './app-shell/HomeRoutePendingSkeleton';
import { resolveHomeSurface } from './app-shell/resolve-home-surface';
import {
  getLegacyPathRedirect,
  getParentView,
  getPathForView,
  resolveViewFromPath,
} from './app-shell/routing';
import { useScrollRestoration } from './app-shell/useScrollRestoration';
import { ChatAuthRecoveryProvider } from './components/chat-dock/ChatAuthRecoveryContext';
import { ChatDock } from './components/chat-dock/ChatDock';
import {
  isDockOwnedViewType,
  isMobileDockFullscreen as isMobileDockFullscreenState,
} from './components/chat-dock/mobile-chrome';
import { Header } from './components/header/Header';
import { LazyBoundary } from './components/LazyBoundary';
import { BannerHost } from './components/notifications/BannerHost';
import { ConnectionBannerSource } from './components/notifications/ConnectionBannerSource';
import { ProjectSidebar } from './components/project-sidebar/ProjectSidebar';
import { Empty, ErrorState } from './components/state';
import { useAgents } from './contexts/AgentsContext';
import { useApiBase } from './contexts/ApiBaseContext';
import { useConfig } from './contexts/ConfigContext';
import { useModels } from './contexts/ModelsContext';
import { useNavigation } from './contexts/NavigationContext';
import { ProjectsProvider } from './contexts/ProjectsContext';
import { useToast } from './contexts/ToastContext';
import { setDockModeOverride } from './hooks/useDockModePreference';
import { useDockSlotPlacement } from './hooks/useIsMobile';
import {
  type WorkspacePaneDockAction,
  WorkspacePaneDockContext,
} from './workspace-panes/WorkspacePaneDockContext';

/**
 * The cheatsheet is an overlay behind a keystroke — nothing about first paint
 * needs it, so it stays out of the entry chunk and loads when first opened.
 */
/**
 * Voice is behind `voiceS2SEnabled`, which is off unless an operator turns it
 * on, so the whole speech-to-speech surface has no business in the entry chunk.
 */
const loadVoicePill = () =>
  import('./components/voice/VoicePill').then((module) => ({
    default: module.VoicePill,
  }));

const loadShortcutsCheatsheet = () =>
  import('./components/ShortcutsCheatsheet').then((module) => ({
    default: module.ShortcutsCheatsheet,
  }));

/**
 * The command palette is an overlay, not first-paint content. Keep its command
 * catalog and search implementation out of the entry chunk while still
 * mounting it at startup so its global shortcut and event listener remain
 * available as soon as the small lazy chunk resolves.
 *
 * station#2652 review H1: the guided first run rides this SAME boundary
 * rather than adding its own — a second lazy boundary cost the entry chunk 131
 * gzip bytes of chunk-registration metadata, far more than the feature's own
 * eager bytes. See `DeferredAppOverlays`.
 */
const loadDeferredAppOverlays = () =>
  import('./components/DeferredAppOverlays');

// Update availability is asynchronous chrome: it never contributes to the
// first painted shell, and only presents a banner after its status request
// resolves. Keep its feed validation and version comparison out of that
// first-paint graph without changing the banner it eventually renders.
const loadCoreUpdateLaunchCheck = () =>
  import('./components/CoreUpdateLaunchCheck').then((module) => ({
    default: module.CoreUpdateLaunchCheck,
  }));

const loadOutboundQueueFlushMount = () =>
  import('./hooks/OutboundQueueFlushMount').then((module) => ({
    default: module.OutboundQueueFlushMount,
  }));

import { useApprovalOsAlerts } from './hooks/useApprovalOsAlerts';
import { useFeatureSettings } from './hooks/useFeatureSettings';
import { useIsMobile } from './hooks/useIsMobile';
import { useKeyboardShortcut } from './hooks/useKeyboardShortcut';
import { useQueryCacheReconnectSync } from './hooks/useQueryCacheReconnectSync';
import { useServerEvents } from './hooks/useServerEvents';
import { setAuthCallback } from './lib/apiClient';
import { checkServerHealth, probeServerConnection } from './lib/serverHealth';
import type { NavigationView } from './types';

function resolveCurrentLocation(options: {
  lastProject?: string | null;
  lastProjectLayout?: string | null;
}) {
  const currentPath = `${window.location.pathname}${window.location.search}`;
  const redirect = getLegacyPathRedirect(currentPath);
  if (redirect) window.history.replaceState(window.history.state, '', redirect);
  return resolveViewFromPath(redirect ?? currentPath, options);
}

const NO_SHORTCUT_MODIFIERS: ('cmd' | 'ctrl' | 'shift' | 'alt')[] = [];

/**
 * The query-param key the `station <dir>` launcher (station#1986) deep-links a
 * project selector under: `<uiUrl>/?project=<name>`.
 */
const PROJECT_SELECT_QUERY_KEY = 'project';

/**
 * Removes the one-shot `?project=` selector from the address bar once it has
 * been applied, mirroring the bootstrap-token flow's `history.replaceState`
 * strip so the deep-link never lingers, re-triggers, or is carried forward by
 * `navigationStore.navigate` (which preserves existing search params).
 */
function stripProjectSelectParam(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(PROJECT_SELECT_QUERY_KEY)) return;
  params.delete(PROJECT_SELECT_QUERY_KEY);
  const search = params.toString();
  const cleanUrl = `${window.location.pathname}${search ? `?${search}` : ''}${
    window.location.hash
  }`;
  window.history.replaceState(window.history.state, '', cleanUrl);
}

function App() {
  const { apiBase: API_BASE } = useApiBase();
  // The saved connection's display identity for unavailable-state copy —
  // `connectionFailureCopy`'s contract wants the short name the user saved,
  // with the URL as the address it actually tried (station#3713 review).
  const { activeConnection } = useConnections();
  const activeConnectionName = activeConnection?.name;
  const activeConnectionUrl = activeConnection?.url;
  const availableModels = useModels();
  const agents = useAgents();
  const { status: connectionStatus, reason: connectionFailureReason } =
    useConnectionStatus({
      checkHealth: checkServerHealth,
      probeEndpoint: probeServerConnection,
      pollInterval: 10_000,
    });

  // station#1912: point the operator at anything blocking on them, at the OS
  // level, on desktop hosts. In-app surfaces are unchanged.
  useApprovalOsAlerts();
  // SSE event stream — replaces all polling for ACP status, agent changes, etc.
  useServerEvents();
  // station#1223: invalidate the persisted (cache-first) query whitelist the
  // moment the connection is confirmed reachable, so restored/stale data is
  // immediately followed by a fresh refetch.
  useQueryCacheReconnectSync();
  // station#1224 (offline slice 2): drain the outbound turn queue the
  // moment the connection is confirmed reachable (and once on mount, for a
  // queue that survived a restart into an already-reachable server).
  const {
    lastProject,
    lastProjectLayout,
    dockMode: dockSlotPreference,
    isDockOpen,
    isDockMaximized,
    setLayout,
    setDockMode,
    navigate,
  } = useNavigation();
  const isMobileViewport = useIsMobile();
  const {
    available: availableDockSlotPlacements,
    effective: effectiveDockSlotPlacement,
  } = useDockSlotPlacement(dockSlotPreference);
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const {
    data: projects = [],
    isLoading: projectsLoading,
    isError: projectsError,
  } = useProjectsQuery();
  const appConfig = useConfig();
  const { settings: featureSettings } = useFeatureSettings();
  const [showShortcutsCheatsheet, setShowShortcutsCheatsheet] = useState(false);
  const [ambientDockAction, setAmbientDockAction] =
    useState<WorkspacePaneDockAction | null>(null);
  const [currentView, setCurrentView] = useState<NavigationView>(() => {
    return resolveCurrentLocation({ lastProject, lastProjectLayout });
  });

  // Navigation functions (declared early so useEffect closures can reference them)
  const navigateToView = useCallback(
    (view: NavigationView) => {
      setCurrentView(view);
      if (view.type === 'layout') {
        setLayout(view.projectSlug, view.layoutSlug);
        return;
      }
      const path = getPathForView(view);
      if (path) {
        if (view.type === 'activity') {
          navigate('/activity', { session: view.sessionId ?? null });
          return;
        }
        navigate(path);
      }
    },
    [navigate, setLayout],
  );

  const navigateHome = useCallback(() => {
    navigate('/');
  }, [navigate]);

  // Listen for path changes (back/forward navigation)
  useEffect(() => {
    const handlePathChange = () => {
      setCurrentView(
        resolveCurrentLocation({ lastProject, lastProjectLayout }),
      );
    };

    handlePathChange(); // Initial call
    window.addEventListener('popstate', handlePathChange);
    return () => {
      window.removeEventListener('popstate', handlePathChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastProject, lastProjectLayout]);

  // Setup auth callback
  useEffect(() => {
    const authCallback = async () => Promise.resolve(false);
    setAuthCallback(authCallback);
    (
      globalThis as typeof globalThis & {
        authCallback?: () => Promise<boolean>;
      }
    ).authCallback = authCallback;
  }, []);

  const handleAuthError = async (): Promise<boolean> => Promise.resolve(false);

  // Sessions are loaded automatically via ConversationsContext

  useEffect(() => {
    // Agents auto-load via context
  }, []);

  // Sync font size from config - handled by ChatDock

  // Auto-scroll to bottom when new messages arrive - handled by ChatDock

  // ⌘, (settings) and ⌘N (new project) are registered through the keyboard
  // registry below (`app.settings` / `app.newLayout`) — a second raw window
  // listener here double-fired them (⌘, toggled settings twice → no-op), so it
  // was removed. Chat shortcuts are handled by ChatDock.

  // Mark sessions as read - handled by ChatDock

  // Drag handling - handled by ChatDock

  // A `/?project=<name>` deep-link from the `station` launcher (#1986) pre-
  // selects a project. Read the selector once at mount (the launcher opens a
  // fresh page with it); an empty value is treated as absent.
  const requestedProject = useMemo(
    () =>
      new URLSearchParams(window.location.search).get(
        PROJECT_SELECT_QUERY_KEY,
      ) || null,
    [],
  );
  // Match the selector against the loaded projects by slug or display name. A
  // matched deep-link is preferred over the persisted `lastProject`; no match
  // falls through to the normal first-project auto-select (never an error).
  const matchedRequestedProject = useMemo(() => {
    if (!requestedProject) return undefined;
    return projects.find(
      (project: { slug: string; name?: string }) =>
        project.slug === requestedProject || project.name === requestedProject,
    );
  }, [requestedProject, projects]);

  // Determine which project the home route loads layouts for: the deep-linked
  // match when present, otherwise the first project. Keeping this one slug in
  // lockstep with the layouts query, `resolveHomeSurface`, and the retry
  // handler means the pre-selected project's first layout is the one applied.
  const firstProjectSlug =
    matchedRequestedProject?.slug || projects[0]?.slug || '';
  const {
    data: firstProjectLayouts = [],
    isLoading: firstProjectLayoutsLoading,
    isError: firstProjectLayoutsError,
  } = useProjectLayoutsQuery(firstProjectSlug, {
    enabled: !!firstProjectSlug,
  });

  // Apply the `/?project=<name>` deep-link exactly once, after projects (and,
  // when matched, that project's layouts) have loaded. On a match this uses
  // `setLayout` so the selection persists like any other project navigation;
  // with no match it just consumes the param and lets auto-select proceed.
  const projectSelectApplied = useRef(false);
  useEffect(() => {
    if (projectSelectApplied.current) return;
    if (!requestedProject) return;
    if (projectsLoading) return;

    if (!matchedRequestedProject) {
      projectSelectApplied.current = true;
      stripProjectSelectParam();
      return;
    }

    // Wait for the matched project's layouts before choosing the target.
    if (firstProjectLayoutsLoading) return;

    projectSelectApplied.current = true;
    // Strip BEFORE navigating: `navigate` preserves existing search params, so
    // the selector must be gone before it builds the project URL.
    stripProjectSelectParam();
    const targetLayout = firstProjectLayouts[0]?.slug;
    if (targetLayout) {
      setLayout(matchedRequestedProject.slug, targetLayout);
    } else {
      navigate(`/projects/${matchedRequestedProject.slug}`);
    }
  }, [
    requestedProject,
    matchedRequestedProject,
    projectsLoading,
    firstProjectLayoutsLoading,
    firstProjectLayouts,
    setLayout,
    navigate,
  ]);

  // Single pre-render resolution point for what `/` means (#223 fix). Pure
  // + unit-tested in resolve-home-surface.test.ts — this is the only place
  // that decides the home route; `resolveViewFromPath`'s root-path branch
  // (routing.ts) stays a URL-parse convenience only, no longer trusted for
  // this render decision (see the comment at routing.ts's root branch).
  const homeSurface = useMemo(
    () =>
      resolveHomeSurface({
        connectionStatus,
        connectionFailureReason,
        projectsLoading,
        projectsError,
        projects,
        lastProject,
        lastProjectLayout,
        firstProjectSlug,
        firstProjectLayoutsLoading,
        firstProjectLayoutsError,
        firstProjectLayouts,
      }),
    [
      connectionStatus,
      connectionFailureReason,
      projectsLoading,
      projectsError,
      projects,
      lastProject,
      lastProjectLayout,
      firstProjectSlug,
      firstProjectLayoutsLoading,
      firstProjectLayoutsError,
      firstProjectLayouts,
    ],
  );

  const displayCurrentView: NavigationView =
    window.location.pathname === '/' ? { type: 'home' } : currentView;
  const selectedLayoutProjectSlug =
    displayCurrentView.type === 'layout'
      ? displayCurrentView.projectSlug
      : undefined;
  const selectedLayoutSlug =
    displayCurrentView.type === 'layout'
      ? displayCurrentView.layoutSlug
      : undefined;
  const { data: selectedLayout, isLoading: selectedLayoutLoading } =
    useProjectLayoutQuery(selectedLayoutProjectSlug, selectedLayoutSlug);
  const isChatWorkspaceLayout = selectedLayout?.type === 'chat';
  // A layout route waits for its type before mounting the ambient controller.
  // This prevents even a loading frame from owning both the dock and the
  // full-screen Chat layout's event listeners/state machine.
  const showAmbientChatDock =
    displayCurrentView.type !== 'layout' ||
    (!selectedLayoutLoading && !isChatWorkspaceLayout);
  /**
   * A full-screen mobile dock owns the whole viewport (station#4460: any
   * occupant, not just Chat — `ChatDockMobileHeader` already carries the app
   * chrome for the docked case, and the shared `DockShell` behaves
   * identically regardless of occupant). A project layout owns the visible
   * view instead, even while a persisted dock snap is being restored on
   * navigation.
   */
  const isAmbientMobileDockFullscreen = isMobileDockFullscreenState({
    isMobile: isMobileViewport,
    isDockOpen,
    isDockMaximized,
    isDockOwnedView: isDockOwnedViewType(displayCurrentView.type),
  });
  const isMobileDockFullscreen =
    isAmbientMobileDockFullscreen ||
    (isMobileViewport && isChatWorkspaceLayout);
  const retryHomeSurface = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    if (firstProjectSlug) {
      void queryClient.invalidateQueries({
        queryKey: ['projects', firstProjectSlug, 'layouts'],
      });
    }
  }, [firstProjectSlug, queryClient]);

  const handleSettingsSaved = () => {
    showToast('Settings saved successfully');
  };

  // Keyboard shortcuts
  useKeyboardShortcut(
    'developer.open',
    'd',
    ['cmd', 'shift'],
    'Developer',
    useCallback(() => navigate('/developer'), [navigate]),
    true,
    10,
  );

  useKeyboardShortcut(
    'app.settings',
    ',',
    ['cmd'],
    'Toggle settings',
    useCallback(() => {
      if (displayCurrentView.type === 'settings') {
        navigateHome();
      } else {
        navigateToView({ type: 'settings' });
      }
    }, [displayCurrentView.type, navigateHome, navigateToView]),
  );

  useKeyboardShortcut(
    'app.newLayout',
    'n',
    ['cmd'],
    'New project',
    useCallback(() => {
      navigateToView({ type: 'project-new' });
    }, [navigateToView]),
  );

  useKeyboardShortcut(
    'app.shortcuts',
    '/',
    ['cmd'],
    'Show keyboard shortcuts',
    useCallback(() => {
      setShowShortcutsCheatsheet(true);
    }, []),
  );

  const parentView = useMemo(
    () => getParentView(displayCurrentView),
    [displayCurrentView],
  );
  useKeyboardShortcut(
    'app.escapeUp',
    'Escape',
    NO_SHORTCUT_MODIFIERS,
    'Go up one level',
    useCallback(() => {
      if (parentView) navigateToView(parentView);
    }, [navigateToView, parentView]),
    parentView !== null,
    -100,
  );

  // Determine current layout key for sessionStorage override
  const currentLayoutKey =
    displayCurrentView.type === 'layout' ? 'coding' : null;

  useKeyboardShortcut(
    'dock.cycleMode',
    'm',
    ['cmd', 'shift'],
    'Cycle dock mode',
    useCallback(() => {
      if (availableDockSlotPlacements.length <= 1) return;
      const next =
        availableDockSlotPlacements[
          (availableDockSlotPlacements.indexOf(effectiveDockSlotPlacement) +
            1) %
            availableDockSlotPlacements.length
        ];
      if (!next) return;
      setDockModeOverride(currentLayoutKey, next);
      setDockMode(next);
    }, [
      availableDockSlotPlacements,
      currentLayoutKey,
      effectiveDockSlotPlacement,
      setDockMode,
    ]),
  );

  // SHELL-07: `.content-view` is the shell's one scroll container, so its
  // scroll memory belongs here rather than in any route. Keyed on pathname —
  // the same key an in-app navigation and a browser Back both land on.
  const contentViewRef = useRef<HTMLDivElement>(null);
  useScrollRestoration(contentViewRef, window.location.pathname);

  return (
    <ProjectsProvider>
      <WorkspacePaneDockContext.Provider value={ambientDockAction}>
        <ChatAuthRecoveryProvider onRequestAuth={handleAuthError}>
          {/* Mobile store builds can wait days for review, so check their selected
          Station's release channel at launch. The Settings surface consumes
          this same React Query key and renders the cached result/action
          without a duplicate request. */}
          {/* #2773: a rejected chunk is cached by React forever, and these mount
          above the whole shell — an unguarded 404 after a deploy rebuilt
          dist-ui would blank the app rather than lose one piece of chrome. */}
          <LazyBoundary
            load={loadCoreUpdateLaunchCheck}
            pending={null}
            componentProps={{ apiBase: API_BASE }}
          />
          <LazyBoundary
            load={loadOutboundQueueFlushMount}
            pending={null}
            componentProps={{ apiBase: API_BASE }}
          />
          <div className="app app--with-sidebar">
            {/* SHELL-14: the shell chrome is already first in DOM order
              (measured: sidebar → toolbar → route → dock), so the keyboard
              defect was not the order — it was that there is no way PAST the
              chrome. This is the first focusable element in the document and
              moves focus into the route's own landmark. It is a button, not
              an `href="#…"` link, because `navigation-store` preserves
              `location.hash` across every navigation: a fragment link would
              stick `#station-main` onto every subsequent URL. */}
            <button
              type="button"
              className="skip-to-content"
              onClick={() => {
                const main = document.getElementById('station-main');
                main?.focus();
                main?.scrollTo({ top: 0 });
              }}
            >
              Skip to content
            </button>
            <ProjectSidebar />
            <div
              className={`app__main app__main--dock-${effectiveDockSlotPlacement}${
                isMobileDockFullscreen
                  ? ' app__main--mobile-dock-fullscreen'
                  : ''
              }`}
            >
              <Header
                currentView={displayCurrentView}
                onNavigate={navigateToView}
                onToggleSettings={() => {
                  if (displayCurrentView.type === 'settings') {
                    navigateHome();
                  } else {
                    navigateToView({ type: 'settings' });
                  }
                }}
              />
              <ConnectionBannerSource />
              <BannerHost connectionSlot />

              {showShortcutsCheatsheet && (
                <LazyBoundary
                  load={loadShortcutsCheatsheet}
                  componentProps={{
                    isOpen: true,
                    onClose: () => setShowShortcutsCheatsheet(false),
                  }}
                  pending={null}
                />
              )}

              {/* SHELL-14: the route outlet had no `main` landmark at all — a
                screen reader's landmark list held only the sidebar's `nav`
                and the toolbar's `header`. `tabIndex={-1}` makes it a
                programmatic focus target for the skip control without adding
                a tab stop of its own. */}
              <main className="main-content" id="station-main" tabIndex={-1}>
                <div className="content-view" ref={contentViewRef}>
                  {window.location.pathname === '/' &&
                  homeSurface.status === 'pending' ? (
                    <HomeRoutePendingSkeleton />
                  ) : window.location.pathname === '/' &&
                    homeSurface.status === 'host-unavailable' ? (
                    <HomeRouteHostUnavailable
                      reason={homeSurface.reason}
                      host={activeConnectionName || API_BASE}
                      address={activeConnectionUrl || API_BASE}
                    />
                  ) : window.location.pathname === '/' &&
                    homeSurface.status === 'error' ? (
                    <HomeRouteError
                      source={homeSurface.source}
                      onRetry={retryHomeSurface}
                    />
                  ) : (
                    <AppViewContent
                      currentView={displayCurrentView}
                      agents={agents}
                      apiBase={API_BASE}
                      availableModels={availableModels}
                      defaultModel={appConfig?.defaultModel}
                      onNavigate={navigateToView}
                      onNavigateHome={navigateHome}
                      onSettingsSaved={handleSettingsSaved}
                      projectsLoading={projectsLoading}
                      homeContinuation={
                        homeSurface.status === 'resolved'
                          ? homeSurface.target
                          : null
                      }
                    />
                  )}
                </div>
              </main>

              {showAmbientChatDock && (
                <ChatDock
                  homeContinuation={
                    homeSurface.status === 'resolved'
                      ? homeSurface.target
                      : null
                  }
                  onNavigate={navigateToView}
                  onDockActionChange={setAmbientDockAction}
                />
              )}
              <LazyBoundary
                load={loadDeferredAppOverlays}
                componentProps={{}}
                pending={null}
              />
              {/* Single floating voice affordance: the S2S pill. The separate STT
              FAB (GlobalVoiceButton) was removed — having both rendered two
              floating mics (opposite corners) whenever voice was enabled. STT
              while typing remains available via the inline VoiceOrb in the chat
              input. */}
              {featureSettings.voiceS2SEnabled && (
                <LazyBoundary
                  load={loadVoicePill}
                  componentProps={{}}
                  pending={null}
                />
              )}
            </div>
          </div>
        </ChatAuthRecoveryProvider>
      </WorkspacePaneDockContext.Provider>
    </ProjectsProvider>
  );
}

function HomeRouteHostUnavailable({
  reason,
  host,
  address,
}: {
  reason: ConnectionFailureReason | null;
  /** The saved connection's short name when one exists, else the URL —
   * `connectionFailureCopy`'s own display contract (station#3713 review:
   * "http://localhost:3141 isn't accepting this device" should name the
   * Station the user saved). */
  host: string;
  address: string;
}) {
  // station#3711: this used to say "Workspace unavailable while offline" for
  // EVERY non-connected state — an authentication rejection or a version
  // mismatch became a false device-network claim. The connection layer
  // already derives a typed reason with actionable per-reason copy (#3297);
  // render that. `awaiting-approval` is not a failure to explain
  // (environmentProfiles' own contract) and null means no probe has produced
  // a verdict yet — both fall back to copy that claims nothing beyond
  // "unavailable to this app right now".
  const copy =
    reason && reason !== 'awaiting-approval'
      ? connectionFailureCopy(reason, host, address)
      : null;
  return (
    <Empty
      variant="prominent"
      label={copy ? copy.summary : 'This Station is unavailable right now'}
      description={
        copy ? copy.action : 'Station will keep retrying automatically.'
      }
    />
  );
}

function HomeRouteError({
  source,
  onRetry,
}: {
  source: 'projects' | 'first-project-layouts';
  onRetry: () => void;
}) {
  const description =
    source === 'projects'
      ? 'Station could not load your projects.'
      : "Station could not load the first project's layouts.";

  return (
    <ErrorState
      title="Could not load your workspace"
      description={description}
      action={
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      }
    />
  );
}

export default App;
