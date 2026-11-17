/**
 * The Project membership rule for a principal Station resolved itself (a
 * session's recorded owner, a scheduled job's creator), never for a request:
 *
 * - a deployment account holds exactly its active membership's actions;
 * - any other principal is unrestricted in its own Projects, so it may view
 *   and execute;
 * - approving a worker's request is the operator's: no membership row names
 *   anyone else an admin.
 *
 * The station-control dispatch scope checks a session's recorded owner with
 * it, and #5126 checks a Project job's creator with it before each run.
 */
import { isDeploymentAccountPrincipalId } from '../identity/deployment-authentication-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';
import type { ProjectMembershipService } from './project-membership-service.js';

export type ProjectPrincipalAction = 'view' | 'execute' | 'approve';

export function createProjectPrincipalPermission(
  membership:
    | Pick<ProjectMembershipService, 'admissionsForResolvedPrincipal'>
    | undefined,
): (
  principalId: string,
  localProjectId: string,
  action: ProjectPrincipalAction,
) => boolean {
  return (principalId, localProjectId, action) => {
    if (!isDeploymentAccountPrincipalId(principalId))
      return (
        action !== 'approve' || principalId === LOCAL_OPERATOR_PRINCIPAL_ID
      );
    if (!membership) return false;
    return membership
      .admissionsForResolvedPrincipal(principalId)
      .some(
        ({ scope, member }) =>
          scope.localProjectId === localProjectId &&
          member.status === 'active' &&
          member.actions.includes(action),
      );
  };
}

/**
 * #5126: whether a Project job's creator may still start its run. A run is a
 * Task the creator starts, so it needs `execute` in the Project, read from
 * current membership at each run.
 */
export function projectJobCreatorMayRun(
  permission: ReturnType<typeof createProjectPrincipalPermission>,
): (creatorId: string, localProjectId: string) => boolean {
  return (creatorId, localProjectId) =>
    permission(creatorId, localProjectId, 'execute');
}
