import { useCallback, useEffect, useRef } from 'react';
import {
  clampDockHeight,
  DOCK_MIN_HEIGHT,
  type DockSnap,
  resolveMobileDockSnap,
  TAP_MOVE_THRESHOLD,
} from '../components/chat-dock/dockSnap';

const INTERACTIVE_DOCK_TARGET = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[data-no-dock-drag]',
  '[role="button"]',
].join(',');

/**
 * Opt a large interactive region back INTO dragging.
 *
 * `ignoreInteractiveTargets` exists so a tap on a small control keeps its native
 * click. But the mobile dock header is almost entirely covered by one big
 * identity button, which left a ~4px strip as the only place the bar could be
 * grabbed — and that bar is the primary way to resize the dock on a phone.
 * A region marked with this attribute starts a drag like bare surface, while the
 * tap/drag discrimination below still lets a stationary press through as a click.
 */
const DOCK_DRAG_PASSTHROUGH = '[data-dock-drag-passthrough]';
const NO_DOCK_DRAG = '[data-no-dock-drag]';

export function isInteractiveDockDragTarget(
  target: EventTarget | null,
  surface: HTMLElement,
): boolean {
  if (!(target instanceof Element) || target === surface) return false;
  if (target.closest(DOCK_DRAG_PASSTHROUGH)) return false;
  return Boolean(target.closest(INTERACTIVE_DOCK_TARGET));
}

interface UseChatDockVerticalDragOptions {
  mode: 'desktop-free' | 'mobile-snap';
  toolbarHeight: number;
  collapsedHeight: number;
  ignoreInteractiveTargets?: boolean;
  /**
   * Treat interactive descendants as part of one gesture surface. A stationary
   * press remains a native click; movement past the drag threshold captures
   * the pointer and suppresses that gesture's follow-up click.
   */
  dragInteractiveTargets?: boolean;
  onSnap: (snap: DockSnap) => void;
  onCommitHeight: (height: number) => void;
  onLiveHeight: (height: number | null) => void;
  onDragStateChange: (dragging: boolean) => void;
}

/**
 * One pointer-capture gesture contract for both the narrow resize grip and the
 * forgiving mobile dock bar. Desktop commits the exact clamped height; mobile
 * resolves to Collapsed, Half, or Full (see `resolveMobileDockSnap`). Taps are
 * always no-ops and interactive descendants
 * are optionally excluded so their native click behavior remains intact.
 */
