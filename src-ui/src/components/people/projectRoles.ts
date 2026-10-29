import {
  PROJECT_MEMBER_ROLES,
  type ProjectMemberRole,
  type ProjectMemberView,
} from '@kontourai/station-contracts/project-membership';

/** The Project roles a member or invitation can be given; ownership moves only by transfer. */
export const GRANTABLE_ROLES = ['viewer', 'contributor', 'admin'] as const;
export type GrantableProjectRole = (typeof GRANTABLE_ROLES)[number];

export const ROLE_NAMES: Record<ProjectMemberRole, string> = {
  viewer: 'Viewer',
  contributor: 'Contributor',
  admin: 'Project admin',
  owner: 'Owner',
};

/**
 * Whether `actor` may hand out `candidate`: only a role whose every action the
 * actor already holds. No acting member (absent or revoked) grants nothing.
 * The server enforces the same rule; this only keeps the picker honest.
 */
export function canGrant(
  actor: Pick<ProjectMemberView, 'actions'> | undefined,
  candidate: ProjectMemberRole,
): boolean {
  return (
    actor !== undefined &&
    (PROJECT_MEMBER_ROLES[candidate] as readonly string[]).every((action) =>
      actor.actions.includes(action as (typeof actor.actions)[number]),
    )
  );
}
