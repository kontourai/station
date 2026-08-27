import type { CSSProperties } from 'react';

export const inputStyle: CSSProperties = {
  padding: '10px 12px',
  fontSize: 13,
  background: 'var(--bg-primary, #0a0a0a)',
  border: '1px solid var(--border-primary, #333)',
  borderRadius: 8,
  color: 'var(--text-primary, #e5e5e5)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

export const primaryBtnStyle: CSSProperties = {
  padding: '10px 20px',
  fontSize: 13,
  fontWeight: 500,
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  background: 'var(--accent-primary, #3b82f6)',
  color: 'white',
  minHeight: 44,
};

export const secondaryBtnStyle: CSSProperties = {
  padding: '10px 20px',
  fontSize: 13,
  fontWeight: 500,
  borderRadius: 8,
  border: '1px solid var(--border-primary, #333)',
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--text-primary, #e5e5e5)',
  minHeight: 44,
};

export const iconBtnStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--text-secondary, #999)',
  cursor: 'pointer',
  fontSize: 14,
  padding: 8,
  lineHeight: 1,
  minWidth: 44,
  minHeight: 44,
};
