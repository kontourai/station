import type { TaskGraphService } from '../projects/task-graph-service.js';
import type { EventStore } from './event-store.js';
import type { ProjectTaskRoomRuntime } from './project-task-room-runtime.js';

/** Boot-only completion repair. Never invokes a provider or an assignment service. */
export async function recoverCompletedTaskDispatches(input: {
  eventStore: EventStore;
  taskGraph: TaskGraphService;
  room: Pick<
    ProjectTaskRoomRuntime,
    'prepareAgentStarted' | 'publishAgentStarted'
  >;
}): Promise<{ recovered: number; unresolved: number }> {
  const authority = input.eventStore.sessionTurnBoundaryAuthority();
  const recovery = authority.reconcile(new Date().toISOString());
  if (recovery.kind !== 'available') return { recovered: 0, unresolved: 1 };
  const candidates = recovery.interrupted.filter(
    (record) => record.purpose === 'task-dispatch',
  );
  let recovered = 0;
  let unresolved = Math.max(0, candidates.length - 128);
  for (const record of candidates.slice(0, 128)) {
    const outcome = await authority.recoverCompletedDispatch(
      record.threadId,
      async () => {
        const binding = input.eventStore.readProjectTaskRoomExecutionBinding(
          record.threadId,
        );
        const association = input.taskGraph.readCompletedDispatchForRecovery(
          record.threadId,
        );
        const session = input.eventStore.readSessionByThread(record.threadId);
        if (
          !binding ||
          !association ||
          !session ||
          binding.projectId !== association.task.projectId ||
          binding.taskId !== association.task.id ||
          association.dispatch.taskId !== binding.taskId ||
          association.dispatch.sessionId !== record.threadId ||
          session.threadId !== record.threadId ||
          session.provider !== association.dispatch.provider
        )
          return false;
        const result = { ...association, session };
        // This method throws unless the outbox durably acknowledges preparation.
        await input.room.prepareAgentStarted(result);
        // Current task association must still match after asynchronous preparation.
        const current = input.taskGraph.readCompletedDispatchForRecovery(
          record.threadId,
        );
        if (!current || JSON.stringify(current) !== JSON.stringify(association))
          return false;
        try {
          await input.room.publishAgentStarted(result);
        } catch {
          // Durable preparation remains replayable; delivery is observational.
        }
        return true;
      },
    );
    if (outcome.kind === 'applied') recovered++;
    else unresolved++;
  }
  return { recovered, unresolved };
}
