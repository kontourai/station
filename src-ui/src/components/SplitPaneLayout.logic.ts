import {
  clampPaneWidth,
  SPLIT_PANE_MAX_WIDTH,
  SPLIT_PANE_MIN_WIDTH,
  type SplitPanePersistedState,
} from './split-pane-metrics';

// Re-exported so every existing importer keeps its import path; the values and
// the persisted-state readers live in `split-pane-metrics.ts` so a reader that
// needs only those does not pull this module's interaction code with it.
export {
  AGENTS_PANE_ID,
  CONNECTIONS_ENGINES_PANE_ID,
  CONNECTIONS_MODELS_PANE_ID,
  clampPaneWidth,
  defaultSplitPaneState,
  parseSplitPaneState,
  readPersistedPaneCollapsed,
  SPLIT_PANE_DEFAULT_WIDTH,
  SPLIT_PANE_MAX_WIDTH,
  SPLIT_PANE_MIN_WIDTH,
  SPLIT_PANE_STORAGE_PREFIX,
  type SplitPanePersistedState,
  shouldShowMobileDetailSheet,
  splitPaneStorageKey,
} from './split-pane-metrics';

export const SPLIT_PANE_MOBILE_BREAKPOINT = 768;

export function serializeSplitPaneState(
  state: SplitPanePersistedState,
): string {
  return JSON.stringify({
    width: clampPaneWidth(state.width),
    collapsed: state.collapsed,
  });
}

export function resizePaneFromPointer(
  pointerClientX: number,
  paneLeft: number,
): number {
  return clampPaneWidth(pointerClientX - paneLeft);
}

export function resizePaneFromKeyboard(
  currentWidth: number,
  key: string,
  options: { shiftKey?: boolean } = {},
): number | null {
  const step = options.shiftKey ? 40 : 16;

  if (key === 'ArrowLeft') return clampPaneWidth(currentWidth - step);
  if (key === 'ArrowRight') return clampPaneWidth(currentWidth + step);
  if (key === 'Home') return SPLIT_PANE_MIN_WIDTH;
  if (key === 'End') return SPLIT_PANE_MAX_WIDTH;

  return null;
}

export function collapseSplitPaneState(
  state: SplitPanePersistedState,
): SplitPanePersistedState {
  return {
    ...state,
    collapsed: true,
  };
}

export function expandSplitPaneState(
  state: SplitPanePersistedState,
): SplitPanePersistedState {
  return {
    ...state,
    collapsed: false,
  };
}

export function isSplitPaneMobile(width: number): boolean {
  return width <= SPLIT_PANE_MOBILE_BREAKPOINT;
}

/**
 * The breadcrumb segments the list pane should actually render for `label`,
 * given the `title` printed immediately beneath it (archive#2931).
 *
 * `docs/design/shell-skeletons.md` §2.1: the shell names the collection ONCE.
 * A single-segment trail whose only segment restates the title is that name
 * printed twice, one line apart — the literal "double header" reported in
 * archive#2931, reproduced in the shipped UI as `SESSIONS` above **Sessions**
 * and ` QUEUE` above **Review Queue**. It also carries no navigation: a
 * one-crumb trail has no ancestor to return to.
 *
 * Deliberately narrow. A MULTI-segment trail is a real breadcrumb whose last
 * crumb conventionally is the current page, so `CONNECTIONS / PROVIDERS` above
 * **Providers** is kept as-is; and a segment the view wired a `breadcrumbLinks`
 * handler to is an affordance, never dropped, however it reads.
 *
 * This is the UNFRAMED rule only. `framedBreadcrumbSegments` below governs
 * the page header's own eyebrow and is stricter — it drops a trailing
 * restated-title crumb even out of a multi-segment trail, because framed
 * there is no second heading below it for that crumb to precede. Do not
 * reuse this function's "multi-segment trail is kept as-is" reasoning for
 * the framed case; it does not hold there.
 */
export function visibleBreadcrumbSegments(
  label: string,
  title: string,
  breadcrumbLinks?: Record<string, () => void>,
): string[] {
  const segments = label.split(/\s*\/\s*/);
  if (segments.length !== 1) return segments;

  const only = segments[0];
  if (breadcrumbLinks?.[only.toLowerCase()]) return segments;

  const normalize = (value: string) =>
    value.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(only) === normalize(title) ? [] : segments;
}

/**
 * The eyebrow segments a FRAMED page header should render for `label`, given
 * the `title` printed as the frame's own `<h1>` (archive#4463, the
 *).
 *
 * The frame's `<h1>` already names the current page, so a trailing crumb that
 * restates it is dropped unconditionally — this is stricter than
 * `visibleBreadcrumbSegments` above, which keeps a multi-segment trail's last
 * crumb because the UNFRAMED list pane draws its own `<h2>` title immediately
 * below that trail (a real second heading the crumb still precedes). Framed,
 * there is no second heading: the eyebrow sits directly above the frame's own
 * title, so the segment naming the current page is redundant whether the
 * trail has one segment (a top-level route — `AGENTS` above **Agents** — which
 * drops to no eyebrow at all) or several (a subpage — `CONNECTIONS / ENGINES`
 * above **Engines** — which drops to just its parent, `Connections`, the
 * shape the decided a subpage's eyebrow should have).
 */
export function framedBreadcrumbSegments(
  label: string,
  title: string,
): string[] {
  const segments = label.split(/\s*\/\s*/).filter(Boolean);
  if (segments.length === 0) return segments;
  const normalize = (value: string) =>
    value.trim().replace(/\s+/g, ' ').toLowerCase();
  const last = segments[segments.length - 1];
  return normalize(last) === normalize(title)
    ? segments.slice(0, -1)
    : segments;
}
