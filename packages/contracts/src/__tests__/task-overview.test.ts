import { describe, expect, test } from 'vitest';
import type { OrchestrationSessionSummary } from '../orchestration.js';
import type { TaskRecord } from '../task-graph.js';
import {
  deriveTaskLane,
  type TaskLaneInput,
  type TaskPullRequestFact,
} from '../task-lane.js';
import {
  deriveTaskOverviewPlacement,
  partitionTaskOverview,
  TASK_OVERVIEW_AUTO_RESOLVE_DEFAULT_DAYS,
  TASK_OVERVIEW_GROUP_LABELS,
  taskOverviewAutoResolveDays,
} from '../task-overview.js';

const DAY = 86_400_000;
const UPDATED = '2026-11-10T00:00:00.000Z';
const NOW = Date.parse('2026-11-11T00:00:00.000Z');

function task(
  overrides: Partial<TaskRecord> = {},
): TaskRecord & { latestReport?: { text: string; at: string } } {
  return {
    id: 'task-a',
    projectId: 'demo',
    title: 'Work',
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'user',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: UPDATED,
    agentId: 'claude',
    sessionId: 'run-a',
    ...overrides,
  };
}

function session(
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    threadId: 'run-a',
    provider: 'claude',
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 4,
    createdAt: UPDATED,
    updatedAt: UPDATED,
    ...overrides,
  };
}

function pr(
  status: Partial<
    Extract<TaskPullRequestFact['status'], { state: 'current' }>
  > = {},
): TaskPullRequestFact {
  return {
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'acme', name: 'app' },
    ref: '7',
    url: 'https://github.com/acme/app/pull/7',
    observedAt: UPDATED,
    status: {
      state: 'current',
      pullRequestState: 'OPEN',
      mergeability: 'mergeable',
      ...status,
    },
  };
}

const CLEAN = { readiness: 'clean' as const };

function place(
  input: Partial<TaskLaneInput> & {
    task?: ReturnType<typeof task>;
    now?: number;
    days?: number;
  },
) {
  const named = input.task ?? task();
  const derivation = deriveTaskLane({
    task: named,
    session: 'session' in input ? input.session : session(),
    pullRequests: 'pullRequests' in input ? input.pullRequests : [],
  });
  return deriveTaskOverviewPlacement({
    task: named,
    derivation,
    autoResolveDays: input.days ?? TASK_OVERVIEW_AUTO_RESOLVE_DEFAULT_DAYS,
    now: input.now ?? NOW,
  });
}

describe('deriveTaskOverviewPlacement', () => {
  test.each([
    [
      'needs approval',
      {
        session: session({
          lifecycleState: 'review_pending',
          pendingReview: true,
        }),
      },
      'waiting_on_you',
    ],
    [
      'needs input',
      {
        session: session({
          lifecycleState: 'needs_input',
          transitionReason: 'input_requested',
        }),
      },
      'waiting_on_you',
    ],
    [
      'failed',
      { session: session({ lifecycleState: 'failed' }) },
      'waiting_on_you',
    ],
    [
      'marked blocked',
      { task: task({ status: 'blocked' }), pullRequests: [pr(CLEAN)] },
      'waiting_on_you',
    ],
    [
      'running',
      { session: session({ lifecycleState: 'running', hasActiveTurn: true }) },
      'working',
    ],
    [
      'PR awaiting review',
      {
        pullRequests: [
          pr({ readiness: 'blocked', reviewDecision: 'review_required' }),
        ],
      },
      'ready_for_review',
    ],
    [
      'changes requested',
      { pullRequests: [pr({ reviewDecision: 'changes_requested' })] },
      'ready_for_review',
    ],
    [
      'marked for review',
      { task: task({ status: 'review' }) },
      'ready_for_review',
    ],
    [
      'auto-merge armed',
      { pullRequests: [pr({ ...CLEAN, landing: 'auto-merge' })] },
      'landing',
    ],
    [
      'in merge queue',
      { pullRequests: [pr({ ...CLEAN, landing: 'merge-queue' })] },
      'landing',
    ],
    [
      'approved, checks running',
      {
        pullRequests: [
          pr({ readiness: 'checks-not-passing', reviewDecision: 'approved' }),
        ],
      },
      'landing',
    ],
    ['finished, nothing pending', {}, 'idle'],
    [
      'every PR merged',
      { pullRequests: [pr({ pullRequestState: 'MERGED' })] },
      'resolved',
    ],
    ['done', { task: task({ status: 'done' }) }, 'resolved'],
    ['canceled', { task: task({ status: 'canceled' }) }, 'resolved'],
    [
      'backlog',
      {
        task: task({ status: 'todo', sessionId: undefined }),
        session: undefined,
      },
      undefined,
    ],
  ] as const)('%s → %s', (_name, input, group) => {
    expect(place(input as Parameters<typeof place>[0]).group).toBe(group);
  });

  test('a PR moved to the merge queue moves its Task to Landing, and merging moves it to Resolved', () => {
    const ready = place({
      pullRequests: [pr({ ...CLEAN, landing: 'not-queued' })],
    });
    const queued = place({
      pullRequests: [pr({ ...CLEAN, landing: 'merge-queue' })],
    });
    const merged = place({
      pullRequests: [pr({ pullRequestState: 'MERGED' })],
    });
    expect([ready.group, queued.group, merged.group]).toEqual([
      'ready_for_review',
      'landing',
      'resolved',
    ]);
    expect(queued.word).toBe('In merge queue');
  });

  test('a green PR nobody armed is Ready for review with a "not queued" note', () => {
    const placement = place({
      pullRequests: [pr({ ...CLEAN, landing: 'not-queued' })],
    });
    expect(placement.group).toBe('ready_for_review');
    expect(placement.note).toBe('not-queued');
  });

  test('a green PR whose landing was not observed claims no note and is not Landing', () => {
    const placement = place({ pullRequests: [pr(CLEAN)] });
    expect(placement.group).toBe('ready_for_review');
    expect(placement.note).toBeUndefined();
  });

  test('approved and clean but unarmed is the stall, not Landing', () => {
    const placement = place({
      pullRequests: [
        pr({ ...CLEAN, reviewDecision: 'approved', landing: 'not-queued' }),
      ],
    });
    expect(placement.group).toBe('ready_for_review');
    expect(placement.note).toBe('not-queued');
  });

  test('an unread PR beside a queued one is not Landing', () => {
    const unread: TaskPullRequestFact = {
      ...pr(),
      ref: '8',
      status: { state: 'unavailable', reason: 'Timed out.' },
    };
    const placement = place({
      pullRequests: [pr({ ...CLEAN, landing: 'merge-queue' }), unread],
    });
    expect(placement.group).not.toBe('landing');
  });

  test('Waiting on you does not depend on pull request facts', () => {
    const asking = session({
      lifecycleState: 'needs_input',
      transitionReason: 'input_requested',
    });
    expect(place({ session: asking, pullRequests: undefined }).group).toBe(
      'waiting_on_you',
    );
    expect(
      place({
        session: asking,
        pullRequests: [pr({ ...CLEAN, landing: 'merge-queue' })],
      }).group,
    ).toBe('waiting_on_you');
  });
});

