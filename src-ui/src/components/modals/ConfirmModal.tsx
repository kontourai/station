import { type MouseEvent, type PointerEvent, useRef } from 'react';
import { createPortal } from 'react-dom';
import { triggerHaptic } from '../../platform/native/haptics';
import { Button } from '../Button';
import { Dialog } from '../Dialog';

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'danger' | 'warning' | 'default';
  /**
   * `alertdialog` when the prompt interrupts to guard something — unsaved
   * work, a destructive action. Assistive tech announces the two roles
   * differently, so this is not cosmetic.
   */
  role?: 'dialog' | 'alertdialog';
  pending?: boolean;
}

/**
 * Portal boundary containment. React synthetic events follow the React tree,
 * not the DOM tree, so an event raised inside a portal still bubbles to the
 * component that rendered `<ConfirmModal>` — even though the DOM node lives on
 * `document.body`. Station#1111: `ACPConnectionCard` puts `onClick` on its root
 * `<div>`, so dismissing a "remove this connection" dialog by clicking the
 * scrim also fired the card's select handler.
 *
 * The portal is this component's own implementation detail; none of its 22 call
 * sites can be expected to know they are hosting one. So the leak is stopped
 * here, at the boundary that creates it, rather than by asking every consumer
 * to defend against it.
 *
 * The wrapper that carries these handlers is deliberately unstyled: its only
 * child is the `position: fixed` overlay, so it collapses to a zero-height
 * block at the end of `<body>` and contributes nothing to layout.
 */
function containToPortal(event: MouseEvent | PointerEvent) {
  event.stopPropagation();
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'default',
  role = 'dialog',
  pending = false,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  if (!isOpen) return null;

  // Portalled to the document body rather than rendered where it is used. The
  // overlay is `position: fixed`, which is only relative to the viewport while
  // no ancestor establishes a containing block — and a `transform` does, even
  // an identity one mid-transition. Station#1069: the profile page's stat cards
  // lift on hover (`.profile-stats-grid > .profile-card:hover { transform }`),
  // and because this modal rendered inside one of those cards the two states
  // fed each other every frame — full-viewport overlay covers the cursor, so
  // the card is `:hover`, so the card takes a transform, so the overlay
  // collapses to the card's box, so the cursor is outside it, so `:hover`
  // drops. The dialog oscillated at 60Hz and was never clickable. Ancestors
  // also commonly clip (`.profile-card` sets `overflow: hidden`) or trap the
  // stacking order, which is the same reason the header menus portal.
  //
  // `Dialog` (over `ResponsiveDialogSurface`) owns the chrome AND the modal
  // lifecycle this component used to half-implement. The per-instance
  // `aria-labelledby` id moved with it: two open dialogs used to emit the same
  // `id="confirm-modal-title"` and the label resolved to whichever the
  // document held first (station#1111) — `Dialog`'s own `useId` keeps that
  // fix, for every dialog rather than this one.
  // focus containment, focus restoration, Escape, backdrop
  // dismissal, and VisualViewport geometry. Before station#1110 the whole of
  // the focus handling here was `firstBtn?.focus()`, so `aria-modal="true"` was
  // a claim the DOM did not back — the second Tab walked out of the dialog into
  // the app behind it, and closing stranded focus on `<body>`.
  return createPortal(
    <div className="confirm-modal-portal" onPointerDown={containToPortal}>
      <Dialog
        title={title}
        closeLabel={`Close ${title}`}
        onClose={onCancel}
        role={role}
        size="sm"
        panelClassName={`station-dialog--${variant}`}
        initialFocusRef={cancelRef}
        initialFocusPolicy="always"
        // These dialogs answer a question the user just asked; they are not a
        // navigable destination. Keeping them out of history preserves the
        // behaviour every call site has today, and keeps the unsaved-changes
        // guard — which is itself intercepting a navigation — from pushing a
        // history entry while it decides whether that navigation may proceed.
        historyMode="none"
        footer={
          <>
            <Button
              ref={cancelRef}
              variant="secondary"
              onClick={(event) => {
                event.stopPropagation();
                onCancel();
              }}
            >
              {cancelLabel}
            </Button>
            <Button
              variant={variant === 'danger' ? 'danger' : 'primary'}
              pending={pending}
              pendingLabel={`${confirmLabel}…`}
              onClick={(event) => {
                event.stopPropagation();
                triggerHaptic(variant === 'danger' ? 'error' : 'medium');
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        <p className="station-dialog__message">{message}</p>
      </Dialog>
    </div>,
    document.body,
  );
}
