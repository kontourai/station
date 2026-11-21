import { deriveTaskLane } from '@kontourai/station-contracts/task-lane';
import {
  deriveTaskOverviewPlacement,
  partitionTaskOverview,
  type TaskOverviewGroup,
  type TaskOverviewPlacement,
} from '@kontourai/station-contracts/task-overview';
import type {
  OrchestrationSessionSummary,
  TaskListRecord,
} from '@kontourai/station-sdk';
import { currentExecution } from './useTaskBoardModel';

/**
 * The Project Overview's groups (#5064) from the Tasks board's own read
 * model: the same derivations (`useTaskBoardModel`), placed by the
 * contract's `deriveTaskOverviewPlacement`. Nothing here decides a group.
 */
export function projectOverviewGroups({
  tasks,
  derivations,
  autoResolveDays,
  now,
}: {
  tasks: readonly TaskListRecord[];
  derivations: ReadonlyMap<
    string,
    Parameters<typeof deriveTaskOverviewPlacement>[0]['derivation']
  >;
  autoResolveDays: number;
  now: number;
}): {
  groups: TaskOverviewGroup[];
  placements: ReadonlyMap<string, TaskOverviewPlacement>;
} {
  const placements = new Map<string, TaskOverviewPlacement>();
  const entries = [];
  for (const task of tasks) {
    const derivation = derivations.get(task.id);
    if (!derivation) continue;
    const placement = deriveTaskOverviewPlacement({
      task,
      derivation,
      autoResolveDays,
      now,
    });
    placements.set(task.id, placement);
    entries.push({ placement, derivation });
  }
  return { groups: partitionTaskOverview(entries), placements };
}

/**
 * How many Tasks in each Project are Waiting on you, for the sidebar's dot
 * and the Room header's. Pull requests are deliberately not read: the
 * contract places a Task in Waiting on you from its run and the Task alone,
 * so this agrees with the Overview without a forge read per Project. A run
 * the session list does not hold is unread, exactly as on the board.
 */
export function projectWaitingOnYouCounts({
  tasks,
  sessions,
  sessionsKnown,
}: {
  tasks: readonly TaskListRecord[];
  sessions: readonly OrchestrationSessionSummary[];
  sessionsKnown: boolean;
}): ReadonlyMap<string, number> {
  const sessionsById = new Map(
    sessions.map((session) => [session.threadId, session]),
  );
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const sessionId = task.sessionId?.trim();
    const derivation = deriveTaskLane({
      task,
      session: sessionId
        ? sessionsKnown
          ? currentExecution(sessionsById, sessionId)
          : 'unreadable'
        : undefined,
      pullRequests: undefined,
    });
    const { group } = deriveTaskOverviewPlacement({
      task,
      derivation,
      // Waiting on you never depends on the quiet period.
      autoResolveDays: 0,
      now: 0,
    });
    if (group === 'waiting_on_you')
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  }
  return counts;
}
