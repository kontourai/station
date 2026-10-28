import { useCallback, useEffect, useRef } from 'react';
import { wantsNativeContextMenu } from '../lib/native-context-menu';

/** The hold that opens an item's menu on touch; `useLongPress`'s number. */
const HOLD_MS = 500;

/** How far a held finger may wander before the hold becomes a scroll. */
const MOVE_TOLERANCE_PX = 8;

/**
 * How long after a hold the trailing click is still swallowed. A bound rather
 * than a flag that waits for "the" click: iOS and Android disagree about
 * whether a completed hold produces a click at all, and a flag left standing
 * would eat the user's next keyboard activation of the same row. A new press
 * on the item ends it early (`onPointerDown`).
 */
const SUPPRESS_CLICK_MS = 700;

export interface ContextMenuPoint {
  x: number;
  y: number;
}

/** The props an item spreads onto the element that owns its menu. */
export interface ContextMenuGestureHandlers {
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

/**
 * Whether the event happened in the item's own DOM. React delivers a portal's
 * events through the component tree, so a menu or sheet the item opened (body
 * portals) bubbles its presses and clicks through the item too; those are the
 * menu's, never a new hold on the item or the trailing click of the last one.
 */
function inItem(event: React.SyntheticEvent<HTMLElement>): boolean {
  return (
    event.target instanceof Node && event.currentTarget.contains(event.target)
  );
}

/**
 * An item's menu behind a right-click or a touch hold: a list row, a message,
 * a file in the tree.
 *
 * Not `useLongPress`, which is a single control whose CLICK it owns and whose
 * hold any pointer (a mouse too) can complete. An item here keeps its own
 * click handlers untouched — the swallow is a capture-phase `click` listener
 * on the item — and only a finger or pen holds, because a mouse already has a
 * right button and a 500ms mouse hold on a row is the start of a drag.
 *
 * `onOpen` gets the item and, where there is one, the point the gesture
 * happened at. Engines report the keyboard's context-menu key either at (0, 0)
 * or at the focused element; (0, 0) arrives as `null` so a point-anchored menu
 * can fall back to the item instead of opening in the corner. `onOpen` must be
 * an OPEN, not a toggle: one hold can reach it twice (see `onContextMenu`).
 *
 * The native menu still wins where it is the useful one
 * (`wantsNativeContextMenu`): selected text, an editable field, Shift.
 */
export function useContextMenuGesture({
  onOpen,
  enabled = true,
  touchHold = true,
}: {
  /**
   * Opens the menu. `false` means there was none to open (a lazy menu not yet
   * loaded): the gesture is then left to the platform and the app-wide guard
   * rather than swallowed with nothing shown.
   */
  onOpen: (
    item: HTMLElement,
    point: ContextMenuPoint | null,
  ) => boolean | undefined;
  /** Off leaves every gesture to the platform (and to the app-wide guard). */
  enabled?: boolean;
  /**
   * Off for an item that is mostly selectable text (a chat message), where a
   * held finger means "select", not "menu". That covers the platform's own
   * long-press `contextmenu` (Android) as well as the hold timer.
   */
  touchHold?: boolean;
}): ContextMenuGestureHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<ContextMenuPoint | null>(null);
  /** This press's hold has opened the menu and the finger is still down. */
  const holding = useRef(false);
  /** A finger is down on the item (for `touchHold: false`). */
  const touchDown = useRef(false);
  const suppressUntil = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const end = useCallback(() => {
    cancel();
    if (holding.current) suppressUntil.current = Date.now() + SUPPRESS_CLICK_MS;
    holding.current = false;
    touchDown.current = false;
  }, [cancel]);

  return {
    onContextMenu: (event) => {
      if (!enabled) return;
      // The platform's own long-press on a text item: selection, not a menu.
      if (!touchHold && touchDown.current) return;
      if (wantsNativeContextMenu(event)) return;
      const point =
        event.clientX === 0 && event.clientY === 0
          ? null
          : { x: event.clientX, y: event.clientY };
      // Android (and Chromium's own gesture recogniser) fires a `contextmenu`
      // from the SAME long-press, usually after the timer below has opened
      // the menu, and it hit-tests whatever is under the finger by then: the
      // row, or the menu's own backdrop (a portal, which React bubbles here).
      // Either way it is this hold's, so it is refused to the platform and
      // opens again rather than being ignored: the long-press can move focus
      // onto the backdrop first, and the menu closes on that focus move.
      if (holding.current) {
        if (onOpen(event.currentTarget, origin.current ?? point) === false)
          return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Otherwise a right-click inside something the item opened (its menu,
      // its sheet, a dialog from a menu row) is that surface's business.
      if (!inItem(event)) return;
      const midPress = origin.current !== null;
      cancel();
      if (onOpen(event.currentTarget, point) === false) return;
      if (midPress) {
        holding.current = true;
        suppressUntil.current = Date.now() + SUPPRESS_CLICK_MS;
      }
      event.preventDefault();
      // Stopped so a nested item (a row inside a pane) opens ITS menu and not
      // every ancestor's as well.
      event.stopPropagation();
    },
    onPointerDown: (event) => {
      // Any new press, on the item or on what it opened: whatever click the
      // last hold ended in is not coming now.
      suppressUntil.current = 0;
      if (!inItem(event)) return;
      holding.current = false;
      touchDown.current = event.pointerType === 'touch';
      if (!enabled || !touchHold) return;
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      if (event.button !== 0) return;
      cancel();
      const item = event.currentTarget;
      const point = { x: event.clientX, y: event.clientY };
      origin.current = point;
      timer.current = setTimeout(() => {
        timer.current = null;
        holding.current = true;
        suppressUntil.current = Date.now() + SUPPRESS_CLICK_MS;
        onOpen(item, point);
      }, HOLD_MS);
    },
    onPointerMove: (event) => {
      const start = origin.current;
      if (!start || timer.current === null || !inItem(event)) return;
      if (
        Math.hypot(event.clientX - start.x, event.clientY - start.y) >
        MOVE_TOLERANCE_PX
      )
        cancel();
    },
    onPointerUp: (event) => {
      if (inItem(event)) end();
    },
    // A hold that turns into a scroll ends here, not in a menu.
    onPointerCancel: (event) => {
      if (inItem(event)) end();
    },
    // Not limited to the item: the click a hold ends in is hit-tested where
    // the finger lifts, which can be the menu or sheet the hold just opened
    // under it. A deliberate tap there starts with a press, which closed the
    // window above.
    onClickCapture: (event) => {
      if (Date.now() >= suppressUntil.current) return;
      suppressUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
