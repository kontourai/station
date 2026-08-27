import { type RefObject, useCallback, useEffect, useRef } from 'react';

/**
 * Keyboard and focus behavior shared by this plugin's dialogs.
 *
 * The handler is returned rather than installed on `document`: a per-dialog
 * document listener makes every open dialog react to the same Escape, so a
 * confirmation opened on top of a form would close both. Here each dialog
 * owns a listener on its own element and consults the mount-ordered stack
 * below, so only the topmost dialog acts.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Mount-ordered ids of the dialogs currently open. Last entry is topmost. */
const openDialogStack: symbol[] = [];

function focusableWithin(dialog: HTMLElement | null): HTMLElement[] {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export interface TopmostModalOptions {
  /** Dialogs that render unconditionally can leave this at its default. */
  isOpen?: boolean;
  onClose: () => void;
  /**
   * The control to focus when the dialog opens — the field a user would
   * reach for first. Falls back to the dialog's first focusable descendant.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export interface TopmostModalBindings {
  /** Attach to the dialog element itself, not to the overlay wrapper. */
  dialogRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

export function useTopmostModal({
  isOpen = true,
  onClose,
  initialFocusRef,
}: TopmostModalOptions): TopmostModalBindings {
  const dialogRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<symbol | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const id = Symbol('enterprise-dialog');
    idRef.current = id;
    openDialogStack.push(id);

    const opener = document.activeElement as HTMLElement | null;
    const initialFocus =
      initialFocusRef?.current ?? focusableWithin(dialogRef.current)[0];
    initialFocus?.focus();

    return () => {
      const index = openDialogStack.lastIndexOf(id);
      if (index !== -1) openDialogStack.splice(index, 1);
      idRef.current = null;
      if (opener?.isConnected) opener.focus();
    };
  }, [isOpen, initialFocusRef]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (openDialogStack[openDialogStack.length - 1] !== idRef.current) return;

      if (event.key === 'Escape') {
        // Stops an enclosing dialog from also seeing this Escape.
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = focusableWithin(dialogRef.current);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const inside = dialogRef.current?.contains(active) ?? false;

      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [],
  );

  return { dialogRef, onKeyDown };
}
