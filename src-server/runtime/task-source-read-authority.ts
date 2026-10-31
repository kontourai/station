import { isDeepStrictEqual } from 'node:util';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { isDeploymentAccountPrincipalId } from '../services/identity/deployment-authentication-service.js';
import type { ProjectMembershipService } from '../services/projects/project-membership-service.js';
import type { ProjectSharedTaskStore } from '../services/projects/project-shared-task-store.js';

/** Shared Task source rule; transport authentication and currentness stay with each caller. */
export function createCanonicalTaskSourceReader(options: {
  readTask(
    id: string,
  ): Pick<TaskRecord, 'id' | 'projectId' | 'createdAt'> | null;
  projects(): readonly { id: string; slug: string }[];
  shares: Pick<ProjectSharedTaskStore, 'admission'> | undefined;
  membership:
    | Pick<ProjectMembershipService, 'admissionsForResolvedPrincipal'>
    | undefined;
  portableProjectId(slug: string): string | undefined;
}) {
  return (
    taskId: string,
    principalId: string,
    admission: {
      operatorInPerson: boolean;
      shares: Map<string, string | undefined>;
    },
  ): boolean => {
    if (
      !isDeploymentAccountPrincipalId(principalId) ||
      admission.operatorInPerson
    )
      return true;
    const task = options.readTask(taskId);
    const share = options.shares?.admission(taskId);
    if (!admission.shares.has(taskId))
      admission.shares.set(taskId, share?.shareId);
    if (
      !task ||
      !share ||
      share.taskCreatedAt !== task.createdAt ||
      admission.shares.get(taskId) !== share.shareId
    )
      return false;
    const projects = options
      .projects()
      .filter(
        (project) =>
          project.id === task.projectId || project.slug === task.projectId,
      );
    if (
      projects.length !== 1 ||
      projects[0]!.id !== share.scope.localProjectId ||
      projects[0]!.slug !== share.scope.localProjectSlug ||
      options.portableProjectId(share.scope.localProjectSlug) !==
        share.scope.portableProjectId
    )
      return false;
    return (
      options.membership
        ?.admissionsForResolvedPrincipal(principalId)
        .some(
          ({ scope, member }) =>
            isDeepStrictEqual(scope, share.scope) &&
            member.status === 'active' &&
            member.actions.includes('view'),
        ) === true
    );
  };
}
