/**
 * Lining the accessibility tree up with the drawn device screen (#1971).
 *
 * The tree arrives normalised to its OWN screen (`space`, 0..1 on both
 * axes). The canvas shows the frame turned by the frame header's
 * `rotation` (clockwise, see `LiveSurfaceCanvas`'s `draw`). Two cases:
 *
 * - the tree is in the orientation the user sees (its `space` has the shown
 *   frame's aspect): it maps straight onto the shown box;
 * - the tree is in the raw panel's orientation (a quarter turn is pending
 *   and the tree's aspect is the RAW frame's, not the shown one): each rect
 *   is turned by the same clockwise rotation the canvas applies.
 *
 * A half turn cannot be told apart by aspect, so it is treated as the first
 * case (both platforms report their tree in interface coordinates). The
 * aspect check makes a quarter turn correct whichever way a helper reports.
 */

export type DeviceFrameRotation = 0 | 90 | 180 | 270;

export interface UnitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Turn a unit rect clockwise by `rotation` (the canvas's drawing turn). */
export function rotateUnitRect(
  rect: UnitRect,
  rotation: DeviceFrameRotation,
): UnitRect {
  switch (rotation) {
    case 90:
      // Raw (u, v) is drawn at (1 - v, u).
      return {
        x: 1 - (rect.y + rect.height),
        y: rect.x,
        width: rect.height,
        height: rect.width,
      };
    case 180:
      return {
        x: 1 - (rect.x + rect.width),
        y: 1 - (rect.y + rect.height),
        width: rect.width,
        height: rect.height,
      };
    case 270:
      // Raw (u, v) is drawn at (v, 1 - u).
      return {
        x: rect.y,
        y: 1 - (rect.x + rect.width),
        width: rect.height,
        height: rect.width,
      };
    default:
      return { ...rect };
  }
}

function isLandscape(size: { width: number; height: number }): boolean {
  return size.width > size.height;
}

/**
 * Where an element (unit rect in the tree's `space`) sits on the SHOWN
 * frame, as a unit rect of the canvas box.
 */
export function axRectOnShownFrame(
  rect: UnitRect,
  space: { width: number; height: number },
  shown: { width: number; height: number },
  rotation: DeviceFrameRotation,
): UnitRect {
  const quarterTurn = rotation === 90 || rotation === 270;
  const treeIsRaw =
    quarterTurn &&
    space.width !== space.height &&
    isLandscape(space) !== isLandscape(shown);
  return treeIsRaw ? rotateUnitRect(rect, rotation) : { ...rect };
}
