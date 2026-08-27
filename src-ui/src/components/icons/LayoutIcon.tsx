import type { ReactNode } from 'react';
import { getLayoutIcon, getLayoutIconStyle } from '../../utils/layout';

interface LayoutIconProps {
  layout: { name: string; icon?: string };
  size?: number;
  style?: React.CSSProperties;
  fallback?: ReactNode;
}

export function LayoutIcon({
  layout,
  size = 24,
  style,
  fallback,
}: LayoutIconProps) {
  const icon = getLayoutIcon(layout);
  const baseStyle = getLayoutIconStyle(layout, size);

  return (
    <div
      style={{
        ...baseStyle,
        background: 'var(--bg-tertiary)',
        color: 'var(--text-primary)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {icon.isUrl ? (
        <img
          src={icon.display}
          alt={layout.name}
          width={size}
          height={size}
          style={{ borderRadius: 'inherit', objectFit: 'cover' }}
        />
      ) : icon.isCustomIcon ? (
        icon.display
      ) : (
        (fallback ?? icon.display)
      )}
    </div>
  );
}
