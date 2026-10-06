/**
 * #3071 — a request whose own turn was aborted is settled.
 *
 * Every case here goes through the REAL folds: `projectSessionLifecycle` and
 * `buildOrchestrationSessionSummary` for the session, `collectOpenRequests`
 * for the surfaces that list requests. The summary literals asserted with
 * `toEqual` live in `helpers/request-settlement-fixtures.ts` so client tests
 * can use the same shapes.
 */

import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { requestIdsSettledByTurnAbort } from '@kontourai/station-shared/request-settlement';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import { collectOpenRequests } from '../open-requests.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';
import { projectSessionLifecycle } from '../session-lifecycle-service.js';
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

const settled = (events: CanonicalRuntimeEvent[]) => [
  ...requestIdsSettledByTurnAbort(events),
];
const open = (events: CanonicalRuntimeEvent[]) => [
  ...collectOpenRequests(events).keys(),
];
/** A request the adapter knows the turn itself is waiting on. */
const turnRequest = (
  requestId: string,
  turnId: string,
  second: number,
  overrides: Parameters<typeof requestOpened>[2] = {},
) => requestOpened(requestId, second, { turnId, ...overrides });

describe('#3071: requests that stay open', () => {
  test('a question between turns survives a later restart banner for a turn that never owned it', () => {
    // The question was asked at rest; a later turn starts, dies in a crash,
    // and recovery aborts and banners it. The question predates that turn.
    const events = [
      ...QUESTION_BETWEEN_TURNS_EVENTS,
      turnStarted('turn-2', 6),
      ...recoveryAbortAndBanner('turn-2', 8),
    ];
    expect(open(events)).toEqual(['req-1']);
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
    expect(settled(events)).toEqual([]);
    expect(open(events)).toEqual(['req-1']);
  });

  test('an approval pausing a turn that is still open stays pending', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
    ];
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'review_pending',
      transitionReason: 'review_requested',
      pendingReview: true,
      hasActiveTurn: true,
      openRequestIds: ['req-1'],
      blockingOpenRequestIds: ['req-1'],
    });
  });

  test('the stop race: a request opened between a stop and its abort, naming no turn, is not settled by that abort', () => {
    // A background subagent that survives the stop asks for permission after
    // the adapter cancelled the turn's own request and before the abort is
    // published. By position it sits inside the dying turn, and it is live:
    // hiding it would leave the subagent waiting on an approval no surface
    // shows.
    const events = [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
      requestResolved('req-1', 3, 'cancelled'),
      requestOpened('req-subagent', 4),
      turnAborted('turn-1', 5, 'user stopped it'),
    ];
    expect(settled(events)).toEqual([]);
    expect(open(events)).toEqual(['req-subagent']);
    expect(summarize(events).openRequestIds).toEqual(['req-subagent']);
    // ...including when the engine's own stop confirmation follows.
    expect(
      settled([...events, turnCompleted('turn-1', 6, 'cancelled')]),
    ).toEqual([]);
  });

  test('a live abort never settles by position: an unattributed request is left visible', () => {
    const events = [
      turnStarted('turn-1', 1),
      requestOpened('req-1', 2),
      turnAborted('turn-1', 3),
    ];
    expect(settled(events)).toEqual([]);
    expect(open(events)).toEqual(['req-1']);
  });

  test('a failure with no abort leaves the approval outstanding (archive#1548)', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
      runtimeError(3, { turnId: 'turn-1' }),
    ];
    expect(lifecycle(events)).toMatchObject({
      lifecycleState: 'failed',
      pendingReview: true,
    });
    expect(open(events)).toEqual(['req-1']);
  });

  test('an ordinary completion does not settle a request, even one that names the turn', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
      turnCompleted('turn-1', 3, 'stop'),
    ];
    expect(settled(events)).toEqual([]);
    expect(open(events)).toEqual(['req-1']);
  });

  test('an abort of an earlier turn does not settle the current turn’s request', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnStarted('turn-2', 2),
      turnRequest('req-2', 'turn-2', 3),
      turnAborted('turn-1', 4),
    ];
    expect(settled(events)).toEqual([]);
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'review_pending',
      pendingReview: true,
      openRequestIds: ['req-2'],
    });
  });

  test('a request opened after its turn was aborted, with a stop confirmation still to come, is settled only if it names that turn', () => {
    // Codex's ordinary stop ordering: abort, then completed(cancelled).
    const unattributed = [
      turnStarted('turn-1', 1),
      turnAborted('turn-1', 2),
      requestOpened('req-1', 3),
      turnCompleted('turn-1', 4, 'cancelled'),
    ];
    expect(settled(unattributed)).toEqual([]);
    const attributed = [
      turnStarted('turn-1', 1),
      turnAborted('turn-1', 2),
      turnRequest('req-1', 'turn-1', 3),
      turnCompleted('turn-1', 4, 'cancelled'),
    ];
    expect(settled(attributed)).toEqual(['req-1']);
  });

  test('a request re-opened after its turn was aborted is a new ask', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
      turnAborted('turn-1', 3),
      turnCompleted('turn-1', 4, 'cancelled'),
      requestOpened('req-1', 5),
    ];
    expect(settled(events)).toEqual([]);
    expect(open(events)).toEqual(['req-1']);
  });
});

