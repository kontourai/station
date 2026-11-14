import {
  type PermissionPosture,
  permissionPostureLabel,
} from '../../utils/sessionDisplay';
import './AttributionChip.css';

interface PermissionPostureBadgeProps {
  posture: PermissionPosture | null | undefined;
  className?: string;
}

/** Recorded posture annotation; absence renders no badge. */
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
