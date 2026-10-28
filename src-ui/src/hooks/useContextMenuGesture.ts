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
 * would eat the user's next keyboard activation of the same row.
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
 * An item's menu behind a right-click or a touch hold: a list row, a pane
 * head, a file in the tree.
 *
 * Not `useLongPress`, which is a single control whose CLICK it owns and whose
 * hold any pointer (a mouse too) can complete. An item here keeps its own
 * click handlers untouched — the swallow is a capture-phase `click` listener
 * on the item — and only a finger or pen holds, because a mouse already has a
 * right button and a 500ms mouse hold on a row is the start of a drag.
 *
 * `onOpen` gets the item and, where there is one, the point the gesture
 * happened at. The keyboard's context-menu key has no pointer, and engines
 * report it as (0, 0); that arrives as `null` so a point-anchored menu can
 * fall back to the item instead of opening in the corner.
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
   * held finger means "select", not "menu".
   */
  touchHold?: boolean;
}): ContextMenuGestureHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<ContextMenuPoint | null>(null);
  /**
   * When this press's hold opened the menu; 0 when it has not. A time, not a
   * flag: the keyboard's context-menu key on the same item later has no press
   * to reset a flag at, and must still open the menu.
   */
  const firedAt = useRef(0);
  const suppressUntil = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const end = useCallback(() => {
    cancel();
    if (firedAt.current) suppressUntil.current = Date.now() + SUPPRESS_CLICK_MS;
  }, [cancel]);

  return {
    onContextMenu: (event) => {
      if (!enabled || wantsNativeContextMenu(event)) return;
      // Android fires its own `contextmenu` from a long-press, around the same
      // threshold as the timer below. Whichever lands second must not open
      // the menu a second time.
      if (firedAt.current && Date.now() - firedAt.current < HOLD_MS * 2) return;
      const midPress = origin.current !== null;
      cancel();
      if (midPress) {
        firedAt.current = Date.now();
        suppressUntil.current = Date.now() + SUPPRESS_CLICK_MS;
      }
      const point =
        event.clientX === 0 && event.clientY === 0
          ? null
          : { x: event.clientX, y: event.clientY };
      if (onOpen(event.currentTarget, point) === false) return;
      event.preventDefault();
      // Stopped so a nested item (a row inside a pane) opens ITS menu and not
      // every ancestor's as well.
      event.stopPropagation();
    },
    onPointerDown: (event) => {
      firedAt.current = 0;
      if (!enabled || !touchHold) return;
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      if (event.button !== 0) return;
      cancel();
      const item = event.currentTarget;
      const point = { x: event.clientX, y: event.clientY };
      origin.current = point;
      timer.current = setTimeout(() => {
        timer.current = null;
        origin.current = null;
        firedAt.current = Date.now();
        suppressUntil.current = Date.now() + SUPPRESS_CLICK_MS;
        onOpen(item, point);
      }, HOLD_MS);
    },
    onPointerMove: (event) => {
      const start = origin.current;
      if (!start) return;
      if (
        Math.hypot(event.clientX - start.x, event.clientY - start.y) >
        MOVE_TOLERANCE_PX
      )
        cancel();
    },
    onPointerUp: end,
    // A hold that turns into a scroll ends here, not in a menu.
    onPointerCancel: end,
    onClickCapture: (event) => {
      if (Date.now() >= suppressUntil.current) return;
      suppressUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