describe('#3071: requests a live abort settles (they name the turn)', () => {
  test('a user-stopped turn with an open approval: stopped, nothing pending, and a new turn does not revive it', () => {
    const stopped = [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
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
    expect(open(stopped)).toEqual([]);

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
      turnRequest('req-1', 'turn-1', 2),
      turnCompleted('turn-1', 3, 'cancelled'),
      turnStarted('turn-2', 5),
    ];
    expect(settled(events)).toEqual(['req-1']);
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
      turnRequest('req-1', 'turn-1', 2),
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
    expect(open(events)).toEqual([]);
  });

  test('a request that names its turn is settled by that turn’s abort even when another turn is open', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnStarted('turn-2', 2),
      turnRequest('req-1', 'turn-1', 3),
      turnAborted('turn-1', 4),
    ];
    expect(settled(events)).toEqual(['req-1']);
  });

  test('a question the aborted turn asked is settled with its approvals; a resolved one is left as resolved', () => {
    const events = [
      turnStarted('turn-1', 1),
      turnRequest('req-answered', 'turn-1', 2),
      requestResolved('req-answered', 3),
      turnRequest('req-question', 'turn-1', 4, { requestType: 'input' }),
      turnRequest('req-async', 'turn-1', 5, { blocking: false }),
      turnAborted('turn-1', 6),
    ];
    expect(settled(events)).toEqual(['req-question', 'req-async']);
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'canceled',
      pendingReview: false,
      openRequestIds: [],
    });
  });
});

