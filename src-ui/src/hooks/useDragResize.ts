import { useCallback, useEffect, useRef } from 'react';

interface UseDragResizeOptions {
  setIsDragging: (value: boolean) => void;
  setHeight: (value: number) => void;
  setWidth?: (value: number) => void;
  direction?: 'vertical' | 'horizontal';
  minHeight?: number;
  maxHeightOffset?: number;
  minWidth?: number;
  maxWidthPercent?: number;
  /** Which side of the viewport owns a horizontal panel. */
  fromLeft?: boolean;
  /**
   * Invoked once, synchronously, at the very start of a drag (before the
   * first size is applied). The side-panel handle stays mounted while the
   * dock is collapsed so it can be grabbed from that state; this lets the
   * caller expand the dock the instant the drag begins so it continues
   * growing into real content instead of a collapsed/hidden shell.
   */
  onDragStart?: () => void;
}

/**
 * Pointer-Events-based drag-to-resize for the desktop chat-dock side panel
 * (width) — mirrors the vertical bottom-dock handle's approach in
 * `ChatDockResizeHandle`. Uses `setPointerCapture` so the drag keeps
 * receiving move/up events even if the pointer leaves the window or crosses
 * an iframe (e.g. the MCP-UI host); `pointerup`/`pointercancel` and the
 * browser's own `lostpointercapture` event all release the drag
 * deterministically, so it can never strand the dock in `is-dragging`. Live
 * size updates are coalesced to one `requestAnimationFrame` per pointer
 * move so a fast drag doesn't force more than one re-render per frame.
 */
export function useDragResize({
  setIsDragging,
  setHeight,
  setWidth,
  direction = 'vertical',
  minHeight = 200,
  maxHeightOffset = 150,
  minWidth = 280,
  maxWidthPercent = 0.6,
  fromLeft = false,
  onDragStart,
}: UseDragResizeOptions) {
  const cleanupRef = useRef<(() => void) | null>(null);

  const applyMove = useCallback(
    (clientX: number, clientY: number) => {
      if (direction === 'horizontal' && setWidth) {
        const newWidth = fromLeft ? clientX : window.innerWidth - clientX;
        setWidth(
          Math.max(
            minWidth,
            Math.min(newWidth, window.innerWidth * maxWidthPercent),
          ),
        );
      } else {
        const newHeight = window.innerHeight - clientY;
        setHeight(
          Math.max(
            minHeight,
            Math.min(newHeight, window.innerHeight - maxHeightOffset),
          ),
        );
      }
    },
    [
      direction,
      setWidth,
      setHeight,
      minWidth,
      maxWidthPercent,
      fromLeft,
      minHeight,
      maxHeightOffset,
    ],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      cleanupRef.current?.();
      onDragStart?.();
      setIsDragging(true);

      const pointerId = e.pointerId;
      const target = e.currentTarget;
      target.setPointerCapture?.(pointerId);

      // Align the first frame with the pointer immediately (rather than
      // waiting for the next rAF-coalesced move) so a drag starting from the
      // collapsed state doesn't jump before it starts growing.
      applyMove(e.clientX, e.clientY);

      let rafId: number | null = null;
      let pending: { x: number; y: number } | null = null;
      let settled = false;

      const flush = () => {
        rafId = null;
        if (pending) applyMove(pending.x, pending.y);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        pending = { x: ev.clientX, y: ev.clientY };
        if (rafId === null) rafId = requestAnimationFrame(flush);
      };

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        target.removeEventListener('lostpointercapture', cleanup);
        if (target.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture?.(pointerId);
        }
        if (cleanupRef.current === cleanup) cleanupRef.current = null;
        setIsDragging(false);
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cleanup();
      };

      cleanupRef.current = cleanup;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      target.addEventListener('lostpointercapture', cleanup, { once: true });
    },
    [applyMove, onDragStart, setIsDragging],
  );

  // Release an in-flight drag if the component unmounts mid-gesture.
  useEffect(() => () => cleanupRef.current?.(), []);

  return { onPointerDown };
}
