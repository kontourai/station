import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { developerFeatures } from '../hooks/developer-features';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { motionTokenMs } from '../lib/reduced-motion';
import { TAP_MOVE_THRESHOLD } from './chat-dock/dockSnap';
import {
  resolveSheetSnap,
  type SheetSnap,
  sheetCanExpand,
  sheetDragHeight,
} from './sheetSnap';

/**
 * How far (px) a panel's bottom edge may sit from its overlay's bottom edge
 * and still count as docked to it. Anything further is a floating card or a
 * centred dialog, which gets no handle: dragging it down would not read as
 * putting it away.
 */
const DOCKED_TOLERANCE = 12;

/** The handle's hit area reaches this far (px) above the panel's top edge. */
const HANDLE_REACH_ABOVE = 28;

/**
 * Width (px) of the handle's hit area, centred on the panel. Kept narrow so it
 * covers no title-row control: titles sit at the start edge and close buttons
 * at the end edge of every shared sheet header.
 */
const HANDLE_WIDTH = 120;

/**
 * Attribute the shared stylesheet keys the Full height on. Set imperatively:
 * the resting state belongs to this gesture, and a React state flip would
 * re-render every consumer for a change only CSS reads.
 */
const EXPANDED_ATTRIBUTE = 'data-sheet-expanded';

interface UseResponsiveSheetGestureOptions {
  /** Preview on, phone width, open, dismissible, not an alertdialog. */
  enabled: boolean;
  overlayRef: RefObject<HTMLDivElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
}

/**
 * The gap the Full state leaves above the sheet: the top safe area plus a
 * spacing step. It is declared once, in CSS, as the handle's
 * `scroll-margin-top`, because `env()` only resolves inside a real property;
 * reading it back here keeps the live drag's ceiling and the resting Full
 * height the same number.
 */
