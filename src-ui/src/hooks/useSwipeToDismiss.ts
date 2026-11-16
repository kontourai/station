import type { CSSProperties, MouseEvent, PointerEvent } from 'react';
import { useCallback, useRef, useState } from 'react';

/**
 * Touch swipe-to-dismiss for a toast card. Same gesture rules as the Inbox
 * row swipe (`useInboxSwipe`): touch or pen only, a 12px slop, and a
 * horizontal lock before the card moves, so a vertical scroll or a tap is
 * never taken. Either direction dismisses once the drag passes the threshold
 * or flings fast enough; a shorter drag springs back. A click that ends a
 * drag is swallowed so the card does not also activate.
 */
const SLOP_PX = 12;
const MIN_DISMISS_PX = 72;
const DISMISS_FRACTION = 0.35;
const FLING_PX_PER_MS = 0.5;
const MIN_FLING_PX = 32;
/** `--motion-fast`, the slide-out transition in NotificationContainer.css. */
export const SWIPE_DISMISS_EXIT_MS = 150;

export function useSwipeToDismiss(enabled: boolean, onDismiss: () => void) {
  const [offset, setOffset] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<-1 | 1 | null>(null);
  const origin = useRef<{
    x: number;
    y: number;
    t: number;
    id: number;
    horizontal: boolean;
    element: HTMLElement;
  } | null>(null);
  const suppressUntil = useRef(0);

  const reset = useCallback(() => {
    const start = origin.current;
    origin.current = null;
    setOffset(null);
    if (start?.element.hasPointerCapture?.(start.id))
      start.element.releasePointerCapture(start.id);
  }, []);

  const shown = leaving ? `${leaving * 110}%` : `${offset ?? 0}px`;
  const style: CSSProperties & { '--toast-swipe-offset': string } = {
    '--toast-swipe-offset': shown,
  };

  return {
    style,
    dragging: offset !== null,
    leaving: leaving !== null,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (
        !enabled ||
        leaving ||
        !event.isPrimary ||
        event.button !== 0 ||
        event.pointerType === 'mouse'
      )
        return;
      origin.current = {
        x: event.clientX,
        y: event.clientY,
        t: event.timeStamp,
        id: event.pointerId,
        horizontal: false,
        element: event.currentTarget,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!start.horizontal) {
        if (Math.abs(dy) > SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
          reset();
          return;
        }
        if (Math.abs(dx) <= SLOP_PX || Math.abs(dx) <= Math.abs(dy) * 1.5)
          return;
        start.horizontal = true;
        start.element.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
      setOffset(dx);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start || start.id !== event.pointerId) return;
      reset();
      if (!start.horizontal) return;
      suppressUntil.current = Date.now() + 500;
      const dx = event.clientX - start.x;
      const elapsed = Math.max(1, event.timeStamp - start.t);
      const width = start.element.getBoundingClientRect().width;
      const threshold = Math.max(MIN_DISMISS_PX, width * DISMISS_FRACTION);
      const fling =
        Math.abs(dx) >= MIN_FLING_PX &&
        Math.abs(dx) / elapsed >= FLING_PX_PER_MS;
      if (Math.abs(dx) >= threshold || fling) {
        setLeaving(dx < 0 ? -1 : 1);
        setTimeout(onDismiss, SWIPE_DISMISS_EXIT_MS);
      }
    },
    onPointerCancel: reset,
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => {
      if (event.target === event.currentTarget) reset();
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (Date.now() >= suppressUntil.current) return;
      suppressUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
