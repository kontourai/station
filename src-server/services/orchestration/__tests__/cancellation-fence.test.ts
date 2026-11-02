import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import { captureTurnIntent } from '../prepared-turn-intent.js';
import { createSqliteSessionTurnBoundaryCoordinator } from '../sqlite-session-turn-boundary.js';

const makeTempDir = trackTempDirs();

test.each(['begin', 'resume'] as const)(
  'a fence refuses an otherwise eligible prepared claim at %s',
  (transition) => {
    const path = join(makeTempDir('cascade-prepared-fence-'), 'events.sqlite');
    const store = new EventStore(path);
    const db = new DatabaseSync(path);
    const now = '2026-01-01T00:00:00.000Z';
    const owner = {
      id: 'prepared-owner',
      pid: 616161,
      birth: 'old-birth',
      identityKind: 'exact' as const,
    };
    const coordinator = createSqliteSessionTurnBoundaryCoordinator({
      db,
      head: () => 0,
      reconcileTerminals() {},
      retiredBoundaryIds: () => [],
      transactionLost: (cause) => new Error('Lost transaction', { cause }),
      preparedClaims: {
        owner,
        liveness: () => 'dead',
        adopt: () => {
          throw new Error('No linked dedup');
        },
      },
    });
    try {
      for (const threadId of ['control', 'fenced']) {
        const boundaryId = `prepared-${threadId}`;
        const capture = captureTurnIntent(
          { threadId, input: 'prepared work' },
          { binding: {}, requiresFreshCompanions: false },
        );
        expect(
          coordinator.create({
            boundaryId,
            threadId,
            state: 'reserved',
            ownerId: owner.id,
            ownerPid: owner.pid,
            ownerIdentityKind: owner.identityKind,
            ownerBirth: owner.birth,
            createdAt: now,
            updatedAt: now,
          }).kind,
        ).toBe('applied');
        expect(
          coordinator.prepareIntent!({
            boundaryId,
            ownerId: owner.id,
            capture,
            now,
          }).kind,
        ).toBe('applied');
        if (threadId === 'fenced') {
          store.appendEvent({
            eventId: 'cancel-parent',
            threadId: 'parent',
            sessionId: 'parent',
            provider: 'claude',
            method: 'session.exited',
            reason: 'stopped',
            createdAt: now,
          });
          store.recordCascadeStopIntent('parent', threadId, 'cancel-parent');
        }
        const result =
          transition === 'begin'
            ? coordinator.beginPrepared!({
                boundaryId,
                ownerId: owner.id,
                capture,
                now,
                current: () => true,
              })
            : coordinator.resumePrepared!({
                capture,
                owner: {
                  id: 'resumed-owner',
                  pid: process.pid,
                  identityKind: 'exact',
                  birth: 'new-birth',
                },
                now,
                current: () => true,
              });
        if (threadId === 'control') expect(result.kind).toBe('applied');
        else {
          expect(result.kind).not.toBe('applied');
          expect(
            db
              .prepare(
                'SELECT state FROM orchestration_turn_boundaries WHERE boundary_id = ?',
              )
              .get(boundaryId),
          ).toEqual({ state: 'prepared' });
        }
      }
    } finally {
      db.close();
      store.close();
    }
  },
);

