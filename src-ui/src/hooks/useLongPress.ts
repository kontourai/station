import { useCallback, useEffect, useRef } from 'react';

/**
 * How long a press must be held, uninterrupted, to count as a long press.
 * Module-private: a caller that needs a different hold passes `durationMs`,
 * and an exported constant with no importer is a number two places could
 * drift from. The e2e that drives the gesture holds 600ms against it with
 * room to spare rather than reading it (`openChooserFromToggle`).
 */
const LONG_PRESS_MS = 500;

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
  onPointerLeave: (event: React.PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => void;
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
 * panel AND toggle the region underneath it.
 *
 * THE PRESS IS CAPTURED (`setPointerCapture`), which is what makes that
 * suppression reachable at all (#2155 review B1/M2). A hold opens a panel
 * WHILE THE POINTER IS STILL DOWN, and that panel's dismiss backdrop covers
 * the viewport — so without capture the release is delivered to the backdrop
 * and this control never sees the `pointerup`/`click` it was going to
 * swallow, leaving the flag standing for the user's next press. Capture also
 * keeps `pointermove` coming once the pointer leaves the control, which is
 * the only way the tolerance below can see a press dragged away; where the
 * platform has no capture (jsdom, and any engine that refuses the id),
 * `pointerleave` is the fallback for that second job. The backdrop carries
 * the other half of the fix — it dismisses only on a release it saw the press
 * for (`RegionEmptyChooser`).
 *
 * `contextmenu` is the pointer-independent route to the same act (a mouse's
 * right button, and the keyboard's context-menu key, which browsers deliver
 * here with no pointer sequence at all) and is prevented, so the control
 * opens its own panel rather than the browser's menu. It sets the suppression
 * too: a mouse right-click produces no click, but Android and iOS fire
 * `contextmenu` from their own long-press recognisers — before this hook's
 * threshold — and DO deliver a trailing click, which would toggle the region
 * under the panel the platform just asked for.
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

  /**
   * Ends the pointer's turn: the timer stops and the capture goes back. Both
   * halves run on every release path (`pointerup`, `pointercancel`, a
   * departure without capture), because a capture the control keeps would
   * swallow every later pointer event on the page.
   */
  const release = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      cancel();
      const target = event.currentTarget;
      if (target.hasPointerCapture?.(event.pointerId))
        target.releasePointerCapture?.(event.pointerId);
    },
    [cancel],
  );

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
      // Optional-called: jsdom implements no pointer capture, and a real
      // engine can refuse an id it no longer considers active. The gesture
      // still works without it — the panel's backdrop refuses a release it
      // did not see the press for — it just loses the off-element tolerance,
      // which `onPointerLeave` then supplies.
      trigger.setPointerCapture?.(event.pointerId);
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
      ) {
        cancel();
        // AND suppress the click, which the capture above now delivers here
        // whatever the pointer did in between. MEASURED in Chromium: with
        // capture, a press dragged 350px off this button and released there
        // still produces `pointerdown, pointerup, click` ON THE BUTTON;
        // without capture it produces no click at all. So before the capture
        // existed a dragged-away press simply did not activate, and after it
        // the control would have toggled the region — which is neither the
        // platform convention for a button nor what this design records
        // (`docs/design/placement.md`: a press dragged away cancels).
        //
        // Reuses the swallow-exactly-one flag, with the consequence stated:
        // a pointer that wanders past the tolerance and comes BACK before
        // releasing is also refused, where a native button would re-arm. The
        // tolerance is 8px on a 32px control, so that is a deliberate
        // gesture away and back, and refusing it is the reading that matches
        // the sentence above.
        completed.current = true;
      }
    },
    onPointerUp: release,
    onPointerCancel: release,
    // Only reachable while the press is NOT captured (a captured pointer
    // sends no `pointerleave` until it is released, and the release path
    // above has already cancelled by then). This is the no-capture engine's
    // "the press was dragged off the control" — the case `pointermove`
    // cannot see, because it stops arriving at the element the pointer left.
    //
    // It is a blunter instrument than capture, and the difference is
    // MEASURED: with capture removed in a real browser, a hold over a
    // settling layout is cancelled before its threshold, because content
    // moving under a STATIONARY pointer produces a boundary event just as a
    // moving pointer does. Kept anyway, and the trade is the safer one: on
    // such an engine a hold that does nothing is a gesture the user repeats,
    // while a hold that opens a panel after the finger was dragged away is a
    // panel nobody asked for. Every engine that grants the capture above
    // never reaches this at all.
    onPointerLeave: cancel,
    // The engine took the capture away mid-press (a system gesture, a
    // navigation). No release is coming to this element, so the pending hold
    // ends here rather than firing into a gesture the control no longer owns.
    onLostPointerCapture: cancel,
    onClick: (event) => {
      if (completed.current) {
        // Exactly ONE click is swallowed. Cleared HERE, and again at the next
        // `pointerdown` — the two together are what bound it, because neither
        // runs in every case: a hold whose release the control never sees
        // reaches no click to clear the flag at, and a keyboard activation
        // starts no pointer sequence to clear it at either. That residue is
        // why the press is captured above: with capture the release comes
        // back here, the flag is consumed, and the only way to leave it
        // standing is an engine that refused the capture AND a release the
        // control never saw. The test named for it holds the case open.
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
      // Whether this `contextmenu` interrupted a press IN PROGRESS, read
      // before `cancel()` clears the evidence. It decides whether a trailing
      // click is coming, and the three routes here answer differently:
      //
      //   mid-press  — a mobile engine's own long-press recogniser, which
      //                begins with a primary `pointerdown` (so the timer and
      //                the origin are both live) and DOES deliver a trailing
      //                click. Suppressed, or that click would toggle the
      //                region under the panel the platform just opened.
      //   right-click — its `pointerdown` early-returns on `button !== 0`
      //                before the origin is set, and it produces no click.
      //   the keyboard's context-menu key — no pointer sequence at all, and
      //                the user's very next act is plausibly Enter on this
      //                same button.
      //
      // Flagging the last two would swallow that Enter: the flag is cleared
      // in `onClick` or at the next `pointerdown`, and a keyboard activation
      // is a click with no pointer sequence to clear it at. The code this
      // replaced set no flag at all and named that hazard as its reason; the
      // condition is what keeps both halves.
      const midPress = timer.current !== null || origin.current !== null;
      cancel();
      if (midPress) completed.current = true;
      onLongPress(event.currentTarget);
    },
  };
}
