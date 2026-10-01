/**
 * #3071 — a request whose own turn was aborted is settled.
 *
 * Every case here goes through the REAL folds: `projectSessionLifecycle` and
 * `buildOrchestrationSessionSummary` for the session, `collectOpenRequests`
 * for the surfaces that list requests. The summary literals asserted with
 * `toEqual` live in `helpers/request-settlement-fixtures.ts` so client tests
 * can use the same shapes.
 */
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { collectOpenRequests } from '../open-requests.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';
import {
  foldRequestTurnOwnership,
  projectSessionLifecycle,
} from '../session-lifecycle-service.js';
import {
  APPROVAL_BETWEEN_TURNS_EVENTS,
  APPROVAL_BETWEEN_TURNS_SUMMARY,
  INTERRUPTED_WITH_NO_REQUEST_EVENTS,
  INTERRUPTED_WITH_NO_REQUEST_SUMMARY,
  INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS,
  INTERRUPTED_WITH_SETTLED_APPROVAL_EVENTS,
  INTERRUPTED_WITH_SETTLED_APPROVAL_SUMMARY,
  QUESTION_BETWEEN_TURNS_EVENTS,
  QUESTION_BETWEEN_TURNS_SUMMARY,
  recoveryAbortAndBanner,
  requestOpened,
  requestResolved,
  runtimeError,
  SETTLEMENT_OBSERVATION,
  SETTLEMENT_SESSION,
  SETTLEMENT_THREAD_ID,
  turnAborted,
  turnCompleted,
  turnStarted,
} from './helpers/request-settlement-fixtures.js';

/**
 * The summary a route emits: `openRequestIds` is the store's unresolved set
 * (every `request.opened` with no later `request.resolved`), which is what
 * `EventStore.listOpenRequestIdsByThreads` hands the builder.
 */
function summarize(events: CanonicalRuntimeEvent[]) {
  const unresolved = new Map<string, true>();
  for (const event of events) {
    if (event.method === 'request.opened')
      unresolved.set(event.requestId, true);
    if (event.method === 'request.resolved') unresolved.delete(event.requestId);
  }
  return buildOrchestrationSessionSummary({
    persisted: SETTLEMENT_SESSION,
    events,
    answerability: SETTLEMENT_OBSERVATION,
    openRequestIds: [...unresolved.keys()],
  });
}

function lifecycle(events: CanonicalRuntimeEvent[]) {
  return projectSessionLifecycle({ session: SETTLEMENT_SESSION, events });
}

describe('#3071: the four inbox-row summaries, as the fold emits them', () => {
  test('interrupted turn with its approval resolved by recovery: the recovery stamp stands', () => {
    expect(summarize(INTERRUPTED_WITH_SETTLED_APPROVAL_EVENTS)).toEqual(
      INTERRUPTED_WITH_SETTLED_APPROVAL_SUMMARY,
    );
  });

  test('a log from before #3071 (abort and banner, request never resolved) reads the same', () => {
    // The issue's exact sequence. Before the fix this read review_pending /
    // review_requested / pendingReview: true over the recovery stamp, with
    // the dead request still listed.
    const summary = summarize(INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS);
    expect(summary).toEqual({
      ...INTERRUPTED_WITH_SETTLED_APPROVAL_SUMMARY,
      eventCount: INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS.length,
    });
    expect(lifecycle(INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS)).toEqual({
      lifecycleState: 'needs_input',
      previousLifecycleState: 'needs_input',
      transitionReason: 'runtime_exit',
      transitionSource: 'system_recovery',
      pendingReview: false,
    });
    expect(
      collectOpenRequests(INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS).size,
    ).toBe(0);
  });

  test('interrupted turn that had no request', () => {
    expect(summarize(INTERRUPTED_WITH_NO_REQUEST_EVENTS)).toEqual(
      INTERRUPTED_WITH_NO_REQUEST_SUMMARY,
    );
  });

  test('an approval between turns that nothing interrupted still needs approval', () => {
    expect(summarize(APPROVAL_BETWEEN_TURNS_EVENTS)).toEqual(
      APPROVAL_BETWEEN_TURNS_SUMMARY,
    );
    expect([
      ...collectOpenRequests(APPROVAL_BETWEEN_TURNS_EVENTS).keys(),
    ]).toEqual(['req-1']);
  });

  test('a question between turns still needs an answer', () => {
    expect(summarize(QUESTION_BETWEEN_TURNS_EVENTS)).toEqual(
      QUESTION_BETWEEN_TURNS_SUMMARY,
    );
  });
});

