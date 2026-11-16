import type { TaskRecord } from './task-graph.js';
import type {
  TaskLaneDerivation,
  TaskLaneRung,
  TaskPullRequestFact,
} from './task-lane.js';

/**
 * THE PROJECT OVERVIEW'S GROUPS (#5064): every Task filed under what it needs
 * next, named for the next action rather than for an internal status.
 *
 * A projection, never a store. A Task's group is read from its derived lane
 * (`deriveTaskLane`, which already joins the Task, its run and its kept pull
 * requests) plus two facts the lane does not carry: whether an open pull
 * request is armed or queued to merge, and how long the Task has been quiet.
 * The one persisted input is a person's reopen (`TaskRecord.overviewReopenedAt`),
 * which restarts the quiet clock.
 *
 * Two rules keep it honest, the lane's own:
 *
 * - "Waiting on you" reads only the run and the Task itself, never a pull
 *   request. Whatever needs a person is known without a forge read, so a
 *   surface that cannot afford one (the sidebar's dot) still agrees with the
 *   Overview about it.
 * - A fact that was not observed is never claimed. A pull request whose
 *   landing state was not read is never "Landing" by being queued, and never
 *   carries the "Not queued" note.
 */
export const TASK_OVERVIEW_GROUPS = [
  'waiting_on_you',
  'ready_for_review',
  'working',
  'landing',
  'idle',
  'resolved',
] as const;
export type TaskOverviewGroupId = (typeof TASK_OVERVIEW_GROUPS)[number];

export const TASK_OVERVIEW_GROUP_LABELS: Record<TaskOverviewGroupId, string> = {
  waiting_on_you: 'Waiting on you',
  ready_for_review: 'Ready for review',
  working: 'Working',
  landing: 'Landing',
  idle: 'Idle',
  resolved: 'Resolved',
};

/** An Idle Task with no activity for this many days is auto-resolved. */
export const TASK_OVERVIEW_AUTO_RESOLVE_DEFAULT_DAYS = 7;
/** The longest quiet period a Project may set. `0` turns it off. */
export const TASK_OVERVIEW_AUTO_RESOLVE_MAX_DAYS = 365;
/** The Resolved group lists this many of the most recently active Tasks. */
export const TASK_OVERVIEW_RESOLVED_LIMIT = 20;

const DAY_MS = 86_400_000;

/** A Project's stored quiet period, or the default when it sets none. */
export function taskOverviewAutoResolveDays(
  stored: number | undefined,
): number {
  return typeof stored === 'number' &&
    Number.isInteger(stored) &&
    stored >= 0 &&
    stored <= TASK_OVERVIEW_AUTO_RESOLVE_MAX_DAYS
    ? stored
    : TASK_OVERVIEW_AUTO_RESOLVE_DEFAULT_DAYS;
}

/** Rungs where the run or the Task itself waits on a person. */
const WAITING_RUNGS: ReadonlySet<TaskLaneRung> = new Set<TaskLaneRung>([
  'approval',
  'answer',
  'interrupted',
  'blocked',
  'waiting',
  'taskQuestion',
  'failed',
  'markedBlocked',
]);

/** Rungs whose open pull requests are where the Task stands. */
const OPEN_PULL_REQUEST_RUNGS: ReadonlySet<TaskLaneRung> =
  new Set<TaskLaneRung>([
    'changesRequested',
    'conflict',
    'checksNotPassing',
    'draft',
    'awaitingReview',
    'repoBlocked',
    'behind',
    'prOpen',
    'readyToMerge',
  ]);

export interface TaskOverviewInput {
  task: Pick<TaskRecord, 'id' | 'updatedAt' | 'overviewReopenedAt'> & {
    latestReport?: { at: string };
  };
  derivation: TaskLaneDerivation;
  /** The Project's quiet period in days; `0` never auto-resolves. */
  autoResolveDays: number;
  /** Epoch milliseconds. The only clock read is the caller's. */
  now: number;
}

export interface TaskOverviewPlacement {
  taskId: string;
  /** `undefined`: the Task is not on the Overview (Backlog). */
  group: TaskOverviewGroupId | undefined;
  /** The status word the row prints; the lane's unless the group refines it. */
  word: string;
  /**
   * `not-queued`: every open pull request is ready and at least one was read
   * as neither armed nor queued — the stall the Overview exists to show.
   */
  note?: 'not-queued';
  /** Present when the quiet period, not a person, resolved it. */
  autoResolved?: { idleSince: string };
  /** The latest instant anything happened on the Task, when known. */
  lastActivityAt?: string;
}

type CurrentFact = TaskPullRequestFact & {
  status: Extract<TaskPullRequestFact['status'], { state: 'current' }>;
};

const openFacts = (facts: readonly TaskPullRequestFact[]): CurrentFact[] =>
  facts.filter(
    (fact): fact is CurrentFact =>
      fact.status.state === 'current' &&
      fact.status.pullRequestState === 'OPEN',
  );

const isQueued = (fact: CurrentFact) =>
  fact.status.landing === 'auto-merge' || fact.status.landing === 'merge-queue';

