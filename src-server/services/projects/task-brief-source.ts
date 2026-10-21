/**
 * Gathers what a Task brief is built from (epic #4003): the Task record, the
 * shared Task document, the Task's other Sessions and, at dispatch only, a
 * fresh read of the linked tracker item. The builder itself is pure
 * (`task-brief.ts`); this module owns the reads and their failure words.
 *
 * Authority is the caller's: `forDispatch` runs inside an already admitted
 * dispatch, and `forSession` derives the Task from the Session's immutable
 * server-owned room execution binding, never from an argument.
 */
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  buildTaskBrief,
  type TaskBriefInput,
  type TaskBriefObservation,
  type TaskBriefSessionLine,
  type TaskBriefSnapshot,
  type WorkItemObserver,
} from './task-brief.js';

/** A tracker read longer than this is abandoned; dispatch never waits on it. */
export const TASK_BRIEF_OBSERVE_TIMEOUT_MS = 10_000;

export interface TaskBriefSourceDeps {
  readTask(taskId: string): TaskRecord | null;
  /** Every Session dispatched for the Task, oldest first. */
  listTaskSessions(
    taskId: string,
  ): readonly { sessionId: string; provider?: string; createdAt: string }[];
  readDocument(taskId: string): Promise<TaskBriefInput['document']>;
  sessionStatus?(sessionId: string): string | undefined;
  /** The immutable Session → Task binding (`project_task_room_execution_bindings`). */
  readBinding(
    sessionId: string,
  ): { projectId: string; taskId: string } | undefined;
  /** The tracker read the intake lane provides; absent says so in the brief. */
  observeWorkItem?: WorkItemObserver;
  observeTimeoutMs?: number;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export type TaskBriefForSession =
  | { kind: 'brief'; brief: TaskBriefSnapshot }
  | { kind: 'unbound' }
  | { kind: 'unavailable'; reason: string };

export interface TaskBriefSource {
  /** The brief a Session dispatched for `task` receives with its first turn. */
  forDispatch(task: TaskRecord, sessionId: string): Promise<TaskBriefSnapshot>;
  /** The current brief for the Task the Session is bound to. */
  forSession(sessionId: string): Promise<TaskBriefForSession>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTaskBriefSource(
  deps: TaskBriefSourceDeps,
): TaskBriefSource {
  const readDocument = async (
    taskId: string,
  ): Promise<TaskBriefInput['document']> => {
    try {
      return await deps.readDocument(taskId);
    } catch (error) {
      return { kind: 'unavailable', reason: errorText(error) };
    }
  };

  const otherSessions = (
    taskId: string,
    sessionId: string,
  ): TaskBriefSessionLine[] =>
    deps
      .listTaskSessions(taskId)
      .filter((session) => session.sessionId !== sessionId)
      .map((session) => {
        let status: string | undefined;
        try {
          status = deps.sessionStatus?.(session.sessionId);
        } catch {
          status = undefined;
        }
        return {
          sessionId: session.sessionId,
          ...(session.provider ? { provider: session.provider } : {}),
          ...(status ? { status } : {}),
        };
      });

  const observe = async (
    task: TaskRecord,
    sessionId: string,
  ): Promise<TaskBriefObservation | undefined> => {
    const ref = task.workItemRef;
    if (!ref) return undefined;
    if (!deps.observeWorkItem)
      return {
        status: 'not-read',
        reason: 'this Station has no tracker reader',
      };
    // Comments newer than the last time Station looked: the previous
    // dispatch, or the Task's creation (Start Task seeded what came before).
    const prior = deps
      .listTaskSessions(task.id)
      .filter((session) => session.sessionId !== sessionId)
      .at(-1);
    const commentsSince = prior?.createdAt ?? task.createdAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        deps.observeWorkItem(ref, { commentsSince }),
        new Promise<TaskBriefObservation>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: 'not-read', reason: 'timed out' }),
            deps.observeTimeoutMs ?? TASK_BRIEF_OBSERVE_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      // Exact identity: an answer about another item is no answer.
      if (
        result.status === 'observed' &&
        result.observation.workItemRef !== ref
      )
        return {
          status: 'unavailable',
          reason: 'the tracker answered for a different item',
        };
      return result;
    } catch (error) {
      deps.logger?.warn('Task brief tracker read failed', {
        taskId: task.id,
        error: errorText(error),
      });
      return { status: 'not-read', reason: 'the tracker read failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    async forDispatch(task, sessionId) {
      const [document, observation] = await Promise.all([
        readDocument(task.id),
        observe(task, sessionId),
      ]);
      return buildTaskBrief({
        task,
        document,
        sessions: otherSessions(task.id, sessionId),
        ...(observation ? { observation } : {}),
      });
    },

    async forSession(sessionId) {
      const binding = deps.readBinding(sessionId);
      if (!binding) return { kind: 'unbound' };
      const task = deps.readTask(binding.taskId);
      if (!task || task.projectId !== binding.projectId)
        return {
          kind: 'unavailable',
          reason: 'The Task this session was dispatched for no longer exists.',
        };
      const document = await readDocument(task.id);
      // The binding is immutable, but the Task can be replaced while the
      // document read crosses its worker boundary.
      const current = deps.readTask(binding.taskId);
      if (
        !current ||
        current.createdAt !== task.createdAt ||
        current.projectId !== binding.projectId
      )
        return {
          kind: 'unavailable',
          reason: 'The Task changed while its brief was read.',
        };
      return {
        kind: 'brief',
        brief: buildTaskBrief({
          task: current,
          document,
          sessions: otherSessions(current.id, sessionId),
          ...(current.workItemRef
            ? {
                observation: {
                  status: 'not-read' as const,
                  reason:
                    'get_task_brief reads Station memory only; read the item with the tracker CLI',
                },
              }
            : {}),
        }),
      };
    },
  };
}

