import { useCallback, useEffect, useRef } from 'react';

/** How long a press must be held, uninterrupted, to count as a long press. */
export const LONG_PRESS_MS = 500;

/**
 * How far the pointer may travel before the press stops being a press. Six
 * pixels is `TAP_MOVE_THRESHOLD`'s neighbourhood (dockSnap.ts) but this one
 * is deliberately its own number: that threshold decides whether a DRAG
 * happened, this one decides whether a finger held still, and a finger
 * resting on a 32px control wanders further than a mouse does.
 */
const MOVE_TOLERANCE_PX = 8;

/** The props a long-pressable control spreads onto its element. */
export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
}

/**
 * A control with a primary act on the click and a SECOND one behind a hold or
 * a right-click (#2155: the region toggles show and hide; the chooser they
 * anchor is the hold's).
 *
 * The two gestures are exclusive, and the suppression is the load-bearing
 * part: a completed hold ends in a `pointerup` that the browser still turns
 * into a `click`, so without swallowing that click a hold would open the
 * panel AND toggle the region underneath it. The flag is cleared by the next
 * `pointerdown` rather than by a timeout, so a hold released off the control
 * — which produces no click at all — cannot leave the next press swallowed.
 *
 * `contextmenu` is the pointer-independent route to the same act (a mouse's
 * right button, and the keyboard's context-menu key, which browsers deliver
 * here with no pointer sequence at all) and is prevented, so the control
 * opens its own panel rather than the browser's menu. It sets no suppression:
 * a right-click produces no click to suppress, and a flag left standing would
 * swallow the user's next real press.
 *
 * Pointer events, not touch events: one code path covers finger, pen and
 * mouse, and `pointercancel` is what ends a hold that turns into a scroll —
 * the gap that left the toolbar menus open in #1386.
 */
export function useLongPress({
  durationMs = LONG_PRESS_MS,
  onLongPress,
  onClick,
}: {
  durationMs?: number;
  /** The completed hold, given the element it was held on (for anchoring). */
  onLongPress: (trigger: HTMLElement) => void;
  /** The ordinary press — not called for the click that ends a hold. */
  onClick: () => void;
}): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const completed = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  // A pending hold outlives the component otherwise: the toolbar replaces its
  // controls whenever the device folds, and the timer would fire against an
  // unmounted trigger.
  useEffect(() => cancel, [cancel]);

  return {
    onPointerDown: (event) => {
      // The primary button only. A right-press arrives here too, and its act
      // is `contextmenu`'s; starting a hold timer for it would open the panel
      // twice.
      if (event.button !== 0) return;
      cancel();
      completed.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      // Captured now: React clears `currentTarget` once dispatch returns, so
      // reading it inside the timeout would give null.
      const trigger = event.currentTarget;
      timer.current = setTimeout(() => {
        timer.current = null;
        origin.current = null;
        completed.current = true;
        onLongPress(trigger);
      }, durationMs);
    },
    onPointerMove: (event) => {
      const start = origin.current;
      if (!start) return;
      if (
        Math.abs(event.clientX - start.x) > MOVE_TOLERANCE_PX ||
        Math.abs(event.clientY - start.y) > MOVE_TOLERANCE_PX
      )
        cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClick: (event) => {
      if (completed.current) {
        // Exactly ONE click is swallowed, cleared here as well as at the next
        // `pointerdown`. A hold released off the control produces no click at
        // all, so without this clearing the flag would stand until the next
        // press — and a keyboard activation, which starts no pointer
        // sequence, would be the thing it swallowed.
        completed.current = false;
        // `preventDefault` as well as the early return: this control is
        // inside a `fieldset` in a header, and a swallowed click that still
        // ran its default is how a suppressed press becomes a submit
        // somewhere else.
        event.preventDefault();
        return;
      }
      onClick();
    },
    onContextMenu: (event) => {
      event.preventDefault();
      cancel();
      onLongPress(event.currentTarget);
    },
  };
}
