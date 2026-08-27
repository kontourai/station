/**
 * Snap logic for the bottom chat dock's resize handle.
 *
 * The dock's top edge is draggable. While dragging the height tracks the
 * pointer; on release the height snaps to the nearest of three discrete states
 * — Collapsed (header only) / Half / Full (maximized). This mirrors the mobile
 * file-tree pattern in `coding-layout/treeSnap.ts` and is kept intentionally
 * pure (no React, no DOM) so the snap math is unit-testable in isolation.
 *
 * Pixel resolution depends on the live viewport, so heights are resolved
 * against `viewportHeight` (and a toolbar offset for the Full state, which can
 * never exceed `viewport - toolbar`).
 */

export type DockSnap = 'collapsed' | 'half' | 'full';

export const DOCK_SNAP_ORDER: DockSnap[] = ['collapsed', 'half', 'full'];

export const DEFAULT_DOCK_SNAP: DockSnap = 'half';

export const DOCK_SNAP_STORAGE_KEY = 'station.chatDock.snap';

/**
 * Default header-only peek height (px) for the Collapsed state.
 *
 * This MUST match the desktop value of `--chat-dock-header-height` in
 * `index.css`. On mobile that CSS variable is bumped (the bar needs more room
 * for its label + controls), so callers pass the live, CSS-resolved height
 * through `SnapMetrics.collapsedHeight` — keeping the snap math in lock-step
 * with the actual rendered bar. When no override is supplied the snap math
 * falls back to this desktop default.
 */
export const DOCK_COLLAPSED_HEIGHT = 38;

/** Half opens the dock to this fraction of the available viewport. */
export const DOCK_HALF_FRACTION = 0.45;

/** Movement threshold (px) below which a pointer interaction counts as a tap. */
export const TAP_MOVE_THRESHOLD = 6;

/** Release speed (CSS px/ms) that makes a mobile dock gesture a fling. */
export const MOBILE_DOCK_FLING_VELOCITY = 0.45;

/**
 * Downward release speed (CSS px/ms) fast enough to collapse the dock
 * outright — the flick that opens the dock (Half → Full) must also be able
 * to put it away. Deliberately faster than `MOBILE_DOCK_FLING_VELOCITY` (the
 * Half↔Full swap fling) so a moderate downward fling still lands on Half;
 * only a decisive "throw it away" flick reaches Collapsed. Standard
 * bottom-sheet dismiss-fling feel, no prior constant in this module covered
 * a third (collapsing) tier.
 */
export const MOBILE_DOCK_COLLAPSE_FLING_VELOCITY = 0.65;

/** Minimum draggable body height (used to clamp the live drag). */
export const DOCK_MIN_HEIGHT = 200;

interface SnapMetrics {
  viewportHeight: number;
  toolbarHeight?: number;
  /**
   * Live collapsed-bar height (px), resolved from `--chat-dock-header-height`.
   * Defaults to the desktop `DOCK_COLLAPSED_HEIGHT` so existing callers/tests
   * keep their behavior. On mobile the CSS variable is larger, so the resize
   * snap/clamp logic snaps to the real bar height instead of the 38px literal.
   */
  collapsedHeight?: number;
}

/** Largest height the dock body may occupy (full minus the app toolbar). */
export function dockFullHeight({
  viewportHeight,
  toolbarHeight = 0,
}: SnapMetrics): number {
  return Math.max(DOCK_MIN_HEIGHT, viewportHeight - toolbarHeight);
}

/** Resolve a snap state to an absolute pixel height for the given viewport. */
export function dockSnapPixels(snap: DockSnap, metrics: SnapMetrics): number {
  switch (snap) {
    case 'collapsed':
      return metrics.collapsedHeight ?? DOCK_COLLAPSED_HEIGHT;
    case 'half':
      return Math.round(
        Math.max(DOCK_MIN_HEIGHT, metrics.viewportHeight * DOCK_HALF_FRACTION),
      );
    case 'full':
      return dockFullHeight(metrics);
  }
}

