import type {
  OrchestrationSessionSummary,
  TurnProgressObservation,
} from '@kontourai/station-contracts/orchestration';

/**
 * Session summaries as the SERVER folds them, for client tests that need the
 * real shape rather than a guess at it (#3042).
 *
 * Each fixture is a literal event sequence and the literal summary fields
 * the fold produces for it. `src-server/services/orchestration/__tests__/
 * session-summary-fold-fixtures.test.ts` drives every sequence through the
 * real event store, `ConversationTurnActivityProjection` and
 * `buildOrchestrationSessionSummary` and requires the result to equal the
 * literal here, key for key, over `FOLD_FIXTURE_KEYS`. A change to the fold
 * therefore fails that test, and the client tests that import these
 * literals are then updated against the new truth instead of drifting.
 *
 * To regenerate `SUMMARIES` after an intended fold change, run that test
 * with `FOLD_FIXTURES_DUMP=<file>` and paste the result.
 *
 * The client test cannot run the fold itself: `typecheck:ui` does not
 * resolve the server module graph.
 */

export type FoldEvent = Record<string, unknown> & { method: string };

export interface FoldFixtureOptions {
  /** Children the engine reports running under the thread. */
  runningChildren?: number;
  /** The serving process no longer holds the thread or its provider. */
  detached?: boolean;
  /**
   * After the last event, the turn-stall watchdog's clock runs this long
   * with nothing arriving, so the real `TurnProgressTracker` writes its
   * silence marker.
   */
  silentForMs?: number;
}

/**
 * A fixture's summary: the contract's shape over the fields the fold test
 * pins, typed rather than asserted so the compiler checks every literal.
 *
 * `turnProgress` is the one place the wire carries more than the contract
 * declares: `TurnProgressTracker.recordProgress` keeps `threadId` and
 * `turnId` on the stored observation and the summary serializes it as-is,
 * so an exact fixture has to carry them. Nothing in the client reads them;
 * `TurnProgressObservation` is still what consumers are scoped to.
 */
export type FoldSummary = Partial<
  Omit<OrchestrationSessionSummary, 'turnProgress'>
> & {
  turnProgress?: TurnProgressObservation & { threadId: string; turnId: string };
};

export interface FoldFixture {
  events: readonly FoldEvent[];
  options?: FoldFixtureOptions;
  summary: FoldSummary;
}

/** The summary fields the inbox status code reads; compared exactly. */
export const FOLD_FIXTURE_KEYS: readonly (keyof OrchestrationSessionSummary)[] =
  [
    'threadId',
    'status',
    'controlMode',
    'lifecycleState',
    'previousLifecycleState',
    'transitionReason',
    'transitionSource',
    'pendingReview',
    'blockedReason',
    'hasActiveTurn',
    'terminalAttribution',
    'answerability',
    'conversationActivity',
    'draft',
    'turnProgress',
    'updatedAt',
  ];

/** The fold's clock: the session exists from :01, events land one second
 *  apart from :03, so a sequence's first event is at `FOLD_FIRST_EVENT_AT`. */
export const FOLD_SESSION_CREATED_AT = '2026-09-30T10:00:01.000Z';
export const FOLD_FIRST_EVENT_AT = '2026-09-30T10:00:03.000Z';
export const FOLD_OBSERVED_AT = '2026-09-30T10:00:10.000Z';

const TURN: FoldEvent = { method: 'turn.started', turnId: 't1', prompt: 'go' };
const BASH: FoldEvent = {
  method: 'tool.started',
  itemId: 'c1',
  toolCallId: 'c1',
  toolName: 'Bash',
};
const APPROVAL: FoldEvent = {
  method: 'request.opened',
  requestId: 'r1',
  requestType: 'approval',
  title: 'Run pnpm db:migrate',
};
/** Interrupted-turn recovery: its abort, then its `needs_input` stamp. */
const RECOVERY: FoldEvent[] = [
  {
    method: 'turn.aborted',
    turnId: 't1',
    reason: 'Turn interrupted',
    recoveryTerminal: true,
  },
  {
    method: 'session.state-changed',
    sessionId: 'T',
    from: 'running',
    to: 'awaiting-approval',
    reason: 'Turn interrupted',
    sessionState: 'needs_input',
    transitionReason: 'runtime_exit',
    transitionSource: 'system_recovery',
  },
];