/** Approved, with nothing left for a person: the forge is finishing it. */
const isApprovedInFlight = (fact: CurrentFact) =>
  fact.status.reviewDecision === 'approved' &&
  fact.status.draft !== true &&
  fact.status.mergeability !== 'conflicting' &&
  (fact.status.readiness === 'checks-not-passing' ||
    fact.status.readiness === 'blocked' ||
    fact.status.readiness === 'behind');

function latest(...stamps: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const stamp of stamps) {
    if (!stamp) continue;
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    best = stamp;
    bestMs = ms;
  }
  return best;
}

/**
 * One Task's Overview group. Pure; `now` is the caller's.
 *
 * | Group            | From                                                      |
 * | ---------------- | --------------------------------------------------------- |
 * | Waiting on you   | the run or Task needs input or approval, or failed        |
 * | Ready for review | an open PR or result awaits review, not armed or queued   |
 * | Working          | the run is moving                                         |
 * | Landing          | every open PR is armed or queued, or approved and waiting on checks |
 * | Idle             | finished its turn (or not started), nothing pending       |
 * | Resolved         | done, canceled, every PR merged, or Idle past the quiet period |
 */
export function deriveTaskOverviewPlacement(
  input: TaskOverviewInput,
): TaskOverviewPlacement {
  const { task, derivation } = input;
  const lastActivityAt = latest(
    task.updatedAt,
    task.overviewReopenedAt,
    derivation.factTime,
    task.latestReport?.at,
  );
  const base = {
    taskId: task.id,
    word: derivation.word,
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
  const { rung, placement } = derivation;

  if (placement.kind === 'shelf') {
    if (placement.shelf === 'backlog') return { ...base, group: undefined };
    return { ...base, group: 'resolved' };
  }
  if (WAITING_RUNGS.has(rung)) return { ...base, group: 'waiting_on_you' };
  if (rung === 'running') return { ...base, group: 'working' };
  if (rung === 'merged') return { ...base, group: 'resolved' };

  if (OPEN_PULL_REQUEST_RUNGS.has(rung)) {
    const open = openFacts(derivation.evidence.pullRequests);
    const unread = derivation.certainty !== 'observed';
    if (open.length && !unread) {
      if (open.every(isQueued))
        return {
          ...base,
          group: 'landing',
          word: open.some((fact) => fact.status.landing === 'merge-queue')
            ? 'In merge queue'
            : 'Auto-merge on',
        };
      if (
        rung !== 'changesRequested' &&
        rung !== 'conflict' &&
        open.every((fact) => isQueued(fact) || isApprovedInFlight(fact))
      )
        return { ...base, group: 'landing', word: 'Approved' };
    }
    const notQueued =
      rung === 'readyToMerge' &&
      open.some((fact) => fact.status.landing === 'not-queued');
    return {
      ...base,
      group: 'ready_for_review',
      ...(notQueued ? { note: 'not-queued' as const } : {}),
    };
  }
  if (placement.lane === 'in_review' || rung === 'markedReview')
    return { ...base, group: 'ready_for_review' };

  // Idle: finished, stopped, a draft, elsewhere, unread run, not started.
  if (input.autoResolveDays > 0 && lastActivityAt) {
    const quietFor = input.now - Date.parse(lastActivityAt);
    if (quietFor >= input.autoResolveDays * DAY_MS)
      return {
        ...base,
        group: 'resolved',
        word: 'Auto-resolved',
        autoResolved: { idleSince: lastActivityAt },
      };
  }
  return { ...base, group: 'idle' };
}

export interface TaskOverviewGroup {
  id: TaskOverviewGroupId;
  label: string;
  taskIds: string[];
  /** Every Task in the group, including those a limit leaves out. */
  total: number;
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/**
 * Every group in reading order, each newest activity first (urgent Tasks
 * first in the groups that ask something of a person). Empty groups are
 * returned too; a surface decides whether to print them. Resolved lists
 * the {@link TASK_OVERVIEW_RESOLVED_LIMIT} most recent.
 */
export function partitionTaskOverview(
  entries: readonly {
    placement: TaskOverviewPlacement;
    derivation: Pick<TaskLaneDerivation, 'order'>;
  }[],
): TaskOverviewGroup[] {
  const activity = (entry: (typeof entries)[number]) =>
    entry.placement.lastActivityAt ?? entry.derivation.order.updatedAt;
  return TASK_OVERVIEW_GROUPS.map((id) => {
    const members = entries
      .filter((entry) => entry.placement.group === id)
      .sort((a, b) => {
        const urgency =
          id === 'waiting_on_you' || id === 'ready_for_review'
            ? PRIORITY_RANK[a.derivation.order.priority] -
              PRIORITY_RANK[b.derivation.order.priority]
            : 0;
        return (
          urgency ||
          activity(b).localeCompare(activity(a)) ||
          a.placement.taskId.localeCompare(b.placement.taskId)
        );
      });
    const limited =
      id === 'resolved'
        ? members.slice(0, TASK_OVERVIEW_RESOLVED_LIMIT)
        : members;
    return {
      id,
      label: TASK_OVERVIEW_GROUP_LABELS[id],
      taskIds: limited.map((entry) => entry.placement.taskId),
      total: members.length,
    };
  });
}
