/**
 * #3071: event logs and the session summaries the REAL fold produces from
 * them, for the four states a client has to tell apart on an inbox row.
 *
 * The `*_SUMMARY` literals are what `buildOrchestrationSessionSummary` returns
 * for the log beside them; `request-turn-settlement.test.ts` asserts each one
 * with `toEqual`, so a literal here cannot drift from the fold. Client tests
 * that need fold output copy or import these rather than hand-writing a
 * summary the server never emits.
 *
 * The recovery events use the exact shape `InterruptedTurnRecovery.consume()`
 * writes (`interrupted-turn-recovery.ts`): deterministic event ids, the
 * `recoveryTerminal` marker, and the banner's `interruptedTurnBoundary`.
 */
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { TURN_INTERRUPTED_MESSAGE } from '@kontourai/station-shared/runtime-event-projection';
import type { SessionAnswerabilityObservation } from '../../open-requests.js';

export const SETTLEMENT_THREAD_ID = 'thread-settle';
const PROVIDER = 'claude';
const BOUNDARY_ID = 'boundary-1';

export const SETTLEMENT_SESSION: ProviderSession = {
  provider: PROVIDER,
  threadId: SETTLEMENT_THREAD_ID,
  status: 'ready',
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:09.000Z',
};

/** The serving process holds the thread, as it does once recovery re-attached it. */
export const SETTLEMENT_OBSERVATION: SessionAnswerabilityObservation = {
  threadAttachment: 'attached',
  providerRegistered: true,
  observedBy: 'test-instance#0',
  observedAt: '2026-09-30T10:00:10.000Z',
};

const base = { provider: PROVIDER, threadId: SETTLEMENT_THREAD_ID };

export function turnStarted(
  turnId: string,
  second: number,
): CanonicalRuntimeEvent {
  return {
    ...base,
    eventId: `evt-start-${turnId}`,
    createdAt: at(second),
    method: 'turn.started',
    turnId,
    prompt: 'go',
  };
}

export function turnCompleted(
  turnId: string,
  second: number,
  finishReason?: 'stop' | 'cancelled',
): CanonicalRuntimeEvent {
  return {
    ...base,
    eventId: `evt-done-${turnId}-${second}`,
    createdAt: at(second),
    method: 'turn.completed',
    turnId,
    ...(finishReason ? { finishReason } : {}),
  };
}

export function turnAborted(
  turnId: string,
  second: number,
  reason = 'stopped',
): CanonicalRuntimeEvent {
  return {
    ...base,
    eventId: `evt-abort-${turnId}-${second}`,
    createdAt: at(second),
    method: 'turn.aborted',
    turnId,
    reason,
  };
}

export function requestOpened(
  requestId: string,
  second: number,
  overrides: Partial<
    Extract<CanonicalRuntimeEvent, { method: 'request.opened' }>
  > = {},
): Extract<CanonicalRuntimeEvent, { method: 'request.opened' }> {
  return {
    ...base,
    eventId: `evt-open-${requestId}-${second}`,
    createdAt: at(second),
    method: 'request.opened',
    requestId,
    requestType: 'approval',
    title: 'Allow bash',
    ...overrides,
  };
}

export function requestResolved(
  requestId: string,
  second: number,
  status: 'approved' | 'denied' | 'cancelled' | 'expired' = 'approved',
): CanonicalRuntimeEvent {
  return {
    ...base,
    eventId: `evt-resolve-${requestId}-${second}`,
    createdAt: at(second),
    method: 'request.resolved',
    requestId,
    status,
  };
}

export function runtimeError(
  second: number,
  overrides: Partial<
    Extract<CanonicalRuntimeEvent, { method: 'runtime.error' }>
  > = {},
): CanonicalRuntimeEvent {
  return {
    ...base,
    eventId: `evt-error-${second}`,
    createdAt: at(second),
    method: 'runtime.error',
    severity: 'error',
    message: 'boom',
    ...overrides,
  };
}

/** The resolution recovery writes for a request its dead turn left open. */
function recoveryRequestResolved(
  requestId: string,
  turnId: string,
  second: number,
): CanonicalRuntimeEvent {
  return {
    ...base,
    eventId: `turn-interrupted-request:${BOUNDARY_ID}:${requestId}`,
    createdAt: at(second),
    method: 'request.resolved',
    turnId,
    requestId,
    status: 'expired',
    response: { reason: 'turn-interrupted' },
  };
}

/** Recovery's terminal for the dead turn, then its `needs_input` banner. */
export function recoveryAbortAndBanner(
  turnId: string,
  second: number,
  boundaryId = BOUNDARY_ID,
): CanonicalRuntimeEvent[] {
  return [
    {
      ...base,
      eventId: `turn-interrupted-abort:${boundaryId}`,
      createdAt: at(second),
      method: 'turn.aborted',
      turnId,
      reason: TURN_INTERRUPTED_MESSAGE,
      recoveryTerminal: true,
    },
    {
      ...base,
      eventId: `turn-interrupted:${boundaryId}`,
      createdAt: at(second),
      method: 'session.state-changed',
      sessionId: SETTLEMENT_THREAD_ID,
      from: 'running',
      to: 'awaiting-approval',
      reason: TURN_INTERRUPTED_MESSAGE,
      sessionState: 'needs_input',
      transitionReason: 'runtime_exit',
      transitionSource: 'system_recovery',
      interruptedTurnBoundary: {
        boundaryId,
        priorState: 'accepted',
        providerTurnId: turnId,
        ownerId: 'owner-1',
        boundaryCreatedAt: at(1),
        boundaryUpdatedAt: at(1),
      },
    },
  ];
}

