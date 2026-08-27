export function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

type IconEntity = { name: string; icon?: string };

function isUrl(s: string): boolean {
  return (
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('/') ||
    s.startsWith('data:image/')
  );
}

function getIcon(entity: IconEntity): {
  display: string;
  isCustomIcon: boolean;
  isUrl: boolean;
} {
  if (entity.icon) {
    return {
      display: entity.icon,
      isCustomIcon: true,
      isUrl: isUrl(entity.icon),
    };
  }

  return {
    display: getInitials(entity.name),
    isCustomIcon: false,
    isUrl: false,
  };
}

function getIconStyle(
  entity: IconEntity,
  size: number = 48,
  variant: 'default' | 'user' | 'muted' = 'default',
) {
  const iconInfo = getIcon(entity);
  const baseStyle = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: variant === 'user' ? '50%' : `${size / 4}px`,
    background: 'var(--accent-primary)',
    color: 'var(--text-on-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: iconInfo.isCustomIcon ? `${size / 2}px` : `${size / 2.67}px`,
    fontWeight: 600,
    flexShrink: 0,
  };

  if (variant === 'user') {
    return {
      ...baseStyle,
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border-primary)',
    };
  }

  if (variant === 'muted') {
    return {
      ...baseStyle,
      background: 'var(--bg-tertiary)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-primary)',
    };
  }

  return baseStyle;
}

export function getLayoutIcon(layout: IconEntity) {
  return getIcon(layout);
}

export function getLayoutIconStyle(layout: IconEntity, size: number = 48) {
  return getIconStyle(layout, size);
}

export function getUserIconStyle(user: IconEntity, size: number = 20) {
  return getIconStyle(user, size, 'user');
}