/**
 * The runtime composition both consumers share: the dispatcher (first-turn
 * delivery) and the `get_task_brief` route. Structural inputs, so neither
 * consumer's wiring can drift from the other's.
 */
export function composeTaskBriefSource(input: {
  taskGraph: {
    readTaskView(taskId: string): TaskRecord | null;
    listTaskDispatchSessions(
      taskId: string,
    ): readonly { sessionId: string; provider?: string; createdAt: string }[];
  };
  eventStore:
    | {
        readProjectTaskRoomExecutionBinding(
          sessionId: string,
        ): { projectId: string; taskId: string } | undefined;
        readSessionByThread(sessionId: string): { status?: string } | undefined;
      }
    | undefined;
  /** Read lazily: the room runtime is composed after the dispatcher. */
  roomRuntime: () =>
    | {
        readTaskDocumentForBrief(
          taskId: string,
        ): Promise<TaskBriefInput['document']>;
      }
    | undefined;
  observeWorkItem?: WorkItemObserver;
  logger?: TaskBriefSourceDeps['logger'];
}): TaskBriefSource {
  return createTaskBriefSource({
    readTask: (taskId) => input.taskGraph.readTaskView(taskId),
    listTaskSessions: (taskId) =>
      input.taskGraph.listTaskDispatchSessions(taskId),
    readDocument: async (taskId) => {
      const runtime = input.roomRuntime();
      return runtime
        ? runtime.readTaskDocumentForBrief(taskId)
        : { kind: 'unavailable', reason: 'the Task room is not running' };
    },
    sessionStatus: (sessionId) =>
      input.eventStore?.readSessionByThread(sessionId)?.status,
    readBinding: (sessionId) =>
      input.eventStore?.readProjectTaskRoomExecutionBinding(sessionId),
    ...(input.observeWorkItem
      ? { observeWorkItem: input.observeWorkItem }
      : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
}