describe('#3071: requests that stay open', () => {
  test('a question between turns survives a later restart banner for a turn that never owned it', () => {
    // The question was asked at rest; a later turn starts, dies in a crash,
    // and recovery aborts and banners it. The abort names turn-2, which the
    // question never belonged to.
    const events = [
      ...QUESTION_BETWEEN_TURNS_EVENTS,
      turnStarted('turn-2', 6),
      ...recoveryAbortAndBanner('turn-2', 8),
    ];
    expect([...collectOpenRequests(events).keys()]).toEqual(['req-1']);
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'needs_input',
      transitionReason: 'runtime_exit',
      pendingReview: false,
      openRequestIds: ['req-1'],
      blockingOpenRequestIds: ['req-1'],
    });
  });

  test('a question between turns survives a re-attach', () => {
    const events: CanonicalRuntimeEvent[] = [
      ...QUESTION_BETWEEN_TURNS_EVENTS,
      {
        provider: 'claude',
        threadId: SETTLEMENT_THREAD_ID,
        eventId: 'evt-reattach',
        createdAt: '2026-09-30T10:00:07.000Z',
        method: 'session.configured',
        sessionId: SETTLEMENT_THREAD_ID,
      },
    ];
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'needs_input',
      transitionReason: 'input_requested',
      openRequestIds: ['req-1'],
    });
  });

  test('an approval between turns survives a later turn being aborted', () => {
    const events = [
      ...APPROVAL_BETWEEN_TURNS_EVENTS,
      turnStarted('turn-2', 6),
      turnAborted('turn-2', 7),
    ];
    expect(foldRequestTurnOwnership(events).settledRequestIds.size).toBe(0);
    expect([...collectOpenRequests(events).keys()]).toEqual(['req-1']);
  });

  test('an approval pausing a turn that is still open stays pending', () => {
    const events = [turnStarted('turn-1', 1), requestOpened('req-1', 2)];
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'review_pending',
      transitionReason: 'review_requested',
      pendingReview: true,
      hasActiveTurn: true,
      openRequestIds: ['req-1'],
      blockingOpenRequestIds: ['req-1'],
    });
  });

  test('a turn retrying after a deferred error keeps its approval', () => {
    const events = [
      turnStarted('turn-1', 1),
      // Codex's `willRetry` error: the one error that does not end its turn
      // (`isDeferredRetriableTurnError`).
      runtimeError(2, { provider: 'codex', turnId: 'turn-1', retriable: true }),
      requestOpened('req-1', 3),
    ];
    const { ownerTurnIdByOpenRequestId, settledRequestIds } =
      foldRequestTurnOwnership(events);
    expect(ownerTurnIdByOpenRequestId.get('req-1')).toBe('turn-1');
    expect(settledRequestIds.size).toBe(0);
  });

  test('a failure with no abort leaves the approval outstanding (archive#1548)', () => {
    const events = [
      turnStarted('turn-1', 1),
      requestOpened('req-1', 2),
      runtimeError(3, { turnId: 'turn-1' }),
    ];
    expect(lifecycle(events)).toMatchObject({
      lifecycleState: 'failed',
      pendingReview: true,
    });
    expect([...collectOpenRequests(events).keys()]).toEqual(['req-1']);
  });

  test('an ordinary completion does not settle a request: a background subagent can still be waiting on it', () => {
    const events = [
      turnStarted('turn-1', 1),
      requestOpened('req-1', 2),
      turnCompleted('turn-1', 3, 'stop'),
    ];
    expect(foldRequestTurnOwnership(events).settledRequestIds.size).toBe(0);
    expect([...collectOpenRequests(events).keys()]).toEqual(['req-1']);
  });

  test('an abort of an earlier turn does not settle the current turn’s request', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnStarted('turn-2', 2),
      requestOpened('req-2', 3),
      turnAborted('turn-1', 4),
    ];
    expect(foldRequestTurnOwnership(events).settledRequestIds.size).toBe(0);
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'review_pending',
      pendingReview: true,
      openRequestIds: ['req-2'],
    });
  });

  test('a request re-opened after its turn was aborted is a new ask', () => {
    const events = [
      turnStarted('turn-1', 1),
      requestOpened('req-1', 2),
      turnAborted('turn-1', 3),
      turnCompleted('turn-1', 4, 'cancelled'),
      requestOpened('req-1', 5),
    ];
    expect(foldRequestTurnOwnership(events).settledRequestIds.size).toBe(0);
    expect([...collectOpenRequests(events).keys()]).toEqual(['req-1']);
  });
});

