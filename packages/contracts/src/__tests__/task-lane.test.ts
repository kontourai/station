import { describe, expect, test } from 'vitest';
import type { OrchestrationSessionSummary } from '../orchestration.js';
import type { TaskRecord } from '../task-graph.js';
import {
  deriveTaskLane,
  partitionTaskLanes,
  type TaskLaneDerivation,
  type TaskLaneInput,
  type TaskPullRequestFact,
  type TaskPullRequestFeedbackFact,
} from '../task-lane.js';

const OBSERVED = '2026-11-15T12:00:00.000Z';

test.each(['reviewing', 'review-needed'] as const)(
  'a clean forge head with Station %s stays in review until its review clears',
  (state) => {
    const fact = pr('42', { readiness: 'clean', headSha: 'a'.repeat(40) });
    fact.feedback = { state, headSha: 'a'.repeat(40), reviewEachHead: true };
    expect(derive({ pullRequests: [fact] }).placement).toEqual({
      kind: 'lane',
      lane: 'in_review',
    });
    fact.feedback.headSha = 'b'.repeat(40);
    expect(derive({ pullRequests: [fact] }).placement).toEqual({
      kind: 'lane',
      lane: 'in_review',
    });
    delete fact.feedback.headSha;
    expect(derive({ pullRequests: [fact] }).placement).toEqual({
      kind: 'lane',
      lane: 'in_review',
    });
    if (fact.status.state === 'current') delete fact.status.headSha;
    expect(derive({ pullRequests: [fact] }).placement).toEqual({
      kind: 'lane',
      lane: 'in_review',
    });
    delete fact.feedback.reviewEachHead;
    expect(derive({ pullRequests: [fact] }).placement).toEqual({
      kind: 'lane',
      lane: 'ready_to_merge',
    });
  },
);

function task(overrides: Partial<TaskLaneInput['task']> = {}) {
  return {
    id: 'task-a',
    projectId: 'demo',
    title: 'Work',
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'user',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    agentId: 'claude',
    ...overrides,
  } satisfies TaskRecord & { openQuestionCount?: number };
}

/** The shape `GET /api/orchestration/sessions/read-model` answers with. */
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
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T01:00:00.000Z',
    ...overrides,
  };
}

const RUNNING = { lifecycleState: 'running', hasActiveTurn: true } as const;

function pr(
  ref: string,
  status: Partial<
    Extract<TaskPullRequestFact['status'], { state: 'current' }>
  > = {},
): TaskPullRequestFact {
  return {
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'acme', name: 'app' },
    ref,
    url: `https://github.com/acme/app/pull/${ref}`,
    observedAt: OBSERVED,
    status: {
      state: 'current',
      pullRequestState: 'OPEN',
      mergeability: 'mergeable',
      ...status,
    },
  };
}

function unreadPr(ref: string): TaskPullRequestFact {
  return {
    ...pr(ref),
    status: { state: 'unavailable', reason: 'Timed out reading the provider.' },
  };
}

function derive(
  input: Partial<TaskLaneInput> & { task?: TaskLaneInput['task'] },
) {
  const named = input.task ?? task({ sessionId: 'run-a' });
  return deriveTaskLane({
    task: named,
    // A Task that names a run reads it as finished unless a case says
    // otherwise; an unread run is its own case ('unreadable' or undefined).
    session:
      'session' in input
        ? input.session
        : named.sessionId
          ? session({ threadId: named.sessionId, lifecycleState: 'completed' })
          : undefined,
    pullRequests: input.pullRequests,
  });
}

const placed = (d: TaskLaneDerivation) =>
  d.placement.kind === 'lane'
    ? `lane:${d.placement.lane}`
    : `shelf:${d.placement.shelf}`;

