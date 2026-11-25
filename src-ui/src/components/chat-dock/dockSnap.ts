/**
 * Snap logic for the bottom chat dock's resize handle.
 *
 * The dock's top edge is draggable. While dragging the height tracks the
 * pointer; on release the height snaps to the nearest of four discrete states
 * — Collapsed (header only) / Half / Tall / Full (maximized). It is kept
 * intentionally pure (no React, no DOM) so the snap math is unit-testable in
 * isolation. The phone sheet gesture (`sheetSnap.ts`) reuses `nearestSnap` and
 * the tap and fling thresholds from here, so the two gestures agree on what
 * "nearest" and "fling" mean.
 *
 * Pixel resolution depends on the live viewport, so heights are resolved
 * against `viewportHeight` (and a toolbar offset for the Full state, which can
 * never exceed `viewport - toolbar`).
 */

export type DockSnap = 'collapsed' | 'half' | 'tall' | 'full';

/** Smallest to largest: the order the release tie-break and keyboard steps follow. */
export const DOCK_SNAP_ORDER: readonly DockSnap[] = [
  'collapsed',
  'half',
  'tall',
  'full',
];

export const DEFAULT_DOCK_SNAP: DockSnap = 'half';

const DOCK_SNAP_STORAGE_KEY = 'station.chatDock.snap';

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
const DOCK_HALF_FRACTION = 0.45;

/**
 * Tall opens it to this fraction: most of the screen, with the page behind
 * still showing. Half leaves too little transcript to read on a phone and
 * Full hides everything else, so Tall is the level a conversation is read at
 * while the page behind stays in view.
 */
const DOCK_TALL_FRACTION = 0.75;

/**
 * On a phone, Half is never shorter than this: 45% of a 390×844 screen. At
 * 300px on a 667px-tall phone the bar and a three-line composer left about
 * 105px of transcript, less than one message.
 */
const DOCK_HALF_MIN_HEIGHT = 380;

/**
 * The least distance between two open levels. Each level's release band is
 * only as wide as this gap lets it be, so Half's floor stops short of Tall
 * instead of meeting or passing it on a short viewport.
 */
const DOCK_LEVEL_GAP = 100;

/** Movement threshold (px) below which a pointer interaction counts as a tap. */
export const TAP_MOVE_THRESHOLD = 6;

/** Release speed (CSS px/ms) that makes a mobile dock gesture a fling. */
export const MOBILE_DOCK_FLING_VELOCITY = 0.45;

/**
 * Downward release speed (CSS px/ms) fast enough to collapse the dock
 * outright — the flick that opens the dock must also be able to put it away.
 * Deliberately faster than `MOBILE_DOCK_FLING_VELOCITY` (the one-level fling)
 * so a moderate downward fling only steps down one level; only a decisive
 * "throw it away" flick reaches Collapsed. Standard bottom-sheet
 * dismiss-fling feel.
 */
export const MOBILE_DOCK_COLLAPSE_FLING_VELOCITY = 0.65;

/** Minimum draggable body height (used to clamp the live drag). */
export const DOCK_MIN_HEIGHT = 200;

export interface SnapMetrics {
  viewportHeight: number;
  toolbarHeight?: number;
  /**
   * Live collapsed-bar height (px), resolved from `--chat-dock-header-height`.
   * Defaults to the desktop `DOCK_COLLAPSED_HEIGHT` so existing callers/tests
   * keep their behavior. On mobile the CSS variable is larger, so the resize
   * snap/clamp logic snaps to the real bar height instead of the 38px literal.
   */
  collapsedHeight?: number;
  /**
   * Whether this is a phone (narrow or coarse), where Half has a floor. Off by
   * default: a desktop dock is dragged freely and uses Half only as the size
   * it opens at, which stays 45% of the viewport.
   */
  phone?: boolean;
}

/** Largest height the dock body may occupy (full minus the app toolbar). */
export function dockFullHeight({
  viewportHeight,
  toolbarHeight = 0,
}: SnapMetrics): number {
  return Math.max(DOCK_MIN_HEIGHT, viewportHeight - toolbarHeight);
}

function fractionOfViewport(fraction: number, viewportHeight: number): number {
  return Math.round(Math.max(DOCK_MIN_HEIGHT, viewportHeight * fraction));
}

