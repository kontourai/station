import type { ProjectMemberRole } from '@kontourai/station-contracts/project-membership';
import type { ReactNode } from 'react';
import {
  GRANTABLE_ROLES,
  type GrantableProjectRole,
  ROLE_NAMES,
} from './projectRoles';

/**
 * A labelled Project role select: `label` is the visible text around it.
 * Roles the acting member cannot grant stay listed but disabled, so the
 * reader sees the whole ladder and where they stop.
 */
export function ProjectRolePicker({
  label,
  value,
  onChange,
  canGrant,
  disabled,
  title,
  'aria-label': ariaLabel,
}: {
  label: ReactNode;
  value: GrantableProjectRole;
  onChange: (role: GrantableProjectRole) => void;
  canGrant: (role: ProjectMemberRole) => boolean;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        title={title}
        value={value}
        onChange={(event) =>
          onChange(event.target.value as GrantableProjectRole)
        }
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
    </label>
  );
}