describe('the lane table, one row at a time', () => {
  test.each<
    [
      name: string,
      input: Partial<TaskLaneInput> & { task?: TaskLaneInput['task'] },
      placement: string,
      rung: TaskLaneDerivation['rung'],
      word: string,
      action: string,
    ]
  >([
    [
      '0a canceled',
      { task: task({ status: 'canceled' }) },
      'shelf:canceled',
      'canceled',
      'Canceled',
      'Open Task',
    ],
    [
      '0b done',
      {
        task: task({ status: 'done', sessionId: 'run-a' }),
        session: session(RUNNING),
      },
      'shelf:done',
      'done',
      'Done',
      'Open Task',
    ],
    [
      '1 approval',
      {
        session: session({
          lifecycleState: 'review_pending',
          pendingReview: true,
        }),
      },
      'lane:needs_you',
      'approval',
      'Needs approval',
      'Approve…',
    ],
    [
      '1 answer',
      {
        session: session({
          lifecycleState: 'needs_input',
          transitionReason: 'input_requested',
        }),
      },
      'lane:needs_you',
      'answer',
      'Needs input',
      'Answer…',
    ],
    [
      '1 interrupted',
      {
        session: session({
          lifecycleState: 'needs_input',
          transitionReason: 'runtime_exit',
        }),
      },
      'lane:needs_you',
      'interrupted',
      'Interrupted',
      'Resume…',
    ],
    [
      '1 blocked run',
      { session: session({ lifecycleState: 'blocked' }) },
      'lane:needs_you',
      'blocked',
      'Blocked',
      'Answer…',
    ],
    [
      '1 waiting',
      { session: session({ lifecycleState: 'needs_input' }) },
      'lane:needs_you',
      'waiting',
      'Waiting on you',
      'Answer…',
    ],
    [
      '2 Task question',
      { task: task({ openQuestionCount: 2 }) },
      'lane:needs_you',
      'taskQuestion',
      'Needs input',
      'Answer…',
    ],
    [
      '3 failed',
      { session: session({ lifecycleState: 'failed' }) },
      'lane:needs_you',
      'failed',
      'Failed',
      'Open run',
    ],
    [
      '4 running',
      { session: session(RUNNING) },
      'lane:running',
      'running',
      'Running',
      'Open run',
    ],
    [
      '5 merged',
      {
        session: session({ lifecycleState: 'completed' }),
        pullRequests: [pr('7', { pullRequestState: 'MERGED' })],
      },
      'lane:needs_you',
      'merged',
      'PR merged',
      'Mark done',
    ],
    [
      '6 changes requested',
      {
        pullRequests: [
          pr('7', {
            reviewDecision: 'changes_requested',
            readiness: 'blocked',
          }),
        ],
      },
      'lane:in_review',
      'changesRequested',
      'Changes requested',
      'Open PR',
    ],
    [
      '7 conflict',
      { pullRequests: [pr('7', { mergeability: 'conflicting' })] },
      'lane:in_review',
      'conflict',
      'Conflicts with base',
      'Open PR',
    ],
    [
      '8 checks failing',
      { pullRequests: [pr('7', { readiness: 'checks-not-passing' })] },
      'lane:in_review',
      'checksNotPassing',
      'Checks not passing',
      'Open PR',
    ],
    [
      '9 draft',
      { pullRequests: [pr('7', { draft: true, readiness: 'draft' })] },
      'lane:in_review',
      'draft',
      'Draft PR',
      'Open PR',
    ],
    [
      '10 waiting for review',
      {
        pullRequests: [
          pr('7', { readiness: 'blocked', reviewDecision: 'review_required' }),
        ],
      },
      'lane:in_review',
      'awaitingReview',
      'Waiting for review',
      'Open PR',
    ],
    [
      '11 repository rules',
      { pullRequests: [pr('7', { readiness: 'blocked' })] },
      'lane:in_review',
      'repoBlocked',
      'Blocked by repository rules',
      'Open PR',
    ],
    [
      '12 behind',
      { pullRequests: [pr('7', { readiness: 'behind' })] },
      'lane:in_review',
      'behind',
      'Behind base',
      'Open PR',
    ],
    [
      '13 ready',
      { pullRequests: [pr('7', { readiness: 'clean' })] },
      'lane:ready_to_merge',
      'readyToMerge',
      'Ready to merge',
      'Merge…',
    ],
    [
      '14 PR open',
      { pullRequests: [pr('7', { readiness: 'unknown' })] },
      'lane:in_review',
      'prOpen',
      'PR open',
      'Open PR',
    ],
    [
      '15 PR unreadable',
      { pullRequests: [unreadPr('7')] },
      'lane:in_review',
      'prUnknown',
      'PR status unavailable',
      'Open PR',
    ],
    [
      '16a fix attempts used (#5066)',
      {
        task: task({
          status: 'blocked',
          pullRequestWatchHold: {
            checks: ['ci / unit-tests'],
            pullRequest: 'acme/widgets#42',
            at: OBSERVED,
          },
        }),
      },
      'lane:needs_you',
      'fixAttemptsUsed',
      'Fix attempts used',
      'Open Task',
    ],
    [
      '16 marked blocked',
      { task: task({ status: 'blocked' }) },
      'lane:needs_you',
      'markedBlocked',
      'Marked blocked',
      'Open Task',
    ],
    [
      '17 marked review',
      { task: task({ status: 'verification' }) },
      'lane:needs_you',
      'markedReview',
      'Marked for review',
      'Open Task',
    ],
    [
      '18 run unreadable',
      { session: 'unreadable' },
      'lane:idle',
      'runUnknown',
      'Run status unavailable',
      'Open Task',
    ],
    [
      '19 read only',
      { session: session({ ...RUNNING, controlMode: 'read-only-attached' }) },
      'lane:idle',
      'elsewhere',
      'Read only',
      'Open run',
    ],
    [
      '20 finished',
      { session: session({ lifecycleState: 'completed' }), pullRequests: [] },
      'lane:idle',
      'finished',
      'Agent finished',
      'Open run',
    ],
    [
      '20 stopped',
      { session: session({ lifecycleState: 'canceled' }), pullRequests: [] },
      'lane:idle',
      'stopped',
      'Stopped',
      'Open run',
    ],
    [
      '21 backlog',
      { task: task({ status: 'todo' }), pullRequests: [] },
      'shelf:backlog',
      'backlog',
      'To do',
      'Start',
    ],
    [
      '22 not started',
      { task: task({ status: 'ready' }), pullRequests: [] },
      'lane:idle',
      'notStarted',
      'Not started',
      'Start',
    ],
  ])('%s', (_name, input, placement, rung, word, action) => {
    const derived = derive(input);
    expect([
      placed(derived),
      derived.rung,
      derived.word,
      derived.nextAction.label,
    ]).toEqual([placement, rung, word, action]);
  });
});