function fullTopGap(handle: HTMLElement | null): number {
  if (!handle) return 0;
  const value = Number.parseFloat(getComputedStyle(handle).scrollMarginTop);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Publish (or, with `null`, withdraw) the Full height the shared stylesheet
 * sizes the expanded panel from. The one writer of the property; its name is
 * spelled out literally so the undefined-custom-property scan sees it defined.
 */
function publishFullHeight(overlay: HTMLElement, height: number | null) {
  if (height === null)
    overlay.style.removeProperty('--responsive-sheet-full-height');
  else
    overlay.style.setProperty('--responsive-sheet-full-height', `${height}px`);
}

/**
 * Full height: from the panel's own bottom edge up to the top gap. Measured
 * rather than derived from the viewport in CSS, because consumers dock the
 * panel inside overlay padding and above the keyboard, which CSS here cannot
 * see; the bottom edge is where the panel actually rests. Not offered below
 * the height the sheet already has.
 */
function measureFullHeight(
  overlay: HTMLElement,
  panelRect: DOMRect,
  handle: HTMLElement | null,
) {
  const overlayTop = overlay.getBoundingClientRect().top;
  return Math.max(
    panelRect.height,
    Math.round(panelRect.bottom - overlayTop - fullTopGap(handle)),
  );
}

function clearInlineGeometry(panel: HTMLElement) {
  panel.style.removeProperty('transition');
  panel.style.removeProperty('transform');
  panel.style.removeProperty('height');
  panel.style.removeProperty('max-height');
}

/**
 * Whether the Sheet gestures device preview is on. Read from the store
 * directly rather than through `useDeveloperFeatures`: every dialog renders
 * this surface, and `DeviceSettingsContext` arms haptics when it loads, which
 * the surface has no business depending on.
 */
export function useSheetGesturesPreview(): boolean {
  return developerFeatures(
    useSyncExternalStore(
      deviceSettingsStore.subscribe,
      deviceSettingsStore.getSnapshot,
      deviceSettingsStore.getSnapshot,
    ),
  ).sheetGestures;
}

/**
 * Drag-to-expand and drag-to-dismiss for a `ResponsiveDialogSurface` sheet on
 * a phone, behind the Sheet gestures device preview.
 *
 * The gesture lives on a handle the surface renders next to (not inside) the
 * panel, so it needs no knowledge of the consumer's markup and never competes
 * with the panel's own scrolling or its controls. The handle appears only
 * while the panel is measured docked to the overlay's bottom edge.
 *
 * Live geometry is written to the panel's inline style, never through React
 * state, so a drag re-renders nothing. Pulling up grows the panel's height;
 * pulling down shrinks it back to its Default height, then slides it down.
 * Dismissal plays the slide out and calls the surface's ordinary `onClose`,
 * so history entries, unsaved-change guards and focus return behave exactly
 * as they do for the close button. A consumer that refuses to close gets its
 * sheet back.
 */
export function useResponsiveSheetGesture({
  enabled,
  overlayRef,
  panelRef,
  onDismiss,
}: UseResponsiveSheetGestureOptions) {
  const handleRef = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  const [handleStyle, setHandleStyle] = useState<CSSProperties>({});
  const defaultHeightRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const syncHandle = useCallback(() => {
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) return;
    const overlayRect = overlay.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    // A drag in progress moves the panel on purpose; docking is judged on the
    // resting geometry only, so the handle does not vanish under the finger.
    if (!cleanupRef.current) {
      const isDocked =
        panelRect.height > 0 &&
        Math.abs(overlayRect.bottom - panelRect.bottom) <= DOCKED_TOLERANCE;
      setDocked(isDocked);
      // Kept current while resting (keyboard, rotation), never mid-drag or
      // mid-settle, where the bottom edge is moving on purpose.
      if (settleTimerRef.current === null)
        publishFullHeight(
          overlay,
          measureFullHeight(overlay, panelRect, handleRef.current),
        );
    }
    setHandleStyle({
      // Viewport coordinates: the handle is `position: fixed`, so it does not
      // depend on whether a consumer's overlay is a containing block.
      top: `${Math.round(panelRect.top - HANDLE_REACH_ABOVE)}px`,
      left: `${Math.round(panelRect.left + (panelRect.width - HANDLE_WIDTH) / 2)}px`,
      width: `${HANDLE_WIDTH}px`,
    });
  }, [overlayRef, panelRef]);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  // Track the panel's geometry while the gesture is offered.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!enabled || !panel) {
      setDocked(false);
      return;
    }
    syncHandle();
    window.addEventListener('resize', syncHandle);
    window.visualViewport?.addEventListener('resize', syncHandle);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(syncHandle);
    observer?.observe(panel);
    if (overlayRef.current) observer?.observe(overlayRef.current);
    return () => {
      window.removeEventListener('resize', syncHandle);
      window.visualViewport?.removeEventListener('resize', syncHandle);
      observer?.disconnect();
    };
  }, [enabled, overlayRef, panelRef, syncHandle]);

  // Withdrawing the gesture (closed, preview off, desktop width) returns the
  // sheet to its own CSS geometry.
  useEffect(() => {
    if (enabled) return;
    cleanupRef.current?.();
    clearSettleTimer();
    defaultHeightRef.current = null;
    overlayRef.current?.removeAttribute(EXPANDED_ATTRIBUTE);
    if (overlayRef.current) publishFullHeight(overlayRef.current, null);
    const panel = panelRef.current;
    if (panel) clearInlineGeometry(panel);
  }, [clearSettleTimer, enabled, overlayRef, panelRef]);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      clearSettleTimer();
    },
    [clearSettleTimer],
  );

  const settle = useCallback(
    (
      snap: SheetSnap,
      metrics: { defaultHeight: number; fullHeight: number },
    ) => {
      const overlay = overlayRef.current;
      const panel = panelRef.current;
      if (!overlay || !panel) return;
      clearSettleTimer();
      const duration = motionTokenMs(
        getComputedStyle(document.documentElement),
        '--motion-base',
        200,
      );
      const easing = 'var(--ease-emphasized)';
      panel.style.transition = `height ${duration}ms ${easing}, transform ${duration}ms ${easing}`;
      const after = (finish: () => void) => {
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          finish();
          syncHandle();
        }, duration);
      };

      if (snap === 'dismiss') {
        const height = panel.getBoundingClientRect().height;
        panel.style.transform = `translateY(${Math.ceil(height + HANDLE_REACH_ABOVE)}px)`;
        after(() => {
          onDismissRef.current();
          // The consumer unmounts the surface (or flips `open`) on its next
          // render. If it is still showing two frames later it refused to
          // close — an unsaved-changes guard, say — so give the sheet back.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const current = panelRef.current;
              if (!current?.isConnected) return;
              overlayRef.current?.removeAttribute(EXPANDED_ATTRIBUTE);
              defaultHeightRef.current = null;
              clearInlineGeometry(current);
              syncHandle();
            }),
          );
        });
        return;
      }

      panel.style.transform = 'translateY(0)';
      if (snap === 'full') {
        publishFullHeight(overlay, metrics.fullHeight);
        panel.style.height = `${metrics.fullHeight}px`;
        after(() => {
          overlay.setAttribute(EXPANDED_ATTRIBUTE, '');
          clearInlineGeometry(panel);
        });
        return;
      }
      panel.style.height = `${metrics.defaultHeight}px`;
      after(() => {
        defaultHeightRef.current = null;
        clearInlineGeometry(panel);
      });
    },
    [clearSettleTimer, overlayRef, panelRef, syncHandle],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const overlay = overlayRef.current;
      const panel = panelRef.current;
      const handle = event.currentTarget;
      if (!overlay || !panel) return;
      // The browser plays no part in this gesture: no focus move, no scroll,
      // no text selection, and (with `touch-action: none` on the handle) no
      // native pan claiming the touch before the threshold.
      event.preventDefault();
      cleanupRef.current?.();
      clearSettleTimer();

      const wasExpanded = overlay.hasAttribute(EXPANDED_ATTRIBUTE);
      const panelRect = panel.getBoundingClientRect();
      const startHeight = panelRect.height;
      // Default is the height the consumer's CSS gives the sheet; measured
      // the first time it is dragged from rest and kept while expanded,
      // where the CSS height is no longer on screen to measure.
      if (!wasExpanded || defaultHeightRef.current === null)
        defaultHeightRef.current = startHeight;
      const defaultHeight = defaultHeightRef.current;
      // Snapshotted per gesture, like the dock's drag (archive#1052): the
      // Android URL bar collapsing mid-drag must not move the ceiling.
      const fullHeight = Math.max(
        defaultHeight,
        measureFullHeight(overlay, panelRect, handleRef.current),
      );
      const metrics = { defaultHeight, fullHeight };
      const canExpand = sheetCanExpand(defaultHeight, fullHeight);

      // From here the inline style owns the geometry: freeze the current
      // height so leaving the expanded attribute (whose CSS is !important)
      // is not a visible jump, and lift the consumer's max-height so the
      // panel can grow past it.
      panel.style.transition = 'none';
      panel.style.height = `${startHeight}px`;
      panel.style.maxHeight = 'none';
      overlay.removeAttribute(EXPANDED_ATTRIBUTE);

      const pointerId = event.pointerId;
      const startY = event.clientY;
      let lastY = startY;
      let lastTime = event.timeStamp;
      let velocityY = 0;
      let moved = false;
      let frame: number | null = null;
      let pendingY = startY;
      handle.setPointerCapture?.(pointerId);

      const apply = () => {
        frame = null;
        const deltaY = pendingY - startY;
        const ceiling = canExpand ? fullHeight : defaultHeight;
        const height = sheetDragHeight(startHeight, deltaY, ceiling);
        if (height >= defaultHeight) {
          panel.style.height = `${height}px`;
          panel.style.transform = 'translateY(0)';
        } else {
          panel.style.height = `${defaultHeight}px`;
          panel.style.transform = `translateY(${defaultHeight - height}px)`;
        }
        syncHandle();
      };

      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        if (!moved && Math.abs(move.clientY - startY) < TAP_MOVE_THRESHOLD)
          return;
        moved = true;
        if (move.cancelable) move.preventDefault();
        const elapsed = Math.max(1, move.timeStamp - lastTime);
        velocityY = (move.clientY - lastY) / elapsed;
        lastY = move.clientY;
        lastTime = move.timeStamp;
        pendingY = move.clientY;
        if (frame === null) frame = requestAnimationFrame(apply);
      };

      const detach = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        handle.removeEventListener('lostpointercapture', onCancel);
        if (handle.hasPointerCapture?.(pointerId))
          handle.releasePointerCapture?.(pointerId);
        cleanupRef.current = null;
      };

      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        detach();
        const start = wasExpanded ? 'full' : 'default';
        if (!moved) {
          // A tap toggles between the two resting heights.
          settle(start === 'full' || !canExpand ? 'default' : 'full', metrics);
          return;
        }
        // A finger held still before lifting is not a fling.
        const releaseVelocity = up.timeStamp - lastTime > 100 ? 0 : velocityY;
        settle(
          resolveSheetSnap({
            start,
            startHeight,
            defaultHeight,
            fullHeight,
            deltaY: up.clientY - startY,
            velocityY: releaseVelocity,
          }),
          metrics,
        );
      };

      // An interrupted gesture returns to where it began.
      const onCancel = () => {
        detach();
        settle(wasExpanded ? 'full' : 'default', metrics);
      };

      cleanupRef.current = onCancel;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      handle.addEventListener('lostpointercapture', onCancel, { once: true });
    },
    [clearSettleTimer, overlayRef, panelRef, settle, syncHandle],
  );

  return {
    showHandle: enabled && docked,
    handleProps: {
      ref: handleRef,
      className: 'responsive-sheet-handle',
      style: handleStyle,
      onPointerDown,
      'aria-hidden': true as const,
      'data-sheet-handle': '',
    },
  };
}
