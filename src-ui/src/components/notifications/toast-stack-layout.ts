/**
 * Pure layout helpers for the transient toast stack (station#1960).
 * Station-owned — no external toast library.
 */

/** Max transient cards rendered in the flyout stack. */
export const TOAST_STACK_VISIBLE_CAP = 5;

/** Peek (px) each collapsed card sticks out under the front card. */
export const TOAST_STACK_PEEK_PX = 10;

/** Scale step applied per depth when collapsed. */
export const TOAST_STACK_SCALE_STEP = 0.06;

export type ToastStackItemLayout = {
  index: number;
  /** 0 = front-most (newest). */
  depth: number;
  hideContentWhenCollapsed: boolean;
  offsetY: number;
  scale: number;
  zIndex: number;
};

/**
 * Behind cards hide body content when collapsed so only the front card is
 * readable; expanded stack shows every card.
 */
export function shouldHideCollapsedToastContent(
  depth: number,
  visibleCount: number,
): boolean {
  if (visibleCount <= 1) return false;
  return depth > 0;
}

/**
 * Layout for a visible toast list ordered front-first (newest at index 0).
 * Offset/scale apply only in the collapsed (non-expanded) presentation;
 * expanded CSS ignores them.
 */
export function buildToastStackLayout(
  count: number,
  options?: { peekPx?: number; scaleStep?: number },
): ToastStackItemLayout[] {
  const peek = options?.peekPx ?? TOAST_STACK_PEEK_PX;
  const scaleStep = options?.scaleStep ?? TOAST_STACK_SCALE_STEP;
  const items: ToastStackItemLayout[] = [];
  for (let index = 0; index < count; index += 1) {
    const depth = index;
    const scale = Math.max(0.82, 1 - depth * scaleStep);
    items.push({
      index,
      depth,
      hideContentWhenCollapsed: shouldHideCollapsedToastContent(depth, count),
      offsetY: depth * peek,
      scale,
      zIndex: count - depth,
    });
  }
  return items;
}

/** Newest-first list → front of stack; cap for render. */
export function selectToastStackItems<T>(
  items: readonly T[],
  cap = TOAST_STACK_VISIBLE_CAP,
): T[] {
  if (items.length <= cap) return [...items];
  return items.slice(0, cap);
}
