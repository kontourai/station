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
import type { AgentSummary } from '../../types';
import {
  type TaskStatusPresentation,
  taskStatusPresentation,
} from './taskStatusPresentation';

/** How long the board waits for its first pull request facts. */
const FIRST_FACTS_WAIT_MS = 2_000;

export interface TaskBoardModel {
  /** `loading` until Tasks and runs have answered (and briefly, facts). */
  status: 'loading' | 'ready';
  derivations: ReadonlyMap<string, TaskLaneDerivation>;
  /** Each Task's one status, as both the board and the list print it. */
  presentations: ReadonlyMap<string, TaskStatusPresentation>;
  partition: TaskLanePartition;
  sessionsById: ReadonlyMap<string, OrchestrationSessionSummary>;
  sessions: {
    failed: boolean;
    fetching: boolean;
    refetch: ReturnType<typeof useOrchestrationSessionsQuery>['refetch'];
  };
  pullRequests: {
    /** The first read has not answered yet. */
    checking: boolean;
    /**
     * The board's facts have answered (or are not read here), so a card's
     * lane now reflects them: order and arrival announcements start from
     * here, and the facts' own arrival is not a card arriving anywhere.
     */
    settled: boolean;
    /** The last read failed; `asOf` is when the facts shown were read. */
    failed: boolean;
    asOf?: string;
    refetch(): void;
  };
}

/**
 * The Project Tasks board's one read model: each Task joined to its run (by
 * `TaskRecord.sessionId`, followed to the execution its conversation has
 * moved on to, see {@link currentExecution}) and its pull request facts,
 * derived into lanes by the contract's `deriveTaskLane`. Nothing here decides
 * a lane; it only says which facts were and were not read.
 *
 * `readPullRequests` is the board's: the list does not read the forge, so its
 * rows claim nothing about pull requests unless facts are already cached.
 */
export function useTaskBoardModel({
  projectSlug,
  tasks,
  tasksSettled,
  agents,
  readPullRequests,
}: {
  projectSlug: string;
  tasks: readonly TaskListRecord[];
  tasksSettled: boolean;
  agents: AgentSummary[];
  readPullRequests: boolean;
}): TaskBoardModel {
  const sessionsQuery = useOrchestrationSessionsQuery();
  const factsQuery = useTaskPullRequestFactsQuery(projectSlug, {
    enabled: tasksSettled && readPullRequests,
  });
  // The short wait for first facts starts when the board is first shown,
  // not when the section mounts: opening the list and then the board still
  // waits, rather than flashing cards that move once the facts land.
  const [waitedForFacts, setWaitedForFacts] = useState(false);
  useEffect(() => {
    if (!readPullRequests || waitedForFacts) return;
    const timer = setTimeout(
      () => setWaitedForFacts(true),
      FIRST_FACTS_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [readPullRequests, waitedForFacts]);

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
  const factsSettled = !readPullRequests || facts !== undefined || factsFailed;

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
    // Until the facts answer, every partition seeds afresh: their arrival
    // moves cards into PR lanes, and none of them is "new" there.
    if (!factsSettled) return;
    previousOrder.current = new Map(
      partition.lanes.map((lane) => [lane.id, lane.taskIds]),
    );
  }, [partition, factsSettled]);

  const now = Date.now();
  // `now` only feeds a duration the presentation does not print.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  const presentations = useMemo(() => {
    const byId = new Map<string, TaskStatusPresentation>();
    for (const [taskId, derivation] of derivations) {
      const runId = derivation.evidence.sessionId;
      byId.set(
        taskId,
        taskStatusPresentation(
          derivation,
          runId ? sessionsById.get(runId) : undefined,
          agents,
          now,
        ),
      );
    }
    return byId;
  }, [derivations, sessionsById, agents]);

  const ready =
    tasksSettled &&
    (sessionsKnown || sessionsQuery.isError) &&
    (factsSettled || waitedForFacts);
  return {
    status: ready ? 'ready' : 'loading',
    derivations,
    presentations,
    partition,
    sessionsById,
    sessions: {
      failed: sessionsQuery.isError,
      fetching: sessionsQuery.isFetching,
      refetch: sessionsQuery.refetch,
    },
    pullRequests: {
      checking: !factsSettled,
      settled: factsSettled,
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
export function currentExecution(
  sessionsById: ReadonlyMap<string, OrchestrationSessionSummary>,
  sessionId: string,
): OrchestrationSessionSummary | 'unreadable' {
  const named = sessionsById.get(sessionId);
  if (!named) return 'unreadable';
  const current = named.currentSessionId?.trim();
  if (!current || current === sessionId) return named;
  return sessionsById.get(current) ?? 'unreadable';
}
