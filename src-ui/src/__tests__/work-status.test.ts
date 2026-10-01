import type {
  OrchestrationSessionSummary,
  TaskRecord,
} from '@kontourai/station-sdk';
import { describe, expect, it } from 'vitest';
import { createDefaultChatState } from '../contexts/active-chats-state';
import { partitionHomeWorkItems } from '../views/home/home-lane-model';
import {
  buildActiveChatTaskItems,
  buildHomeWorkItems,
  buildOrchestrationItems,
  type HomeWorkItem,
} from '../views/home/home-view-model';
import {
  formatElapsed,
  type WorkLane,
  workStatus,
} from '../views/home/work-status';

/**
 * #3042: one status line per row, chosen by one ladder, and the lane read
 * off the same call.
 *
 * The session fixtures below are the REAL server folds, captured by driving
 * `projectSessionLifecycle` and `ConversationTurnActivityProjection` over an
 * event store with the named event sequences. They are literal on purpose:
 * a fixture derived from the ladder's own constants would prove nothing.
 */

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const TURN_STARTED = '2026-09-30T10:00:03.000Z'; // 1m 12s before NOW

function session(
  over: Partial<OrchestrationSessionSummary>,
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId: 'T',
    status: 'running',
    createdAt: '2026-09-30T10:00:01.000Z',
    updatedAt: '2026-09-30T10:00:02.000Z',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 3,
    ...over,
  };
}

/** turn.started, tool.started(Bash). */
const RUNNING_TOOL = session({
  lifecycleState: 'running',
  previousLifecycleState: 'running',
  transitionReason: 'turn_started',
  transitionSource: 'runtime',
  pendingReview: false,
  hasActiveTurn: true,
  conversationActivity: {
    conversationId: 'T',
    currentThreadId: 'T',
    asOfSequence: 2,
    openTurn: { turnId: 't1', threadId: 'T', startedAt: TURN_STARTED },
    runningTools: [
      { name: 'Bash', callId: 'c1', startedAt: '2026-09-30T10:00:04.000Z' },
    ],
    lastActivityAt: '2026-09-30T10:00:04.000Z',
  },
});

/** turn.started, tool.started(Bash), request.opened(approval). The turn is
 *  STILL OPEN: an approval pauses a turn, it does not close it. */
const APPROVAL_IN_OPEN_TURN = session({
  lifecycleState: 'review_pending',
  previousLifecycleState: 'running',
  transitionReason: 'review_requested',
  transitionSource: 'runtime',
  pendingReview: true,
  hasActiveTurn: true,
  conversationActivity: {
    conversationId: 'T',
    currentThreadId: 'T',
    asOfSequence: 3,
    openTurn: { turnId: 't1', threadId: 'T', startedAt: TURN_STARTED },
    runningTools: [
      { name: 'Bash', callId: 'c1', startedAt: '2026-09-30T10:00:04.000Z' },
    ],
    lastActivityAt: '2026-09-30T10:00:05.000Z',
  },
});

/** turn.started, request.opened(input). */
const QUESTION_IN_OPEN_TURN = session({
  lifecycleState: 'needs_input',
  previousLifecycleState: 'running',
  transitionReason: 'input_requested',
  transitionSource: 'runtime',
  pendingReview: false,
  hasActiveTurn: true,
  conversationActivity: {
    conversationId: 'T',
    currentThreadId: 'T',
    asOfSequence: 2,
    openTurn: { turnId: 't1', threadId: 'T', startedAt: TURN_STARTED },
    lastActivityAt: '2026-09-30T10:00:04.000Z',
  },
});

/** turn.started, turn.aborted, then interrupted-turn recovery's stamp. */
const INTERRUPTED = session({
  lifecycleState: 'needs_input',
  previousLifecycleState: 'needs_input',
  transitionReason: 'runtime_exit',
  transitionSource: 'system_recovery',
  pendingReview: false,
  hasActiveTurn: false,
  conversationActivity: {
    conversationId: 'T',
    currentThreadId: 'T',
    asOfSequence: 3,
    lastActivityAt: '2026-09-30T10:00:05.000Z',
  },
});

