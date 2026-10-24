import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import './ActionControl.css';

export type ActionControlVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'danger-outline'
  | 'success'
  | 'link'
  | 'ghost';
export interface ActionControlProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionControlVariant;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
  pending?: boolean;
  pendingLabel?: ReactNode;
  children?: ReactNode;
}

export const ActionControl = forwardRef<HTMLButtonElement, ActionControlProps>(
  function ActionControl(
    {
      variant = 'secondary',
      size = 'md',
      active = false,
      pending = false,
      pendingLabel,
      className = '',
      disabled,
      children,
      ...props
    }: ActionControlProps,
    ref,
  ) {
    const classes = [
      'button',
      `button--${variant}`,
      size === 'sm' && 'button--small',
      size === 'lg' && 'button--large',
      active && 'is-active',
      pending && 'is-pending',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        type="button"
        className={classes}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        {...props}
      >
        {pending && <span className="button__spinner" aria-hidden="true" />}
        {pending && pendingLabel !== undefined ? pendingLabel : children}
      </button>
    );
  },
);
