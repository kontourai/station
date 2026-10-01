import type {
  OrchestrationSessionSummary,
  TaskRecord,
} from '@kontourai/station-sdk';
import { describe, expect, it } from 'vitest';
import {
  FOLD_FIRST_EVENT_AT,
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../tests/helpers/session-summary-fold-fixtures';
import {
  type ChatUIState,
  createDefaultChatState,
} from '../contexts/active-chats-state';
import { sessionStatusWord } from '../utils/session-state';
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
 * THE SESSION FIXTURES ARE THE SERVER'S OWN FOLD. `FOLD_FIXTURES`
 * (`tests/helpers/session-summary-fold-fixtures.ts`) pairs literal event
 * sequences with the literal summary fields the server produces for them,
 * and `src-server/services/orchestration/__tests__/
 * session-summary-fold-fixtures.test.ts` runs every sequence through the
 * real event store, activity projection and `buildOrchestrationSessionSummary`
 * and requires exact equality. A fold change fails there; nothing here is a
 * hand-written guess at a summary. (This file cannot run the fold itself:
 * `typecheck:ui` does not resolve the server module graph.)
 */

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
// Every sequence's first event, `turn.started`: 1m 12s before NOW.
const TURN_STARTED = FOLD_FIRST_EVENT_AT;

const SILENCE = {
  lastProgressEventAt: '2026-09-30T09:55:15.000Z',
  progressSilence: {
    detectedAt: '2026-09-30T10:00:15.000Z',
    windowMs: 300_000,
    silentSinceEventAt: '2026-09-30T09:55:15.000Z',
    provider: 'claude',
  },
} satisfies OrchestrationSessionSummary['turnProgress'];

/** A folded fixture as the summary the client receives: the fields the fold
 *  test pins, plus the row-identity fields no status code reads. */
function folded(
  name: keyof typeof FOLD_FIXTURES,
  over: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId: 'T',
    status: 'running',
    createdAt: FOLD_SESSION_CREATED_AT,
    updatedAt: '2026-09-30T10:00:02.000Z',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: FOLD_FIXTURES[name].events.length,
    ...(FOLD_FIXTURES[name].summary as Partial<OrchestrationSessionSummary>),
    ...over,
  };
}

