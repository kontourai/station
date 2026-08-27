import { type RefObject, useEffect, useRef } from 'react';

/**
 * Focus management for the SDK's `aria-modal="true"` surfaces.
 *
 * `aria-modal` tells assistive technology to ignore everything outside the
 * dialog's subtree. A dialog that sets it without moving focus inside therefore
 * *removes* the trigger from the AT's reachable tree while leaving focus on it
 * — strictly worse than the plain `<div>` it replaced. This hook supplies the
 * three things the attribute promises: focus moves in on open, Tab is trapped,
 * and focus returns to the trigger on close.
 *
 * This is `ConnectionManagerModalContent`'s trap (in `@kontourai/station-connect`)
 * reduced to what the SDK can carry. That component uses
 * `@kontourai/station-shared`'s `captureReturnFocus`/`restoreReturnFocus`; the
 * SDK deliberately does **not** depend on `station-shared` (its dependencies are
 * `@kontourai/console-core` and `@kontourai/station-contracts` only), and adding
 * that edge is a release-ordering change, not an accessibility fix. The
 * ancestor-chain capture below is the same policy in miniature: restore the
 * trigger, and when the trigger did not survive the dialog's own action, fall
 * back to the nearest surviving ancestor. `document.body` is excluded on
 * purpose — focusing it is the bug, not the focus-return target.
 */

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])';

export interface DialogFocusTrapOptions {
  /** Whether the dialog is currently rendered. The trap is inert when false. */
  active: boolean;
  /**
   * Escape handler, installed on `document` so it fires wherever focus sits
   * inside the dialog. Omit it when the surface already owns a working Escape
   * path of its own — two handlers mean two `onClose` calls.
   */
  onEscape?: () => void;
}

/**
 * The trigger followed by its ancestors, captured while all of them are still
 * attached: a dialog action can detach the row the trigger lived on, and React
 * nulls `parentElement` on detach, leaving nothing to walk at restore time.
 */
function captureFocusChain(): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (
    let node =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    node && node !== document.body;
    node = node.parentElement
  ) {
    chain.push(node);
  }
  return chain;
}

export function useDialogFocusTrap<T extends HTMLElement = HTMLDivElement>({
  active,
  onEscape,
}: DialogFocusTrapOptions): RefObject<T | null> {
  // `T | null` is what `useRef<T>(null)` actually returns, and since React 19's
  // types it is what `RefObject` reports. The old `RefObject<T>` claimed the
  // element is always attached — it is null before mount and after unmount, and
  // every consumer already guards `.current`. Compatible with the React 18
  // types too, where `RefObject<T>` was itself `{ current: T | null }`.
  const dialogRef = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const returnFocusChain = captureFocusChain();

    // Hide every branch outside the dialog from AT and from the pointer, so
    // `aria-modal` describes what the DOM actually does. Prior values are kept
    // so an already-inert host tree is restored, not clobbered.
    const inertedBackground: Array<{
      element: HTMLElement;
      inert: boolean;
      ariaHidden: string | null;
    }> = [];
    let activeBranch: HTMLElement | null = dialog;
    while (activeBranch?.parentElement) {
      const parent: HTMLElement = activeBranch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === activeBranch || !(sibling instanceof HTMLElement)) {
          continue;
        }
        inertedBackground.push({
          element: sibling,
          inert: sibling.inert,
          ariaHidden: sibling.getAttribute('aria-hidden'),
        });
        sibling.inert = true;
        sibling.setAttribute('aria-hidden', 'true');
      }
      activeBranch = parent;
      if (parent === document.body) break;
    }

    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscapeRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      for (const { element, inert, ariaHidden } of inertedBackground) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
      // Deferred on purpose (station#1245): un-setting `inert` above is
      // synchronous in the DOM but a browser only re-admits those nodes to the
      // focus order on the next frame, so a synchronous restore walks a tree
      // that still refuses focus and runs out. Do not "simplify" this.
      window.requestAnimationFrame(() => {
        for (const candidate of returnFocusChain) {
          if (!candidate.isConnected) continue;
          candidate.focus();
          if (document.activeElement === candidate) return;
        }
      });
    };
  }, [active]);

  return dialogRef;
}