/** A manual transition to blocked. `blockedReason` is raw text and must not
 *  reach the row. */
const BLOCKED = session({
  lifecycleState: 'blocked',
  previousLifecycleState: 'blocked',
  transitionReason: 'blocked_by_user',
  transitionSource: 'user_action',
  pendingReview: false,
  blockedReason: 'raw adapter text',
  hasActiveTurn: false,
  conversationActivity: {
    conversationId: 'T',
    currentThreadId: 'T',
    asOfSequence: 1,
    lastActivityAt: '2026-09-30T10:00:03.000Z',
  },
});

/** turn.started, turn.completed: a finished turn on a live session. */
const TURN_COMPLETED = session({
  lifecycleState: 'idle',
  previousLifecycleState: 'running',
  transitionReason: 'turn_completed',
  transitionSource: 'runtime',
  pendingReview: false,
  hasActiveTurn: false,
  conversationActivity: {
    conversationId: 'T',
    currentThreadId: 'T',
    asOfSequence: 2,
    lastActivityAt: '2026-09-30T10:00:04.000Z',
  },
});

function rowFor(summary: OrchestrationSessionSummary): HomeWorkItem {
  const [item] = buildOrchestrationItems([summary], []);
  return item;
}

function statusOf(summary: OrchestrationSessionSummary) {
  const { line, lane, rung } = workStatus(rowFor(summary), NOW);
  return { line, lane, rung };
}