export function useChatDockVerticalDrag({
  mode,
  toolbarHeight,
  collapsedHeight,
  ignoreInteractiveTargets = false,
  dragInteractiveTargets = false,
  onSnap,
  onCommitHeight,
  onLiveHeight,
  onDragStateChange,
}: UseChatDockVerticalDragOptions) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  /** True only while this hook itself replays a stationary tap's click. */
  const replayClickRef = useRef(false);

  const clearClickSuppression = useCallback(() => {
    suppressClickRef.current = false;
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
  }, []);

  const onClickCapture = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      // A click this hook is replaying itself must pass — suppression exists
      // for the browser's own gesture click, which capture retargeted at the
      // surface (see the replay in `finish`).
      if (replayClickRef.current) return;
      // A keyboard activation is not a gesture click and can never be the one
      // this guard exists to swallow: `detail` counts the pointer clicks that
      // produced the event, so the browser's gesture click is >= 1 and
      // Enter/Space on a focused control is 0. Suppression is retired by the
      // next `pointerdown` (below) or a 500ms timer, neither of which a
      // keyboard user reaches — so without this a stale flag silently ate the
      // first Enter/Space on every mobile dock header control (archive#3345:
      // the `…` overflow trigger needed two presses).
      if (event.detail === 0) return;
      if (!suppressClickRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      clearClickSuppression();
    },
    [clearClickSuppression],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // A touch drag often produces no compatibility click at all. In that
      // case the prior gesture's short-lived click guard is still armed when
      // the user deliberately taps another header control (most visibly the
      // mobile `…` menu). A new pointerdown is an independent gesture, so it
      // must retire any suppression left behind by the previous one. The
      // compatibility click from a drag, when the browser does emit it, is
      // dispatched immediately after that drag's pointerup and is still caught
      // by onClickCapture before another pointerdown can occur.
      clearClickSuppression();

      // Only a primary-button press is a dock gesture. A right-click, middle
      // click, or pen barrel press keeps its native behavior — capture-first
      // would otherwise swallow it and the replay would synthesize a primary
      // activation the browser never intended. isPrimary is deliberately not consulted: a second concurrent
      // pointer replacing the gesture is the accepted multi-touch limitation,
      // and constructed PointerEvents default it to false.
      if (event.button !== 0) return;

      const target = event.currentTarget;
      if (
        event.target instanceof Element &&
        event.target.closest(NO_DOCK_DRAG)
      ) {
        return;
      }
      const startedOnInteractive = isInteractiveDockDragTarget(
        event.target,
        target,
      );
      if (
        ignoreInteractiveTargets &&
        startedOnInteractive &&
        !dragInteractiveTargets
      ) {
        return;
      }

      cleanupRef.current?.();

      const pointerId = event.pointerId;
      const startY = event.clientY;
      const startTime = event.timeStamp;
      let lastY = startY;
      let lastTime = startTime;
      let moved = false;
      let settled = false;
      /**
       * A press that begins on a passthrough control might still be a tap.
       * The first shape of this gesture deferred pointer CAPTURE until
       * movement proved a drag, to keep the control's native click alive —
       * and real Android touch showed why that fails (archive#1052 follow-up,
       * owner device report): between pointerdown and the
       * threshold crossing, the WebView still owns the gesture and can
       * resolve it however it likes, so drags starting on header controls
       * died while the bare resize grip (immediate capture) kept working.
       *
       * Now every accepted press captures immediately — the browser is out
       * of the gesture from the first event — and a stationary release
       * REPLAYS the click on the control it landed on (capture retargets
       * the native click at the surface, where it activates nothing).
       * Dragging-state still waits for movement: flipping it re-renders the
       * dock, and a re-render between press and release is what used to eat
       * taps.
       */
      const startedOnTapTarget =
        event.target instanceof Element &&
        (Boolean(event.target.closest(DOCK_DRAG_PASSTHROUGH)) ||
          (dragInteractiveTargets && startedOnInteractive));
      const pressedControl =
        startedOnTapTarget && event.target instanceof Element
          ? event.target.closest<HTMLElement>(INTERACTIVE_DOCK_TARGET)
          : null;
      const replayControl =
        pressedControl && target.contains(pressedControl)
          ? pressedControl
          : null;
      target.setPointerCapture?.(pointerId);
      let dragAnnounced = false;
      const announceDrag = () => {
        if (dragAnnounced) return;
        dragAnnounced = true;
        onDragStateChange(true);
      };
      let rafId: number | null = null;
      let pendingY: number | null = null;

      /**
       * Snapshotted once per gesture, deliberately: reading
       * `visualViewport.height` live meant Android's URL bar collapsing
       * mid-drag (which a downward drag itself provokes) changed the frame the
       * pointer was measured against, so the dock jumped out from under a
       * finger that had not moved. A drag is measured against the viewport it
       * started in (archive#1052).
       *
       * Accepted trade-off: a software keyboard opening or closing mid-drag
       * would also be ignored for the rest of that one gesture (self-correcting
       * on the next). That needs a second concurrent interaction to trigger,
       * where URL-bar collapse is provoked by the drag itself.
       */
      const gestureViewportHeight =
        window.visualViewport?.height ?? window.innerHeight ?? 0;
      const gestureViewportTop = window.visualViewport?.offsetTop ?? 0;
      const gestureViewportBottom = gestureViewportTop + gestureViewportHeight;
      const metrics = () => ({
        viewportHeight: gestureViewportHeight,
        toolbarHeight,
        collapsedHeight,
      });
      const heightFor = (clientY: number) => {
        const clamped = clampDockHeight(
          gestureViewportBottom - clientY,
          metrics(),
        );
        return mode === 'desktop-free'
          ? Math.max(DOCK_MIN_HEIGHT, clamped)
          : clamped;
      };

      const applyLiveHeight = (clientY: number) => {
        if (Math.abs(clientY - startY) < TAP_MOVE_THRESHOLD) return;
        moved = true;
        onLiveHeight(heightFor(clientY));
      };
      const flush = () => {
        rafId = null;
        if (pendingY !== null) applyLiveHeight(pendingY);
      };
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        // Once this is a drag rather than a tap, stop the browser scrolling or
        // selecting underneath it.
        if (Math.abs(moveEvent.clientY - startY) >= TAP_MOVE_THRESHOLD) {
          // Capture and announce the drag the moment it stops being a tap —
          // synchronously, not inside the rAF-coalesced height update, so the
          // dock's dragging state lands on this event rather than a frame late.
          // Neither may happen on pointerdown: capture retargets the follow-up
          // events at this surface, and flipping dragging state re-renders the
          // dock between mousedown and mouseup. Both swallowed the click of a
          // passthrough control the press started on.
          announceDrag();
          if (startedOnTapTarget) suppressClickRef.current = true;
          if (moveEvent.cancelable) moveEvent.preventDefault();
        }
        pendingY = moveEvent.clientY;
        lastY = moveEvent.clientY;
        lastTime = moveEvent.timeStamp;
        if (rafId === null) rafId = requestAnimationFrame(flush);
      };

      const finish = (release: PointerEvent | null) => {
        if (settled) return;
        settled = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        target.removeEventListener('lostpointercapture', onLostCapture);
        if (target.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture?.(pointerId);
        }
        if (cleanupRef.current === cancel) cleanupRef.current = null;
        if (dragAnnounced) onDragStateChange(false);
        onLiveHeight(null);

        if (suppressClickRef.current) {
          if (suppressClickTimerRef.current !== null) {
            window.clearTimeout(suppressClickTimerRef.current);
          }
          suppressClickTimerRef.current = window.setTimeout(
            clearClickSuppression,
            500,
          );
        }

        if (!release) return;
        const deltaY = release.clientY - startY;
        if (!moved && Math.abs(deltaY) < TAP_MOVE_THRESHOLD) {
          // Accepted limitation (MED): the replay is bound to the
          // node that was pressed. If a re-render REPLACED it mid-press, the
          // tap fires nothing — deliberately safer than activating whatever
          // element now occupies those coordinates.
          if (replayControl?.isConnected) {
            // Stationary tap on a control: the immediate capture above
            // retargeted this gesture's native click at the surface, so the
            // control's activation is replayed here — deterministically,
            // exactly once. The suppression guard swallows the browser's own
            // follow-up click wherever it lands.
            suppressClickRef.current = true;
            if (suppressClickTimerRef.current !== null) {
              window.clearTimeout(suppressClickTimerRef.current);
            }
            suppressClickTimerRef.current = window.setTimeout(
              clearClickSuppression,
              500,
            );
            replayClickRef.current = true;
            try {
              replayControl.focus?.();
              replayControl.click();
            } finally {
              replayClickRef.current = false;
            }
          }
          return;
        }

        const height = heightFor(release.clientY);
        if (mode === 'desktop-free') {
          onCommitHeight(height);
          return;
        }
        const elapsed = Math.max(1, release.timeStamp - lastTime);
        const velocityY = (release.clientY - lastY) / elapsed;
        onSnap(
          resolveMobileDockSnap({
            pixels: height,
            deltaY,
            velocityY,
            metrics: metrics(),
          }),
        );
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId === pointerId) finish(upEvent);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === pointerId) finish(null);
      };
      const onLostCapture = () => finish(null);
      const cancel = () => finish(null);

      cleanupRef.current = cancel;
      // Always prevented: with capture taken and the click replayed manually,
      // the browser has no remaining role in this gesture — leaving the
      // default in place only re-opens the door to native gesture handling
      // (the on-device failure this shape exists to close).
      event.preventDefault();
      if (!startedOnTapTarget) announceDrag();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      target.addEventListener('lostpointercapture', onLostCapture, {
        once: true,
      });
    },
    [
      clearClickSuppression,
      collapsedHeight,
      dragInteractiveTargets,
      ignoreInteractiveTargets,
      mode,
      onCommitHeight,
      onDragStateChange,
      onLiveHeight,
      onSnap,
      toolbarHeight,
    ],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      clearClickSuppression();
    },
    [clearClickSuppression],
  );

  return { onPointerDown, onClickCapture };
}
