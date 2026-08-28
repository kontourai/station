import { type ReactNode, type RefObject, useId } from 'react';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  type ResponsiveDialogSurfaceProps,
  ResponsiveSurfaceActions,
} from './ResponsiveDialogSurface';

export interface DialogProps {
  /** Small uppercase line above the title (New Project's `PROJECT SETUP`). */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Optional second line under the title, muted. */
  subtitle?: ReactNode;
  /**
   * Accessible name for the close affordance ("Close new project"). Required
   * because "Close" alone is ambiguous once two dialogs can stack.
   */
  closeLabel: string;
  onClose: () => void;
  /**
   * Footer controls, rendered in a `ResponsiveSurfaceActions` row. Omit for a
   * dialog whose body commits (the New Chat picker: clicking a row starts the
   * chat) — but prefer a footer: a dialog with no visible commit was the
   * single most confusing surface in the audit (SHELL-02, and the New Chat
   * row of the view-but-can't-act inventory).
   */
  footer?: ReactNode;
  children: ReactNode;
  /**
   * `alertdialog` for a prompt that interrupts with something the user must
   * act on. Forwarded to `ResponsiveDialogSurface`, which is where the ARIA
   * contract lives.
   */
  role?: ResponsiveDialogSurfaceProps['role'];
  dismissible?: boolean;
  historyMode?: ResponsiveDialogSurfaceProps['historyMode'];
  initialFocusRef?: RefObject<HTMLElement | null>;
  initialFocusPolicy?: ResponsiveDialogSurfaceProps['initialFocusPolicy'];
  returnFocusTarget?: ResponsiveDialogSurfaceProps['returnFocusTarget'];
  /** Panel width. `md` (560px) is the default; `lg` for form-heavy dialogs. */
  size?: 'sm' | 'md' | 'lg';
  /** Extra classes on the panel, for a surface that owns unusual geometry. */
  panelClassName?: string;
  overlayClassName?: string;
  /**
   * Hide the header close button. Escape and the backdrop still dismiss (that
   * is `dismissible`), so this is only for a surface whose header has no room
   * — never as a way to make a dialog harder to leave. Delete Job shipped
   * without an X while the Add Job dialog beside it had one; that
   * inconsistency is the reason this defaults to `false`.
   */
  hideClose?: boolean;
}

/**
 * The one Station dialog chrome: eyebrow · title · subtitle · close X, a
 * scroll-safe body, and a footer action row.
 *
 * The audit opened four dialogs in one session and found four different
 * systems (SHELL-02): New Project had an eyebrow, sentence-case labels and a
 * dark-outlined `Create`; Add Job had UPPERCASE labels and a teal-filled
 * primary; Delete Job had a red primary and NO close X — and those last two
 * open from the same table row. Source-side that was 20 distinct `*-modal__*`
 * class families sitting alongside `ResponsiveDialogSurface`.
 *
 * This composes `ResponsiveDialogSurface` rather than replacing it: that
 * component owns the hard parts (focus containment and restoration, Escape,
 * backdrop dismissal, VisualViewport geometry, dialog history) and is the
 * repo's registered responsive-surface owner. What was missing above it was
 * the *visual* contract, which is what lives here.
 *
 * The styles live in `index.css`, deliberately — the eagerly loaded sheet. A
 * dialog chrome defined in a lazily imported stylesheet renders unstyled for
 * whichever consumer opens first, which is exactly the bug
 * `ResponsiveDialogHeader` was created to fix.
 *
 * The classes are `station-dialog__*`, not `dialog__*`: @kontourai/ui already
 * owns a `.dialog` contract for its own Dialog primitive — one built on the
 * native `<dialog>` element, which is why Station does not consume it (no
 * VisualViewport containment, no mobile sheet geometry, no dialog history, no
 * return-focus). The first draft used the bare names and the kit's rules won
 * on the shared ones, rendering dialog titles in a display serif at uppercase
 * beside DM Sans sentence-case page titles. See the block comment in
 * index.css.
 */
export function Dialog({
  eyebrow,
  title,
  subtitle,
  closeLabel,
  onClose,
  footer,
  children,
  role,
  dismissible,
  historyMode,
  initialFocusRef,
  initialFocusPolicy,
  returnFocusTarget,
  size = 'md',
  panelClassName = '',
  overlayClassName = '',
  hideClose = false,
}: DialogProps) {
  const titleId = useId();

  return (
    <ResponsiveDialogSurface
      role={role}
      onClose={onClose}
      ariaLabelledBy={titleId}
      dismissible={dismissible}
      historyMode={historyMode}
      initialFocusRef={initialFocusRef}
      initialFocusPolicy={initialFocusPolicy}
      returnFocusTarget={returnFocusTarget}
      overlayClassName={`station-dialog__overlay ${overlayClassName}`.trim()}
      panelClassName={`station-dialog station-dialog--${size} ${panelClassName}`.trim()}
    >
      <div className="station-dialog__header">
        <div className="station-dialog__heading">
          {eyebrow && <p className="station-dialog__eyebrow">{eyebrow}</p>}
          <h2 className="station-dialog__title" id={titleId}>
            {title}
          </h2>
          {subtitle && <p className="station-dialog__subtitle">{subtitle}</p>}
        </div>
        {!hideClose && (
          <ResponsiveDialogCloseButton label={closeLabel} onClick={onClose} />
        )}
      </div>
      <div className="station-dialog__body">{children}</div>
      {footer && (
        <ResponsiveSurfaceActions className="station-dialog__footer">
          {footer}
        </ResponsiveSurfaceActions>
      )}
    </ResponsiveDialogSurface>
  );
}
