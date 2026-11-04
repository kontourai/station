import type {
  LiveSurfaceFold,
  LiveSurfacePosture,
} from '@kontourai/station-contracts/live-surface';

/**
 * How a foldable's lit display is drawn bent at its hinge, and how a point
 * on that drawing maps back to the flat frame the device addresses.
 *
 * The frame is cut at its crease into two halves. Each half turns about the
 * crease by its own angle (positive brings its outer edge toward the
 * viewer) and is seen through a perspective whose eye sits `perspective`
 * pixels in front of the crease's centre. CSS draws the same projection
 * (`perspective` on the container, the halves turned about the crease), so
 * `unprojectFoldPoint` is the exact inverse of what the viewer shows.
 */

export type FoldCrease = 'vertical' | 'horizontal';

export interface FoldPresentation {
  /** Where the display bends; null draws it flat (the cover display). */
  crease: FoldCrease | null;
  /** Turn of the left/top and right/bottom halves, in degrees. */
  turns: readonly [number, number];
}

/**
 * The hinge angle each stand rests at on the simulator, so a stand the
 * device names without an angle is still drawn bent.
 */
export const POSTURE_HINGE_ANGLE: Readonly<Record<LiveSurfacePosture, number>> =
  {
    closed: 0,
    tent: 80,
    book: 90,
    laptop: 90,
    open: 180,
  };

/** A turn this close to edge-on would draw a sliver; it is held short of it. */
const MAX_TURN = 80;

const FLAT: FoldPresentation = { crease: null, turns: [0, 0] };

/**
 * The drawing for `fold`. `previewAngle` (a hinge being dragged) replaces
 * the device's reported angle until the device reports the new one.
 *
 * The crease splits the frame's longer side: a book-style inner display is
 * wider than tall when the hinge stands upright and taller than wide when
 * it lies across, whichever way the device has been turned.
 */
export function foldPresentation(
  fold: LiveSurfaceFold | undefined,
  shown: { width: number; height: number },
  previewAngle: number | null = null,
): FoldPresentation {
  if (!fold || fold.activeDisplay === 'cover') return FLAT;
  const angle =
    previewAngle ??
    fold.hingeAngle ??
    (fold.posture ? POSTURE_HINGE_ANGLE[fold.posture] : 180);
  const bend = Math.min(180, Math.max(0, 180 - angle));
  const crease: FoldCrease =
    shown.width >= shown.height ? 'vertical' : 'horizontal';
  const cap = (turn: number) => Math.max(-MAX_TURN, Math.min(MAX_TURN, turn));
  // A stand without a preview keeps its own shape; a dragged hinge bends
  // symmetrically, the way a hand opens a book.
  const posture = previewAngle === null ? fold.posture : null;
  if (posture === 'laptop') return { crease, turns: [0, cap(bend)] };
  if (posture === 'tent')
    return { crease, turns: [cap(-bend / 2), cap(-bend / 2)] };
  return { crease, turns: [cap(bend / 2), cap(bend / 2)] };
}

/** The eye distance used for the drawing (CSS `perspective`), in box pixels. */
export function foldPerspective(box: { width: number; height: number }) {
  return 2.5 * Math.max(box.width, box.height);
}

const RADIANS = Math.PI / 180;

/**
 * Where a point of the FLAT box (box pixels from its top-left) is drawn.
 * Used to check the inverse; the browser does the drawing.
 */
export function projectFoldPoint(
  point: { x: number; y: number },
  box: { width: number; height: number },
  presentation: FoldPresentation,
): { x: number; y: number } {
  if (!presentation.crease) return point;
  const vertical = presentation.crease === 'vertical';
  const cx = box.width / 2;
  const cy = box.height / 2;
  const along = vertical ? point.x - cx : point.y - cy;
  const across = vertical ? point.y - cy : point.x - cx;
  const side = along < 0 ? -1 : 1;
  const turn = presentation.turns[along < 0 ? 0 : 1] * RADIANS;
  const p = foldPerspective(box);
  const u = Math.abs(along);
  const depth = p / (p - u * Math.sin(turn));
  const drawnAlong = side * u * Math.cos(turn) * depth;
  const drawnAcross = across * depth;
  return vertical
    ? { x: cx + drawnAlong, y: cy + drawnAcross }
    : { x: cx + drawnAcross, y: cy + drawnAlong };
}

/**
 * The FLAT box point drawn at `point` (box pixels from its top-left), or
 * null where the drawing shows no display.
 */
export function unprojectFoldPoint(
  point: { x: number; y: number },
  box: { width: number; height: number },
  presentation: FoldPresentation,
): { x: number; y: number } | null {
  if (!presentation.crease) {
    return point.x >= 0 &&
      point.y >= 0 &&
      point.x <= box.width &&
      point.y <= box.height
      ? point
      : null;
  }
  const vertical = presentation.crease === 'vertical';
  const cx = box.width / 2;
  const cy = box.height / 2;
  const along = vertical ? point.x - cx : point.y - cy;
  const across = vertical ? point.y - cy : point.x - cx;
  const halfLength = vertical ? cx : cy;
  const halfCross = vertical ? cy : cx;
  const side = along < 0 ? -1 : 1;
  const turn = presentation.turns[along < 0 ? 0 : 1] * RADIANS;
  const p = foldPerspective(box);
  const a = Math.abs(along);
  const denominator = p * Math.cos(turn) + a * Math.sin(turn);
  if (!(denominator > 0)) return null;
  const u = (a * p) / denominator;
  const flatAcross = (across * (p - u * Math.sin(turn))) / p;
  if (u > halfLength + 0.5 || Math.abs(flatAcross) > halfCross + 0.5)
    return null;
  const flatAlong = side * Math.min(u, halfLength);
  const clampedAcross = Math.max(-halfCross, Math.min(halfCross, flatAcross));
  return vertical
    ? { x: cx + flatAlong, y: cy + clampedAcross }
    : { x: cx + clampedAcross, y: cy + flatAlong };
}

/** A dragged hinge settles on a stand's angle when it passes within this. */
export const HINGE_SNAP_DEGREES = 6;

/**
 * The angle a dragged hinge settles on: the nearest stand angle among the
 * device's stands when within `HINGE_SNAP_DEGREES`, else the whole degree.
 */
export function snapHingeAngle(
  angle: number,
  postures: readonly LiveSurfacePosture[],
): number {
  const clamped = Math.min(180, Math.max(0, angle));
  let best: number | null = null;
  for (const posture of postures) {
    const target = POSTURE_HINGE_ANGLE[posture];
    const distance = Math.abs(target - clamped);
    if (
      distance <= HINGE_SNAP_DEGREES &&
      (best === null || distance < Math.abs(best - clamped))
    )
      best = target;
  }
  return best ?? Math.round(clamped);
}