describe('#3071: requests an aborted turn settles', () => {
  test('a user-stopped turn with an open approval: stopped, nothing pending, and a new turn does not revive it', () => {
    const stopped = [
      turnStarted('turn-1', 1),
      requestOpened('req-1', 2),
      turnAborted('turn-1', 3, 'user stopped it'),
    ];
    expect(summarize(stopped)).toMatchObject({
      lifecycleState: 'canceled',
      transitionReason: 'user_canceled',
      pendingReview: false,
      hasActiveTurn: false,
      openRequestIds: [],
      blockingOpenRequestIds: [],
    });
    expect(collectOpenRequests(stopped).size).toBe(0);

    // Before the fix the dead approval came back the moment the session was
    // resumable again: the next turn read review_pending with nothing to
    // approve.
    const continued = [...stopped, turnStarted('turn-2', 5)];
    expect(summarize(continued)).toMatchObject({
      lifecycleState: 'running',
      transitionReason: 'turn_started',
      pendingReview: false,
      hasActiveTurn: true,
      openRequestIds: [],
    });
  });

  test('an engine’s stop confirmation (turn.completed, cancelled) settles like an abort', () => {
    const events = [
      turnStarted('turn-1', 1),
      requestOpened('req-1', 2),
      turnCompleted('turn-1', 3, 'cancelled'),
      turnStarted('turn-2', 5),
    ];
    expect([...foldRequestTurnOwnership(events).settledRequestIds]).toEqual([
      'req-1',
    ]);
    expect(lifecycle(events)).toMatchObject({
      lifecycleState: 'running',
      pendingReview: false,
    });
  });

  test('an engine-failed turn that is aborted: failed, with no approval outstanding', () => {
    // `failed` can resume, so before the fix this approval read as
    // outstanding (pendingReview: true) with no turn left to take it.
    const events = [
      turnStarted('turn-1', 1),
      requestOpened('req-1', 2),
      turnAborted('turn-1', 3, 'engine failed'),
      runtimeError(3, { turnId: 'turn-1' }),
    ];
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'failed',
      pendingReview: false,
      hasActiveTurn: false,
      openRequestIds: [],
      blockingOpenRequestIds: [],
    });
    expect(collectOpenRequests(events).size).toBe(0);
  });

  test('a request that names its turn is settled by that turn’s abort even when another turn is open', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnStarted('turn-2', 2),
      requestOpened('req-1', 3, { turnId: 'turn-1' }),
      turnAborted('turn-1', 4),
    ];
    expect([...foldRequestTurnOwnership(events).settledRequestIds]).toEqual([
      'req-1',
    ]);
  });

  test('a question the aborted turn asked is settled with its approvals; a resolved one is left as resolved', () => {
    const events = [
      turnStarted('turn-1', 1),
      requestOpened('req-answered', 2),
      requestResolved('req-answered', 3),
      requestOpened('req-question', 4, { requestType: 'input' }),
      requestOpened('req-async', 5, { blocking: false }),
      turnAborted('turn-1', 6),
    ];
    expect([...foldRequestTurnOwnership(events).settledRequestIds]).toEqual([
      'req-question',
      'req-async',
    ]);
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'canceled',
      pendingReview: false,
      openRequestIds: [],
    });
  });
});
