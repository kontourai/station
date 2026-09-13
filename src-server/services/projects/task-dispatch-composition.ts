import {
  createTaskDispatcher,
  type TaskDispatcher,
  type TaskDispatchLiveWorkPublisher,
} from './task-dispatcher.js';
import type {
  TaskDispatchAdapterDeps,
  TaskGraphService,
} from './task-graph-service.js';

/** Runtime Composition Seam: graph durability stays separate from dispatch. */
export function composeTaskDispatcher(
  taskGraphService: TaskGraphService,
  deps?: TaskDispatchAdapterDeps,
  liveWorkPublisher?: TaskDispatchLiveWorkPublisher,
): TaskDispatcher {
  const adapters = taskGraphService.createTaskDispatchAdapters(deps);
  return createTaskDispatcher(
    adapters.graph,
    adapters.claims,
    adapters.remoteSessions,
    adapters.telemetry,
    liveWorkPublisher,
    adapters.execution,
  );
}
