import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type { TaskRelationshipRouteAdapters } from '../../routes/orchestration/task-relationships.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { TaskGraphService } from '../../services/projects/task-graph-service.js';
import { TaskRelationshipError } from '../../services/projects/task-relationship-state.js';
import type { TaskRoomWorkModule } from '../../services/projects/task-room-work-module.js';

/** Batches discovery, then prepares and rechecks each exact relationship's reader. */
export function createTaskInboxProjection(deps: {
  graph: TaskGraphService;
  projects(): readonly Pick<ProjectConfig, 'id' | 'slug' | 'createdAt'>[];
  relationships: TaskRelationshipRouteAdapters;
  work: TaskRoomWorkModule;
  events: Pick<
    EventStore,
    'readProjectTaskRoomExecutionBinding' | 'conversationForSession'
  >;
}) {
  return async (request: Request, tasks: readonly TaskRecord[]) => {
    const discover = async () => {
      const projects = deps.projects();
      const scopes = tasks.flatMap((task) => {
        const matches = projects.filter(
          (project) =>
            project.id === task.projectId || project.slug === task.projectId,
        );
        return matches.length === 1
          ? [
              {
                taskId: task.id,
                taskCreatedAt: task.createdAt,
                roomProjectId: task.projectId,
                projectId: matches[0]!.id,
              },
            ]
          : [];
      });
      const requests = await deps.work.readPublicationRequestsForTasks({
        tasks: scopes,
        readBinding: (id) =>
          deps.events.readProjectTaskRoomExecutionBinding(id),
      });
      const candidates = new Map(
        tasks.map((task) => [task.id, new Set<string>()]),
      );
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const conversation = (sessionId: string) =>
        deps.events.conversationForSession(sessionId)?.conversationId ??
        sessionId;
      for (const task of tasks) {
        if (task.sessionId)
          candidates.get(task.id)!.add(conversation(task.sessionId));
      }
      for (const record of requests)
        candidates.get(record.taskId)?.add(conversation(record.sessionId));
      for (const link of deps.graph.listTaskWorkChatCandidates()) {
        if (
          taskById.get(link.task.taskId)?.createdAt === link.task.taskCreatedAt
        )
          candidates.get(link.task.taskId)?.add(link.conversationId);
      }
      return candidates;
    };
    const candidates = await discover();
    const prepared = [];
    for (const task of tasks) {
      const conversationIds = [...candidates.get(task.id)!];
      if (!conversationIds.length) continue;
      try {
        const access = await deps.relationships.authorityForRequest(
          request,
          undefined,
          { taskId: task.id, conversationIds },
        );
        if (access) prepared.push({ task, conversationIds, access });
      } catch (error) {
        // Admission can disappear after discovery. Omit that Task's chats,
        // while preserving failures that indicate a broken store or adapter.
        if (
          !(error instanceof TaskRelationshipError) ||
          error.code !== 'unavailable'
        )
          throw error;
      }
    }
    const currentCandidates = await discover();
    const result = new Map<string, readonly string[]>();
    for (const { task, conversationIds, access } of prepared) {
      const live = deps.graph.readTask(task.id);
      const project = live && access.canonicalProject(live.projectId);
      if (
        !live ||
        live.createdAt !== task.createdAt ||
        !project ||
        project.id !== access.expectedProject.id ||
        project.createdAt !== access.expectedProject.createdAt ||
        !access.canReadTask(live)
      )
        continue;
      result.set(
        task.id,
        conversationIds.filter(
          (id) =>
            currentCandidates.get(task.id)?.has(id) &&
            access.canReadConversation(id, project),
        ),
      );
    }
    return result;
  };
}
