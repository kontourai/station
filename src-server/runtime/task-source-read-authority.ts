import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { isDeploymentAccountPrincipalId } from '../services/identity/deployment-authentication-service.js';
import type { ProjectMembershipService } from '../services/projects/project-membership-service.js';
import type { ProjectSharedTaskStore } from '../services/projects/project-shared-task-store.js';
import { createTaskMemberAdmission } from './routes/task-member-admission.js';

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
  const members = createTaskMemberAdmission({
    task: options.readTask,
    share: (id) => options.shares?.admission(id),
    projects: options.projects,
    portableId: options.portableProjectId,
    admissions: (id) =>
      options.membership?.admissionsForResolvedPrincipal(id) ?? [],
    principalId: () => undefined,
  });
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
    return (
      members.admitPrincipal(principalId, taskId, 'view', admission.shares) !==
      undefined
    );
  };
}