describe('auto-resolve and reopen', () => {
  const lastActivity = Date.parse(UPDATED);

  test('an Idle Task resolves at the threshold, not before', () => {
    const before = place({ now: lastActivity + 7 * DAY - 1 });
    const at = place({ now: lastActivity + 7 * DAY });
    expect(before.group).toBe('idle');
    expect(at.group).toBe('resolved');
    expect(at.word).toBe('Auto-resolved');
    expect(at.autoResolved).toEqual({ idleSince: UPDATED });
  });

  test('the threshold is the Project setting, and 0 never resolves', () => {
    expect(place({ now: lastActivity + 2 * DAY, days: 1 }).group).toBe(
      'resolved',
    );
    expect(place({ now: lastActivity + 400 * DAY, days: 0 }).group).toBe(
      'idle',
    );
  });

  test('reopening restores the prior group and restarts the clock', () => {
    const now = lastActivity + 30 * DAY;
    expect(place({ now }).group).toBe('resolved');
    const reopened = task({
      overviewReopenedAt: new Date(now - 1000).toISOString(),
    });
    expect(place({ task: reopened, now }).group).toBe('idle');
    expect(place({ task: reopened, now: now + 7 * DAY }).group).toBe(
      'resolved',
    );
  });

  test('a newer latest report counts as activity', () => {
    const now = lastActivity + 8 * DAY;
    const reported = {
      ...task(),
      latestReport: {
        text: 'Shipped the fix',
        at: new Date(now - DAY).toISOString(),
      },
    };
    expect(place({ task: reported, now }).group).toBe('idle');
  });

  test('only Idle Tasks auto-resolve', () => {
    const now = lastActivity + 30 * DAY;
    expect(
      place({ now, pullRequests: [pr({ ...CLEAN, landing: 'not-queued' })] })
        .group,
    ).toBe('ready_for_review');
    expect(
      place({ now, session: session({ lifecycleState: 'failed' }) }).group,
    ).toBe('waiting_on_you');
  });
});

describe('partitionTaskOverview', () => {
  test('returns every group in reading order with the issue’s labels', () => {
    const groups = partitionTaskOverview([]);
    expect(groups.map((group) => group.label)).toEqual([
      'Waiting on you',
      'Ready for review',
      'Working',
      'Landing',
      'Idle',
      'Resolved',
    ]);
    expect(Object.values(TASK_OVERVIEW_GROUP_LABELS)).toHaveLength(6);
  });

  test('files each placement under its group, newest activity first', () => {
    const entries = ['a', 'b'].map((id, index) => ({
      placement: {
        taskId: id,
        group: 'idle' as const,
        word: 'Agent finished',
        lastActivityAt: `2026-11-0${index + 1}T00:00:00.000Z`,
      },
      derivation: {
        order: { priority: 'normal' as const, updatedAt: UPDATED },
      },
    }));
    const idle = partitionTaskOverview(entries).find(
      (group) => group.id === 'idle',
    );
    expect(idle?.taskIds).toEqual(['b', 'a']);
    expect(idle?.total).toBe(2);
  });
});

test('taskOverviewAutoResolveDays reads a stored value or the default', () => {
  expect(taskOverviewAutoResolveDays(undefined)).toBe(7);
  expect(taskOverviewAutoResolveDays(0)).toBe(0);
  expect(taskOverviewAutoResolveDays(14)).toBe(14);
  expect(taskOverviewAutoResolveDays(-1)).toBe(7);
  expect(taskOverviewAutoResolveDays(1.5)).toBe(7);
});