describe('#3071: requests a recovery abort settles (the process died)', () => {
  test('every request opened since the dead turn started, attributed or not, and none from before it', () => {
    const events = [
      requestOpened('req-before', 0),
      turnStarted('turn-1', 1),
      requestOpened('req-unattributed', 2),
      turnRequest('req-attributed', 'turn-1', 3),
      requestOpened('req-other-turn', 4, { turnId: 'turn-0' }),
      ...recoveryAbortAndBanner('turn-1', 6),
    ];
    expect(settled(events)).toEqual([
      'req-unattributed',
      'req-attributed',
      'req-other-turn',
    ]);
    expect(open(events)).toEqual(['req-before']);
  });

  test('a request opened after a mid-turn error that named no turn is still the dead turn’s', () => {
    // The error clears every "is a turn open" fold, so position-by-open-turn
    // would call this request ownerless and the banner would be re-stamped
    // review_pending: the original defect by another road.
    const events = [
      turnStarted('turn-1', 1),
      runtimeError(2, { retriable: true }),
      requestOpened('req-1', 3),
      ...recoveryAbortAndBanner('turn-1', 6),
    ];
    expect(settled(events)).toEqual(['req-1']);
    expect(summarize(events)).toMatchObject({
      lifecycleState: 'needs_input',
      transitionReason: 'runtime_exit',
      transitionSource: 'system_recovery',
      pendingReview: false,
      openRequestIds: [],
    });
  });

  test('a recovery abort for a turn with no turn.started has no window: it settles only a request that names the turn', () => {
    const events = [
      requestOpened('req-unattributed', 2),
      turnRequest('req-named', 'turn-never-started', 3),
      ...recoveryAbortAndBanner('turn-never-started', 6),
    ];
    expect(settled(events)).toEqual(['req-named']);
    expect(open(events)).toEqual(['req-unattributed']);
  });

  test('a request a later turn opened before the dead turn’s recovery abort landed is that later turn’s, and stays open', () => {
    // Recovery runs after boot; a newer turn can already be running and
    // waiting on an approval when the old turn's abort is written.
    const events = [
      turnStarted('turn-1', 1),
      requestOpened('req-dead', 2),
      turnStarted('turn-2', 3),
      requestOpened('req-live', 4),
      ...recoveryAbortAndBanner('turn-1', 6),
    ];
    expect(settled(events)).toEqual(['req-dead']);
    expect(open(events)).toEqual(['req-live']);
  });
});

/**
 * The summary routes fold `listSessionProjectionEvents` (and its batched
 * twin), not the full log. The settle rule is only honest if both give the
 * same answer, so this drives every sequence through a real EventStore and
 * compares the three.
 */
