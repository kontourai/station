import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useState,
} from 'react';

const MENU_GAP_PX = 4;
const VIEWPORT_GUTTER_PX = 8;
/** The menu container's own vertical padding. */
const MENU_PADDING_PX = 8;

interface FixedMenuPlacementOptions {
  /** The side of the trigger the menu opens on while that side has room. */
  preferredSide: 'above' | 'below';
  /**
   * Twin of the menu's CSS `min-width`: the placement math needs the menu's
   * widest guaranteed extent before the portalled box has been laid out, so
   * the two must move together.
   */
  minWidthPx: number;
  /**
   * Estimated height of one row. It only has to pick the correct side of the
   * trigger, not equal the rendered height.
   */
  rowPx: number;
  rowCount: number;
}

/**
 * Fixed placement for a portalled "⋯" row menu, anchored to its trigger.
 *
 * A menu positioned absolutely inside its row is clipped by the surfaces
 * around it (a message bubble's `overflow-x: hidden`, a list pane's scroll
 * container). Portalling to the document escapes the clipping and stacking
 * context, and a fixed box anchored to the trigger's own rect replaces the
 * in-row anchoring.
 *
 * Opens on `preferredSide` and flips when that side cannot hold the estimated
 * rows. Right-aligns to the trigger, keeping the viewport gutter, and pins the
 * left gutter when the trigger sits too near the left edge to right-align a
 * min-width menu.
 *
 * Call `place()` as the menu opens; while open, the box follows the trigger
 * through resize and scroll, which a fixed box would otherwise not ride.
 */
export function useFixedMenuPlacement(
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  { preferredSide, minWidthPx, rowPx, rowCount }: FixedMenuPlacementOptions,
) {
  const [position, setPosition] = useState<CSSProperties>({});
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const roomNeeded = rowCount * rowPx + MENU_PADDING_PX + MENU_GAP_PX;
    const fitsPreferred =
      preferredSide === 'above'
        ? rect.top >= roomNeeded
        : window.innerHeight - rect.bottom >= roomNeeded;
    const above = fitsPreferred === (preferredSide === 'above');
    const next: CSSProperties = above
      ? { bottom: window.innerHeight - rect.top + MENU_GAP_PX }
      : { top: rect.bottom + MENU_GAP_PX };
    if (rect.right >= minWidthPx + VIEWPORT_GUTTER_PX) {
      next.right = Math.max(VIEWPORT_GUTTER_PX, window.innerWidth - rect.right);
    } else {
      next.left = VIEWPORT_GUTTER_PX;
    }
    setPosition(next);
  }, [triggerRef, preferredSide, minWidthPx, rowPx, rowCount]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);
  return { position, place };
}
