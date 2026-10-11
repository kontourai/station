import {
  SURFACE_DEEP_LINK_QUERY_KEYS,
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
import { MAIN_PAGE_HISTORY_KEY } from './main-page-history';
import { parseSurfaceDeepLink } from './surface-deep-link';

/** An exact temporary return location, owned and restored by this navigator. */
export type NavigationLocation = Readonly<{ pathname: string; search: string }>;

function canonicalSearch(search: string): string {
  const params = new URLSearchParams(search);
  // A closed dock is never maximized (archive#795, station#1613). Every param
  // WRITE normalizes that away (`closedDockNeverMaximized`), but a URL loaded
  // directly or restored by `popstate` can still carry `maximize=true` with no
  // `dock=open`. When the return trip also closes the dock — `restoreLocation`
  // emits `dock: null` for any `dock` key the origin lacks, so a detour that
  // opened the dock produces one — the destination goes back through a writer
  // and comes home WITHOUT the param, and an origin captured in that state
  // would not compare equal to where the user now is. Dropping it here, where
  // both sides of the comparison pass, is what keeps that round trip exact;
  // canonicalizing only the captured record would instead make
  // `isCurrentLocation` false for a location nobody navigated away from.
  if (params.get('dock') !== 'open') params.delete('maximize');
  params.sort();
  return params.toString();
}

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
  /**
   * Who wrote the current preview intent: `pane` when the Files pane wrote
   * it for its own row (it opens its own preview, so no position should
   * open another), `link` for everything else — a transcript link, a
   * session panel's file, a shared or reloaded URL (#3040 round 4).
   */
  openFilePreviewIntentFrom: 'pane' | 'link';
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
/**
 * How many history entries' locations the store remembers (`entryLocations`).
 * Enough for any Back/Forward control to answer "is the adjacent entry one of
 * mine?"; bounded so a long session does not grow it without limit.
 */
const MAX_REMEMBERED_ENTRY_LOCATIONS = 64;

/**
 * The navigation entry a history state belongs to. A same-URL layer pushed by
 * copying the state it lands on (a dialog's Back marker) carries the index of
 * the entry beneath it, so two states with one index are one entry.
 */
export function navigationEntryIndex(value: unknown): number | undefined {
  return historyIndex(value);
}

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
    openFilePreviewIntentFrom: 'link',
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

/**
 * A closed dock is never maximized (archive#795): a param write that sets
 * `dock` to `null` also deletes `maximize`, whatever the caller passed for it.
 * `is-collapsed` and `is-maximized` are independent CSS classes and the
 * maximized rule wins on height with `!important`, so the pair renders as a
 * full-height dock with an emptied body — a blank shell covering the app.
 *
 * `setDockState` used to carry this alone, and a second writer
 * (`useChatDockActiveChatSync`'s `clearDeadChatPointer`, which closes the dock
 * with a direct `updateParams({ chat: null, dock: null })`) skipped it —
 * station#1613. Both URL-writing entry points now apply it: `updateParams` and
 * `navigate`, the latter because `dock` and `maximize` are both
 * `SHELL_SCOPED_QUERY_PARAMS`, so a route change carries them across together
 * and a navigation that closes the dock would otherwise leave `maximize`
 * behind exactly as the direct write did.
 *
 * `lastDockMaximized` is not touched here: `commitState` only ever moves it to
 * `true`, and `setDockState` is the only path that moves it to `false`, so a
 * close routed through this normalization keeps whatever memory the earlier
 * maximized commit set (archive#945).
 *
 * What this does NOT cover: a URL loaded or restored by `popstate` carrying
 * `maximize=true` without `dock=open` reaches `parseUrl` without passing a
 * writer, and `parseUrl` reads the two params independently. Only writes are
 * normalized. A `dock` value other than `null` is left alone too — no caller
 * writes a non-`open` dock value, and `parseUrl` treats any such value as
 * closed.
 */
function closedDockNeverMaximized(
  params: Record<string, string | null>,
): Record<string, string | null> {
  return params.dock === null ? { ...params, maximize: null } : params;
}

function sameOpenFilePreviewIntent(
  a: OpenFilePreviewIntent | null,
  b: OpenFilePreviewIntent | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.projectSlug === b.projectSlug &&
    a.path === b.path &&
    a.lineRange?.start === b.lineRange?.start &&
    a.lineRange?.end === b.lineRange?.end
  );
}