describe('#3071: the bounded projection settles exactly what the full log does', () => {
  const makeTempDir = trackTempDirs();
  const stores: EventStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  const OTHER_THREAD_ID = 'thread-other';
  const later = [turnStarted('turn-9', 20), requestOpened('req-live', 21)];
  const sequences: Record<string, CanonicalRuntimeEvent[]> = {
    'interrupted, resolved by recovery':
      INTERRUPTED_WITH_SETTLED_APPROVAL_EVENTS,
    'interrupted, pre-fix orphan': INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS,
    'interrupted, no request': INTERRUPTED_WITH_NO_REQUEST_EVENTS,
    'approval between turns': APPROVAL_BETWEEN_TURNS_EVENTS,
    'question between turns': QUESTION_BETWEEN_TURNS_EVENTS,
    // The dead turn is no longer the latest: its start and abort are outside
    // every other slot of the bounded set.
    'pre-fix orphan, then a later turn running': [
      ...INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS,
      ...later,
    ],
    'pre-fix orphan, then two later turns': [
      ...INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS,
      turnStarted('turn-8', 15),
      turnCompleted('turn-8', 16, 'stop'),
      ...later,
    ],
    'request before the dead turn, then a later turn': [
      requestOpened('req-before', 0),
      ...INTERRUPTED_WITH_ORPHANED_APPROVAL_EVENTS,
      ...later,
    ],
    'attributed request, live abort, later turn': [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
      turnAborted('turn-1', 3),
      ...later,
    ],
    'attributed request, stop confirmation, later turn': [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
      turnAborted('turn-1', 3),
      turnCompleted('turn-1', 4, 'cancelled'),
      ...later,
    ],
    // The later completion replaces the abort in the latest-terminal slot.
    'abort, unattributed request, stop confirmation': [
      turnStarted('turn-1', 1),
      turnAborted('turn-1', 2),
      requestOpened('req-1', 3),
      turnCompleted('turn-1', 4, 'cancelled'),
    ],
    'completion, request at rest, stale abort of the same turn': [
      turnStarted('turn-1', 1),
      turnCompleted('turn-1', 2, 'stop'),
      requestOpened('req-1', 3),
      turnAborted('turn-1', 4),
    ],
    'stop race': [
      turnStarted('turn-1', 1),
      turnRequest('req-1', 'turn-1', 2),
      requestResolved('req-1', 3, 'cancelled'),
      requestOpened('req-subagent', 4),
      turnAborted('turn-1', 5),
    ],
    'unattributed request, live abort, later turn': [
      turnStarted('turn-1', 1),
      requestOpened('req-1', 2),
      turnAborted('turn-1', 3),
      ...later,
    ],
    // The dead turn is neither the thread's first turn nor its latest, so
    // neither the first-prompted-turn slot nor the latest-turn slot carries
    // its `turn.started`.
    'dead turn is neither first nor latest': [
      turnStarted('turn-1', 1),
      turnCompleted('turn-1', 2, 'stop'),
      turnStarted('turn-2', 3),
      requestOpened('req-1', 4),
      ...recoveryAbortAndBanner('turn-2', 6),
      turnStarted('turn-3', 8),
    ],
    'two recovery aborts on one thread': [
      turnStarted('turn-1', 1),
      turnCompleted('turn-1', 2, 'stop'),
      turnStarted('turn-2', 3),
      requestOpened('req-a', 4),
      ...recoveryAbortAndBanner('turn-2', 6, 'boundary-a'),
      requestOpened('req-at-rest', 7),
      turnStarted('turn-3', 8),
      requestOpened('req-b', 9),
      ...recoveryAbortAndBanner('turn-3', 11, 'boundary-b'),
      turnStarted('turn-4', 12),
      requestOpened('req-live', 13),
    ],
    'resolved, re-opened, then the turn dies': [
      turnStarted('turn-1', 1),
      turnCompleted('turn-1', 2, 'stop'),
      turnStarted('turn-2', 3),
      requestOpened('req-1', 4),
      requestResolved('req-1', 5),
      requestOpened('req-1', 6),
      ...recoveryAbortAndBanner('turn-2', 8),
      turnStarted('turn-3', 9),
    ],
    'settled, then re-opened under a later turn': [
      turnStarted('turn-1', 1),
      turnCompleted('turn-1', 2, 'stop'),
      turnStarted('turn-2', 3),
      requestOpened('req-1', 4),
      ...recoveryAbortAndBanner('turn-2', 6),
      turnStarted('turn-3', 8),
      requestOpened('req-1', 9),
    ],
    'a later turn opened a request before the dead turn’s abort landed': [
      turnStarted('turn-0', 0),
      turnCompleted('turn-0', 0, 'stop'),
      turnStarted('turn-1', 1),
      requestOpened('req-dead', 2),
      turnStarted('turn-2', 3),
      requestOpened('req-live', 4),
      ...recoveryAbortAndBanner('turn-1', 6),
    ],
    // The superseding turn is itself neither first nor latest, so only the
    // settlement facts carry its start.
    'the superseding turn is neither first nor latest': [
      turnStarted('turn-0', 0),
      turnCompleted('turn-0', 0, 'stop'),
      turnStarted('turn-1', 1),
      requestOpened('req-dead', 2),
      turnStarted('turn-2', 3),
      requestOpened('req-live', 4),
      ...recoveryAbortAndBanner('turn-1', 6),
      turnCompleted('turn-2', 7, 'stop'),
      turnStarted('turn-3', 9),
    ],
    'recovery abort with no start, request names the turn': [
      turnStarted('turn-1', 1),
      turnCompleted('turn-1', 2, 'stop'),
      requestOpened('req-unattributed', 3),
      turnRequest('req-named', 'turn-never-started', 4),
      ...recoveryAbortAndBanner('turn-never-started', 6),
      turnStarted('turn-3', 8),
    ],
    'error mid-turn, request, recovery abort, later turn': [
      turnStarted('turn-1', 1),
      runtimeError(2, { retriable: true }),
      requestOpened('req-1', 3),
      ...recoveryAbortAndBanner('turn-1', 6),
      ...later,
    ],
  };

  test.each(Object.entries(sequences))('%s', (_name, events) => {
    const store = new EventStore(
      join(makeTempDir('request-settlement-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    // A second thread's events interleaved with this one's: every read the
    // rule depends on must stay inside its own thread.
    for (const event of events) {
      store.appendEvent(event);
      store.appendEvent({
        ...event,
        threadId: OTHER_THREAD_ID,
        eventId: `other:${event.eventId}`,
        ...('sessionId' in event ? { sessionId: OTHER_THREAD_ID } : {}),
        // The other thread's requests are all answered, so a leak of its
        // turn facts or of this thread's would change one of the answers.
        ...(event.method === 'request.opened' ||
        event.method === 'request.resolved'
          ? { requestId: `other:${event.requestId}` }
          : {}),
      } as CanonicalRuntimeEvent);
    }
    expect(
      settled(store.listEvents(OTHER_THREAD_ID).map((event) => event.payload)),
    ).toEqual(settled(events).map((id) => `other:${id}`));
    expect(
      settled(
        store
          .listSessionProjectionEvents(OTHER_THREAD_ID)
          .map((event) => event.payload),
      ),
    ).toEqual(settled(events).map((id) => `other:${id}`));

    const full = store
      .listEvents(SETTLEMENT_THREAD_ID)
      .map((event) => event.payload);
    const bounded = store
      .listSessionProjectionEvents(SETTLEMENT_THREAD_ID)
      .map((event) => event.payload);
    const batched = (
      store
        .listSessionProjectionEventsForThreads([SETTLEMENT_THREAD_ID])
        .get(SETTLEMENT_THREAD_ID) ?? []
    ).map((event) => event.payload);

    const expected = settled(full);
    expect(settled(bounded)).toEqual(expected);
    expect(settled(batched)).toEqual(expected);
    expect(lifecycle(bounded).pendingReview).toBe(
      lifecycle(full).pendingReview,
    );
    expect(lifecycle(batched).pendingReview).toBe(
      lifecycle(full).pendingReview,
    );
    // The store's own unresolved set minus the settled ones is what every
    // summary lists; pin it against the full-log answer.
    const unresolved = store
      .listOpenRequestIdsByThreads([SETTLEMENT_THREAD_ID])
      .get(SETTLEMENT_THREAD_ID);
    expect(unresolved?.filter((id) => !settled(bounded).includes(id))).toEqual(
      open(full),
    );
  });

  test('the session inventory reads recovery’s expired resolution as closed, not pending', () => {
    const store = new EventStore(
      join(makeTempDir('request-settlement-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    for (const event of [
      ...INTERRUPTED_WITH_SETTLED_APPROVAL_EVENTS,
      requestOpened('req-answered', 30),
      requestResolved('req-answered', 31, 'approved'),
    ])
      store.appendEvent(event);
    expect(
      store
        .listSessionInventoryEvents(SETTLEMENT_THREAD_ID, {
          group: 'decisions',
        })
        .events.map((descriptor) =>
          descriptor.method === 'request.resolved'
            ? [descriptor.requestId, descriptor.status]
            : [],
        ),
    ).toEqual([
      ['req-1', 'cancelled'],
      ['req-answered', 'accepted'],
    ]);
  });

  test('the sequences cover both answers', () => {
    // Guards the property against passing on an all-empty table.
    const answers = Object.values(sequences).map(
      (events) => settled(events).length > 0,
    );
    expect(answers).toContain(true);
    expect(answers).toContain(false);
    expect(
      settled(sequences['pre-fix orphan, then a later turn running']!),
    ).toEqual(['req-1']);
    expect(
      settled(sequences['dead turn is neither first nor latest']!),
    ).toEqual(['req-1']);
    expect(settled(sequences['two recovery aborts on one thread']!)).toEqual([
      'req-a',
      'req-b',
    ]);
    expect(
      settled(sequences['resolved, re-opened, then the turn dies']!),
    ).toEqual(['req-1']);
    expect(
      settled(sequences['settled, then re-opened under a later turn']!),
    ).toEqual([]);
    expect(
      settled(
        sequences[
          'a later turn opened a request before the dead turn’s abort landed'
        ]!,
      ),
    ).toEqual(['req-dead']);
    expect(
      settled(
        sequences['recovery abort with no start, request names the turn']!,
      ),
    ).toEqual(['req-named']);
  });
});
