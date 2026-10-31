import { isDeepStrictEqual } from 'node:util';
import type {
  ProjectMemberAction,
  ProjectMembershipScope,
  ProjectMemberView,
} from '@kontourai/station-contracts/project-membership';
import type { ProjectSharedTaskAdmission } from '../../services/projects/project-shared-task-store.js';

export type TaskRoomAdmissionCapability =
  | 'discover'
  | 'history-read'
  | 'message-write'
  | 'edit-plan';

export function taskRoomMemberAction(
  capability: TaskRoomAdmissionCapability,
): ProjectMemberAction {
  switch (capability) {
    case 'discover':
    case 'history-read':
      return 'view';
    case 'message-write':
      return 'discuss';
    case 'edit-plan':
      return 'edit';
  }
}

/** Compose a Task's current share with the resolved person's Project membership. */
export function createTaskMemberAdmission(deps: {
  task(id: string): { projectId: string; createdAt: string } | null;
  share(id: string): ProjectSharedTaskAdmission | undefined;
  projects(): readonly { id: string; slug: string }[];
  portableId(slug: string): string | undefined;
  admissions(id: string): readonly {
    scope: ProjectMembershipScope;
    member: ProjectMemberView;
  }[];
  principalId(request: Request): string | undefined;
}) {
  const requestShares = new WeakMap<Request, Map<string, string | undefined>>();
  return {
    admit(request: Request, taskId: string, action: ProjectMemberAction) {
      const principalId = deps.principalId(request);
      if (!principalId) return undefined;
      const task = deps.task(taskId);
      const share = deps.share(taskId);
      let shares = requestShares.get(request);
      if (!shares) {
        shares = new Map();
        requestShares.set(request, shares);
      }
      if (!shares.has(taskId)) shares.set(taskId, share?.shareId);
      if (
        !task ||
        !share ||
        share.taskCreatedAt !== task.createdAt ||
        shares.get(taskId) !== share.shareId
      )
        return undefined;
      const projects = deps
        .projects()
        .filter(
          (project) =>
            project.id === task.projectId || project.slug === task.projectId,
        );
      if (
        projects.length !== 1 ||
        projects[0]!.id !== share.scope.localProjectId ||
        projects[0]!.slug !== share.scope.localProjectSlug ||
        deps.portableId(share.scope.localProjectSlug) !==
          share.scope.portableProjectId
      )
        return undefined;
      return deps
        .admissions(principalId)
        .find(
          ({ scope, member }) =>
            isDeepStrictEqual(scope, share.scope) &&
            member.status === 'active' &&
            member.actions.includes(action),
        );
    },
  };
}
