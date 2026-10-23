import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { ProjectMembershipRefusal } from '../../services/projects/project-membership-store.js';
import {
  type ProjectRoomTaskContext,
  roomTaskReferences,
  sameRoomTaskScope,
} from '../../services/projects/project-room-agent-task-context.js';
import type { ProjectSharedTaskService } from '../../services/projects/project-shared-task-service.js';
import { ProjectSharedTaskRefusal } from '../../services/projects/project-shared-task-store.js';

/** Request credentials and view authority never come from the persisted capture. */
export function createProjectRoomTaskContext(deps: {
  request: Request;
  scope: ProjectMembershipScope;
  requesterId: string;
  /** Uses the enclosing Room Project lease; must not acquire it recursively. */
  requireView(): Promise<() => void>;
  service?: ProjectSharedTaskService;
  principalId(): Promise<string>;
}): ProjectRoomTaskContext {
  const scope = structuredClone(deps.scope);
  let viewCurrent: (() => void) | undefined;
  const requireView = async () => {
    if (
      deps.request.signal.aborted ||
      (await deps.principalId()) !== deps.requesterId
    )
      throw new ProjectMembershipRefusal('forbidden');
    viewCurrent = await deps.requireView();
    viewCurrent();
  };
  const authority = {
    current: async () => ({ principalId: await deps.principalId() }),
    operator: async () => {
      throw new ProjectMembershipRefusal('forbidden');
    },
    requireProjectRead: async (expected: ProjectMembershipScope) => {
      if (!sameRoomTaskScope(scope, expected))
        throw new ProjectMembershipRefusal('forbidden');
      await requireView();
    },
  };
  const assertCurrent: ProjectRoomTaskContext['assertCurrent'] = (snapshot) => {
    if (
      deps.request.signal.aborted ||
      !sameRoomTaskScope(scope, snapshot.project) ||
      !viewCurrent
    )
      throw new ProjectMembershipRefusal('forbidden');
    viewCurrent();
    for (const summary of roomTaskReferences(snapshot)) {
      if (!deps.service) throw new ProjectSharedTaskRefusal('unavailable');
      deps.service.assertSummaryCurrent(summary);
    }
  };
  return {
    async capture() {
      await requireView();
      if (!deps.service) return null;
      try {
        return await deps.service.list(scope, authority);
      } catch (error) {
        if (
          error instanceof ProjectSharedTaskRefusal &&
          error.code === 'unavailable'
        )
          return null;
        throw error;
      }
    },
    async refresh(snapshot) {
      await requireView();
      assertCurrent(snapshot);
    },
    assertCurrent,
    async withCurrent(snapshot, operation) {
      if (!deps.service) {
        assertCurrent(snapshot);
        return operation();
      }
      return deps.service.withCurrentSummaries(
        roomTaskReferences(snapshot),
        () => {
          assertCurrent(snapshot);
          return operation();
        },
      );
    },
  };
}