describe('the status ladder, from real server summaries', () => {
  it('a running row with a pending approval reads as needs-approval, never as running', () => {
    const item = rowFor(APPROVAL_IN_OPEN_TURN);
    // Both facts are on the item: the turn really is still open.
    expect(item.activity).toEqual({
      turnStartedAt: TURN_STARTED,
      toolName: 'Bash',
    });
    expect(item.attention).toBe('approval');
    expect(workStatus(item, NOW)).toMatchObject({
      rung: 'approval',
      lane: 'needsYou',
      line: 'Needs approval',
    });
  });

  it('a running row with an open question reads as needs-your-answer', () => {
    expect(statusOf(QUESTION_IN_OPEN_TURN)).toEqual({
      rung: 'answer',
      lane: 'needsYou',
      line: 'Needs your answer',
    });
  });

  it('a running turn names its current tool and how long the turn has run', () => {
    expect(statusOf(RUNNING_TOOL)).toEqual({
      rung: 'running',
      lane: 'running',
      line: 'Running · Bash · 1m 12s',
    });
  });

  it('counts reported child work ahead of the tool line', () => {
    expect(
      statusOf({
        ...RUNNING_TOOL,
        conversationActivity: {
          ...RUNNING_TOOL.conversationActivity!,
          runningChildWork: { count: 3, producers: ['engine-subagent'] },
        },
      }),
    ).toEqual({
      rung: 'childWork',
      lane: 'running',
      line: '3 sub-agents running · 1m 12s',
    });
  });

  it('child work outliving its turn still reads as running, with no turn clock', () => {
    expect(
      statusOf({
        ...TURN_COMPLETED,
        lifecycleState: 'completed',
        conversationActivity: {
          ...TURN_COMPLETED.conversationActivity!,
          runningChildWork: { count: 1, producers: ['engine-subagent'] },
        },
      }),
    ).toEqual({
      rung: 'childWork',
      lane: 'running',
      line: '1 sub-agent running',
    });
  });

  it('reports the watchdog silence marker instead of the tool', () => {
    expect(
      statusOf({
        ...RUNNING_TOOL,
        turnProgress: {
          lastProgressEventAt: '2026-09-30T09:55:15.000Z',
          progressSilence: {
            detectedAt: '2026-09-30T10:00:15.000Z',
            windowMs: 300_000,
            silentSinceEventAt: '2026-09-30T09:55:15.000Z',
            provider: 'claude',
          },
        },
      }).line,
    ).toBe('Running · no progress for 6m · 1m 12s');
  });

  it('an interrupted turn waits on you and says so', () => {
    expect(statusOf(INTERRUPTED)).toEqual({
      rung: 'interrupted',
      lane: 'needsYou',
      line: 'Interrupted',
    });
  });

  it('a blocked session says Blocked and never prints its raw reason', () => {
    const status = statusOf(BLOCKED);
    expect(status).toEqual({
      rung: 'blocked',
      lane: 'needsYou',
      line: 'Blocked',
    });
    expect(status.line).not.toContain('raw adapter text');
  });

  it('a request nothing here can answer is idle, with its basis, even mid-turn', () => {
    const answerability = {
      answerable: false,
      qualification: 'past_resume',
      observedBy: 'station-a',
      observedAt: '2026-09-30T10:00:10.000Z',
    } as OrchestrationSessionSummary['answerability'];
    const item = rowFor({ ...APPROVAL_IN_OPEN_TURN, answerability });
    const status = workStatus(item, NOW);
    expect(status.rung).toBe('unanswerable');
    expect(status.lane).toBe('idle');
    expect(status.line).toBe(`Can't answer here · ${item.unanswerableNotice}`);
    expect(item.unanswerableNotice).toMatch(/observed by station-a/);
  });

  it('a failed session carries its recorded reason', () => {
    expect(
      statusOf({
        ...TURN_COMPLETED,
        lifecycleState: 'failed',
        terminalAttribution: { kind: 'runtime_error', detail: 'rate limit' },
      }),
    ).toEqual({
      rung: 'failed',
      lane: 'finished',
      line: 'Failed · rate limit',
    });
  });

  it('a finished turn is Done', () => {
    expect(statusOf(TURN_COMPLETED)).toEqual({
      rung: 'done',
      lane: 'finished',
      line: 'Done',
    });
  });

  it('carries the branch only for a session with its own worktree', () => {
    expect(rowFor(RUNNING_TOOL).worktreeBranch).toBeUndefined();
    expect(
      rowFor({ ...RUNNING_TOOL, workspaceIsolation: { mode: 'shared' } })
        .worktreeBranch,
    ).toBeUndefined();
    expect(
      rowFor({
        ...RUNNING_TOOL,
        workspaceIsolation: {
          mode: 'worktree',
          repoPath: '/repo',
          path: '/repo-worktrees/a',
          branch: 'station/inbox-row',
          baseRef: 'main',
          cleanupPolicy: 'cleanup',
          preserveOnFailure: true,
          createdAt: '2026-09-30T10:00:00.000Z',
        },
      }).worktreeBranch,
    ).toBe('station/inbox-row');
  });

  it('a retired execution child does not borrow the conversation’s open turn', () => {
    // The summary of a child that is no longer current still carries the
    // conversation's record; only the current child owns its open turn.
    const retired = rowFor({
      ...TURN_COMPLETED,
      threadId: 'retired',
      lifecycleState: 'running',
      conversationActivity: RUNNING_TOOL.conversationActivity,
    });
    expect(retired.activity).toBeUndefined();
    expect(workStatus(retired, NOW).lane).toBe('idle');
  });
});

/**
 * The literal table (#3042 acceptance): each state, written out as the facts
 * a row carries, pinned to its line and lane. `partitionHomeWorkItems` is
 * asserted against the same row, so a lane that stopped coming from the
 * ladder fails here.
 */
function item(over: Partial<HomeWorkItem>): HomeWorkItem {
  return {
    id: 'a',
    kind: 'orchestration',
    kindLabel: 'Session',
    title: 'Row',
    projectLabel: 'station',
    agentLabel: 'Claude Code',
    modelLabel: 'Opus',
    updatedAt: NOW - 25 * 60_000,
    lifecycleLabel: 'Ready',
    ...over,
  };
}

const ACTIVITY = { turnStartedAt: TURN_STARTED, toolName: 'Bash' };

const TABLE: ReadonlyArray<
  [name: string, facts: Partial<HomeWorkItem>, line: string, lane: WorkLane]
