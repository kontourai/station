/**
 * Mobile file-tree snap logic for the coding layout.
 *
 * On phones the file tree is the top section of a stacked layout. Instead of a
 * fixed `30vh`, it snaps between three discrete sizes the user can drive with a
 * drag handle (drag to resize, release to snap; tap to cycle). All of this is
 * mobile-only — the desktop file-tree column is untouched.
 *
 * This module is intentionally pure (no React, no DOM) so the snap math is
 * unit-testable in isolation.
 */

export type TreeSnap = 'collapsed' | 'half' | 'full';

export const TREE_SNAP_ORDER: TreeSnap[] = ['collapsed', 'half', 'full'];

export const DEFAULT_TREE_SNAP: TreeSnap = 'half';

export const TREE_SNAP_STORAGE_KEY = 'station.coding.treeSnap';

/**
 * Pixel/viewport heights per snap state. `collapsed` is a fixed peek (just the
 * header), the other two are viewport-relative so they scale with the device.
 */
export const TREE_SNAP_HEIGHT: Record<TreeSnap, string> = {
  collapsed: '44px',
  half: '48vh',
  full: '85vh',
};

/** Movement threshold (px) below which a pointer interaction counts as a tap. */
export const TAP_MOVE_THRESHOLD = 6;

/** Returns the CSS height value (e.g. `48vh`) for a snap state. */
export function treeSnapHeight(snap: TreeSnap): string {
  return TREE_SNAP_HEIGHT[snap];
}

/** Cycles Collapsed → Half → Full → Collapsed. */
export function nextTreeSnap(snap: TreeSnap): TreeSnap {
  const idx = TREE_SNAP_ORDER.indexOf(snap);
  return TREE_SNAP_ORDER[(idx + 1) % TREE_SNAP_ORDER.length];
}

/** Grows one snap (toward Full), clamped at Full. */
export function growTreeSnap(snap: TreeSnap): TreeSnap {
  const idx = TREE_SNAP_ORDER.indexOf(snap);
  return TREE_SNAP_ORDER[Math.min(TREE_SNAP_ORDER.length - 1, idx + 1)];
}

/** Shrinks one snap (toward Collapsed), clamped at Collapsed. */
export function shrinkTreeSnap(snap: TreeSnap): TreeSnap {
  const idx = TREE_SNAP_ORDER.indexOf(snap);
  return TREE_SNAP_ORDER[Math.max(0, idx - 1)];
}

/** Resolves a snap height to absolute pixels for a given viewport height. */
export function treeSnapPixels(snap: TreeSnap, viewportHeight: number): number {
  const value = TREE_SNAP_HEIGHT[snap];
  if (value.endsWith('vh')) {
    return (parseFloat(value) / 100) * viewportHeight;
  }
  return parseFloat(value);
}

/** Clamp a live drag height to the [collapsed, full] pixel range. */
export function clampTreeHeight(
  pixels: number,
  viewportHeight: number,
): number {
  const min = treeSnapPixels('collapsed', viewportHeight);
  const max = treeSnapPixels('full', viewportHeight);
  return Math.min(max, Math.max(min, pixels));
}

/** Given a live drag height in px, find the nearest snap state. */
export function nearestTreeSnap(
  pixels: number,
  viewportHeight: number,
): TreeSnap {
  let best: TreeSnap = TREE_SNAP_ORDER[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const snap of TREE_SNAP_ORDER) {
    const dist = Math.abs(treeSnapPixels(snap, viewportHeight) - pixels);
    if (dist < bestDist) {
      bestDist = dist;
      best = snap;
    }
  }
  return best;
}

/** Read the persisted snap, falling back to the default. */
export function readTreeSnap(): TreeSnap {
  try {
    const raw = localStorage.getItem(TREE_SNAP_STORAGE_KEY);
    if (raw && (TREE_SNAP_ORDER as string[]).includes(raw)) {
      return raw as TreeSnap;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_TREE_SNAP;
}

/** Persist the snap state. */
export function writeTreeSnap(snap: TreeSnap): void {
  try {
    localStorage.setItem(TREE_SNAP_STORAGE_KEY, snap);
  } catch {
    /* ignore */
  }
}
