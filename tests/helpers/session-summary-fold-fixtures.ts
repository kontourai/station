import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';

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
 * The client test cannot run the fold itself: `typecheck:ui` does not
 * resolve the server module graph.
 */

export type FoldEvent = Record<string, unknown> & { method: string };

export interface FoldFixtureOptions {
  /** Children the engine reports running under the thread. */
  runningChildren?: number;
  /** The serving process no longer holds the thread or its provider. */
  detached?: boolean;
  /** Stored on the session row, as a worktree session's is. */
  workspaceIsolation?: OrchestrationSessionSummary['workspaceIsolation'];
}

export interface FoldFixture {
  events: readonly FoldEvent[];
  options?: FoldFixtureOptions;
  summary: Partial<OrchestrationSessionSummary>;
}

/** The summary fields the inbox status code reads; compared exactly. */
export const FOLD_FIXTURE_KEYS = [
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
  'workspaceIsolation',
] as const satisfies readonly (keyof OrchestrationSessionSummary)[];

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

export const FOLD_FIXTURES = {
  runningTool: {
    events: [TURN, BASH],
    summary: {
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
    },
  },
  runningWithChildren: {
    events: [TURN, BASH],
    options: { runningChildren: 3 },
    summary: {
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
    },
  },
  approvalInOpenTurn: {
    events: [TURN, BASH, APPROVAL],
    summary: {
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
    },
  },
  detachedApproval: {
    events: [TURN, BASH, APPROVAL],
    options: { detached: true },
    summary: {
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
    },
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
    summary: {
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
    },
  },
  interrupted: {
    events: [TURN, ...RECOVERY],
    summary: {
      threadId: 'T',
      status: 'running',
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
    },
  },
  staleApprovalAfterInterruption: {
    events: [TURN, APPROVAL, ...RECOVERY],
    summary: {
      threadId: 'T',
      status: 'running',
      controlMode: 'station-owned',
      lifecycleState: 'review_pending',
      previousLifecycleState: 'needs_input',
      transitionReason: 'review_requested',
      transitionSource: 'runtime',
      pendingReview: true,
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
    },
  },
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
    summary: {
      threadId: 'T',
      status: 'running',
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
    },
  },
  turnCompleted: {
    events: [TURN, { method: 'turn.completed', turnId: 't1' }],
    summary: {
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
    },
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
    summary: {
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
    },
  },
  worktreeSession: {
    events: [TURN, BASH],
    options: {
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
    },
    summary: {
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
    },
  },
} satisfies Record<string, FoldFixture>;
