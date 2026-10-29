/**
 * Snap logic for the phone sheet gesture (`useResponsiveSheetGesture`).
 *
 * A sheet docked to the bottom edge rests in one of two heights, Default (the
 * height its own CSS gives it) or Full, and a drag can also put it away. While
 * dragging, the sheet's visible height tracks the pointer; on release it snaps
 * to the nearest resting state, or follows a fling. Pure (no React, no DOM) so
 * the snap math is unit-testable, like the dock's `dockSnap.ts`, whose tap and
 * fling thresholds it shares so the two gestures feel the same.
 */
import {
  MOBILE_DOCK_COLLAPSE_FLING_VELOCITY,
  MOBILE_DOCK_FLING_VELOCITY,
  nearestSnap,
} from './chat-dock/dockSnap';

export type SheetSnap = 'dismiss' | 'default' | 'full';

/**
 * Below this much extra room, Full is not offered: a sheet whose own CSS
 * already fills the viewport has nowhere meaningful to grow.
 */
export const SHEET_MIN_EXPANSION = 48;

interface SheetSnapInput {
  /** Where the sheet rested when the gesture began. */
  start: Exclude<SheetSnap, 'dismiss'>;
  /** Visible sheet height (px) when the gesture began. */
  startHeight: number;
  /** Height (px) of the Default resting state. */
  defaultHeight: number;
  /** Height (px) of the Full resting state. */
  fullHeight: number;
  /** Release minus press, CSS px; positive is downward. */
  deltaY: number;
  /** Release speed, CSS px/ms; positive is downward. */
  velocityY: number;
}

export function sheetCanExpand(defaultHeight: number, fullHeight: number) {
  return fullHeight - defaultHeight >= SHEET_MIN_EXPANSION;
}

/** Visible height for a live drag, clamped to [0, Full]. */
export function sheetDragHeight(
  startHeight: number,
  deltaY: number,
  fullHeight: number,
) {
  return Math.min(fullHeight, Math.max(0, startHeight - deltaY));
}

/**
 * Resolve a released drag to a resting state.
 *
 * A fling wins over position. An upward fling expands. A downward fling from
 * Full lands on Default, so a moderate flick does not throw away a sheet the
 * user just expanded. Only a decisive downward flick from Default dismisses
 * (the dock's collapse-fling speed). Otherwise the nearest state wins, ties
 * going to the larger one so a release exactly halfway keeps the sheet open.
 */
export function resolveSheetSnap({
  start,
  startHeight,
  defaultHeight,
  fullHeight,
  deltaY,
  velocityY,
}: SheetSnapInput): SheetSnap {
  const canExpand = sheetCanExpand(defaultHeight, fullHeight);
  if (velocityY <= -MOBILE_DOCK_FLING_VELOCITY && deltaY < 0)
    return canExpand ? 'full' : 'default';
  if (velocityY >= MOBILE_DOCK_FLING_VELOCITY && deltaY > 0) {
    if (start === 'full' && canExpand) return 'default';
    if (velocityY >= MOBILE_DOCK_COLLAPSE_FLING_VELOCITY) return 'dismiss';
  }
  // Largest first: ties keep the sheet open.
  const candidates: [SheetSnap, number][] = [
    ...(canExpand ? [['full', fullHeight] as [SheetSnap, number]] : []),
    ['default', defaultHeight],
    ['dismiss', 0],
  ];
  return nearestSnap(
    candidates,
    sheetDragHeight(startHeight, deltaY, fullHeight),
  );
}