> = [
  [
    'needs approval',
    { lifecycleLabel: 'Needs attention', attention: 'approval' },
    'Needs approval',
    'needsYou',
  ],
  [
    'needs approval while its turn is open',
    {
      lifecycleLabel: 'Needs attention',
      attention: 'approval',
      activity: ACTIVITY,
    },
    'Needs approval',
    'needsYou',
  ],
  [
    'needs your answer',
    { lifecycleLabel: 'Needs attention', attention: 'answer' },
    'Needs your answer',
    'needsYou',
  ],
  [
    'waiting on you',
    { lifecycleLabel: 'Needs attention', attention: 'waiting' },
    'Waiting on you',
    'needsYou',
  ],
  [
    'needs attention with no recorded kind',
    { lifecycleLabel: 'Needs attention' },
    'Waiting on you',
    'needsYou',
  ],
  [
    'queued while offline',
    { lifecycleLabel: 'Needs attention', attention: 'queued' },
    'Queued to send',
    'needsYou',
  ],
  [
    'blocked',
    { lifecycleLabel: 'Needs attention', attention: 'blocked' },
    'Blocked',
    'needsYou',
  ],
  [
    'interrupted',
    { lifecycleLabel: 'Needs attention', attention: 'interrupted' },
    'Interrupted',
    'needsYou',
  ],
  [
    'failed with a reason',
    { lifecycleLabel: 'Failed', failureNotice: 'rate limit exceeded' },
    'Failed · rate limit exceeded',
    'finished',
  ],
  ['failed with none', { lifecycleLabel: 'Failed' }, 'Failed', 'finished'],
  ['stopped', { lifecycleLabel: 'Stopped' }, 'Stopped', 'finished'],
  [
    "can't answer here",
    { lifecycleLabel: 'Unanswerable', unanswerableNotice: 'Observed by a.' },
    "Can't answer here · Observed by a.",
    'idle',
  ],
  [
    'sub-agents running',
    {
      lifecycleLabel: 'Running',
      activity: { ...ACTIVITY, childWorkCount: 2 },
    },
    '2 sub-agents running · 1m 12s',
    'running',
  ],
  [
    'running a tool',
    { lifecycleLabel: 'Running', activeReason: 'turn', activity: ACTIVITY },
    'Running · Bash · 1m 12s',
    'running',
  ],
  [
    'running with no server record',
    { lifecycleLabel: 'Running', activeReason: 'turn' },
    'Running',
    'running',
  ],
  [
    'background work with no count',
    { lifecycleLabel: 'Running', activeReason: 'background' },
    'Background work running',
    'running',
  ],
  ['idle', { lifecycleLabel: 'Ready' }, 'Idle · last activity 25m ago', 'idle'],
  [
    'idle, changed since it was opened',
    {
      lifecycleLabel: 'Recent',
      conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
      acknowledgedAt: Date.parse('2026-09-30T09:00:00.000Z'),
    },
    'Idle · new activity 25m ago',
    'idle',
  ],
  [
    'idle with no recorded time',
    { lifecycleLabel: 'Current', updatedAt: 0 },
    'Idle',
    'idle',
  ],
  ['draft', { lifecycleLabel: 'Draft' }, 'Draft · nothing sent yet', 'drafts'],
  [
    'done and opened',
    {
      lifecycleLabel: 'Completed',
      conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
      acknowledgedAt: Date.parse('2026-09-30T09:36:15.000Z'),
    },
    'Done',
    'finished',
  ],
  [
    'done, not opened',
    {
      lifecycleLabel: 'Completed',
      conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
    },
    'Done · not opened yet',
    'finished',
  ],
  [
    'followed from another app',
    { lifecycleLabel: 'Running', controlMode: 'read-only-attached' },
    'Started in Claude Code',
    'external',
  ],
];

/** The partition's bucket for each ladder lane, written out independently. */
function bucketOf(row: HomeWorkItem): string {
  const partition = partitionHomeWorkItems({
    items: [row],
    now: NOW,
    snoozedUntil: new Map(),
    terminalSince: new Map(),
  });
  return Object.entries(partition)
    .filter(([, rows]) => (rows as HomeWorkItem[]).includes(row))
    .map(([name]) => name)
    .join(',');
}

const BUCKETS: Record<WorkLane, readonly string[]> = {
  needsYou: ['needsYou'],
  running: ['running'],
  idle: ['idle'],
  drafts: ['drafts'],
  external: ['external'],
  finished: ['recentlyFinished', 'settled'],
};

