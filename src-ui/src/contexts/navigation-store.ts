import {
  parseSurfaceDeepLink,
  type SurfaceDeepLinkIntent,
} from '@kontourai/station-contracts/surface-deep-link';
import { MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { getLegacyPathRedirect } from '../app-shell/routing';
import {
  DIALOG_HISTORY_KEY,
  setCollapsedDialogEntryAdopter,
} from '../components/dialog-history';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { type DockMode, normalizeDockMode } from '../types';
import {
  type OpenFilePreviewIntent,
  parseOpenFilePreviewIntent,
  serializeOpenFilePreviewIntent,
} from '../workspace-panes/openFilePreviewIntent';

export type NavigationState = {
  pathname: string;
  selectedAgent: string | null;
  selectedLayout: string | null;
  selectedProject: string | null;
  selectedProjectLayout: string | null;
  activeConversation: string | null;
  activeChat: string | null;
  activeTab: string | null;
  /** Active responsive Workspace Pane, owned by URL/history alongside every other selection. */
  activeWorkspacePane: string | null;
  activeWorkspacePaneScope: string | null;
  /** One exact, route-owned File Preview request. Consumers clear it after host admission. */
  openFilePreviewIntent: OpenFilePreviewIntent | null;
  /** One exact shell-owned surface reveal request. The region model clears it after adoption. */
  surfaceIntent: SurfaceDeepLinkIntent | null;
  isDockOpen: boolean;
  isDockMaximized: boolean;
  dockMode: DockMode;
  fontSize: number | null;
};

const LAST_PROJECT_KEY = 'lastProject';
export const LAST_PROJECT_LAYOUT_KEY = 'lastProjectLayout';
const LAYOUT_TAB_MEMORY_KEY = 'station-layout-tabs';
const NAVIGATION_INDEX_KEY = '__stationNavigationIndex';

function historyIndex(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    value,
    NAVIGATION_INDEX_KEY,
  );
  return descriptor && Number.isSafeInteger(descriptor.value)
    ? (descriptor.value as number)
    : undefined;
}

