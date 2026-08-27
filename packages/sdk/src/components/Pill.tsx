import React from 'react';

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'error';
  size?: 'sm' | 'md';
  removable?: boolean;
  onRemove?: () => void;
}

export const Pill = React.forwardRef<HTMLSpanElement, PillProps>(
  (
    {
      variant = 'default',
      size = 'md',
      removable,
      onRemove,
      children,
      style,
      ...props
    },
    ref,
  ) => {
    const baseStyles: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.25rem',
      borderRadius: '9999px',
      fontSize: size === 'sm' ? '0.75rem' : '0.875rem',
      fontWeight: 500,
      padding: size === 'sm' ? '0.125rem 0.5rem' : '0.25rem 0.75rem',
      whiteSpace: 'nowrap',
      ...style,
    };

    const variantStyles: Record<string, React.CSSProperties> = {
      default: {
        background: 'var(--color-bg-secondary)',
        color: 'var(--color-text)',
        border: '1px solid var(--color-border)',
      },
      primary: {
        background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
        color: 'var(--color-primary)',
        border:
          '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
      },
      // The tinted status pairs, not the --color-success / --color-warning
      // these read until station#1254. Those two names look like members of
      // the host's --color-* alias family (--color-error, one variant below,
      // is real) and are declared nowhere, so both variants rendered as an
      // unpainted pill with no border and body-copy text — indistinguishable
      // from `default` except for the missing chrome.
      //
      // The 15%/30% self-tint the other variants use is deliberately NOT
      // carried over here: measured in a real browser, --success-text on a 15%
      // tint of itself is 3.84:1 in the light theme, under 1.4.3's 4.5:1. The
      // --x-bg / --x-border / --x-text triple is the app's own recipe for a
      // tinted status surface (.plugins__update-banner) and measures 5.01:1
      // light / 8.84:1 dark for success and 6.86:1 / 5.41:1 for warning.
      // --color-error is left as it is: it resolves, and renaming a working
      // token is not this change.
      success: {
        background: 'var(--success-bg)',
        color: 'var(--success-text)',
        border: '1px solid var(--success-border)',
      },
      warning: {
        background: 'var(--warning-bg)',
        color: 'var(--warning-text)',
        border: '1px solid var(--warning-border)',
      },
      error: {
        background: 'color-mix(in srgb, var(--color-error) 15%, transparent)',
        color: 'var(--color-error)',
        border:
          '1px solid color-mix(in srgb, var(--color-error) 30%, transparent)',
      },
    };

    return (
      <span
        ref={ref}
        style={{ ...baseStyles, ...variantStyles[variant] }}
        {...props}
      >
        {children}
        {removable && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove?.();
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              padding: 0,
              marginLeft: '0.25rem',
              fontSize: '1rem',
              lineHeight: 1,
              opacity: 0.7,
            }}
            aria-label="Remove"
          >
            ×
          </button>
        )}
      </span>
    );
  },
);

Pill.displayName = 'Pill';