const SEQUENCES = {
  /** A session nothing has been sent to. */
  draft: { events: [] as FoldEvent[] },
  runningTool: { events: [TURN, BASH] },
  runningWithChildren: {
    events: [TURN, BASH],
    options: { runningChildren: 3 },
  },
  /** The watchdog's default window is 180s; the turn has been silent 6m. */
  silentRun: { events: [TURN, BASH], options: { silentForMs: 360_000 } },
  approvalInOpenTurn: { events: [TURN, BASH, APPROVAL] },
  detachedApproval: {
    events: [TURN, BASH, APPROVAL],
    options: { detached: true },
  },
  questionInOpenTurn: {
    events: [
      TURN,
      {
        method: 'request.opened',
        requestId: 'r1',
        requestType: 'input',
        title: 'Which database?',
      },
    ],
  },
  interrupted: { events: [TURN, ...RECOVERY] },
  approvalSettledByInterruption: { events: [TURN, APPROVAL, ...RECOVERY] },
  blocked: {
    events: [
      {
        method: 'session.state-changed',
        sessionId: 'T',
        from: 'running',
        to: 'blocked',
        reason: 'raw adapter text',
        sessionState: 'blocked',
        transitionReason: 'blocked_by_user',
        transitionSource: 'user_action',
      },
    ],
  },
  turnCompleted: { events: [TURN, { method: 'turn.completed', turnId: 't1' }] },
  /** The turn ended (`idle` since #2540) while its sub-agents kept running. */
  idleWithChildren: {
    events: [TURN, { method: 'turn.completed', turnId: 't1' }],
    options: { runningChildren: 2 },
  },
  failed: {
    events: [
      TURN,
      {
        method: 'runtime.error',
        severity: 'error',
        message: 'rate limit',
        turnId: 't1',
      },
    ],
  },
} satisfies Record<string, Pick<FoldFixture, 'events' | 'options'>>;

export type FoldFixtureName = keyof typeof SEQUENCES;

