import { useAuth } from '../../contexts/AuthContext';
import { getInitials, getUserIconStyle } from '../../utils/layout';

interface UserIconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function UserIcon({ size = 20, className, style }: UserIconProps) {
  const { user } = useAuth();
  const name = user?.name || user?.alias || 'You';
  const baseStyle = getUserIconStyle({ name }, size);

  return (
    <div
      className={className}
      style={{ ...baseStyle, overflow: 'hidden', ...style }}
    >
      {getInitials(name)}
    </div>
  );
}