/** Clamp a live drag height to the [collapsed, full] pixel range. */
export function clampDockHeight(pixels: number, metrics: SnapMetrics): number {
  const min = dockSnapPixels('collapsed', metrics);
  const max = dockSnapPixels('full', metrics);
  return Math.min(max, Math.max(min, pixels));
}

/**
 * Given a live drag height in px, find the nearest snap state.
 *
 * Ties favour the smaller state: the comparison is strict, so the earliest
 * entry in `DOCK_SNAP_ORDER` wins. A release exactly on the Half/Full midpoint
 * therefore lands on Half. (The pre-#795 midpoint fallback resolved that same
 * pixel to Full, so this is a real if vanishingly narrow behaviour change.)
 */
export function nearestDockSnap(
  pixels: number,
  metrics: SnapMetrics,
): DockSnap {
  let best: DockSnap = DOCK_SNAP_ORDER[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const snap of DOCK_SNAP_ORDER) {
    const dist = Math.abs(dockSnapPixels(snap, metrics) - pixels);
    if (dist < bestDist) {
      bestDist = dist;
      best = snap;
    }
  }
  return best;
}

/**
 * Resolve a completed mobile drag to a snap state. The gesture that opens the
 * dock must also be able to put it away: a *net-downward* release that lands
 * clearly below the Half band, or a downward flick fast enough to clear
 * `MOBILE_DOCK_COLLAPSE_FLING_VELOCITY`, collapses the dock outright (from
 * Half *or* Full — a decisive flick skips Half entirely). Short of that, a
 * clear release direction (or the gentler Half↔Full fling) wins; otherwise
 * the geometric midpoint between Half and Full is a deterministic fallback.
 * This preserves the existing Half/Full hysteresis for slow drags: a slow
 * release at or above the Half band is never dismissed by accident.
 *
 * The below-Half-band collapse is gated on net-downward motion
 * (`deltaY >= TAP_MOVE_THRESHOLD`, the same threshold the direction-wins
 * branches below use) because reopening from Collapsed necessarily *starts*
 * the drag near the Collapsed pixel height — an upward-opening gesture that
 * hasn't traveled far yet is still numerically "below the Half band" and
 * must not be reinterpreted as "collapse" just because of where it started.
 * Only a gesture that is actually heading down gets to end the drag early.
 *
 * `deltaY` and `velocityY` use pointer coordinates: negative means the user
 * moved upward (grow), positive means downward (shrink).
 */
export function resolveMobileDockSnap({
  pixels,
  deltaY,
  velocityY,
  metrics,
}: {
  pixels: number;
  deltaY: number;
  velocityY: number;
  metrics: SnapMetrics;
}): DockSnap {
  // A decisive downward flick collapses outright, even from Full — position
  // never gets a veto over a clear "throw it away" gesture. Already
  // one-directional (velocityY is only large-positive for downward motion),
  // so no extra direction gate is needed here.
  if (velocityY >= MOBILE_DOCK_COLLAPSE_FLING_VELOCITY) {
    return 'collapsed';
  }

  // Flings keep their direction-wins semantics: a flick is a statement of
  // intent, not a position.
  if (velocityY <= -MOBILE_DOCK_FLING_VELOCITY) {
    return 'full';
  }
  if (velocityY >= MOBILE_DOCK_FLING_VELOCITY) {
    return 'half';
  }

  // A net-downward release below the midpoint between Collapsed and Half has
  // clearly missed Half — send it the rest of the way down instead of
  // dead-ending. Gated on deltaY so an upward-opening drag (e.g. reopening
  // from Collapsed) always falls through to the position rule below.
  //
  // Since #795 the position rule below reaches the same verdict for every
  // metrics configuration (Full is always further away than Collapsed at these
  // heights), so this branch is currently redundant. It is kept as the
  // explicit statement of the #751 intent — "the gesture that opens the dock
  // must also be able to put it away" — which would otherwise survive only as
  // an accident of the nearest-snap arithmetic.
  if (deltaY >= TAP_MOVE_THRESHOLD) {
    const collapseBelow =
      (dockSnapPixels('collapsed', metrics) + dockSnapPixels('half', metrics)) /
      2;
    if (pixels <= collapseBelow) {
      return 'collapsed';
    }
  }

  // A slow drag lands where the user released it (#795). Direction used to win
  // here too, which made *any* upward movement past the 6px tap threshold
  // resolve to Full no matter where the pointer actually was — so on a phone
  // every resize, 60px or 200px, jumped straight to fullscreen and the height
  // the user chose was ignored. Position is the honest answer for a
  // deliberate, unhurried gesture; the fling branches above still own intent.
  const nearest = nearestDockSnap(pixels, metrics);

  // One exception, preserved from the direction-wins era: a gesture that is
  // opening the dock must never end up collapsing it. Reopening necessarily
  // *starts* near the Collapsed height, so a modest upward drag can still be
  // numerically nearest Collapsed while plainly meaning "open".
  if (deltaY <= -TAP_MOVE_THRESHOLD && nearest === 'collapsed') {
    return 'half';
  }

  return nearest;
}

