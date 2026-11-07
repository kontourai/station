import type { CSSProperties, MouseEvent, PointerEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface InboxSwipeOptions {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  actionWidth?: number;
}

export function useInboxSwipe(
  enabled: boolean,
  {
    open: controlledOpen,
    onOpenChange,
    actionWidth = 144,
  }: InboxSwipeOptions = {},
) {
  const [ownOpen, setOwnOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const open = enabled && (controlledOpen ?? ownOpen);
  const origin = useRef<{
    x: number;
    y: number;
    id: number;
    horizontal: boolean;
    offset: number;
    wasOpen: boolean;
    element: HTMLElement;
  } | null>(null);
  const row = useRef<HTMLElement | null>(null);
  const suppressUntil = useRef(0);
  const setOpen = useCallback(
    (next: boolean) => {
      setOwnOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const cancel = useCallback(() => {
    const start = origin.current;
    origin.current = null;
    setDragOffset(null);
    if (start?.horizontal) {
      suppressUntil.current = Date.now() + 700;
      if (start.element.hasPointerCapture?.(start.id))
        start.element.releasePointerCapture(start.id);
    }
  }, []);
  const close = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel, setOpen]);

  useEffect(() => {
    if (!enabled) close();
  }, [enabled, close]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !row.current?.contains(event.target))
        close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    };
  }, [open, close]);

  const offset = enabled ? (dragOffset ?? (open ? -actionWidth : 0)) : 0;
  const style: CSSProperties & {
    '--inbox-swipe-offset': string;
    '--inbox-swipe-width': string;
  } = {
    '--inbox-swipe-offset': `${offset}px`,
    '--inbox-swipe-width': `${actionWidth}px`,
  };
  return {
    open,
    close,
    style,
    dragging: enabled && dragOffset !== null,
    actionsVisible: open || offset < 0,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      suppressUntil.current = 0;
      if (
        !enabled ||
        !event.isPrimary ||
        event.button !== 0 ||
        event.pointerType === 'mouse' ||
        !(event.target instanceof Element) ||
        !event.target.closest('.inbox-row__open') ||
        !event.currentTarget.contains(event.target)
      )
        return;
      row.current = event.currentTarget;
      origin.current = {
        x: event.clientX,
        y: event.clientY,
        id: event.pointerId,
        horizontal: false,
        offset: open ? -actionWidth : 0,
        wasOpen: open,
        element: event.currentTarget,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!enabled || !start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (
        !start.horizontal &&
        Math.abs(dy) > 12 &&
        Math.abs(dy) >= Math.abs(dx)
      ) {
        cancel();
        return;
      }
      if (
        !start.horizontal &&
        Math.abs(dx) > 12 &&
        Math.abs(dx) > Math.abs(dy) * 1.5
      ) {
        start.horizontal = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      if (!start.horizontal) return;
      event.preventDefault();
      setDragOffset(Math.max(-actionWidth, Math.min(0, start.offset + dx)));
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start || start.id !== event.pointerId) return;
      cancel();
      if (!enabled) return;
      if (!start.horizontal) {
        if (start.wasOpen) {
          suppressUntil.current = Date.now() + 700;
          setOpen(false);
        }
        return;
      }
      const dx = event.clientX - start.x;
      if (Math.abs(dx) >= 40) setOpen(dx < 0);
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (
        event.detail === 0 ||
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