describe('precedence', () => {
  test('an owed decision outranks a running turn, and a running turn outranks a clean PR', () => {
    const clean = [pr('7', { readiness: 'clean' })];
    expect(
      derive({
        session: session({ ...RUNNING, pendingReview: true }),
        pullRequests: clean,
      }).rung,
    ).toBe('approval');
    expect(
      derive({ session: session(RUNNING), pullRequests: clean }).rung,
    ).toBe('running');
    expect(
      derive({
        session: session({ lifecycleState: 'completed' }),
        pullRequests: clean,
      }).rung,
    ).toBe('readyToMerge');
  });

  test('a stored todo with a running run is Running, not Backlog', () => {
    const derived = derive({
      task: task({ status: 'todo', sessionId: 'run-a' }),
      session: session(RUNNING),
    });
    expect(placed(derived)).toBe('lane:running');
  });

  test('a missing run is never "Stopped"', () => {
    const derived = derive({ session: 'unreadable', pullRequests: [] });
    expect(derived.word).toBe('Run status unavailable');
    expect(derived.certainty).toBe('unknown');
    // A Task with a run id but no session read at all is the same.
    expect(derive({ session: undefined }).rung).toBe('runUnknown');
  });
});

describe('a recorded decision and an unread run are never outranked by a PR', () => {
  test('a Task marked blocked stays Marked blocked beside a clean PR', () => {
    const derived = derive({
      task: task({ status: 'blocked' }),
      pullRequests: [pr('7', { readiness: 'clean' })],
    });
    expect([derived.placement, derived.rung]).toEqual([
      { kind: 'lane', lane: 'needs_you' },
      'markedBlocked',
    ]);
  });

  test('marked for review still yields to an open PR', () => {
    expect(
      derive({
        task: task({ status: 'review' }),
        pullRequests: [pr('7', { readiness: 'behind' })],
      }).rung,
    ).toBe('behind');
  });

  test.each([
    ['clean', [pr('7', { readiness: 'clean' })]],
    ['merged', [pr('7', { pullRequestState: 'MERGED' })]],
  ] as const)(
    'an unread run with a %s PR is In review, not a next step',
    (_kind, pullRequests) => {
      const derived = derive({
        session: 'unreadable',
        pullRequests: [...pullRequests],
      });
      expect([
        derived.placement,
        derived.rung,
        derived.word,
        derived.detail,
        derived.nextAction.label,
        derived.certainty,
      ]).toEqual([
        { kind: 'lane', lane: 'in_review' },
        'runUnknown',
        'Run status unavailable',
        '#7',
        'Open PR',
        'unknown',
      ]);
    },
  );

  test('a PR in a state the table does not name (GitLab LOCKED) is never ready', () => {
    const derived = derive({
      session: session({ lifecycleState: 'completed' }),
      pullRequests: [
        pr('7', { pullRequestState: 'LOCKED', readiness: 'clean' }),
      ],
    });
    expect([derived.rung, derived.placement]).toEqual([
      'prUnknown',
      { kind: 'lane', lane: 'in_review' },
    ]);
  });

  test('a Task whose PRs were not read never claims "observed"', () => {
    for (const pullRequests of [undefined, 'unavailable'] as const) {
      expect(
        derive({ task: task({ status: 'todo' }), pullRequests }).certainty,
      ).toBe('partial');
      expect(
        derive({ task: task({ status: 'ready' }), pullRequests }).certainty,
      ).toBe('partial');
    }
  });
});

