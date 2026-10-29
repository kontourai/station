import type { MouseEvent, PointerEvent } from 'react';
import { useRef, useState } from 'react';

export function useInboxSwipe(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const origin = useRef<{
    x: number;
    y: number;
    id: number;
    horizontal: boolean;
  } | null>(null);
  const suppressUntil = useRef(0);
  return {
    open: enabled && open,
    close: () => setOpen(false),
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      suppressUntil.current = 0;
      if (
        !enabled ||
        !event.isPrimary ||
        event.pointerType === 'mouse' ||
        !(event.target instanceof Element) ||
        !event.target.closest('.inbox-row__open') ||
        !event.currentTarget.contains(event.target)
      )
        return;
      origin.current = {
        x: event.clientX,
        y: event.clientY,
        id: event.pointerId,
        horizontal: false,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (
        !start.horizontal &&
        Math.abs(dy) > 12 &&
        Math.abs(dy) >= Math.abs(dx)
      ) {
        origin.current = null;
        return;
      }
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        start.horizontal = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const start = origin.current;
      origin.current = null;
      if (!start || start.id !== event.pointerId || !start.horizontal) return;
      suppressUntil.current = Date.now() + 700;
      const dx = event.clientX - start.x;
      if (Math.abs(dx) >= 40) setOpen(dx < 0);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: () => {
      origin.current = null;
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (
        Date.now() >= suppressUntil.current ||
        !(event.target instanceof Node) ||
        !event.currentTarget.contains(event.target)
      )
        return;
      suppressUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
