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
import { formatDuration } from '../utils/relativeTime';
import { partitionHomeWorkItems } from '../views/home/home-lane-model';
import {
  buildHomeWorkItems,
  buildOrchestrationItems,
  type HomeWorkItem,
} from '../views/home/home-view-model';
import { buildWorkFacts, type WorkFacts } from '../views/home/work-facts';
import { type WorkLane, workStatus } from '../views/home/work-status';
import { sessionWorkStatus } from '../views/sessions/sessions-lane-model';

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
    ...FOLD_FIXTURES[name].summary,
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

  it('a running row with an open question reads as needs-answer', () => {
    expect(statusOf(QUESTION_IN_OPEN_TURN)).toEqual({
      rung: 'answer',
      lane: 'needsYou',
      line: 'Needs answer',
    });
  });

  it('an approval whose turn was interrupted reads Interrupted, not Needs approval (#3071)', () => {
    // Recovery aborts the dead turn, and that abort settles the request the
    // turn had opened, so the fold no longer re-stamps the session
    // review_pending: nobody can answer an approval a dead process asked.
    const summary = folded('approvalSettledByInterruption');
    expect(summary).toMatchObject({
      lifecycleState: 'needs_input',
      transitionReason: 'runtime_exit',
      pendingReview: false,
      hasActiveTurn: false,
    });
    expect(statusOf(summary)).toMatchObject({
      lane: 'needsYou',
      line: 'Interrupted',
    });
  });

  it('a running turn names its current tool and how long the turn has run', () => {
    expect(statusOf(RUNNING_TOOL)).toEqual({
      rung: 'running',
      lane: 'running',
      line: 'Running · Bash · 1m',
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
      line: '3 sub-agents · 1m',
    });
  });

  it('a run the watchdog marks silent is its own cautionary rung, still in Running', () => {
    // The marker is the real watchdog's: nothing arrived for its 180s window.
    const summary = folded('silentRun');
    expect(summary.turnProgress?.progressSilence).toMatchObject({
      windowMs: 180_000,
      silentSinceEventAt: '2026-09-30T10:00:04.000Z',
    });
    // Read at an instant the marker exists: it was written at 10:03:04,
    // after 180s of nothing since the last progress event at 10:00:04.
    expect(summary.turnProgress?.progressSilence?.detectedAt).toBe(
      '2026-09-30T10:03:04.000Z',
    );
    const sixMinutesSilent = Date.parse('2026-09-30T10:06:04.000Z');
    const silent = rowFor(summary);
    const status = workStatus(silent.item, sixMinutesSilent, silent.facts);
    expect(status).toMatchObject({
      rung: 'quiet',
      lane: 'running',
      tone: 'caution',
      // One number: how long it has been quiet (6m), not the turn's age
      // beside a second count baked into the word.
      line: 'No progress · Bash · 6m',
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
      line: '2 sub-agents',
    });
    // The Activity list reads the SAME ladder call for the same summary.
    expect(sessionWorkStatus(summary, [], NOW).word).toBe('2 sub-agents');
    // Without the children the same ending is simply done.
    expect(statusOf(TURN_COMPLETED).line).toBe('Done');
    expect(sessionWorkStatus(TURN_COMPLETED, [], NOW).word).toBe('Done');
  });

  it('a session nothing was sent to is a Draft', () => {
    const summary = folded('draft');
    expect(summary.draft).toBe(true);
    expect(statusOf(summary)).toEqual({
      rung: 'draft',
      lane: 'drafts',
      line: 'Draft',
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

  it('a request nothing here can answer is idle and Elsewhere, its basis off the row, even mid-turn', () => {
    const summary = folded('detachedApproval');
    expect(summary.answerability).toMatchObject({
      answerable: false,
      observedBy: 'station-a',
    });
    const { item, facts } = rowFor(summary);
    const status = workStatus(item, NOW, facts);
    expect(status.rung).toBe('unanswerable');
    expect(status.lane).toBe('idle');
    expect(status.line).toBe('Elsewhere');
    expect(status.reason).toBe(item.unanswerableNotice);
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

  it('a stuck earlier execution child does not borrow the current child’s sub-agents', () => {
    // The conversation's record says three children are running under the
    // CURRENT thread ('T'). An earlier child whose own fold still says a
    // turn is open carries the same record; the count is not its own.
    const current = folded('runningWithChildren');
    expect(current.conversationActivity).toMatchObject({
      currentThreadId: 'T',
      runningChildWork: { count: 3 },
    });
    expect(statusOf(current).line).toBe('3 sub-agents · 1m');
    expect(statusOf({ ...current, threadId: 'earlier-child' })).toEqual({
      rung: 'running',
      lane: 'running',
      line: 'Running',
    });
  });

  it('a remote row reads its own environment’s session, by the id it carries', () => {
    const items = buildHomeWorkItems({
      chats: {},
      sessions: [],
      agents: [],
      remoteEnvironments: [
        {
          environmentId: 'env-1',
          environmentName: 'home-media',
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
    'needs answer',
    { lifecycleLabel: 'Needs attention' },
    { attention: 'answer' },
    'Needs answer',
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
    'elsewhere (nothing here can answer): the basis is the reason, not the line',
    { lifecycleLabel: 'Unanswerable', unanswerableNotice: 'Observed by a.' },
    undefined,
    'Elsewhere',
    'idle',
    'idle',
  ],
  [
    'sub-agents running',
    { lifecycleLabel: 'Running' },
    { activity: { ...ACTIVITY, childWorkCount: 2 } },
    '2 sub-agents · 1m',
    'running',
    'running',
  ],
  [
    'sub-agents still running after their turn ended',
    { lifecycleLabel: 'Running', activeReason: 'background' },
    { activity: { childWorkCount: 2 } },
    '2 sub-agents',
    'running',
    'running',
  ],
  [
    'running a tool',
    { lifecycleLabel: 'Running', activeReason: 'turn' },
    { activity: ACTIVITY },
    'Running · Bash · 1m',
    'running',
    'running',
  ],
  [
    'running, but the watchdog reports no progress',
    { lifecycleLabel: 'Running', activeReason: 'turn', turnProgress: SILENCE },
    { activity: ACTIVITY },
    'No progress · Bash · 6m',
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
    'Running',
    'running',
    'running',
  ],
  [
    'idle: the row corner carries the time, the line says only Idle',
    { lifecycleLabel: 'Ready' },
    undefined,
    'Idle',
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
    'Draft',
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
    'followed from another app: Elsewhere, the app in the reason',
    { lifecycleLabel: 'Running', controlMode: 'read-only-attached' },
    undefined,
    'Elsewhere',
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
    ).toBe('Idle');
  });

  it('a stopped reason and an attached app are reasons, never on the line', () => {
    expect(
      workStatus(
        item({
          lifecycleLabel: 'Stopped',
          failureNotice: 'Stopped by request.',
        }),
        NOW,
      ),
    ).toMatchObject({ line: 'Stopped', reason: 'Stopped by request.' });
    expect(
      workStatus(
        item({ lifecycleLabel: 'Running', controlMode: 'read-only-attached' }),
        NOW,
      ),
    ).toMatchObject({ line: 'Elsewhere', reason: 'Started in Claude Code' });
  });

  it('formats a duration in the coarse vocabulary: 12s, then 4m, then 1h 4m', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(42_900)).toBe('42s');
    expect(formatDuration(59_999)).toBe('59s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(72_000)).toBe('1m');
    expect(formatDuration(250_000)).toBe('4m');
    expect(formatDuration(3_599_999)).toBe('59m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_840_000)).toBe('1h 4m');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
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

  it('an approval the user already answered does not read as needs-approval', () => {
    // Open on the server until `request.resolved`, but it waits on the engine.
    expect(
      build({
        pendingApprovals: ['r1'],
        answeredApprovals: ['r1'],
        status: 'queued',
      }).line,
    ).toBe('Queued to send');
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