function halfHeight({ phone, viewportHeight }: SnapMetrics): number {
  if (!phone) return fractionOfViewport(DOCK_HALF_FRACTION, viewportHeight);
  return Math.round(
    Math.max(
      DOCK_MIN_HEIGHT,
      Math.min(
        Math.max(DOCK_HALF_MIN_HEIGHT, viewportHeight * DOCK_HALF_FRACTION),
        viewportHeight * DOCK_TALL_FRACTION - DOCK_LEVEL_GAP,
      ),
    ),
  );
}

/** Resolve a snap state to an absolute pixel height for the given viewport. */
export function dockSnapPixels(snap: DockSnap, metrics: SnapMetrics): number {
  switch (snap) {
    case 'collapsed':
      return metrics.collapsedHeight ?? DOCK_COLLAPSED_HEIGHT;
    case 'half':
      return halfHeight(metrics);
    case 'tall':
      return fractionOfViewport(DOCK_TALL_FRACTION, metrics.viewportHeight);
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
  return nearestSnap(
    DOCK_SNAP_ORDER.map((snap) => [snap, dockSnapPixels(snap, metrics)]),
    pixels,
  );
}

/**
 * The snap state whose height is nearest `pixels`. Ties go to the earliest
 * candidate, so the caller states its tie preference by order: the dock lists
 * smallest first, the phone sheet (`sheetSnap.ts`) largest first. One
 * implementation, so the two gestures cannot drift on what "nearest" means.
 */
export function nearestSnap<Snap extends string>(
  candidates: readonly (readonly [Snap, number])[],
  pixels: number,
): Snap {
  let [best] = candidates[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [snap, height] of candidates) {
    const dist = Math.abs(height - pixels);
    if (dist < bestDist) {
      bestDist = dist;
      best = snap;
    }
  }
  return best;
}

/**
 * Resolve a completed mobile drag to a snap state.
 *
 * A decisive downward flick (`MOBILE_DOCK_COLLAPSE_FLING_VELOCITY`) collapses
 * the dock outright from any open level: position never gets a veto over a
 * clear "throw it away" gesture, which is what lets the gesture that opens
 * the dock also put it away. An upward fling opens to Full. A moderate
 * downward fling steps down ONE level from where the gesture began and never
 * closes an open dock, so a casual flick cannot put it away by accident.
 * Anything slower lands on the level nearest where it was released.
 *
 * The below-Half-band collapse is gated on net-downward motion
 * (`deltaY >= TAP_MOVE_THRESHOLD`) because reopening from Collapsed
 * necessarily *starts* the drag near the Collapsed pixel height — an
 * upward-opening gesture that hasn't traveled far yet is still numerically
 * "below the Half band" and must not be reinterpreted as "collapse" just
 * because of where it started.
 *
 * `deltaY` and `velocityY` use pointer coordinates: negative means the user
 * moved upward (grow), positive means downward (shrink). `start` is the level
 * the dock rested on when the gesture began.
 */
export function resolveMobileDockSnap({
  pixels,
  deltaY,
  velocityY,
  start,
  metrics,
}: {
  pixels: number;
  deltaY: number;
  velocityY: number;
  start: DockSnap;
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
    // One level down from where the gesture began, and never from Half to
    // Collapsed: putting an open dock away takes the decisive flick above.
    return start === 'full' || start === 'tall' ? shrinkDockSnap(start) : start;
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

/** Cycles Collapsed → Half → Tall → Full → Collapsed for explicit keyboard control. */
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
    if (raw && (DOCK_SNAP_ORDER as readonly string[]).includes(raw)) {
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
 * On a phone, leaving Chat for Settings/Home/Engines must collapse the
 * dock entirely — a half-open sheet over the next route is the desktop
 * overlay leaking onto a destination. Query-only updates (chat=, dock=)
 * stay on the same pathname and must not collapse.
 */
export function shouldCollapseDockOnMobileNavigation({
  previousPathname,
  pathname,
  isMobile,
  isDockOpen,
}: {
  previousPathname: string;
  pathname: string;
  isMobile: boolean;
  isDockOpen: boolean;
}): boolean {
  if (!isMobile || !isDockOpen) return false;
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
 *
 * A Full snap steps back to `dockedSnap`, the level the dock last rested on
 * before it was maximized. Only an open level counts: one maximized from its
 * bar returns to the default, because a navigation restore exists to leave
 * the dock open at a docked size (#869), not to put it away.
 */
export function snapAfterNavigationRestore(
  snap: DockSnap,
  dockedSnap: DockSnap = DEFAULT_DOCK_SNAP,
): DockSnap | null {
  if (snap !== 'full') return null;
  return dockedSnap === 'half' || dockedSnap === 'tall'
    ? dockedSnap
    : DEFAULT_DOCK_SNAP;
}
