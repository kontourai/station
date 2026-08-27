/**
 * Local work-item provider backend (roadmap #583, part of epic #580, S3).
 *
 * An adapter over `TaskGraphService.listTasks` — no storage change. Today's
 * `task-graph.json` tasks are exposed through the provider seam unchanged;
 * this is the zero-dependency fallback that always reports `available`.
 */

import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type {
  ProviderWorkItem,
  WorkItemProviderCapabilities,
  WorkItemProviderIdentity,
  WorkItemProviderListResult,
} from '@kontourai/station-contracts/work-item-provider';
import type {
  IWorkItemProvider,
  WorkItemProjectContext,
} from '../../providers/provider-interfaces.js';
import type { TaskGraphService } from '../projects/task-graph-service.js';

export const LOCAL_WORK_ITEM_PROVIDER_IDENTITY: WorkItemProviderIdentity = {
  kind: 'local',
  id: 'local',
  label: 'Station',
};

const LOCAL_CAPABILITIES: WorkItemProviderCapabilities = {
  readOnly: false,
  supportsDispatch: true,
  // Local tasks already support status writes through TaskGraphService, but
  // that happens through the existing /api/tasks routes, not through this
  // read-only seam yet — kept false here until the seam grows a write path.
  supportsStatusWrite: false,
};

function taskToProviderWorkItem(task: TaskRecord): ProviderWorkItem {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    provider: LOCAL_WORK_ITEM_PROVIDER_IDENTITY,
    workItemRef: task.workItemRef,
    priority: task.priority,
    updatedAt: task.updatedAt,
  };
}

export class LocalWorkItemProvider implements IWorkItemProvider {
  readonly identity = LOCAL_WORK_ITEM_PROVIDER_IDENTITY;
  readonly capabilities = LOCAL_CAPABILITIES;

  constructor(private taskGraphService: Pick<TaskGraphService, 'listTasks'>) {}

  async listWorkItems(
    context: WorkItemProjectContext,
  ): Promise<WorkItemProviderListResult> {
    const tasks = this.taskGraphService.listTasks(context.projectId);
    return { available: true, items: tasks.map(taskToProviderWorkItem) };
  }
}