/** Cycles Collapsed → Half → Full → Collapsed for explicit keyboard control. */
export function nextDockSnap(snap: DockSnap): DockSnap {
  const idx = DOCK_SNAP_ORDER.indexOf(snap);
  return DOCK_SNAP_ORDER[(idx + 1) % DOCK_SNAP_ORDER.length];
}

/** Grows one snap (toward Full), clamped at Full. */
export function growDockSnap(snap: DockSnap): DockSnap {
  const idx = DOCK_SNAP_ORDER.indexOf(snap);
  return DOCK_SNAP_ORDER[Math.min(DOCK_SNAP_ORDER.length - 1, idx + 1)];
}

/** Shrinks one snap (toward Collapsed), clamped at Collapsed. */
export function shrinkDockSnap(snap: DockSnap): DockSnap {
  const idx = DOCK_SNAP_ORDER.indexOf(snap);
  return DOCK_SNAP_ORDER[Math.max(0, idx - 1)];
}

/** Read the persisted snap, falling back to the default. */
export function readDockSnap(): DockSnap {
  try {
    const raw = localStorage.getItem(DOCK_SNAP_STORAGE_KEY);
    if (raw && (DOCK_SNAP_ORDER as string[]).includes(raw)) {
      return raw as DockSnap;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_DOCK_SNAP;
}

/** Persist the snap state. */
export function writeDockSnap(snap: DockSnap): void {
  try {
    localStorage.setItem(DOCK_SNAP_STORAGE_KEY, snap);
  } catch {
    /* ignore */
  }
}

/**
 * Whether a route change should return a maximized dock to its docked size.
 *
 * A maximized dock is opaque and full-height, so navigating elsewhere in the
 * app changes the view *underneath* it and nothing moves — from the user's
 * side the click did nothing (#869). Dock state lives in the query string and
 * `navigate()` preserves it, so `maximize=true` survives the route change.
 *
 * Only a real pathname change counts: re-renders and query-only updates (the
 * dock writes its own `dock`/`maximize` params) must not collapse a dock the
 * user just maximized.
 */
export function shouldRestoreDockOnNavigation({
  previousPathname,
  pathname,
  isDockMaximized,
}: {
  previousPathname: string;
  pathname: string;
  isDockMaximized: boolean;
}): boolean {
  if (!isDockMaximized) return false;
  return previousPathname !== pathname;
}

/**
 * The snap a navigation-restore should leave behind, or `null` when the
 * current one is already coherent.
 *
 * Restoring only `isDockMaximized` is not enough on mobile: the snap-sync
 * effect computes `isDockMaximized ? 'full' : dockSnap`, so clearing the flag
 * while `dockSnap` still says `'full'` makes it re-expand to full height and
 * silently undo the restore (#869 review). `station.chatDock.snap` is also the
 * persisted "previous size", so leaving it at Full would reopen full-height
 * later while the flag says otherwise — the same incoherence #795 had to fix.
 */
export function snapAfterNavigationRestore(snap: DockSnap): DockSnap | null {
  return snap === 'full' ? DEFAULT_DOCK_SNAP : null;
}