describe('pull request facts that were not observed claim nothing', () => {
  test.each([undefined, 'unknown'] as const)(
    'readiness %s is never Ready to merge',
    (readiness) => {
      const derived = derive({
        pullRequests: [pr('7', readiness ? { readiness } : {})],
      });
      expect(derived.placement).toEqual({ kind: 'lane', lane: 'in_review' });
      expect(derived.rung).toBe('prOpen');
    },
  );

  test('one clean PR beside one with unknown readiness is not ready', () => {
    const derived = derive({
      pullRequests: [pr('7', { readiness: 'clean' }), pr('8')],
    });
    expect(derived.rung).toBe('prOpen');
    expect(derived.detail).toBe('#8');
  });

  test('a clean PR beside an unreadable one is not ready', () => {
    const derived = derive({
      pullRequests: [pr('7', { readiness: 'clean' }), unreadPr('8')],
    });
    expect(derived.rung).toBe('prUnknown');
  });

  test('every open PR clean is ready, and names the count', () => {
    const derived = derive({
      pullRequests: [
        pr('7', { readiness: 'clean' }),
        pr('8', { readiness: 'clean' }),
      ],
    });
    expect([derived.rung, derived.detail]).toEqual(['readyToMerge', '2 PRs']);
    expect(derived.nextAction.kind).toBe('open-pull-request');
  });

  test('the worst open PR wins and is the one named', () => {
    const derived = derive({
      pullRequests: [
        pr('7', { readiness: 'behind' }),
        pr('9', { readiness: 'checks-not-passing' }),
      ],
    });
    expect([derived.rung, derived.detail]).toEqual(['checksNotPassing', '#9']);
    expect(derived.evidence.pullRequests.map((fact) => fact.ref)).toEqual([
      '9',
      '7',
    ]);
  });

  test('merged needs every kept PR merged', () => {
    expect(
      derive({
        pullRequests: [
          pr('7', { pullRequestState: 'MERGED' }),
          pr('8', { readiness: 'clean' }),
        ],
      }).rung,
    ).toBe('readyToMerge');
    expect(
      derive({
        pullRequests: [pr('7', { pullRequestState: 'MERGED' }), unreadPr('8')],
      }).rung,
    ).toBe('prUnknown');
  });

  test('a closed-unmerged PR is ignored for the lane but kept as evidence', () => {
    const closed = pr('6', { pullRequestState: 'CLOSED' });
    const merged = derive({
      pullRequests: [closed, pr('7', { pullRequestState: 'MERGED' })],
    });
    expect(merged.rung).toBe('merged');
    expect(merged.evidence.pullRequests.map((fact) => fact.ref)).toEqual([
      '7',
      '6',
    ]);
    const onlyClosed = derive({
      session: session({ lifecycleState: 'completed' }),
      pullRequests: [closed],
    });
    expect(onlyClosed.rung).toBe('finished');
    expect(onlyClosed.statusGlyph).toBe('pr-closed');
  });

  test('"no PR kept" is said only when the facts were read', () => {
    const finished = session({ lifecycleState: 'completed' });
    expect(derive({ session: finished, pullRequests: [] }).detail).toBe(
      'no PR kept',
    );
    for (const pullRequests of [undefined, 'unavailable'] as const) {
      const derived = derive({ session: finished, pullRequests });
      expect(derived.detail).toBeUndefined();
      expect(derived.certainty).toBe('partial');
    }
  });
});

