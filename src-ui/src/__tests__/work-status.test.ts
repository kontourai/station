import type {
  OrchestrationSessionSummary,
  TaskRecord,
} from '@kontourai/station-sdk';
import { describe, expect, it } from 'vitest';
import {
  type ChatUIState,
  createDefaultChatState,
} from '../contexts/active-chats-state';
import { partitionHomeWorkItems } from '../views/home/home-lane-model';
import {
  buildHomeWorkItems,
  buildOrchestrationItems,
  type HomeWorkItem,
} from '../views/home/home-view-model';
import { buildWorkFacts, type WorkFacts } from '../views/home/work-facts';
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

const SILENCE = {
  lastProgressEventAt: '2026-09-30T09:55:15.000Z',
  progressSilence: {
    detectedAt: '2026-09-30T10:00:15.000Z',
    windowMs: 300_000,
    silentSinceEventAt: '2026-09-30T09:55:15.000Z',
    provider: 'claude',
  },
} satisfies OrchestrationSessionSummary['turnProgress'];

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

/**
 * turn.started, request.opened(approval), then the process restarts:
 * recovery's turn.aborted and its `needs_input` stamp. Recovery does not
 * resolve the request the dead turn opened, so the lifecycle fold re-stamps
 * the session `review_pending` over the recovery stamp. Nothing can approve
 * it: no turn is open.
 */
