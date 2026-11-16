import {
  deriveTaskLane,
  partitionTaskLanes,
  type TaskLaneDerivation,
  type TaskLaneId,
  type TaskLaneInput,
  type TaskLanePartition,
} from '@kontourai/station-contracts/task-lane';
import {
  type OrchestrationSessionSummary,
  type TaskListRecord,
  useOrchestrationSessionsQuery,
  useTaskPullRequestFactsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';

/** How long the board waits for its first pull request facts. */
const FIRST_FACTS_WAIT_MS = 2_000;

export interface TaskBoardModel {
  /** `loading` until Tasks and runs have answered (and briefly, facts). */
  status: 'loading' | 'ready';
  derivations: ReadonlyMap<string, TaskLaneDerivation>;
  partition: TaskLanePartition;
  sessionsById: ReadonlyMap<string, OrchestrationSessionSummary>;
  sessions: { failed: boolean; refetch(): void };
  pullRequests: {
    /** The first read has not answered yet. */
    checking: boolean;
    /** The last read failed; `asOf` is when the facts shown were read. */
    failed: boolean;
    asOf?: string;
    refetch(): void;
  };
}

/**
 * The Project Tasks board's one read model: each Task joined to its run (by
 * `TaskRecord.sessionId`, the only Task→run join) and its pull request
 * facts, derived into lanes by the contract's `deriveTaskLane`. Nothing here
 * decides a lane; it only says which facts were and were not read.
 */
export function useTaskBoardModel({
  projectSlug,
  tasks,
  tasksSettled,
}: {
  projectSlug: string;
  tasks: readonly TaskListRecord[];
  tasksSettled: boolean;
}): TaskBoardModel {
  const sessionsQuery = useOrchestrationSessionsQuery();
  const factsQuery = useTaskPullRequestFactsQuery(projectSlug, {
    enabled: tasksSettled,
  });
  const [waitedForFacts, setWaitedForFacts] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setWaitedForFacts(true),
      FIRST_FACTS_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, []);

  const sessionsFailed = sessionsQuery.isError && !sessionsQuery.data;
  const sessionsById = useMemo(
    () =>
      new Map(
        (sessionsQuery.data ?? []).map((session) => [
          session.threadId,
          session,
        ]),
      ),
    [sessionsQuery.data],
  );
  const sessionsKnown = sessionsQuery.data !== undefined;
  const facts = factsQuery.data;
  const factsFailed = factsQuery.isError;
  const factsSettled = facts !== undefined || factsFailed;

  const derivations = useMemo(() => {
    const byId = new Map<string, TaskLaneDerivation>();
    for (const task of tasks) {
      const sessionId = task.sessionId?.trim();
      let session: TaskLaneInput['session'];
      if (sessionId) {
        // A run the list does not hold, or a list that failed, is unread:
        // never treated as a run that ended.
        session =
          sessionsKnown && !sessionsFailed
            ? currentExecution(sessionsById, sessionId)
            : 'unreadable';
      }
      let pullRequests: TaskLaneInput['pullRequests'];
      if (facts) {
        const entry = facts.tasks[task.id];
        // An entry for an earlier Task with this id is not this Task's; a
        // Task created after the read has no entry yet. Both stay unread.
        pullRequests =
          entry && entry.taskCreatedAt === task.createdAt
            ? entry.pullRequests
            : undefined;
      } else if (factsFailed) {
        pullRequests = 'unavailable';
      }
      byId.set(task.id, deriveTaskLane({ task, session, pullRequests }));
    }
    return byId;
  }, [tasks, sessionsById, sessionsKnown, sessionsFailed, facts, factsFailed]);

  // Stable order: the previous partition's order, per lane, is the input to
  // the next, so live data moves a card only when it changes lanes.
  const previousOrder = useRef<ReadonlyMap<TaskLaneId, readonly string[]>>(
    new Map(),
  );
  const partition = useMemo(
    () => partitionTaskLanes([...derivations.values()], previousOrder.current),
    [derivations],
  );
  useEffect(() => {
    previousOrder.current = new Map(
      partition.lanes.map((lane) => [lane.id, lane.taskIds]),
    );
  }, [partition]);

  const ready =
    tasksSettled &&
    (sessionsKnown || sessionsQuery.isError) &&
    (factsSettled || waitedForFacts);
  return {
    status: ready ? 'ready' : 'loading',
    derivations,
    partition,
    sessionsById,
    sessions: {
      failed: sessionsQuery.isError,
      refetch: () => void sessionsQuery.refetch(),
    },
    pullRequests: {
      checking: !factsSettled,
      failed: factsFailed,
      ...(facts?.observedAt ? { asOf: facts.observedAt } : {}),
      refetch: () => void factsQuery.refetch(),
    },
  };
}

/**
 * The run a Task's session stands for now. `TaskRecord.sessionId` names the
 * first execution of the Task's conversation; a continued conversation
 * (after a failure, a restart, a follow-up) runs in a later execution child,
 * which every summary of that conversation names as `currentSessionId`. The
 * Task's state is that child's, never the first one's stale outcome. A named
 * current child the list does not hold is unread. Without `currentSessionId`
 * (an older host), the named session is the run.
 */
function currentExecution(
  sessionsById: ReadonlyMap<string, OrchestrationSessionSummary>,
  sessionId: string,
): OrchestrationSessionSummary | 'unreadable' {
  const named = sessionsById.get(sessionId);
  if (!named) return 'unreadable';
  const current = named.currentSessionId?.trim();
  if (!current || current === sessionId) return named;
  return sessionsById.get(current) ?? 'unreadable';
}
