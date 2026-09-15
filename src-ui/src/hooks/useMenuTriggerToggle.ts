import { type MouseEvent, useRef } from 'react';

/**
 * A menu trigger that can close the menu it opened (#2081).
 *
 * THE DEFECT. A menu whose trigger sits OUTSIDE its container — portalled to
 * `document.body`, or merely a sibling — dismisses itself the moment the user
 * presses that trigger, before the press has become a click. Pressing a button
 * moves focus to it, which is a `focusout` of the menu container, and
 * `useMenuFocus` closes on that; `NotificationHistory` additionally closes on
 * any `mousedown` outside its panel (`NotificationHistory.tsx:294-311`). React
 * flushes the close, and only then does `click` arrive at a trigger whose
 * handler now reads `open === false` and opens the menu straight back up. The
 * control looks inert: it can be pressed forever and the menu never shuts.
 *
 * A functional updater does not save it. `setOpen((current) => !current)` runs
 * after the flush, so `current` is the `false` the dismissal just wrote.
 *
 * THE FIX is to act on the state the user acted on — the state the trigger was
 * in when they PRESSED it, recorded in `mousedown`, which runs before any
 * dismissal the press causes. The only transition that can occur between that
 * press and its click is a dismissal, so "it was open" means the user asked to
 * close it and "it was closed" means the menu is still closed and they asked to
 * open it. Neither reading depends on WHICH dismissal path fired, which is why
 * this is preferred here over suppressing the focus move with
 * `preventDefault()` on the press: that suppresses exactly one of the two paths
 * above, and the bell falls down the other one.
 *
 * The press also leaves focus on the trigger, which is what `useMenuFocus`
 * captures as its return target — so a pointer-opened menu still has somewhere
 * to hand focus back to on close. (`captureReturnFocus` walks up to
 * `document.body` and returns an EMPTY chain when that is all it finds, so a
 * trigger that cancels its own press has to focus itself instead —
 * `ProjectSidebarPresenceTray` does exactly that.)
 *
 * `detail === 0` means "no press to read": a click the user agent synthesises
 * from Enter or Space has no `mousedown` before it and reports a click count of
 * zero, so the live state is the only truth available. Without that branch an
 * abandoned press — pressed, dragged off, released elsewhere — would leave a
 * stale "it was open" for the next keypress to spend itself on.
 *
 * WHAT THAT BRANCH COSTS, stated rather than implied: it is a test of the CLICK
 * COUNT, not of the input device. Any stack that delivers a click with
 * `detail: 0` after a real press — a touch or pen implementation that does not
 * count taps, a synthetic `element.click()` — takes the live-state path and
 * degrades to exactly the pre-fix behaviour for that gesture, because the live
 * state is the one a dismissal has already flushed. The platforms Station ships
 * on all report `detail: 1` for a tap, which is why this is a disclosed
 * degradation and not a second defect; nothing here detects the difference, so
 * a regression in it would be silent.
 *
 * `open` MUST BE AN OPEN, NOT A TOGGLE. The open branch runs when the menu was
 * shut at press time, and while that is nearly always still true at click time,
 * "nearly" is doing real work: a hotkey, a deep link or a notification arriving
 * in that window could open the menu, and a toggle would then close what it was
 * called to open. Handing this an idempotent open removes the question instead
 * of reasoning about the gap.
 *
 * Spread the result onto the trigger. It owns both handlers; a caller with more
 * to do on press or click should call its own work from a wrapper rather than
 * overwriting either.
 */
export function useMenuTriggerToggle(
  isOpen: boolean,
  open: () => void,
  close: () => void,
): {
  onMouseDown: () => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
} {
  const openAtPress = useRef(isOpen);
  return {
    onMouseDown: () => {
      openAtPress.current = isOpen;
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const wasOpen = event.detail === 0 ? isOpen : openAtPress.current;
      if (wasOpen) close();
      else open();
    },
  };
}