class NavigationStore {
  private state!: NavigationState;
  private listeners = new Set<() => void>();
  private isNavigating = false;
  private navigationGuardBypass = false;
  private historyIndex = 0;
  private navigationGeneration = {};
  private guardGeneration = {};
  private navigationHref = '';
  private restoringPop = false;
  private replayingPop = false;
  private pendingPopDelta: number | undefined;
  /**
   * True from the moment a guarded traversal is being travelled back
   * (`history.go(-delta)`) until that bounce lands. The entry the browser is
   * on meanwhile is one the user has not been admitted to: a `popstate`
   * listener that acts on an entry's state must not act on this one.
   */
  get traversalAwaitsGuard(): boolean {
    return this.restoringPop;
  }
  private departedHistoryIndex = 0;
  /**
   * The navigation index of the entry the traversal being handled LEFT. The
   * store's index is the live entry's at every moment — `navigate`, a
   * collapsed dialog layer's adoption and each traversal all move it — so
   * this is read at the top of the handler, before the landing moves it. A
   * listener registered after the store's compares it with the landed
   * entry's index to tell a move between entries from a move within one (a
   * dialog layer shares the index of the entry beneath it).
   */
  get traversalDepartedIndex(): number {
    return this.departedHistoryIndex;
  }
  /**
   * The location of each history entry this page load has observed, keyed by
   * the store's own entry index. The browser exposes only the CURRENT entry's
   * URL, so an in-app Back/Forward control that must know whether the
   * adjacent entry belongs to its own view (`adjacentLocation`) can only ask
   * the store that wrote the entries. Bounded (`MAX_REMEMBERED_ENTRY_LOCATIONS`,
   * farthest from the current entry evicted first) and in memory only: after
   * a reload the neighbours are unknown, which callers treat as "not mine".
   */
  private readonly entryLocations = new Map<number, NavigationLocation>();
  private readonly navigationGuardOwners = new Map<symbol, string>();
  /** Whether any registered guard protects `owner`'s content (it is dirty). */
  hasNavigationGuard(owner: string): boolean {
    for (const value of this.navigationGuardOwners.values())
      if (value === owner) return true;
    return false;
  }
  private readonly navigationGuards = new Map<
    symbol,
    (continueNavigation: () => void, cancelNavigation?: () => void) => void
  >();
  lastProject: string | null;
  lastProjectLayout: string | null;
  /**
   * The most recently observed `true` value of `isDockMaximized`, kept
   * independent of the URL's `maximize` param itself. A dock closed by a PARAM
   * WRITE has `maximize` cleared from the URL (`closedDockNeverMaximized`,
   * applied by both `updateParams` and `navigate` — the archive#795 invariant,
   * moved out of `setDockState` by station#1613). A `?maximize=true` URL loaded
   * directly, or restored by `popstate`, is NOT normalized: `parseUrl` reads
   * the param independently of `dock`, and
   * `RegionModelContext.reshowKeepsMaximizeMemory.test.tsx` pins what the shell
   * does with that state. A closed-and-still-maximized dock renders as a blank
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
   * `isDockMaximized` snapshot. A close written through `updateParams`
   * directly (not via `setDockState`) clears the URL flag but leaves this
   * field as it was, because nothing in `updateParams` or `commitState`
   * assigns it `false`.
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
      // The first commit above ran before the index was known.
      this.entryLocations.clear();
      this.rememberEntryLocation();
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
      // and the shell-clearance CSS vars (`--region-<id>-size` and
      // `--dock-slot-size`) published by `regions/region-clearance.ts` —
      // the single-side width alias they used to include was retired in
      // #1374. Subscribing here gives it the same live-store
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
  private commitState(state: NavigationState, newEntry = false) {
    const href = typeof window === 'undefined' ? '' : window.location.href;
    if (newEntry || href !== this.navigationHref)
      this.navigationGeneration = {};
    this.navigationHref = href;
    this.state = state;
    if (state.isDockMaximized) this.lastDockMaximized = true;
    this.rememberEntryLocation();
  }

  private rememberEntryLocation() {
    if (typeof window === 'undefined') return;
    this.entryLocations.set(this.historyIndex, {
      pathname: window.location.pathname,
      search: window.location.search,
    });
    while (this.entryLocations.size > MAX_REMEMBERED_ENTRY_LOCATIONS) {
      let farthest: number | undefined;
      for (const index of this.entryLocations.keys()) {
        if (
          farthest === undefined ||
          Math.abs(index - this.historyIndex) >
            Math.abs(farthest - this.historyIndex)
        )
          farthest = index;
      }
      if (farthest === undefined) break;
      this.entryLocations.delete(farthest);
    }
  }

  /** The store's index for the current history entry (monotonic per push). */
  getHistoryIndex(): number {
    return this.historyIndex;
  }