// GENERATED by the fold (see the header). Typed, never asserted
// (station#1778), so every literal is checked against the wire shape; the
// summaries are Partial, so completeness is the server test's job: it
// compares each one to the real fold key for key.
const SUMMARIES: Record<FoldFixtureName, FoldSummary> = {
  draft: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'running',
    pendingReview: false,
    hasActiveTurn: false,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 0,
    },
    draft: true,
    updatedAt: '2026-09-30T10:00:02.000Z',
  },
  runningTool: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'running',
    previousLifecycleState: 'running',
    transitionReason: 'turn_started',
    transitionSource: 'runtime',
    pendingReview: false,
    hasActiveTurn: true,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 2,
      openTurn: {
        turnId: 't1',
        threadId: 'T',
        startedAt: '2026-09-30T10:00:03.000Z',
      },
      runningTools: [
        {
          name: 'Bash',
          callId: 'c1',
          startedAt: '2026-09-30T10:00:04.000Z',
        },
      ],
      lastActivityAt: '2026-09-30T10:00:04.000Z',
    },
    draft: false,
    turnProgress: {
      threadId: 'T',
      turnId: 't1',
      lastProgressEventAt: '2026-09-30T10:00:04.000Z',
    },
    updatedAt: '2026-09-30T10:00:04.000Z',
  },
  runningWithChildren: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'running',
    previousLifecycleState: 'running',
    transitionReason: 'turn_started',
    transitionSource: 'runtime',
    pendingReview: false,
    hasActiveTurn: true,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 2,
      runningChildWork: {
        count: 3,
        producers: ['engine-subagent'],
      },
      openTurn: {
        turnId: 't1',
        threadId: 'T',
        startedAt: '2026-09-30T10:00:03.000Z',
      },
      runningTools: [
        {
          name: 'Bash',
          callId: 'c1',
          startedAt: '2026-09-30T10:00:04.000Z',
        },
      ],
      lastActivityAt: '2026-09-30T10:00:04.000Z',
    },
    draft: false,
    turnProgress: {
      threadId: 'T',
      turnId: 't1',
      lastProgressEventAt: '2026-09-30T10:00:04.000Z',
    },
    updatedAt: '2026-09-30T10:00:04.000Z',
  },
  silentRun: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'running',
    previousLifecycleState: 'running',
    transitionReason: 'turn_started',
    transitionSource: 'runtime',
    pendingReview: false,
    hasActiveTurn: true,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 2,
      openTurn: {
        turnId: 't1',
        threadId: 'T',
        startedAt: '2026-09-30T10:00:03.000Z',
      },
      runningTools: [
        {
          name: 'Bash',
          callId: 'c1',
          startedAt: '2026-09-30T10:00:04.000Z',
        },
      ],
      progressSilence: {
        detectedAt: '2026-09-30T10:03:04.000Z',
        windowMs: 180000,
        silentSinceEventAt: '2026-09-30T10:00:04.000Z',
        provider: 'claude',
      },
      lastActivityAt: '2026-09-30T10:00:04.000Z',
    },
    draft: false,
    turnProgress: {
      threadId: 'T',
      turnId: 't1',
      lastProgressEventAt: '2026-09-30T10:00:04.000Z',
      progressSilence: {
        detectedAt: '2026-09-30T10:03:04.000Z',
        windowMs: 180000,
        silentSinceEventAt: '2026-09-30T10:00:04.000Z',
        provider: 'claude',
      },
    },
    updatedAt: '2026-09-30T10:00:04.000Z',
  },
  approvalInOpenTurn: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'review_pending',
    previousLifecycleState: 'running',
    transitionReason: 'review_requested',
    transitionSource: 'runtime',
    pendingReview: true,
    hasActiveTurn: true,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 3,
      openTurn: {
        turnId: 't1',
        threadId: 'T',
        startedAt: '2026-09-30T10:00:03.000Z',
      },
      runningTools: [
        {
          name: 'Bash',
          callId: 'c1',
          startedAt: '2026-09-30T10:00:04.000Z',
        },
      ],
      lastActivityAt: '2026-09-30T10:00:05.000Z',
    },
    draft: false,
    updatedAt: '2026-09-30T10:00:05.000Z',
  },
  detachedApproval: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'review_pending',
    previousLifecycleState: 'running',
    transitionReason: 'review_requested',
    transitionSource: 'runtime',
    pendingReview: true,
    hasActiveTurn: true,
    answerability: {
      answerable: false,
      observedBy: 'station-a',
      observedAt: '2026-09-30T10:00:10.000Z',
      qualification: 'provider_absent',
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 3,
      openTurn: {
        turnId: 't1',
        threadId: 'T',
        startedAt: '2026-09-30T10:00:03.000Z',
      },
      runningTools: [
        {
          name: 'Bash',
          callId: 'c1',
          startedAt: '2026-09-30T10:00:04.000Z',
        },
      ],
      lastActivityAt: '2026-09-30T10:00:05.000Z',
    },
    draft: false,
    updatedAt: '2026-09-30T10:00:05.000Z',
  },
  questionInOpenTurn: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'needs_input',
    previousLifecycleState: 'running',
    transitionReason: 'input_requested',
    transitionSource: 'runtime',
    pendingReview: false,
    hasActiveTurn: true,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 2,
      openTurn: {
        turnId: 't1',
        threadId: 'T',
        startedAt: '2026-09-30T10:00:03.000Z',
      },
      lastActivityAt: '2026-09-30T10:00:04.000Z',
    },
    draft: false,
    updatedAt: '2026-09-30T10:00:04.000Z',
  },
  interrupted: {
    threadId: 'T',
    status: 'ready',
    controlMode: 'station-owned',
    lifecycleState: 'needs_input',
    previousLifecycleState: 'needs_input',
    transitionReason: 'runtime_exit',
    transitionSource: 'system_recovery',
    pendingReview: false,
    hasActiveTurn: false,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 3,
      lastActivityAt: '2026-09-30T10:00:05.000Z',
    },
    draft: false,
    updatedAt: '2026-09-30T10:00:05.000Z',
  },
  approvalSettledByInterruption: {
    threadId: 'T',
    status: 'ready',
    controlMode: 'station-owned',
    lifecycleState: 'needs_input',
    previousLifecycleState: 'needs_input',
    transitionReason: 'runtime_exit',
    transitionSource: 'system_recovery',
    pendingReview: false,
    hasActiveTurn: false,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 4,
      lastActivityAt: '2026-09-30T10:00:06.000Z',
    },
    draft: false,
    updatedAt: '2026-09-30T10:00:06.000Z',
  },
  blocked: {
    threadId: 'T',
    status: 'ready',
    controlMode: 'station-owned',
    lifecycleState: 'blocked',
    previousLifecycleState: 'blocked',
    transitionReason: 'blocked_by_user',
    transitionSource: 'user_action',
    pendingReview: false,
    blockedReason: 'raw adapter text',
    hasActiveTurn: false,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 1,
      lastActivityAt: '2026-09-30T10:00:03.000Z',
    },
    draft: true,
    updatedAt: '2026-09-30T10:00:03.000Z',
  },
  turnCompleted: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'idle',
    previousLifecycleState: 'running',
    transitionReason: 'turn_completed',
    transitionSource: 'runtime',
    pendingReview: false,
    hasActiveTurn: false,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 2,
      lastActivityAt: '2026-09-30T10:00:04.000Z',
    },
    draft: false,
    updatedAt: '2026-09-30T10:00:04.000Z',
  },
  idleWithChildren: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'idle',
    previousLifecycleState: 'running',
    transitionReason: 'turn_completed',
    transitionSource: 'runtime',
    pendingReview: false,
    hasActiveTurn: false,
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 2,
      runningChildWork: {
        count: 2,
        producers: ['engine-subagent'],
      },
      lastActivityAt: '2026-09-30T10:00:04.000Z',
    },
    draft: false,
    updatedAt: '2026-09-30T10:00:04.000Z',
  },
  failed: {
    threadId: 'T',
    status: 'running',
    controlMode: 'station-owned',
    lifecycleState: 'failed',
    previousLifecycleState: 'running',
    transitionReason: 'runtime_error',
    transitionSource: 'runtime',
    pendingReview: false,
    blockedReason: 'rate limit',
    hasActiveTurn: false,
    terminalAttribution: {
      kind: 'runtime_error',
      detail: 'The engine reported an error: rate limit',
    },
    answerability: {
      answerable: true,
    },
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 2,
      lastActivityAt: '2026-09-30T10:00:04.000Z',
    },
    draft: false,
    updatedAt: '2026-09-30T10:00:04.000Z',
  },
};

function fixture(name: FoldFixtureName): FoldFixture {
  return { ...SEQUENCES[name], summary: SUMMARIES[name] };
}

// Written out by name so the type holds the table complete: a sequence
// without a summary, or a summary without a sequence, is a compile error.
export const FOLD_FIXTURES: Record<FoldFixtureName, FoldFixture> = {
  draft: fixture('draft'),
  runningTool: fixture('runningTool'),
  runningWithChildren: fixture('runningWithChildren'),
  silentRun: fixture('silentRun'),
  approvalInOpenTurn: fixture('approvalInOpenTurn'),
  detachedApproval: fixture('detachedApproval'),
  questionInOpenTurn: fixture('questionInOpenTurn'),
  interrupted: fixture('interrupted'),
  approvalSettledByInterruption: fixture('approvalSettledByInterruption'),
  blocked: fixture('blocked'),
  turnCompleted: fixture('turnCompleted'),
  idleWithChildren: fixture('idleWithChildren'),
  failed: fixture('failed'),
};