function readLayoutTabMemory(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LAYOUT_TAB_MEMORY_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function getDefaultNavigationState(): NavigationState {
  return {
    pathname: '/',
    selectedAgent: null,
    selectedLayout: null,
    selectedProject: null,
    selectedProjectLayout: null,
    activeConversation: null,
    activeChat: null,
    activeTab: null,
    activeWorkspacePane: null,
    activeWorkspacePaneScope: null,
    openFilePreviewIntent: null,
    surfaceIntent: null,
    isDockOpen: false,
    isDockMaximized: false,
    dockMode: 'bottom',
    fontSize: null,
  };
}

export function parseProjectSelectionFromPath(pathname: string): {
  selectedProject: string | null;
  selectedProjectLayout: string | null;
} {
  if (pathname === '/projects/new') {
    return { selectedProject: null, selectedProjectLayout: null };
  }

  const match = pathname.match(
    /^\/projects\/([^/]+)(?:\/layouts\/([^/]+)(?:\/.*)?)?/,
  );
  return {
    selectedProject: match?.[1] ?? null,
    selectedProjectLayout: match?.[2] ?? null,
  };
}

/**
 * Query params that belong to the shell rather than to a route, and so survive
 * a route change: the chat dock's open/maximized/mode/font-size state and the
 * conversation it is showing are persistent chrome that does not change
 * because the page behind it did.
 */
const SHELL_SCOPED_QUERY_PARAMS = new Set([
  'chat',
  'conversation',
  'dock',
  'dockSlotPlacement',
  'fontSize',
  'maximize',
  'surface',
  'session',
  'focus',
]);

/**
 * Splits an internal navigation target before it is assigned to URL.pathname.
 *
 * `URL.pathname` escapes `?` because it is a path setter; passing a route such
 * as `/connections?section=engines` straight to it therefore creates the
 * literal (and unrouteable) `/connections%3Fsection=engines` path in Tauri
 * and in browsers. Keep this parsing at the navigation seam so every caller
 * that supplies an internal query route gets the same treatment.
 */
export function parseNavigationTarget(target: string, base: string): URL {
  return new URL(target, base);
}

class NavigationStore {
  private state!: NavigationState;
  private listeners = new Set<() => void>();
  private isNavigating = false;
  private navigationGuardBypass = false;
  private historyIndex = 0;
  private restoringPop = false;
  private replayingPop = false;
  private pendingPopDelta: number | undefined;
  private readonly navigationGuards = new Map<
    symbol,
    (continueNavigation: () => void) => void
  >();
  lastProject: string | null;
  lastProjectLayout: string | null;
  /**
   * The most recently observed `true` value of `isDockMaximized`, kept
   * independent of the URL's `maximize` param itself. A closed dock always
   * has `maximize` cleared from the URL (`setDockState`'s own invariant,
   * archive#795) — a closed-and-still-maximized dock renders as a blank
   * full-height shell both in the desktop right-side-panel layout AND on
   * mobile (index.css's `@media (max-width: 768px)` `.chat-dock.is-maximized`
   * rule matches on `is-maximized` alone and forces `height` with
   * `!important`, beating the plain inline height guard regardless of
   * `is-collapsed` — archive#945 finding). So navigating away from a maximized
   * dock and back (e.g. revealing Activity for a delegated task, then
   * returning via the mobile task switcher) would otherwise lose the
   * maximize preference for good once that param is gone. `commitState`
   * refreshes this to `true` on every parsed navigation state that has it
   * set (covering a direct `?maximize=true` load, not just an explicit
   * `setDockState` call); `setDockState` is the only place that ever moves
   * it back to `false`, on a caller's explicit non-maximized open/close.
   * Restore paths that mean "reopen exactly as it was" (not "the user just
   * asked for a specific size") read this instead of the momentarily-cleared
   * `isDockMaximized` snapshot — every close (including the task switcher's)
   * must still go through `setDockState` so the invariant above holds
   * unconditionally.
   */
  lastDockMaximized = false;
  private layoutTabMemory: Record<string, string> = readLayoutTabMemory();

  constructor() {
    this.lastProject =
      typeof window !== 'undefined'
        ? localStorage.getItem(LAST_PROJECT_KEY)
        : null;
    this.lastProjectLayout =
      typeof window !== 'undefined'
        ? localStorage.getItem(LAST_PROJECT_LAYOUT_KEY)
        : null;
    this.commitState(this.parseUrl());

    if (typeof window !== 'undefined') {
      this.historyIndex = historyIndex(window.history.state) ?? 0;
      if (historyIndex(window.history.state) === undefined) {
        window.history.replaceState(
          {
            ...(window.history.state ?? {}),
            [NAVIGATION_INDEX_KEY]: this.historyIndex,
          },
          '',
          window.location.href,
        );
      }
      window.addEventListener('popstate', this.handlePopState);
      // This store owns navigation indices; `dialog-history` owns the dialog
      // layer. Installed rather than called because the dependency runs that
      // way — that module cannot import this one back without a cycle.
      setCollapsedDialogEntryAdopter((state) =>
        this.adoptCollapsedDialogEntry(state),
      );
      // archive#settings-revamp (deliberate choice,
      // documented per the reviewer's request — the alternative was "any
      // navigation heals it," rejected because dockMode also drives
      // immediately-visible layout: the `chat-dock--right`/`--bottom` class
      // and the `--chat-dock-width`/`--dock-slot-size` CSS vars in
      // `useChatDockState.ts`. Subscribing here gives it the same live-store
      // guarantee `useDeviceSettings` gives `useChatDockState`'s
      // reasoning/tool-details/font-size fix in this same,
      // instead of leaving dockMode stale until the next unrelated
      // navigation happens to re-run `parseUrl`.
      deviceSettingsStore.subscribe(this.handleDeviceSettingsChange);
    }
  }

  /** Applies a freshly parsed state and refreshes `lastDockMaximized`
   * alongside it (see the field doc above) — every code path that assigns
   * `this.state` from a `parseUrl` result routes through here so that
   * memory stays in sync regardless of how the URL got there (initial load,
   * `navigate`, `updateParams`, or a `popstate`). */
  private commitState(state: NavigationState) {
    this.state = state;
    if (state.isDockMaximized) this.lastDockMaximized = true;
  }

  /**
   * Recomputes ONLY the `dockMode` fallback when the device-scope
   * `dockSlotPlacement` setting changes (import, `set`/`merge`, or a
   * cross-tab `storage` event — every device-store mutation path already
   * converges on its own `notify`). A no-op whenever an explicit URL param
   * governs `dockMode` — `parseUrl`'s precedence chain means the device-scope value isn't even
   * being displayed in that case. Every other `NavigationState` field is
   * derived from the URL alone, so a full `parseUrl`/`commitState` isn't
   * needed here (and would be wrong: it would also fight a URL-based
   * `fontSize` field that has nothing to do with this notification).
   */
  private handleDeviceSettingsChange = (): void => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (normalizeDockMode(params.get('dockSlotPlacement'))) {
      return;
    }
    const nextDockMode =
      deviceSettingsStore.get('dockSlotPlacement') || 'bottom';
    if (nextDockMode === this.state.dockMode) return;
    this.state = { ...this.state, dockMode: nextDockMode };
    this.notify();
  };

  private handlePopState = (event: PopStateEvent) => {
    const targetIndex = historyIndex(event.state);
    if (this.replayingPop) {
      this.replayingPop = false;
      if (targetIndex !== undefined) this.historyIndex = targetIndex;
      this.commitState(this.parseUrl());
      this.notify();
      return;
    }
    if (this.restoringPop) {
      this.restoringPop = false;
      const delta = this.pendingPopDelta;
      this.pendingPopDelta = undefined;
      if (delta !== undefined) {
        this.runNavigationGuards(() => {
          this.replayingPop = true;
          window.history.go(delta);
        });
      }
      return;
    }
    const newState = this.parseUrl();

    const oldUrl = new URL(window.location.href);
    oldUrl.pathname = this.state.pathname;
    oldUrl.search = new URLSearchParams({
      ...(this.state.selectedAgent && { agent: this.state.selectedAgent }),
      ...(this.state.selectedLayout && {
        layout: this.state.selectedLayout,
      }),
      ...(this.state.activeConversation && {
        conversation: this.state.activeConversation,
      }),
      ...(this.state.activeChat && { chat: this.state.activeChat }),
      ...(this.state.activeTab && { tab: this.state.activeTab }),
      ...(this.state.activeWorkspacePane && {
        pane: this.state.activeWorkspacePane,
      }),
      ...(this.state.activeWorkspacePaneScope && {
        paneScope: this.state.activeWorkspacePaneScope,
      }),
      ...(this.state.openFilePreviewIntent
        ? serializeOpenFilePreviewIntent(this.state.openFilePreviewIntent)
        : {}),
      ...(this.state.surfaceIntent
        ? {
            surface: this.state.surfaceIntent.surfaceId,
            ...(this.state.surfaceIntent.sessionId && {
              session: this.state.surfaceIntent.sessionId,
            }),
            ...(this.state.surfaceIntent.focus && {
              focus: this.state.surfaceIntent.focus,
            }),
          }
        : {}),
      ...(this.state.isDockOpen && { dock: 'open' }),
      ...(this.state.isDockMaximized && { maximize: 'true' }),
      ...(this.state.fontSize && { fontSize: this.state.fontSize.toString() }),
    }).toString();

    const currentUrl = new URL(window.location.href);
    const isSameMountedSettingsTraversal =
      this.state.pathname === '/settings' && newState.pathname === '/settings';
    if (
      oldUrl.pathname !== currentUrl.pathname ||
      oldUrl.search !== currentUrl.search
    ) {
      if (
        !this.navigationGuardBypass &&
        this.navigationGuards.size > 0 &&
        targetIndex !== undefined &&
        !isSameMountedSettingsTraversal
      ) {
        const delta = targetIndex - this.historyIndex;
        if (delta !== 0) {
          this.pendingPopDelta = delta;
          this.restoringPop = true;
          window.history.go(-delta);
          return;
        }
      }
      if (targetIndex !== undefined) this.historyIndex = targetIndex;
      this.commitState(newState);
      this.notify();
      return;
    }

    this.commitState(newState);
  };

  private parseUrl(): NavigationState {
    if (typeof window === 'undefined') {
      return getDefaultNavigationState();
    }

    // Canonicalize legacy paths BEFORE deriving any state. This store is the
    // pathname authority `useUrlSelection` consumes, and its popstate listener
    // registers at module init — before App's — so a rewrite done only in
    // App.tsx leaves this store holding the legacy pathname on initial load
    // and Back/Forward ( 2 finding). Rewriting here means every
    // consumer sees only canonical paths; App's own rewrite remains as an
    // idempotent belt for render paths that read window.location directly.
    const legacyRedirect = getLegacyPathRedirect(
      `${window.location.pathname}${window.location.search}`,
    );
    if (legacyRedirect) {
      window.history.replaceState(window.history.state, '', legacyRedirect);
    }

    const params = new URLSearchParams(window.location.search);
    const pathname = window.location.pathname;

    let selectedAgent = params.get('agent');
    const agentMatch = pathname.match(/^\/agents?\/([^/]+)/);
    if (agentMatch) selectedAgent = agentMatch[1];

    let selectedLayout = params.get('layout');
    let activeTab = params.get('tab');

    const { selectedProject, selectedProjectLayout } =
      parseProjectSelectionFromPath(pathname);
    const projectMatch = pathname.match(
      /^\/projects\/([^/]+)(?:\/layouts\/([^/]+)(?:\/([^/]+))?)?/,
    );
    if (selectedProject && projectMatch) {
      if (selectedProjectLayout) {
        selectedLayout = selectedProjectLayout;
      }
      // A layout-qualified Pane route names its pane collection after the
      // layout. That collection is route structure, not a layout tab.
      if (projectMatch[3] && projectMatch[3] !== 'panes') {
        activeTab = projectMatch[3];
      }
    }

    return {
      pathname,
      selectedAgent,
      selectedLayout,
      selectedProject,
      selectedProjectLayout,
      activeConversation: params.get('conversation'),
      activeChat: params.get('chat'),
      activeTab,
      activeWorkspacePane: (() => {
        const pane = params.get('pane');
        return pane &&
          pane === pane.trim() &&
          pane.length <= MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH
          ? pane
          : null;
      })(),
      activeWorkspacePaneScope: (() => {
        const scope = params.get('paneScope');
        return scope && scope.length <= 512 && scope === scope.trim()
          ? scope
          : null;
      })(),
      openFilePreviewIntent: parseOpenFilePreviewIntent(
        selectedProject,
        params,
      ),
      surfaceIntent: parseSurfaceDeepLink(params),
      isDockOpen: params.get('dock') === 'open',
      isDockMaximized: params.get('maximize') === 'true',
      // archive#settings-revamp (docs/design/settings-architecture.md §3, §6).
      // Precedence: URL param, then device setting, then the registry default.
      dockMode:
        normalizeDockMode(params.get('dockSlotPlacement')) ||
        deviceSettingsStore.get('dockSlotPlacement') ||
        'bottom',
      fontSize: params.get('fontSize')
        ? parseInt(params.get('fontSize')!, 10)
        : null,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  /**
   * Adopts the entry a collapsed dialog layer leaves behind, which holds a URL
   * this store never pushed for.
   *
   * It arrives carrying the index of the entry beneath it — a dialog's marker
   * push copies the state it lands on, and `updateParams` rewrites whatever
   * index it already found — and two adjacent entries sharing an index make
   * `handlePopState` compute a delta of 0, the value that means "no traversal
   * to guard" and skips `runNavigationGuards`. Assign the index a `navigate`
   * of this store's own would have, so a Back off this entry is a real
   * traversal and the unsaved-changes guard is consulted.
   *
   * Deriving the state and advancing the index are separated so the caller can
   * order the advance after its history write succeeds; this store stays the
   * only writer of `historyIndex`, but it is no longer the one that decides
   * when the write counted.
   */
  private adoptCollapsedDialogEntry(state: Record<string, unknown>): {
    state: Record<string, unknown>;
    commit: () => void;
  } {
    const nextIndex = this.historyIndex + 1;
    return {
      state: { ...state, [NAVIGATION_INDEX_KEY]: nextIndex },
      commit: () => {
        this.historyIndex = nextIndex;
      },
    };
  }

  registerNavigationGuard(
    identity: symbol,
    guard: (continueNavigation: () => void) => void,
  ): () => void {
    this.navigationGuards.set(identity, guard);
    return () => this.navigationGuards.delete(identity);
  }

  private runNavigationGuards(continuation: () => void): void {
    const guards = [...this.navigationGuards.values()];
    const continueAt = (index: number): void => {
      const guard = guards[index];
      if (guard) {
        guard(() => continueAt(index + 1));
        return;
      }
      continuation();
    };
    continueAt(0);
  }

  private notify = () => {
    this.listeners.forEach((listener) => listener());
  };

  navigate(pathname: string, params?: Record<string, string | null>) {
    const target = parseNavigationTarget(pathname, window.location.href);
    if (
      !this.navigationGuardBypass &&
      target.pathname !== window.location.pathname &&
      this.navigationGuards.size > 0
    ) {
      this.runNavigationGuards(() => {
        this.navigationGuardBypass = true;
        try {
          this.navigate(pathname, params);
        } finally {
          this.navigationGuardBypass = false;
        }
      });
      return;
    }
    if (this.isNavigating) return;
    this.isNavigating = true;

    const url = new URL(window.location.href);
    const currentHash = url.hash;
    // The pathname being LEFT, read from the live URL rather than
    // `this.state.pathname`: the two agree except when something outside this
    // store has written history (a `replaceState` elsewhere, or a test), and
    // in exactly that case the stale field would report a route change that
    // did not happen and strip the current route's own params.
    const previousPathname = url.pathname;
    url.pathname = target.pathname;
    if (target.pathname !== previousPathname) {
      // 6-OPS-30: a route change used to carry the SOURCE route's query string
      // to the destination — `/settings?view=notifications` → "View the
      // notifications inbox" landed on `/notifications?view=notifications`,
      // and a shell surface opened from `/settings?view=developer-tools`
      // inherited `view=developer-tools`. Harmless only for as long as the
      // destination ignores the param it inherited; `/notifications` already
      // reads `?category=` from the URL, so the next query-backed surface
      // inherits a real bug. Only the shell-scoped params below outlive a
      // route change — everything else describes the route being left.
      for (const key of [...url.searchParams.keys()]) {
        if (SHELL_SCOPED_QUERY_PARAMS.has(key)) continue;
        if (params && key in params) continue;
        url.searchParams.delete(key);
      }
    }

    // Destination query params describe the route being entered. Apply them
    // after clearing the previous route's params, then let the structured
    // `params` argument override them below when a caller explicitly needs
    // to do so.
    for (const key of new Set(target.searchParams.keys())) {
      url.searchParams.delete(key);
    }
    for (const [key, value] of target.searchParams) {
      url.searchParams.append(key, value);
    }

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value === null) {
          url.searchParams.delete(key);
        } else {
          url.searchParams.set(key, value);
        }
      });
    }

    url.hash = currentHash;
    const nextIndex = this.historyIndex + 1;
    const nextHistoryState = {
      ...(window.history.state ?? {}),
      [NAVIGATION_INDEX_KEY]: nextIndex,
    };
    // A dialog's same-URL Back marker belongs only to the entry on which the
    // dialog opened. Carrying it into a new route makes ordinary dialog
    // cleanup treat the destination as its own marker and immediately Back
    // out of the navigation (observed from New Chat's Connect repair).
    delete nextHistoryState[DIALOG_HISTORY_KEY];
    window.history.pushState(nextHistoryState, '', url.toString());
    this.historyIndex = nextIndex;
    this.commitState(this.parseUrl());
    this.notify();
    window.dispatchEvent(new PopStateEvent('popstate'));
    this.isNavigating = false;
  }

  updateParams(params: Record<string, string | null>) {
    const url = new URL(window.location.href);
    const prev = url.search;
    const currentHash = url.hash;

    Object.entries(params).forEach(([key, value]) => {
      if (value === null) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, value);
      }
    });

    if (url.search === prev) return;

    url.hash = currentHash;
    // Query normalization is not a new entry, but it must retain the store's
    // opaque index so later Back/Forward can restore and guard the real entry.
    window.history.replaceState(
      {
        ...(window.history.state ?? {}),
        [NAVIGATION_INDEX_KEY]: this.historyIndex,
      },
      '',
      url.toString(),
    );
    this.commitState(this.parseUrl());
    this.notify();
  }

  /** User pane selection is a history entry so browser Back/Forward restores it. */
  setActiveWorkspacePane(instanceId: string | null, scope: string | null) {
    if (
      instanceId !== null &&
      (instanceId !== instanceId.trim() ||
        instanceId.length === 0 ||
        instanceId.length > MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH)
    )
      return;
    this.navigate(this.state.pathname, { pane: instanceId, paneScope: scope });
  }

  setAgent(slug: string | null) {
    if (slug) {
      this.navigate(`/agents/${slug}`);
    } else {
      this.navigate('/');
    }
  }

  setLayoutTab(layoutSlug: string, tabId: string | null) {
    const { selectedProject } = this.state;
    if (!selectedProject) {
      this.navigate('/');
      return;
    }
    this.rememberLayoutTab(layoutSlug, tabId);
    const base = `/projects/${selectedProject}/layouts/${layoutSlug}`;
    this.navigate(tabId ? `${base}/${tabId}` : base);
  }

  /** Persist the last tab a user opened within a layout so re-entering the
   *  layout restores it instead of snapping back to the first tab. */
  private rememberLayoutTab(layoutSlug: string, tabId: string | null) {
    if (tabId) {
      this.layoutTabMemory[layoutSlug] = tabId;
    } else {
      delete this.layoutTabMemory[layoutSlug];
    }
    try {
      localStorage.setItem(
        LAYOUT_TAB_MEMORY_KEY,
        JSON.stringify(this.layoutTabMemory),
      );
    } catch {}
  }

  setProject(slug: string) {
    this.navigate(`/projects/${slug}`);
  }

  setLayout(
    projectSlug: string,
    layoutSlug: string,
    options?: { openFilePreviewIntent?: OpenFilePreviewIntent },
  ) {
    this.lastProject = projectSlug;
    this.lastProjectLayout = layoutSlug;
    try {
      localStorage.setItem(LAST_PROJECT_KEY, projectSlug);
      localStorage.setItem(LAST_PROJECT_LAYOUT_KEY, layoutSlug);
    } catch {}
    const base = `/projects/${projectSlug}/layouts/${layoutSlug}`;
    const rememberedTab = this.layoutTabMemory[layoutSlug];
    const previewParams = options?.openFilePreviewIntent
      ? serializeOpenFilePreviewIntent(options.openFilePreviewIntent)
      : null;
    // A plain layout switch clears every File Preview query field. The routed
    // Project identity is authoritative, so a mismatched intent is not emitted.
    this.navigate(rememberedTab ? `${base}/${rememberedTab}` : base, {
      previewPath:
        options?.openFilePreviewIntent?.projectSlug === projectSlug
          ? (previewParams?.previewPath ?? null)
          : null,
      previewLineStart:
        options?.openFilePreviewIntent?.projectSlug === projectSlug
          ? (previewParams?.previewLineStart ?? null)
          : null,
      previewLineEnd:
        options?.openFilePreviewIntent?.projectSlug === projectSlug
          ? (previewParams?.previewLineEnd ?? null)
          : null,
    });
  }

  setConversation(id: string | null) {
    this.updateParams({ conversation: id });
  }

  setActiveChat(id: string | null) {
    this.updateParams({ chat: id });
  }

  setActiveTab(tabId: string | null) {
    this.updateParams({ tab: tabId });
  }

  /**
   * A closed dock is never maximized (archive#795). `is-collapsed` and
   * `is-maximized` are independent CSS classes and the maximized rule wins on
   * height with `!important`, so the pair renders as a full-height dock with
   * an emptied body — a blank shell covering the app. Callers used to have to
   * remember this individually and one of them didn't, so the invariant lives
   * here rather than at each call site. Reopening still restores the previous
   * size: that is carried by the persisted `station.chatDock.snap`, not by
   * this flag.
   */
  setDockState(open: boolean, maximized?: boolean) {
    const params: Record<string, string | null> = {
      dock: open ? 'open' : null,
    };
    // Track the caller's stated intent, not the post-invariant effective
    // value below — a close call that forwards the dock's current maximize
    // state (the established pattern; see the Cmd+D toggle in
    // `useChatDockKeyboardShortcuts`) is exactly the signal worth
    // remembering for a later restore.
    if (maximized !== undefined) {
      this.lastDockMaximized = maximized;
    }
    const effectiveMaximized = open ? maximized : false;
    if (effectiveMaximized !== undefined) {
      params.maximize = effectiveMaximized ? 'true' : null;
    }
    this.updateParams(params);
  }

  /**
   * archive#1298: collapse a maximized dock to its docked size WITHOUT
   * closing it — `isDockOpen` is left exactly as it is — and WITHOUT
   * touching `lastDockMaximized`.
   *
   * `setDockState`'s `maximized` argument always overwrites
   * `lastDockMaximized` when defined (see that method's own doc): that is
   * correct for a caller stating an explicit new preference (an explicit
   * non-maximized open, or a close that forwards the live value per archive#945),
   * but it is the wrong tool for a dock-owned navigation seam (an inbox row
   * revealing Activity, the project-context badge, a delegation
   * toast) — the dock stays open the whole time, so there is no
   * close-then-reopen round trip for `lastDockMaximized` to survive; it
   * would just get clobbered to `false` on every such navigation. archive#1298's
   * rule is explicit that restore is manual (the user re-engages, e.g.
   * `focusSession`'s `setDockState(true, lastDockMaximized)`) — this method
   * is what keeps that later read meaningful.
   */
  collapseMaximizedDock() {
    this.updateParams({ maximize: null });
  }

  setDockMode(mode: DockMode) {
    // Explicit user choices always write the param — even the default mode —
    // so "explicit → URL" stays a single invariant now that the default is a
    // real mode rather than the absence of one (archive#1043).
    this.updateParams({ dockSlotPlacement: mode });
    // archive#settings-revamp: an explicit dock-mode choice (⌘⇧M or
    // the chat settings panel — both routes converge here) is also this
    // device's new fallback for every other session/layout with no more
    // specific override (see `parseUrl` above). A same-value write is a
    // no-op inside the store itself.
    deviceSettingsStore.set('dockSlotPlacement', mode);
  }
}

export const navigationStore = new NavigationStore();