  /**
   * The location of the entry `delta` steps from the current one, when this
   * page load has observed it; null when it has not (a reload, an entry
   * another origin wrote, or nothing there). A push truncates the forward
   * entries, so a forward neighbour is only ever one this store still owns.
   */
  adjacentLocation(delta: -1 | 1): NavigationLocation | null {
    return this.entryLocations.get(this.historyIndex + delta) ?? null;
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
    this.departedHistoryIndex = this.historyIndex;
    const targetIndex = historyIndex(event.state);
    if (targetIndex !== undefined && targetIndex !== this.historyIndex)
      this.navigationGeneration = {};
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
            ...(this.state.surfaceIntent.messageAnchor &&
            this.state.surfaceIntent.sessionId
              ? {
                  messageSession: this.state.surfaceIntent.sessionId,
                  messageDirection:
                    this.state.surfaceIntent.messageAnchor.direction,
                  messageRequest:
                    this.state.surfaceIntent.messageAnchor.requestKey,
                }
              : {}),
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

    // A same-URL traversal between two entries of this store's own (`main`'s
    // page entries, #2986) is still a move along the stack: without this the
    // index stays on the entry left, and the next guarded Back computes its
    // restore delta from the wrong place. A dialog layer shares the index of
    // the entry beneath it, so for that traversal this assigns what it had.
    if (targetIndex !== undefined) this.historyIndex = targetIndex;
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

    const previewIntent = parseOpenFilePreviewIntent(selectedProject, params);
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
      openFilePreviewIntent: previewIntent,
      // A writer names itself for the parse its write causes, and the name
      // stays with that intent through later parses that keep it (a pane
      // selection written beside it); a new or re-read intent (a popstate,
      // a reload) is a link's.
      openFilePreviewIntentFrom:
        this.nextPreviewIntentFrom ??
        (this.state &&
        sameOpenFilePreviewIntent(
          this.state.openFilePreviewIntent,
          previewIntent,
        )
          ? this.state.openFilePreviewIntentFrom
          : 'link'),
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

  /**
   * A synchronous read for a caller that must not open the async
   * confirm-and-continue flow `navigate()` runs when a guard is registered
   * for the SAME target (kontourai/station#1418, #1419: a plugin-command
   * navigation settles `aborted` with a notice instead of prompting, so the
   * local effect stays one synchronous step).
   *
   * Shares the exact predicate `navigate()` itself uses to decide whether to
   * consult guards at all, extracted here so the two cannot drift (#1418/
   * #1419 review, MEDIUM: a caller that asked "is any guard registered,
   * anywhere" over-aborted for a same-pathname target navigate() would have
   * let straight through, and for a `showSurface` destination navigate()
   * never even runs for).
   */
  wouldNavigationGuardBlock(pathname: string): boolean {
    if (this.navigationGuards.size === 0) return false;
    const target = parseNavigationTarget(pathname, window.location.href);
    return target.pathname !== window.location.pathname;
  }

  /**
   * `owner` names the surface whose content the guard protects (a dock
   * pane's surface id, `UnsavedGuardOwnerContext`), so a surface-scoped exit
   * can ask only that surface's guards (`runNavigationGuards`'s `owner`).
   * Route navigation ignores it and asks every guard, as before.
   */
  registerNavigationGuard(
    identity: symbol,
    guard: (
      continueNavigation: () => void,
      cancelNavigation?: () => void,
    ) => void,
    owner?: string | null,
  ): () => void {
    this.guardGeneration = {};
    this.navigationGuards.set(identity, guard);
    if (owner) this.navigationGuardOwners.set(identity, owner);
    else this.navigationGuardOwners.delete(identity);
    return () => {
      if (this.navigationGuards.get(identity) !== guard) return;
      this.navigationGuards.delete(identity);
      this.navigationGuardOwners.delete(identity);
      // An approved form may become clean while preparation awaits. Removal
      // only loosens the guard set; additions/replacements revoke admission.
    };
  }

  /**
   * Ask the registered unsaved-changes guards before leaving a surface:
   * `continuation` runs once all of them allow it, `cancelled` when one
   * refuses. With `owner`, only the guards registered for that surface are
   * asked — the phone layer (`RegionModelContext`), whose Back and "‹ Chat"
   * unmount one pane without a route change, asks that pane's guards and
   * no one else's. Without it, every guard, as route navigation does.
   */
  runNavigationGuards(
    continuation: () => void,
    cancelled?: () => void,
    options: { owner?: string } = {},
  ): void {
    const { owner } = options;
    const guards = [...this.navigationGuards.entries()]
      .filter(
        ([identity]) =>
          owner === undefined ||
          this.navigationGuardOwners.get(identity) === owner,
      )
      .map(([, guard]) => guard);
    const continueAt = (index: number): void => {
      const guard = guards[index];
      if (guard) {
        guard(() => continueAt(index + 1), cancelled);
        return;
      }
      continuation();
    };
    continueAt(0);
  }

  private notify = () => {
    this.listeners.forEach((listener) => listener());
  };

  /**
   * Records exactly where the user is. The closed-dock rule that lets a
   * restored location still compare equal to its origin lives in
   * `canonicalSearch`, which both sides of `isCurrentLocation` pass through —
   * canonicalizing the RECORD instead would make `isCurrentLocation` false for
   * a location nobody navigated away from (station#1613 review).
   */
  captureLocation(): NavigationLocation {
    return {
      pathname: window.location.pathname,
      search: window.location.search,
    };
  }

  /**
   * Compares through `canonicalSearch`, which ignores param order and a
   * `maximize` that a closed dock cannot mean (archive#795, station#1613) — so
   * two URLs differing only by that param, with the dock closed in both, are
   * the same place here.
   */
  isCurrentLocation(location: NavigationLocation): boolean {
    return (
      window.location.pathname === location.pathname &&
      canonicalSearch(window.location.search) ===
        canonicalSearch(location.search)
    );
  }

  restoreLocation(
    location: NavigationLocation,
    admission: Parameters<NavigationStore['navigateWithPrecommit']>[1],
  ): Promise<boolean> {
    const captured = new URLSearchParams(location.search);
    const clear: Record<string, null> = {};
    for (const key of new URLSearchParams(window.location.search).keys()) {
      if (!captured.has(key)) clear[key] = null;
    }
    // Keep exact Pane paths, tabs, and query selections through the same
    // guarded navigation path. A Project-only projection cannot restore them.
    return this.navigateWithPrecommit(
      `${location.pathname}${location.search}`,
      admission,
      clear,
    );
  }

  /** Fixed destination, fresh admission after any dirty-state delay. No alternate router. */
  navigateWithPrecommit(
    pathname: string,
    admission: {
      current: () => boolean;
      prepare: () => Promise<boolean>;
      signal: AbortSignal;
    },
    params?: Record<string, string | null>,
  ): Promise<boolean> {
    const captured = { ...admission };
    const capturedParams = params ? { ...params } : undefined;
    const navigation = this.navigationGeneration;
    return import('./navigation-precommit')
      .then(({ runNavigationPrecommit }) => {
        const guards = this.guardGeneration;
        return runNavigationPrecommit(
          {
            ...captured,
            current: () =>
              this.navigationGeneration === navigation &&
              this.guardGeneration === guards &&
              captured.current(),
          },
          (proceed, cancel) => this.runNavigationGuards(proceed, cancel),
          () => {
            if (this.isNavigating) return false;
            const previousBypass = this.navigationGuardBypass;
            this.navigationGuardBypass = true;
            try {
              this.navigate(pathname, capturedParams);
            } finally {
              this.navigationGuardBypass = previousBypass;
            }
            return true;
          },
        );
      })
      .catch(() => false);
  }

  navigate(
    pathname: string,
    params?: Record<string, string | null>,
    options?: { preserveChatProjectDefault?: boolean },
  ) {
    const target = parseNavigationTarget(pathname, window.location.href);
    if (
      !this.navigationGuardBypass &&
      this.wouldNavigationGuardBlock(pathname)
    ) {
      this.runNavigationGuards(() => {
        this.navigationGuardBypass = true;
        try {
          this.navigate(pathname, params, options);
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
      // `session`/`focus` are fragments of a surface deep link
      // (`surfaceDeepLink`): they travel with *their* surface and fall away
      // with it — when the caller clears the surface on this navigation, and
      // equally when it swaps in a different one. Comparing the value rather
      // than mere presence is what separates those: `/projects?surface=activity
      // &session=x&focus=evidence` → `navigate('/?surface=chat')` would
      // otherwise re-attach one surface's session to another.
      const outgoingSurface = url.searchParams.get(
        SURFACE_DEEP_LINK_QUERY_KEYS.surface,
      );
      // Precedence mirrors the writes below: the structured `params` argument
      // is applied last and so wins, then the target pathname's own query,
      // then — when neither names a surface — the outgoing one stays put
      // (`surface` is shell-scoped, so the loop below never deletes it).
      const incomingSurface =
        params && SURFACE_DEEP_LINK_QUERY_KEYS.surface in params
          ? params[SURFACE_DEEP_LINK_QUERY_KEYS.surface]
          : (target.searchParams.get(SURFACE_DEEP_LINK_QUERY_KEYS.surface) ??
            outgoingSurface);
      const surfaceSurvives =
        outgoingSurface !== null && incomingSurface === outgoingSurface;
      for (const key of [...url.searchParams.keys()]) {
        if (SHELL_SCOPED_QUERY_PARAMS.has(key)) continue;
        if (
          surfaceSurvives &&
          Object.values(SURFACE_DEEP_LINK_QUERY_KEYS).some(
            (surfaceKey) => surfaceKey === key,
          )
        )
          continue;
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
      Object.entries(closedDockNeverMaximized(params)).forEach(
        ([key, value]) => {
          if (value === null) {
            url.searchParams.delete(key);
          } else {
            url.searchParams.set(key, value);
          }
        },
      );
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
    // Likewise `main`'s page stamp: it says what the entry being LEFT showed.
    // The region model stamps the destination itself when it is `/`.
    delete nextHistoryState[MAIN_PAGE_HISTORY_KEY];
    window.history.pushState(nextHistoryState, '', url.toString());
    this.historyIndex = nextIndex;
    // A push discards every forward entry the browser held.
    for (const index of [...this.entryLocations.keys()])
      if (index > nextIndex) this.entryLocations.delete(index);
    const next = this.parseUrl();
    const previousProject = this.state.selectedProject;
    this.commitState(next, true);
    if (
      !options?.preserveChatProjectDefault &&
      next.selectedProject &&
      (next.selectedProject !== previousProject ||
        (target.pathname === `/projects/${next.selectedProject}` &&
          !target.search &&
          !params))
    ) {
      deviceSettingsStore.set('chatDockProjectSlug', next.selectedProject);
    }
    this.notify();
    window.dispatchEvent(new PopStateEvent('popstate'));
    this.isNavigating = false;
  }

  updateParams(params: Record<string, string | null>) {
    const url = new URL(window.location.href);
    const prev = url.search;
    const currentHash = url.hash;

    Object.entries(closedDockNeverMaximized(params)).forEach(([key, value]) => {
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
    this.commitState(this.parseUrl(), true);
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
      // Clearing the agent returns to `/` and whatever occupies `main` —
      // not Home by name, which is the region model's `showSurface('home')`
      // and out of a store's reach (#1523).
      this.navigate('/');
    }
  }

  setLayoutTab(layoutSlug: string, tabId: string | null) {
    const { selectedProject } = this.state;
    if (!selectedProject) {
      // No project to route into: fall back to `/`'s occupant, whatever it
      // is. Same meaning as `setAgent(null)` above (#1523).
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

  /** See `NavigationState.openFilePreviewIntentFrom`; null outside `setLayout`. */
  private nextPreviewIntentFrom: 'pane' | 'link' | null = null;

  setLayout(
    projectSlug: string,
    layoutSlug: string,
    options?: {
      openFilePreviewIntent?: OpenFilePreviewIntent;
      /** The Files pane's own row write; absent for any other writer. */
      from?: 'pane';
      preserveChatProjectDefault?: boolean;
    },
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
    const pathname = rememberedTab ? `${base}/${rememberedTab}` : base;
    const previewFields = {
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
    };
    // Choosing a file in the layout already on screen is a row selection,
    // not a page: the fields are written in place. The page change, where
    // there is one, is the pane host's own selection write — a pushed
    // drill-in below the Coding layout's wide fold, a replaced side panel
    // past it (#3040) — and a selection that also pushed here made Back step
    // through the chosen file before the pane it opened.
    this.nextPreviewIntentFrom = options?.openFilePreviewIntent
      ? (options.from ?? 'link')
      : null;
    try {
      if (
        options?.openFilePreviewIntent &&
        pathname === window.location.pathname
      ) {
        this.updateParams(previewFields);
        // The same intent written again by another writer changes no URL
        // field, only whose intent it is.
        const from = options.from ?? 'link';
        if (
          this.state.openFilePreviewIntent &&
          this.state.openFilePreviewIntentFrom !== from
        ) {
          this.state = { ...this.state, openFilePreviewIntentFrom: from };
          this.notify();
        }
        return;
      }
      this.navigate(pathname, previewFields, options);
    } finally {
      this.nextPreviewIntentFrom = null;
    }
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
   * remember this individually and one of them didn't, so the invariant was
   * moved here; a second caller then wrote `dock: null` through
   * `updateParams` directly and skipped it (station#1613), so it now lives in
   * `closedDockNeverMaximized`, which both URL writers — `updateParams` and
   * `navigate` — apply (`navigate` has its own push path and does not call
   * `updateParams`). This method still computes `params.maximize = null` for a
   * close so its own intent reads locally; the helper deletes `maximize` on
   * any `dock: null` write regardless. Reopening still restores the previous size: that is
   * carried by the persisted `station.chatDock.snap`, not by this flag.
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