const RUNNING_TOOL = folded('runningTool');
const APPROVAL_IN_OPEN_TURN = folded('approvalInOpenTurn');
const QUESTION_IN_OPEN_TURN = folded('questionInOpenTurn');
const INTERRUPTED = folded('interrupted');
const BLOCKED = folded('blocked');
const TURN_COMPLETED = folded('turnCompleted');
const FAILED = folded('failed');

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
  const { line, lane, rung } = workStatus(item, NOW, facts);
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

  it('an approval left behind by an interrupted turn still reads Needs approval (#3071)', () => {
    // Recovery aborts the dead turn but does not settle the request it had
    // opened, so the fold re-stamps the session review_pending. Nothing on
    // the summary reliably separates this from a live approval, so the row
    // does not guess: it says what the server says. Pinned so the row
    // changes only when the server does.
    const summary = folded('staleApprovalAfterInterruption');
    expect(summary).toMatchObject({
      lifecycleState: 'review_pending',
      pendingReview: true,
      hasActiveTurn: false,
    });
    expect(statusOf(summary).line).toBe('Needs approval');
  });

  it('a running turn names its current tool and how long the turn has run', () => {
    expect(statusOf(RUNNING_TOOL)).toEqual({
      rung: 'running',
      lane: 'running',
      line: 'Running · Bash · 1m 12s',
    });
  });

  it('counts reported child work ahead of the tool line', () => {
    const summary = folded('runningWithChildren');
    expect(summary.conversationActivity?.runningChildWork).toMatchObject({
      count: 3,
      producers: ['engine-subagent'],
    });
    expect(statusOf(summary)).toEqual({
      rung: 'childWork',
      lane: 'running',
      line: '3 sub-agents running · 1m 12s',
    });
  });

  it('a run the watchdog marks silent is its own cautionary rung, still in Running', () => {
    // The marker is the real watchdog's: nothing arrived for its 180s window.
    const summary = folded('silentRun');
    expect(summary.turnProgress?.progressSilence).toMatchObject({
      windowMs: 180_000,
      silentSinceEventAt: '2026-09-30T10:00:04.000Z',
    });
    const silent = rowFor(summary);
    const status = workStatus(silent.item, NOW, silent.facts);
    expect(status).toMatchObject({
      rung: 'quiet',
      lane: 'running',
      tone: 'caution',
      line: 'No progress for 1m · Bash · 1m 12s',
    });
    // Never drawn as the healthy run it sits beside.
    const healthy = rowFor(RUNNING_TOOL);
    expect(workStatus(healthy.item, NOW, healthy.facts)).toMatchObject({
      rung: 'running',
      tone: 'active',
    });
  });

  it('a turn that ended while its sub-agents kept running reads as running, not Done', () => {
    // Ordinary turns end `idle` (#2540). The session is not finished while
    // the engine still reports children under it.
    const summary = folded('idleWithChildren');
    expect(summary).toMatchObject({
      lifecycleState: 'idle',
      hasActiveTurn: false,
      conversationActivity: { runningChildWork: { count: 2 } },
    });
    expect(statusOf(summary)).toEqual({
      rung: 'childWork',
      lane: 'running',
      line: '2 sub-agents running',
    });
    // The Sessions list's word comes from the same label fold and agrees.
    expect(sessionStatusWord(summary)).toBe('Running');
    // Without the children the same ending is simply done.
    expect(statusOf(TURN_COMPLETED).line).toBe('Done');
    expect(sessionStatusWord(TURN_COMPLETED)).toBe('Completed');
  });

  it('a session nothing was sent to is a Draft', () => {
    const summary = folded('draft');
    expect(summary.draft).toBe(true);
    expect(statusOf(summary)).toEqual({
      rung: 'draft',
      lane: 'drafts',
      line: 'Draft · nothing sent yet',
    });
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
    const summary = folded('detachedApproval');
    expect(summary.answerability).toMatchObject({
      answerable: false,
      observedBy: 'station-a',
    });
    const { item, facts } = rowFor(summary);
    const status = workStatus(item, NOW, facts);
    expect(status.rung).toBe('unanswerable');
    expect(status.lane).toBe('idle');
    expect(status.line).toBe(`Can't answer here · ${item.unanswerableNotice}`);
    expect(item.unanswerableNotice).toMatch(/observed by station-a/);
    // No kind is recorded for a request nothing here can answer.
    expect(facts?.attention).toBeUndefined();
  });

  it('a failed session carries the reason the server attributed', () => {
    expect(FAILED.terminalAttribution?.detail).toBeTruthy();
    expect(statusOf(FAILED)).toEqual({
      rung: 'failed',
      lane: 'finished',
      line: `Failed · ${FAILED.terminalAttribution?.detail}`,
    });
  });

  it('a finished turn is Done', () => {
    expect(statusOf(TURN_COMPLETED)).toEqual({
      rung: 'done',
      lane: 'finished',
      line: 'Done',
    });
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
    expect(workStatus(items[0], NOW, facts.get(items[0].id)).line).toBe(
      'Needs approval',
    );
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
    'sub-agents still running after their turn ended',
    { lifecycleLabel: 'Running', activeReason: 'background' },
    { activity: { childWorkCount: 2 } },
    '2 sub-agents running',
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
    'done, not opened: Just finished, with no extra claim on the row',
    {
      lifecycleLabel: 'Completed',
      conversationUpdatedAt: '2026-09-30T09:36:15.000Z',
    },
    undefined,
    'Done',
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
    const status = workStatus(row, NOW, facts);
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
      { attention: 'approval', activity: ACTIVITY },
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
        expect(workStatus(row, NOW, facts).lane).toBe(bare);
      }
    }
    // And a fact its label does not explain changes nothing at all.
    expect(
      workStatus(item({ lifecycleLabel: 'Ready' }), NOW, {
        attention: 'approval',
        activity: ACTIVITY,
      }).line,
    ).toBe('Idle · last activity 25m ago');
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
      line: workStatus(items[0], NOW, facts.get(items[0].id)).line,
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
