import type { ProjectMemberRole } from '@kontourai/station-contracts/project-membership';
import {
  GRANTABLE_ROLES,
  type GrantableProjectRole,
  ROLE_NAMES,
} from './projectRoles';

/**
 * A Project role select. Roles the acting member cannot grant stay listed but
 * disabled, so the reader sees the whole ladder and where they stop.
 */
export function ProjectRolePicker({
  value,
  onChange,
  canGrant,
  disabled,
  title,
  'aria-label': ariaLabel,
}: {
  value: GrantableProjectRole;
  onChange: (role: GrantableProjectRole) => void;
  canGrant: (role: ProjectMemberRole) => boolean;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
      value={value}
      onChange={(event) => onChange(event.target.value as GrantableProjectRole)}
    >
      {GRANTABLE_ROLES.map((candidate) => (
        <option
          key={candidate}
          value={candidate}
          disabled={!canGrant(candidate)}
        >
          {ROLE_NAMES[candidate]}
        </option>
      ))}
    </select>
  );
}