test('a stale cancellation target cannot commit a request or subtree stop intents', () => {
  const store = new EventStore(
    join(makeTempDir('cascade-stale-target-'), 'events.sqlite'),
  );
  const at = '2026-01-01T00:00:00.000Z';
  try {
    for (const id of ['parent', 'child'])
      store.appendEvent({
        eventId: `${id}-start`,
        threadId: id,
        sessionId: id,
        provider: 'codex',
        method: 'session.started',
        createdAt: at,
        metadata:
          id === 'child'
            ? {
                delegation: {
                  parentSessionId: 'parent',
                  parentConversationId: 'parent',
                },
                stationDelegationProvenance: 'caller-derived',
              }
            : {},
      });
    store.appendEvent({
      eventId: 'old-start',
      provider: 'codex',
      threadId: 'parent',
      method: 'turn.started',
      turnId: 'old',
      createdAt: at,
    });
    store.appendEvent({
      eventId: 'old-end',
      provider: 'codex',
      threadId: 'parent',
      method: 'turn.completed',
      turnId: 'old',
      finishReason: 'stop',
      createdAt: at,
    });
    store.appendEvent({
      eventId: 'current-start',
      provider: 'codex',
      threadId: 'parent',
      method: 'turn.started',
      turnId: 'current',
      createdAt: at,
    });
    expect(() =>
      store.appendEvent({
        eventId: 'stale-cancel',
        provider: 'codex',
        threadId: 'parent',
        sessionId: 'parent',
        method: 'session.cancellation-requested',
        action: 'cancel',
        turnId: 'old',
        createdAt: at,
      }),
    ).toThrow('target is no longer active');
    expect(store.eventById('parent', 'stale-cancel')).toBeUndefined();
    expect(store.pendingCascadeStops()).toEqual([]);
    const child = store.sessionTurnBoundaryAuthority().claim('child', at);
    expect(child.kind).toBe('owner');
    if (child.kind !== 'owner')
      throw new Error('Stale cancellation fenced the child');
    child.claim.notInvoked();
  } finally {
    store.close();
  }
});

test('a durable parent terminal records one child stop intent and fence across reopen', () => {
  const path = join(makeTempDir('cascade-intent-'), 'events.sqlite');
  const store = new EventStore(path);
  store.appendEvent({
    eventId: 'parent-terminal',
    threadId: 'parent',
    sessionId: 'parent',
    provider: 'codex',
    method: 'session.exited',
    createdAt: '2026-01-01T00:00:00.000Z',
    reason: 'stopped',
  });
  expect(
    store.recordCascadeStopIntent('parent', 'child', 'parent-terminal'),
  ).toBe(true);
  expect(
    store.recordCascadeStopIntent('parent', 'child', 'parent-terminal'),
  ).toBe(false);
  expect(() =>
    store.recordCascadeStopIntent(
      'other-parent',
      'other-child',
      'parent-terminal',
    ),
  ).toThrow('Cascade parent terminal is unavailable');
  store.close();
  const db = new DatabaseSync(path);
  try {
    expect(
      db
        .prepare(
          'SELECT thread_id, terminal_event_id FROM orchestration_cancellation_fences',
        )
        .all(),
    ).toEqual([{ thread_id: 'child', terminal_event_id: 'parent-terminal' }]);
    expect(
      db
        .prepare(
          'SELECT parent_session_id, child_session_id, terminal_event_id, state FROM orchestration_cascade_stop_intents',
        )
        .all(),
    ).toEqual([
      {
        parent_session_id: 'parent',
        child_session_id: 'child',
        terminal_event_id: 'parent-terminal',
        state: 'pending',
      },
    ]);
  } finally {
    db.close();
  }
});

test('a fence write failure rolls back the stop intent', () => {
  const path = join(makeTempDir('cascade-rollback-'), 'events.sqlite');
  const store = new EventStore(path);
  store.appendEvent({
    eventId: 'terminal',
    threadId: 'parent',
    sessionId: 'parent',
    provider: 'codex',
    method: 'session.exited',
    createdAt: '2026-01-01T00:00:00.000Z',
    reason: 'stopped',
  });
  const peer = new DatabaseSync(path);
  try {
    peer.exec(`CREATE TRIGGER fail_cascade_fence BEFORE INSERT ON orchestration_cancellation_fences
      BEGIN SELECT RAISE(ABORT, 'injected fence failure'); END`);
    expect(() =>
      store.recordCascadeStopIntent('parent', 'child', 'terminal'),
    ).toThrow('injected fence failure');
    expect(
      peer.prepare('SELECT * FROM orchestration_cascade_stop_intents').all(),
    ).toEqual([]);
    expect(
      peer.prepare('SELECT * FROM orchestration_cancellation_fences').all(),
    ).toEqual([]);
  } finally {
    peer.close();
    store.close();
  }
});
