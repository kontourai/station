import type {
  TaskDispatchInput,
  TaskDispatchResult,
} from '@kontourai/station-contracts';
import { composeTaskDispatcher } from '../task-dispatch-composition.js';
import type { DispatchOutcome, TaskDispatcher } from '../task-dispatcher.js';
import type { TaskGraphService } from '../task-graph-service.js';

const dispatchers = new WeakMap<TaskGraphService, TaskDispatcher>();

/** One explicitly composed Dispatcher per durable graph for test scenarios. */
export function composeTestTaskDispatcher(
  service: TaskGraphService,
): TaskDispatcher {
  const existing = dispatchers.get(service);
  if (existing) return existing;
  const dispatcher = composeTaskDispatcher(service);
  dispatchers.set(service, dispatcher);
  return dispatcher;
}

/** Legacy assertion convenience lives in tests, never on TaskGraphService. */
export function unwrapDispatch(outcome: DispatchOutcome): TaskDispatchResult {
  if (outcome.kind === 'dispatched') return outcome.result;
  throw new Error(outcome.reason);
}

export async function dispatchTaskForTest(
  service: TaskGraphService,
  taskId: string,
  input: TaskDispatchInput,
): Promise<TaskDispatchResult> {
  return unwrapDispatch(
    await composeTestTaskDispatcher(service).dispatch(taskId, input),
  );
}
