import {
  type PermissionPosture,
  permissionPostureLabel,
} from '../../utils/sessionDisplay';
import './AttributionChip.css';

interface PermissionPostureBadgeProps {
  posture: PermissionPosture | null | undefined;
  className?: string;
}

/**
 * Row-level permission-posture badge (station#1424): flags a read-only
 * -attached row so a reader never mistakes it for an ordinary station-owned
 * turn. `posture` absent/null renders nothing — the common case (an
 * ordinary session has no posture to flag).
 */
export function PermissionPostureBadge({
  posture,
  className = '',
}: PermissionPostureBadgeProps) {
  if (!posture) return null;
  return (
    <span
      className={`attribution-chip attribution-chip--${posture} ${className}`.trim()}
    >
      <span className="attribution-chip__pill attribution-chip__pill--posture">
        {permissionPostureLabel(posture)}
      </span>
    </span>
  );
}