describe('stable lane order', () => {
  const at = (
    id: string,
    updatedAt: string,
    priority: TaskRecord['priority'] = 'normal',
  ) =>
    deriveTaskLane({
      task: task({ id, status: 'ready', updatedAt, priority }),
      session: undefined,
      pullRequests: [],
    });

  test('first render seeds by priority, then most recent, then id', () => {
    const { lanes } = partitionTaskLanes([
      at('b', '2026-11-01T00:00:00.000Z'),
      at('a', '2026-11-01T00:00:00.000Z'),
      at('c', '2026-11-05T00:00:00.000Z'),
      at('u', '2026-10-01T00:00:00.000Z', 'urgent'),
    ]);
    expect(lanes.find((lane) => lane.id === 'idle')?.taskIds).toEqual([
      'u',
      'c',
      'a',
      'b',
    ]);
  });

  test('a card keeps its place when its updatedAt changes; an arrival goes on top', () => {
    const first = partitionTaskLanes([
      at('a', '2026-11-05T00:00:00.000Z'),
      at('b', '2026-11-01T00:00:00.000Z'),
    ]);
    const previous = new Map(
      first.lanes.map((lane) => [lane.id, lane.taskIds]),
    );
    const next = partitionTaskLanes(
      [
        at('a', '2026-11-05T00:00:00.000Z'),
        at('b', '2026-11-20T00:00:00.000Z'),
        at('n', '2026-10-01T00:00:00.000Z'),
      ],
      previous,
    );
    expect(next.lanes.find((lane) => lane.id === 'idle')?.taskIds).toEqual([
      'n',
      'a',
      'b',
    ]);
  });

  test('every lane is returned, empty or not, in reading order', () => {
    expect(partitionTaskLanes([]).lanes.map((lane) => lane.label)).toEqual([
      'Needs you',
      'Running',
      'In review',
      'Ready to merge',
      'Idle',
    ]);
  });

  test('the Done shelf keeps the 20 most recent and counts them all', () => {
    const done = Array.from({ length: 23 }, (_, index) =>
      deriveTaskLane({
        task: task({
          id: `d${index}`,
          status: 'done',
          updatedAt: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        }),
        session: undefined,
        pullRequests: undefined,
      }),
    );
    const { shelves, shelfTotals } = partitionTaskLanes(done);
    expect(shelves.done).toHaveLength(20);
    expect(shelves.done[0]).toBe('d22');
    expect(shelfTotals.done).toBe(23);
  });
});