describe('the status ladder, state by state', () => {
  it.each(TABLE)('%s', (_name, facts, line, lane) => {
    const row = item(facts);
    const status = workStatus(row, NOW);
    expect(status.line).toBe(line);
    expect(status.lane).toBe(lane);
    expect(BUCKETS[lane]).toContain(bucketOf(row));
  });

  it('marks unread only when the conversation changed after it was opened', () => {
    const unread = (over: Partial<HomeWorkItem>) =>
      workStatus(item(over), NOW).unread;
    expect(unread({})).toBe(false);
    expect(
      unread({
        conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
        acknowledgedAt: Date.parse('2026-09-30T09:36:15.000Z'),
      }),
    ).toBe(false);
    expect(
      unread({
        conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
        acknowledgedAt: Date.parse('2026-09-30T09:36:14.000Z'),
      }),
    ).toBe(true);
    expect(unread({ conversationUpdatedAt: '2026-09-30T09:36:15.000Z' })).toBe(
      true,
    );
  });

  it('formats a duration so it reads the same while it ticks', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_900)).toBe('42s');
    expect(formatElapsed(72_000)).toBe('1m 12s');
    expect(formatElapsed(3_840_000)).toBe('1h 04m');
    expect(formatElapsed(-5)).toBe('0s');
  });
});

describe('status facts on chat and task rows', () => {
  const chat = (over: Record<string, unknown>) =>
    buildActiveChatTaskItems({
      chats: {
        'chat-1': {
          ...createDefaultChatState(),
          title: 'Chat',
          createdAt: NOW - 60_000,
          ...over,
        },
      },
      agents: [],
    })[0];

  it('a chat holding a pending approval reads as needs-approval', () => {
    const row = chat({ pendingApprovals: ['r1'], status: 'sending' });
    expect(row.attention).toBe('approval');
    expect(workStatus(row, NOW).line).toBe('Needs approval');
  });

  it('a send queued while offline reads as queued, under Needs you', () => {
    const row = chat({ status: 'queued' });
    expect(workStatus(row, NOW)).toMatchObject({
      line: 'Queued to send',
      lane: 'needsYou',
    });
  });

  it('a blocked durable Task reads as blocked', () => {
    const [row] = buildHomeWorkItems({
      chats: {},
      sessions: [],
      agents: [],
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'blocked',
          updatedAt: '2026-09-30T10:00:00.000Z',
        } as TaskRecord,
      ],
    });
    expect(workStatus(row, NOW).line).toBe('Blocked');
  });

  it('a merged chat+session row keeps the more urgent kind, bound to the label that won', () => {
    const mergedWith = (
      chatOver: Record<string, unknown>,
      summary: OrchestrationSessionSummary,
    ) =>
      buildHomeWorkItems({
        chats: {
          c1: {
            ...createDefaultChatState(),
            conversationId: 'c1',
            title: 'Chat',
            createdAt: NOW - 60_000,
            ...chatOver,
          },
        },
        sessions: [{ ...summary, threadId: 'c1', conversationId: 'c1' }],
        agents: [],
      })[0];

    // The chat only knows "waiting"; the session knows it is an approval.
    expect(
      mergedWith(
        { orchestrationStatus: 'awaiting-approval' },
        APPROVAL_IN_OPEN_TURN,
      ),
    ).toMatchObject({
      lifecycleLabel: 'Needs attention',
      attention: 'approval',
    });
    // The chat holds the approval first-hand; the session summary is stale.
    expect(
      mergedWith({ pendingApprovals: ['r1'] }, TURN_COMPLETED),
    ).toMatchObject({
      lifecycleLabel: 'Needs attention',
      attention: 'approval',
    });
    // Nothing is owed: no kind survives a label that is not Needs attention.
    const settled = mergedWith({}, TURN_COMPLETED);
    expect(settled.lifecycleLabel).not.toBe('Needs attention');
    expect(settled.attention).toBeUndefined();
    expect(settled.activity).toBeUndefined();
  });
});
