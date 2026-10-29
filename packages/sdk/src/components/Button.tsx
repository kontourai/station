import React from 'react';
import { ActionControl } from './ActionControl';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'success' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

/** SDK defaults and loading state over the shared Station action control. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', loading = false, type, children, ...props }, ref) => (
    <ActionControl
      ref={ref}
      type={type ?? 'submit'}
      variant={variant}
      pending={loading}
      {...props}
    >
      {children}
    </ActionControl>
  ),
);
Button.displayName = 'Button';