const APPROVAL_OUTLIVED_ITS_INTERRUPTED_TURN = session({
  lifecycleState: 'review_pending',
  previousLifecycleState: 'needs_input',
  transitionReason: 'review_requested',
  transitionSource: 'runtime',
  pendingReview: true,
  hasActiveTurn: false,
  lastEventMethod: 'session.state-changed',
  conversationActivity: {
    conversationId: 'T',
    currentThreadId: 'T',
    asOfSequence: 4,
    lastActivityAt: '2026-09-30T10:00:06.000Z',
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

function rowFor(summary: OrchestrationSessionSummary): {
  item: HomeWorkItem;
  facts: WorkFacts | undefined;
} {
  const items = buildOrchestrationItems([summary], []);
  return {
    item: items[0],
    facts: buildWorkFacts({ items, sessions: [summary] }).get(items[0].id),
  };
}

function statusOf(summary: OrchestrationSessionSummary) {
  const { item, facts } = rowFor(summary);
  const { line, lane, rung } = workStatus(item, NOW, { facts });
  return { line, lane, rung };
}

describe('the status ladder, from real server summaries', () => {
  it('a running row with a pending approval reads as needs-approval, never as running', () => {
    // The turn really is still open on this summary; the shared attention
    // fold files it as awaiting anyway, and the row follows.
    expect(APPROVAL_IN_OPEN_TURN.hasActiveTurn).toBe(true);
    expect(statusOf(APPROVAL_IN_OPEN_TURN)).toEqual({
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

  it('an approval that outlived its interrupted turn reads Interrupted, not Needs approval', () => {
    expect(statusOf(APPROVAL_OUTLIVED_ITS_INTERRUPTED_TURN)).toEqual({
      rung: 'interrupted',
      lane: 'needsYou',
      line: 'Interrupted',
    });
  });

  it('keeps Needs approval for an approval between turns that nothing interrupted', () => {
    // Same state, but reached by a request (the last event), not by recovery.
    expect(
      statusOf({
        ...APPROVAL_OUTLIVED_ITS_INTERRUPTED_TURN,
        previousLifecycleState: 'idle',
        lastEventMethod: 'request.opened',
      }).line,
    ).toBe('Needs approval');
    expect(
      statusOf({
        ...APPROVAL_OUTLIVED_ITS_INTERRUPTED_TURN,
        lastEventMethod: 'request.opened',
      }).line,
    ).toBe('Needs approval');
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

  it('a run the watchdog marks silent is its own cautionary rung, still in Running', () => {
    const silent = rowFor({ ...RUNNING_TOOL, turnProgress: SILENCE });
    const status = workStatus(silent.item, NOW, { facts: silent.facts });
    expect(status).toMatchObject({
      rung: 'quiet',
      lane: 'running',
      tone: 'caution',
      line: 'No progress for 6m · Bash · 1m 12s',
    });
    // Never drawn as the healthy run it sits beside.
    const healthy = rowFor(RUNNING_TOOL);
    expect(
      workStatus(healthy.item, NOW, { facts: healthy.facts }),
    ).toMatchObject({ rung: 'running', tone: 'active' });
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
    const { item, facts } = rowFor({ ...APPROVAL_IN_OPEN_TURN, answerability });
    const status = workStatus(item, NOW, { facts });
    expect(status.rung).toBe('unanswerable');
    expect(status.lane).toBe('idle');
    expect(status.line).toBe(`Can't answer here · ${item.unanswerableNotice}`);
    expect(item.unanswerableNotice).toMatch(/observed by station-a/);
    // No kind is recorded for a request nothing here can answer.
    expect(facts?.attention).toBeUndefined();
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

  it('records the branch only for a session with its own worktree', () => {
    expect(rowFor(RUNNING_TOOL).facts?.worktreeBranch).toBeUndefined();
    expect(
      rowFor({ ...RUNNING_TOOL, workspaceIsolation: { mode: 'shared' } }).facts
        ?.worktreeBranch,
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
      }).facts?.worktreeBranch,
    ).toBe('station/inbox-row');
  });

  it('a stuck earlier execution child does not borrow the current child’s turn', () => {
    // This summary's own fold says a turn is open (it never got a terminal),
    // but the conversation's open turn is on ANOTHER thread. The row is
    // Running by its own fold; it must not show that other turn's tool or
    // clock as its own.
    expect(
      statusOf({
        ...RUNNING_TOOL,
        threadId: 'earlier-child',
        conversationActivity: RUNNING_TOOL.conversationActivity,
      }),
    ).toEqual({ rung: 'running', lane: 'running', line: 'Running' });
  });

  it('a remote row reads its own environment’s session, by the id it carries', () => {
    const items = buildHomeWorkItems({
      chats: {},
      sessions: [],
      agents: [],
      remoteEnvironments: [
        {
          environmentId: 'env-1',
          environmentName: 'brian-media',
          sessions: [APPROVAL_IN_OPEN_TURN],
        },
      ],
    });
    expect(items[0].id).toBe('remote:env-1:T');
    const facts = buildWorkFacts({
      items,
      // A LOCAL session with the same thread id must not answer for it.
      sessions: [RUNNING_TOOL],
      remoteEnvironments: [
        { environmentId: 'env-1', sessions: [APPROVAL_IN_OPEN_TURN] },
      ],
    });
    expect(
      workStatus(items[0], NOW, { facts: facts.get(items[0].id) }).line,
    ).toBe('Needs approval');
  });
});

/**
 * The literal table (#3042 acceptance): each state, written out as the item
 * and the facts beside it, pinned to its line, its lane, and the bucket the
 * partition files it in. Every column is a literal; nothing in the expected
 * values is derived from the ladder.
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
const OPENED = {
  conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
  acknowledgedAt: Date.parse('2026-09-30T09:36:15.000Z'),
};

const TABLE: ReadonlyArray<
  [
    name: string,
    row: Partial<HomeWorkItem>,
    facts: WorkFacts | undefined,
    line: string,
    lane: WorkLane,
    bucket: string,
  ]
> = [
  [
    'needs approval',
    { lifecycleLabel: 'Needs attention' },
    { attention: 'approval' },
    'Needs approval',
    'needsYou',
    'needsYou',
  ],
  [
    'needs your answer',
    { lifecycleLabel: 'Needs attention' },
    { attention: 'answer' },
    'Needs your answer',
    'needsYou',
    'needsYou',
  ],
  [
    'waiting on you',
    { lifecycleLabel: 'Needs attention' },
    { attention: 'waiting' },
    'Waiting on you',
    'needsYou',
    'needsYou',
  ],
  [
    'needs attention with no recorded kind',
    { lifecycleLabel: 'Needs attention' },
    undefined,
    'Waiting on you',
    'needsYou',
    'needsYou',
  ],
  [
    'queued while offline',
    { lifecycleLabel: 'Needs attention' },
    { attention: 'queued' },
    'Queued to send',
    'needsYou',
    'needsYou',
  ],
  [
    'blocked',
    { lifecycleLabel: 'Needs attention' },
    { attention: 'blocked' },
    'Blocked',
    'needsYou',
    'needsYou',
  ],
  [
    'interrupted',
    { lifecycleLabel: 'Needs attention' },
    { attention: 'interrupted' },
    'Interrupted',
    'needsYou',
    'needsYou',
  ],
  [
    'failed with a reason',
    { lifecycleLabel: 'Failed', failureNotice: 'rate limit exceeded' },
    undefined,
    'Failed · rate limit exceeded',
    'finished',
    'recentlyFinished',
  ],
  [
    'failed with none',
    { lifecycleLabel: 'Failed' },
    undefined,
    'Failed',
    'finished',
    'recentlyFinished',
  ],
  [
    'stopped',
    { lifecycleLabel: 'Stopped' },
    undefined,
    'Stopped',
    'finished',
    'recentlyFinished',
  ],
  [
    "can't answer here",
    { lifecycleLabel: 'Unanswerable', unanswerableNotice: 'Observed by a.' },
    undefined,
    "Can't answer here · Observed by a.",
    'idle',
    'idle',
  ],
  [
    'sub-agents running',
    { lifecycleLabel: 'Running' },
    { activity: { ...ACTIVITY, childWorkCount: 2 } },
    '2 sub-agents running · 1m 12s',
    'running',
    'running',
  ],
  [
    'running a tool',
    { lifecycleLabel: 'Running', activeReason: 'turn' },
    { activity: ACTIVITY },
    'Running · Bash · 1m 12s',
    'running',
    'running',
  ],
  [
    'running, but the watchdog reports no progress',
    { lifecycleLabel: 'Running', activeReason: 'turn', turnProgress: SILENCE },
    { activity: ACTIVITY },
    'No progress for 6m · Bash · 1m 12s',
    'running',
    'running',
  ],
  [
    'running with no facts',
    { lifecycleLabel: 'Running', activeReason: 'turn' },
    undefined,
    'Running',
    'running',
    'running',
  ],
  [
    'background work with no count',
    { lifecycleLabel: 'Running', activeReason: 'background' },
    undefined,
    'Background work running',
    'running',
    'running',
  ],
  [
    'idle',
    { lifecycleLabel: 'Ready' },
    undefined,
    'Idle · last activity 25m ago',
    'idle',
    'idle',
  ],
  [
    'idle, changed since it was opened',
    {
      lifecycleLabel: 'Recent',
      conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
      acknowledgedAt: Date.parse('2026-09-30T09:00:00.000Z'),
    },
    undefined,
    'Idle · new activity 25m ago',
    'idle',
    'idle',
  ],
  [
    'idle with no recorded time',
    { lifecycleLabel: 'Current', updatedAt: 0 },
    undefined,
    'Idle',
    'idle',
    'idle',
  ],
  [
    'draft',
    { lifecycleLabel: 'Draft' },
    undefined,
    'Draft · nothing sent yet',
    'drafts',
    'drafts',
  ],
  [
    'done and opened',
    { lifecycleLabel: 'Completed', ...OPENED },
    undefined,
    'Done',
    'finished',
    'settled',
  ],
  [
    'done, not opened',
    {
      lifecycleLabel: 'Completed',
      conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
    },
    undefined,
    'Done · not opened yet',
    'finished',
    'recentlyFinished',
  ],
  [
    'followed from another app',
    { lifecycleLabel: 'Running', controlMode: 'read-only-attached' },
    undefined,
    'Started in Claude Code',
    'external',
    'external',
  ],
];

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

describe('the status ladder, state by state', () => {
  it.each(TABLE)('%s', (_name, over, facts, line, lane, bucket) => {
    const row = item(over);
    const status = workStatus(row, NOW, { facts });
    expect(status.line).toBe(line);
    expect(status.lane).toBe(lane);
    expect(bucketOf(row)).toBe(bucket);
  });

  it('facts only choose words: no fact moves an item to another lane', () => {
    // The partition files items with no facts in hand, so a fact that could
    // change the lane would let a row and its heading disagree. Every fact,
    // against every label.
    const everyFact: WorkFacts[] = [
      { attention: 'approval' },
      { attention: 'interrupted' },
      { activity: { ...ACTIVITY, childWorkCount: 3 } },
      { attention: 'approval', activity: ACTIVITY, worktreeBranch: 'b' },
    ];
    for (const lifecycleLabel of [
      'Needs attention',
      'Failed',
      'Stopped',
      'Running',
      'Current',
      'Ready',
      'Recent',
      'Draft',
      'Unanswerable',
      'Completed',
    ] as const) {
      const row = item({ lifecycleLabel });
      const bare = workStatus(row, NOW).lane;
      for (const facts of everyFact) {
        expect(workStatus(row, NOW, { facts }).lane).toBe(bare);
      }
    }
    // And a fact its label does not explain changes nothing at all.
    expect(
      workStatus(item({ lifecycleLabel: 'Ready' }), NOW, {
        facts: { attention: 'approval', activity: ACTIVITY },
      }).line,
    ).toBe('Idle · last activity 25m ago');
  });

  it('marks unread only when the conversation changed after it was opened', () => {
    const unread = (over: Partial<HomeWorkItem>) =>
      workStatus(item(over), NOW).unread;
    expect(unread({})).toBe(false);
    expect(unread(OPENED)).toBe(false);
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

  it('the conversation on screen is never unread, in the flag or the words', () => {
    const changed = item({
      lifecycleLabel: 'Recent',
      conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
      acknowledgedAt: Date.parse('2026-09-30T09:00:00.000Z'),
    });
    expect(workStatus(changed, NOW)).toMatchObject({
      unread: true,
      line: 'Idle · new activity 25m ago',
    });
    expect(workStatus(changed, NOW, { current: true })).toMatchObject({
      unread: false,
      line: 'Idle · last activity 25m ago',
    });
    const finished = item({
      lifecycleLabel: 'Completed',
      conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
    });
    expect(workStatus(finished, NOW, { current: true }).line).toBe('Done');
  });

  it('formats a duration so it reads the same while it ticks', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_900)).toBe('42s');
    expect(formatElapsed(72_000)).toBe('1m 12s');
    expect(formatElapsed(3_840_000)).toBe('1h 04m');
    expect(formatElapsed(-5)).toBe('0s');
  });
});

describe('status facts for chat, task and merged rows', () => {
  const build = (
    chatOver: Record<string, unknown> | null,
    sessions: OrchestrationSessionSummary[] = [],
    tasks: TaskRecord[] = [],
  ) => {
    const chats: Record<string, ChatUIState> = chatOver
      ? {
          c1: {
            ...createDefaultChatState(),
            title: 'Chat',
            createdAt: NOW - 60_000,
            ...chatOver,
          },
        }
      : {};
    const items = buildHomeWorkItems({ chats, sessions, tasks, agents: [] });
    const facts = buildWorkFacts({ items, chats, sessions, tasks });
    return {
      item: items[0],
      facts: facts.get(items[0].id),
      line: workStatus(items[0], NOW, { facts: facts.get(items[0].id) }).line,
    };
  };
  const asConversation = (summary: OrchestrationSessionSummary) => ({
    ...summary,
    threadId: 'conv',
    conversationId: 'conv',
    conversationActivity: summary.conversationActivity && {
      ...summary.conversationActivity,
      conversationId: 'conv',
      currentThreadId: 'conv',
    },
  });

  it('a chat holding a pending approval reads as needs-approval', () => {
    expect(build({ pendingApprovals: ['r1'], status: 'sending' }).line).toBe(
      'Needs approval',
    );
  });

  it('a send queued while offline reads as queued', () => {
    expect(build({ status: 'queued' }).line).toBe('Queued to send');
  });

  it('a blocked durable Task reads as blocked', () => {
    expect(
      build(
        null,
        [],
        [
          {
            id: 'task-1',
            title: 'Task',
            status: 'blocked',
            updatedAt: '2026-09-30T10:00:00.000Z',
          } as TaskRecord,
        ],
      ).line,
    ).toBe('Blocked');
  });

  it('a merged chat+session row reads the more urgent kind, only under the label that won', () => {
    // The chat only knows "waiting"; the session knows it is an approval.
    expect(
      build(
        { conversationId: 'conv', orchestrationStatus: 'awaiting-approval' },
        [asConversation(APPROVAL_IN_OPEN_TURN)],
      ),
    ).toMatchObject({ line: 'Needs approval' });
    // The chat holds the approval first-hand; the session summary is stale.
    expect(
      build({ conversationId: 'conv', pendingApprovals: ['r1'] }, [
        asConversation(TURN_COMPLETED),
      ]),
    ).toMatchObject({ line: 'Needs approval' });
    // Nothing is owed: no kind is recorded under a label that is not
    // Needs attention.
    const settled = build({ conversationId: 'conv' }, [
      asConversation(TURN_COMPLETED),
    ]);
    expect(settled.item.lifecycleLabel).not.toBe('Needs attention');
    expect(settled.facts?.attention).toBeUndefined();
    expect(settled.facts?.activity).toBeUndefined();
  });
});