function at(second: number): string {
  return `2026-09-30T10:00:${String(second).padStart(2, '0')}.000Z`;
}

/**
 * `turn.started → request.opened(approval) → restart`, as recovery writes it
 * since #3071: the request is resolved `expired` before the abort.
 */
export const INTERRUPTED_WITH_SETTLED_APPROVAL_EVENTS: CanonicalRuntimeEvent[] =
  [
    turnStarted('turn-1', 1),
    requestOpened('req-1', 2),
    recoveryRequestResolved('req-1', 'turn-1', 5),
    ...recoveryAbortAndBanner('turn-1', 5),
  ];

/**
 * The same crash in a log written BEFORE #3071: recovery aborted the turn and
 * bannered, and nothing resolved the request. The fold settles it on read.
 */
export const INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS: CanonicalRuntimeEvent[] =
  [
    turnStarted('turn-1', 1),
    requestOpened('req-1', 2),
    ...recoveryAbortAndBanner('turn-1', 5),
  ];

export const INTERRUPTED_WITH_NO_REQUEST_EVENTS: CanonicalRuntimeEvent[] = [
  turnStarted('turn-1', 1),
  ...recoveryAbortAndBanner('turn-1', 5),
];

/** An approval raised after its turn finished; nothing interrupted it. */
export const APPROVAL_BETWEEN_TURNS_EVENTS: CanonicalRuntimeEvent[] = [
  turnStarted('turn-1', 1),
  turnCompleted('turn-1', 3, 'stop'),
  requestOpened('req-1', 4),
];

/** A question raised after its turn finished; nothing interrupted it. */
export const QUESTION_BETWEEN_TURNS_EVENTS: CanonicalRuntimeEvent[] = [
  turnStarted('turn-1', 1),
  turnCompleted('turn-1', 3, 'stop'),
  requestOpened('req-1', 4, {
    requestType: 'input',
    title: 'Which branch?',
  }),
];

const SUMMARY_BASE = {
  provider: PROVIDER,
  threadId: SETTLEMENT_THREAD_ID,
  status: 'ready',
  controlMode: 'station-owned',
  answerability: { answerable: true },
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:09.000Z',
  isLoaded: false,
  isPersisted: true,
  displayTitle: 'go',
  draft: false,
} as const;

/**
 * Interrupted with its approval settled. Identical for the post-#3071 log
 * (resolved at the source) and the pre-#3071 log (settled by the fold),
 * except `eventCount`.
 */
export const INTERRUPTED_WITH_SETTLED_APPROVAL_SUMMARY: OrchestrationSessionSummary =
  {
    ...SUMMARY_BASE,
    eventCount: 5,
    lifecycleState: 'needs_input',
    previousLifecycleState: 'needs_input',
    transitionReason: 'runtime_exit',
    transitionSource: 'system_recovery',
    pendingReview: false,
    lastEventAt: '2026-09-30T10:00:05.000Z',
    lastEventMethod: 'session.state-changed',
    openRequestIds: [],
    blockingOpenRequestIds: [],
    hasActiveTurn: false,
  };

export const INTERRUPTED_WITH_NO_REQUEST_SUMMARY: OrchestrationSessionSummary =
  {
    ...SUMMARY_BASE,
    eventCount: 3,
    lifecycleState: 'needs_input',
    previousLifecycleState: 'needs_input',
    transitionReason: 'runtime_exit',
    transitionSource: 'system_recovery',
    pendingReview: false,
    lastEventAt: '2026-09-30T10:00:05.000Z',
    lastEventMethod: 'session.state-changed',
    openRequestIds: [],
    blockingOpenRequestIds: [],
    hasActiveTurn: false,
  };

export const APPROVAL_BETWEEN_TURNS_SUMMARY: OrchestrationSessionSummary = {
  ...SUMMARY_BASE,
  eventCount: 3,
  lifecycleState: 'review_pending',
  previousLifecycleState: 'idle',
  transitionReason: 'review_requested',
  transitionSource: 'runtime',
  pendingReview: true,
  lastEventAt: '2026-09-30T10:00:04.000Z',
  lastEventMethod: 'request.opened',
  openRequestIds: ['req-1'],
  blockingOpenRequestIds: ['req-1'],
  hasActiveTurn: false,
};

export const QUESTION_BETWEEN_TURNS_SUMMARY: OrchestrationSessionSummary = {
  ...SUMMARY_BASE,
  eventCount: 3,
  lifecycleState: 'needs_input',
  previousLifecycleState: 'idle',
  transitionReason: 'input_requested',
  transitionSource: 'runtime',
  pendingReview: false,
  lastEventAt: '2026-09-30T10:00:04.000Z',
  lastEventMethod: 'request.opened',
  openRequestIds: ['req-1'],
  blockingOpenRequestIds: ['req-1'],
  hasActiveTurn: false,
};
