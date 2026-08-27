/**
 * The split pane's numbers and its persisted state, alone in a module of their
 * own.
 *
 * They used to live in `SplitPaneLayout.logic.ts` beside the interaction code
 * that uses them, which was fine while every reader was also a reader of that
 * code. The route-pending placeholder (`app-shell/RoutePendingSkeleton`) is
 * not: it is on the eager entry path, it needs the default width and the
 * persisted collapse of the pane the arriving route will mount, and importing
 * those from the logic module pulled its whole resize/keyboard/breadcrumb
 * surface into the entry bundle — a measured 408 gzip bytes for a `280`.
 *
 * `SplitPaneLayout.logic.ts` re-exports everything here, so nothing that
 * already imported these from there had to change.
 */
export const SPLIT_PANE_DEFAULT_WIDTH = 280;
export const SPLIT_PANE_MIN_WIDTH = 220;
export const SPLIT_PANE_MAX_WIDTH = 420;

export const SPLIT_PANE_STORAGE_PREFIX = 'station:split-pane';

/**
 * The pane identities that persist width and collapse.
 *
 * Declared here, once, and imported by BOTH the view that mounts the pane and
 * the placeholder that has to know whether that pane will come back collapsed.
 * They were string literals inside three views; a second copy in the shell
 * would have been a silent drift the moment a view renamed its pane, and the
 * symptom would have been a placeholder that draws a rail the page then hides.
 *
 * Only these three panes persist anything. Every other split-pane route mounts
 * `SplitPaneLayout` without a `paneId`, so it always starts expanded — which is
 * why the placeholder can treat "no entry here" as "not collapsed" rather than
 * as "unknown".
 */
export const AGENTS_PANE_ID = 'agents';
export const CONNECTIONS_ENGINES_PANE_ID = 'connections-agent-apps';
export const CONNECTIONS_MODELS_PANE_ID = 'connections-models';

export interface SplitPanePersistedState {
  width: number;
  collapsed: boolean;
}

export function splitPaneStorageKey(paneId: string): string {
  return `${SPLIT_PANE_STORAGE_PREFIX}:${paneId}`;
}

export function clampPaneWidth(
  width: number,
  min = SPLIT_PANE_MIN_WIDTH,
  max = SPLIT_PANE_MAX_WIDTH,
): number {
  if (!Number.isFinite(width)) return SPLIT_PANE_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(width), min), max);
}

export function defaultSplitPaneState(): SplitPanePersistedState {
  return {
    width: SPLIT_PANE_DEFAULT_WIDTH,
    collapsed: false,
  };
}

export function parseSplitPaneState(
  raw: string | null,
): SplitPanePersistedState {
  const fallback = defaultSplitPaneState();
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as Partial<SplitPanePersistedState>;
    return {
      width: clampPaneWidth(
        typeof parsed.width === 'number' ? parsed.width : fallback.width,
      ),
      collapsed:
        typeof parsed.collapsed === 'boolean'
          ? parsed.collapsed
          : fallback.collapsed,
    };
  } catch {
    return fallback;
  }
}

/**
 * Whether a split pane is showing its detail as a full-width sheet.
 *
 * Below the mobile breakpoint the pane shows ONE side at a time and picks the
 * detail whenever something is selected — the rule `SplitPaneLayout` applies to
 * `leftVisible`/`rightVisible`, and the rule the route placeholder has to apply
 * too or it draws a list for a page that opens an editor.
 */
export function shouldShowMobileDetailSheet(
  isMobile: boolean,
  selectedId: string | null,
  unselectedDetailOpen = false,
): boolean {
  return isMobile && (selectedId !== null || unselectedDetailOpen);
}

/**
 * The collapse a pane will restore, read the same way `SplitPaneLayout` reads
 * it on mount. A pane with no id, an unreadable store, or no entry has never
 * been collapsed.
 */
export function readPersistedPaneCollapsed(paneId: string | null): boolean {
  if (!paneId || typeof window === 'undefined') return false;
  try {
    return parseSplitPaneState(
      window.localStorage.getItem(splitPaneStorageKey(paneId)),
    ).collapsed;
  } catch {
    return false;
  }
}
