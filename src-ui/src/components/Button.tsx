import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'danger-outline'
  | 'success'
  | 'link'
  | 'ghost';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
  /**
   * An async action this button started is still in flight.
   *
   * Renders a spinner beside the label and disables the control, so the two
   * facts a user needs — "it heard me" and "don't press it again" — are one
   * prop instead of a per-view convention. The audit found the opposite
   * everywhere: Create project fired with no acknowledgement at all for 6-8
   * seconds (SHELL-01), which is precisely what invites the double-submit
   * that produced the first pass's error render; `Run now`, `Enable` and
   * `Set up 2` were equally silent (SHELL-12, SHELL-16).
   *
   * `pendingLabel` swaps the text as well ("Creating…"); without it the label
   * stays put and only the spinner appears. Prefer swapping it — a label that
   * still reads "Create" while the spinner turns is ambiguous about whether
   * the click landed.
   */
  pending?: boolean;
  /** Label to show while `pending`. Defaults to `children` unchanged. */
  pendingLabel?: ReactNode;
  children: ReactNode;
  /**
   * Forwarded to the underlying `<button>`. React 19 passes `ref` through as an
   * ordinary prop, so the spread below is all the plumbing needed — but the
   * type has to say so, because `ButtonHTMLAttributes` does not carry it.
   * Dialogs need this to name their own initial focus target.
   */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  active = false,
  pending = false,
  pendingLabel,
  className = '',
  disabled,
  children,
  ...props
}: ButtonProps) {
  const classes = [
    'button',
    `button--${variant}`,
    size === 'sm' && 'button--small',
    active && 'is-active',
    pending && 'is-pending',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      // A pending control must REFUSE the second click, not merely look busy.
      // `disabled` also picks up `.button:disabled`'s opacity/not-allowed
      // treatment, so a pending primary can never be mistaken for a live one
      // (RT-05 measured a disabled Save Changes painted as a full-strength
      // primary: `opacity: 1`, `cursor: pointer`, no tooltip).
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending && <span className="button__spinner" aria-hidden="true" />}
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