describe('agent feedback adds a note, never a lane', () => {
  const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const withFeedback = (
    feedback: TaskPullRequestFact['feedback'],
    status: Parameters<typeof pr>[1] = {},
  ): TaskPullRequestFact => ({
    ...pr('42', { readiness: 'checks-not-passing', headSha: HEAD, ...status }),
    ...(feedback ? { feedback } : {}),
  });
  /** Everything but the note: what feedback must never change. */
  const placement = (d: TaskLaneDerivation) => {
    const { feedbackNote: _note, ...rest } = d;
    return rest;
  };

  test.each<[TaskPullRequestFeedbackFact['state'], string, string | undefined]>(
    [
      ['watching', 'auto-fix on', undefined],
      ['waiting-on-checks', 'waiting on checks', undefined],
      ['sent', 'sent', '2026-11-15T11:57:00.000Z'],
      ['paused', 'auto-fix paused', undefined],
    ],
  )('In review: %s reads "%s"', (state, text, at) => {
    const plain = derive({ pullRequests: [withFeedback(undefined)] });
    const noted = derive({
      pullRequests: [
        withFeedback({ state, headSha: HEAD, ...(at ? { at } : {}) }),
      ],
    });
    expect(placed(noted)).toBe('lane:in_review');
    expect(noted.feedbackNote).toEqual({ text, ...(at ? { at } : {}) });
    expect(noted.detail).toBe('#42');
    // Lane, rung, tone, certainty, words and action: all as without it.
    expect(placement(noted)).toEqual(
      placement({
        ...plain,
        evidence: {
          ...plain.evidence,
          pullRequests: noted.evidence.pullRequests,
        },
      }),
    );
  });

  test('only while it is about the head the provider reported', () => {
    for (const headSha of [undefined, 'f'.repeat(40)])
      expect(
        derive({
          pullRequests: [
            withFeedback({ state: 'watching', headSha: HEAD }, { headSha }),
          ],
        }).feedbackNote,
      ).toBeUndefined();
  });

  test('fixing names the pull request on a Running card, and still shows on an In review one', () => {
    const fixing = withFeedback({ state: 'fixing', headSha: HEAD });
    const running = derive({
      session: session({ ...RUNNING }),
      pullRequests: [fixing],
    });
    expect(placed(running)).toBe('lane:running');
    expect(running.rung).toBe('running');
    expect(running.tone).toBe('active');
    expect(running.feedbackNote).toEqual({ text: 'fixing checks on #42' });
    // The facts say this Task's run is fixing, but the run list read it as
    // finished: the In review card still says so instead of hiding it.
    const idle = derive({ pullRequests: [fixing] });
    expect(placed(idle)).toBe('lane:in_review');
    expect(idle.feedbackNote).toEqual({ text: 'fixing checks' });
    // A Running card says nothing for feedback that is not a fix in flight.
    expect(
      derive({
        session: session({ ...RUNNING }),
        pullRequests: [withFeedback({ state: 'sent', headSha: HEAD })],
      }).feedbackNote,
    ).toBeUndefined();
  });

  test('a ready pull request is not noted, and stays ready', () => {
    const ready = derive({
      pullRequests: [
        withFeedback(
          { state: 'watching', headSha: HEAD },
          { readiness: 'clean' },
        ),
      ],
    });
    expect(placed(ready)).toBe('lane:ready_to_merge');
    expect(ready.feedbackNote).toBeUndefined();
  });
});
