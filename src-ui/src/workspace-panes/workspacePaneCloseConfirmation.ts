/**
 * The pane close prompt's presentation, as a value.
 *
 * It lives apart from the component because the component's confirmation
 * state is controller-driven and awkward to reach from a test — and this is
 * exactly the part that has to stay right: the prompt was hand-rolled markup
 * under a class with no CSS rule, so it had no dialog surface and its
 * DISCARDING action was visually identical to Cancel (archive#3157).
 *
 * `danger` is the load-bearing field. Everything else is wording.
 */
export type PaneCloseReason = 'dirty' | (string & {});

export interface PaneCloseConfirmationProps {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger';
  /**
   * `alertdialog`, not `dialog`. This prompt interrupts to guard unsaved
   * work; ARIA distinguishes the two and assistive tech announces them
   * differently. The hand-rolled markup this replaced had it right, and
   * reusing ConfirmModal silently downgraded it until the pane host's own
   * test caught the missing role (archive#3157).
   */
  role: 'alertdialog';
}

export function paneCloseConfirmationProps(
  reason: PaneCloseReason | undefined,
): PaneCloseConfirmationProps {
  return {
    title: 'Close workspace pane',
    message:
      reason === 'dirty'
        ? 'This pane has unsaved changes.'
        : 'This pane has pending work.',
    confirmLabel: 'Close pane',
    // Closing discards work in BOTH branches — pending work is lost the same
    // way unsaved work is — so the destructive treatment is unconditional.
    variant: 'danger',
    role: 'alertdialog',
  };
}
