import {
  applyReturnFocus,
  captureReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps a portalled menu reachable from the keyboard.
 *
 * These menus render into `document.body` so they can escape the toolbar's
 * stacking context and its `overflow: hidden`. That fixes the pointer bug but
 * breaks sequential focus: the trigger stays in the toolbar while the menu
 * items sit at the end of the document, so Tab walks past the open menu into
 * the rest of the app instead of into it.
 *
 * Moving focus to the first item on open restores the expected order, and
 * returning it to whatever was focused before means dismissing the menu does
 * not strand the user at the top of the page.
 *
 * Attach the returned ref to the menu container, or pass one the caller
 * already holds. The container needs `tabIndex={-1}` so it can receive focus
 * when the menu has no focusable content of its own.
 */
export function useMenuFocus<T extends HTMLElement>(
  isOpen: boolean,
  onClose?: () => void,
  externalRef?: RefObject<T | null>,
) {
  const ownRef = useRef<T>(null);
  const containerRef = externalRef ?? ownRef;

  useEffect(() => {
    if (!isOpen) return;

    const container = containerRef.current;
    const returnFocus = captureReturnFocus();

    // Fall back to the container when the menu has nothing focusable in it —
    // an empty notification popover, or one whose items have not arrived yet.
    // Leaving focus on the trigger would let Tab move behind the open popover.
    const target =
      container?.querySelector<HTMLElement>(FOCUSABLE) ?? container;
    target?.focus();

    return () => {
      // Restore through the shared module (archive#1245). Its own copy was
      // `if (previouslyFocused?.isConnected) previouslyFocused.focus`, which
      // carried both #1126 gaps: a connected-but-unfocusable trigger swallows
      // the restore, and a trigger the menu's own action removed gets nothing
      // at all. That case is real for these menus — a notification popover's
      // trigger is a per-notification button the popover can dismiss.
      //
      // Synchronous, not `restoreReturnFocus`'s next frame: these menus stay
      // mounted and merely render null, so a deferred restore could land after
      // the next menu has already opened and focused itself. The dialog tier
      // defers because its surface has to finish tearing down first; nothing
      // here does.
      //
      // A MENU IS NOT A MODAL, and the fit was checked rather than assumed
      // (archive#1245). The one behaviour that changes is dismissal by
      // focusout, which these menus do by design: tabbing out used to fire
      // `onClose`, unmount the menu, and then yank focus back to the trigger,
      // so Tab appeared to do nothing. The shared module's gap-1 guard leaves
      // an already-claimed focus alone, so Tab now lands where the user aimed.
      // Escape and select-item dismissals are unchanged: the focused item is
      // removed with the menu, focus is on `<body>`, and the trigger wins.
      applyReturnFocus(returnFocus, container);
    };
    // Keyed on `isOpen`, not on mount: these menus stay mounted and merely
    // render null while closed, so a mount-only effect would fire once against
    // an empty ref and never run again when the menu actually opened.
  }, [isOpen, containerRef]);

  // Dismiss when focus leaves. `tabIndex={-1}` makes the container focusable
  // programmatically but does not put it in tab order, and the portal sits at
  // the end of the document — so without this, Tab walks out of an open menu
  // and into the app behind it, leaving a popover open over content the user
  // is now interacting with.
  useEffect(() => {
    if (!isOpen || !onClose) return;
    const container = containerRef.current;
    if (!container) return;

    const handleFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      // Moving between items inside the menu is not leaving it.
      if (next instanceof Node && container.contains(next)) return;
      onClose();
    };

    container.addEventListener('focusout', handleFocusOut);
    return () => container.removeEventListener('focusout', handleFocusOut);
  }, [isOpen, onClose, containerRef]);

  return containerRef;
}
