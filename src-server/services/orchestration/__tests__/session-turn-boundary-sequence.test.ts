import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ORCHESTRATION_EVENT_STORE_MIGRATION } from '../../../domain/migrations/003-orchestration-events.js';
import { EventStore } from '../event-store.js';
import { SESSION_TURN_ACCEPTED_CAPACITY } from '../session-turn-boundary.js';

describe('session-terminal boundary ordering', () => {
  const makeTempDir = trackTempDirs();
  const stores: EventStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    vi.useRealTimers();
  });
  function databasePath() {
    const root = makeTempDir('boundary-sequence-');
    return join(root, 'orchestration.sqlite');
  }
  function open(path: string) {
    const store = new EventStore(path);
    stores.push(store);
    return store;
  }
  function terminal(
    method: 'session.exited' | 'runtime.error',
  ): CanonicalRuntimeEvent {
    const base = {
      eventId: 'terminal',
      provider: 'claude' as const,
      threadId: 'thread',
      createdAt: new Date().toISOString(),
    };
    return method === 'session.exited'
      ? { ...base, method, sessionId: 'thread', exitCode: 0 }
      : { ...base, method, severity: 'error', message: 'Session failed' };
  }
  function invoking(store: EventStore) {
    const claim = store
      .sessionTurnBoundaryAuthority()
      .claim('thread', new Date().toISOString());
    if (claim.kind !== 'owner') throw new Error('Expected boundary owner');
    expect(claim.claim.beginInvocation(new Date().toISOString())).toEqual({
      kind: 'applied',
    });
  }
  function settle(
    store: EventStore,
    path: string,
    event: CanonicalRuntimeEvent,
    mode: 'observe' | 'read' | 'restart',
  ) {
    if (mode === 'observe') {
      expect(store.sessionTurnBoundaryAuthority().observe(event)).toEqual({
        kind: 'applied',
      });
    }
    if (mode === 'read')
      store.sessionTurnBoundaryAuthority().hasPossibleEffect('thread');
    if (mode === 'restart') {
      expect(store.close()).toEqual({ kind: 'closed' });
      return open(path);
    }
    return store;
  }
  function boundaries(path: string) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db
        .prepare(
          'SELECT thread_id FROM orchestration_turn_boundaries ORDER BY thread_id',
        )
        .all();
    } finally {
      db.close();
    }
  }
  test('polling reads committed terminal history under a peer writer without retiring rows', () => {
    const path = databasePath();
    const store = open(path);
    invoking(store);
    const peer = open(path);
    const authority = store.sessionTurnBoundaryAuthority();
    const db = store['db'];
    db.exec('PRAGMA busy_timeout = 1000');
    peer['db'].exec('BEGIN IMMEDIATE');
    try {
      peer.appendEvent(terminal('session.exited'));
      const changes = db.prepare('SELECT total_changes() AS n').get();
      const started = performance.now();
      expect(authority.hasPossibleEffect('thread')).toEqual({
        kind: 'available',
        active: true,
      });
      expect(performance.now() - started).toBeLessThan(500);
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
      peer['db'].exec('COMMIT');
      peer['db'].exec('BEGIN IMMEDIATE');
      const committedPoll = performance.now();
      expect(authority.hasPossibleEffect('thread')).toEqual({
        kind: 'available',
        active: false,
      });
      expect(performance.now() - committedPoll).toBeLessThan(500);
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
    } finally {
      if (peer['db'].isTransaction) peer['db'].exec('ROLLBACK');
    }
  });
  test('polling retains pending transitions until a writer retries them', () => {
    const path = databasePath();
    const store = open(path);
    const authority = store.sessionTurnBoundaryAuthority();
    const claim = authority.claim('thread', '2030-01-01T00:00:00.000Z');
    if (claim.kind !== 'owner') throw new Error('Expected boundary owner');
    const peer = new DatabaseSync(path);
    try {
      store['db'].exec('PRAGMA busy_timeout = 25');
      peer.exec('BEGIN IMMEDIATE');
      expect(claim.claim.notInvoked()).toEqual({ kind: 'unavailable' });
      store['db'].exec('PRAGMA busy_timeout = 1000');
      const started = performance.now();
      expect(authority.hasPossibleEffect('thread')).toEqual({
        kind: 'available',
        active: true,
      });
      expect(performance.now() - started).toBeLessThan(500);
      peer.exec('ROLLBACK');
      expect(authority.hasPossibleEffect('thread')).toEqual({
        kind: 'available',
        active: true,
      });
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
      const retried = authority.claim('thread', '2030-01-01T00:00:01.000Z');
      expect(retried.kind).toBe('owner');
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
    } finally {
      if (peer.isTransaction) peer.exec('ROLLBACK');
      peer.close();
    }
  });
  test.each(['claim', 'lifecycle', 'engine'] as const)(
    '%s admission retires committed terminal rows before occupancy and capacity decisions',
    (mode) => {
      const path = databasePath();
      const store = open(path);
      const authority = store.sessionTurnBoundaryAuthority();
      const at = '2030-01-01T00:00:00.000Z';
      for (let i = 0; i < SESSION_TURN_ACCEPTED_CAPACITY; i++) {
        const claim = authority.claim('thread', at);
        if (claim.kind !== 'owner') throw new Error('Expected boundary owner');
        expect(claim.claim.beginInvocation(at)).toEqual({ kind: 'applied' });
        expect(claim.claim.accepted(`turn-${i}`, at)).toEqual({
          kind: 'applied',
        });
      }
      for (let i = 0; i < SESSION_TURN_ACCEPTED_CAPACITY; i++) {
        store.appendEvent({
          eventId: `terminal-${i}`,
          provider: 'claude',
          threadId: 'thread',
          turnId: `turn-${i}`,
          method: 'turn.completed',
          createdAt: at,
        });
      }
      expect(boundaries(path)).toHaveLength(SESSION_TURN_ACCEPTED_CAPACITY);
      if (mode === 'engine') {
        const peer = new DatabaseSync(path, { readOnly: true });
        try {
          const event = {
            eventId: 'engine-start',
            provider: 'claude',
            threadId: 'thread',
            turnId: 'new-turn',
            method: 'turn.started',
            createdAt: at,
          } as const;
          const prepared = authority.prepareProviderTurn(
            'thread',
            'new-turn',
            at,
          );
          const record = () => {
            expect(prepared.record()).toEqual({ kind: 'applied' });
            expect(store['db'].isTransaction).toBe(true);
            expect(
              store['db']
                .prepare(
                  'SELECT provider_turn_id FROM orchestration_turn_boundaries',
                )
                .all(),
            ).toEqual([{ provider_turn_id: 'new-turn' }]);
            expect(
              peer
                .prepare(
                  'SELECT COUNT(*) AS n FROM orchestration_turn_boundaries',
                )
                .get(),
            ).toEqual({ n: SESSION_TURN_ACCEPTED_CAPACITY });
          };
          expect(() =>
            store.appendEvent(event, [], () => {
              record();
              throw new Error('outer rollback');
            }),
          ).toThrow('outer rollback');
          expect(boundaries(path)).toHaveLength(SESSION_TURN_ACCEPTED_CAPACITY);
          expect(store.hasEventId(event.eventId)).toBe(false);
          store.appendEvent(event, [], record);
        } finally {
          peer.close();
        }
      } else {
        const claim =
          mode === 'lifecycle'
            ? authority.claimLifecycle('thread', at)
            : authority.claim('thread', at);
        expect(claim.kind).toBe('owner');
      }
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
    },
  );
  test.each(['claim', 'lifecycle'] as const)(
    '%s admission clears a session-retired invocation without polling first',
    (mode) => {
      const path = databasePath();
      const store = open(path);
      invoking(store);
      store.appendEvent(terminal('session.exited'));
      const authority = store.sessionTurnBoundaryAuthority();
      const claim =
        mode === 'lifecycle'
          ? authority.claimLifecycle('thread', '2030-01-01T00:00:00.000Z')
          : authority.claim('thread', '2030-01-01T00:00:00.000Z');
      expect(claim.kind).toBe('owner');
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
    },
  );
  test.each([
    'recovery',
    'admission-error',
    'task-dispatch',
    'lifecycle',
    'empty-turn',
    'null-turn',
  ] as const)(
    'polling and writer admission preserve the existing %s terminal classification',
    (mode) => {
      const path = databasePath();
      const store = open(path);
      const authority = store.sessionTurnBoundaryAuthority();
      const at = '2030-01-01T00:00:00.000Z';
      if (mode === 'lifecycle') {
        expect(authority.claimLifecycle('thread', at).kind).toBe('owner');
      } else if (mode === 'task-dispatch') {
        expect(authority.claimTaskDispatch('thread', at).kind).toBe('owner');
      } else if (mode === 'admission-error') {
        invoking(store);
      } else {
        expect(
          authority
            .prepareProviderTurn(
              'thread',
              mode === 'empty-turn' ? '' : 'turn',
              at,
            )
            .record(),
        ).toEqual({ kind: 'applied' });
        if (mode === 'null-turn')
          store['db']
            .prepare(
              'UPDATE orchestration_turn_boundaries SET provider_turn_id = NULL WHERE thread_id = ?',
            )
            .run('thread');
      }
      const base = {
        eventId: 'excluded-terminal',
        provider: 'claude',
        threadId: 'thread',
        createdAt: at,
      } as const;
      const event: CanonicalRuntimeEvent =
        mode === 'recovery'
          ? {
              ...base,
              method: 'turn.aborted',
              turnId: 'turn',
              reason: 'Interrupted turn recovery',
              recoveryTerminal: true,
            }
          : mode === 'admission-error'
            ? {
                ...base,
                method: 'runtime.error',
                severity: 'error',
                message: 'uncertain admission',
                code: 'SESSION_START_INDETERMINATE',
              }
            : mode === 'empty-turn' || mode === 'null-turn'
              ? { ...base, method: 'turn.completed', turnId: '' }
              : {
                  ...base,
                  method: 'session.exited',
                  sessionId: 'thread',
                  exitCode: 0,
                };
      store.appendEvent(event);
      // Existing SQL matches an empty provider id, but never a NULL id.
      const retired = mode === 'empty-turn';
      expect(authority.hasPossibleEffect('thread')).toEqual({
        kind: 'available',
        active: !retired && mode !== 'lifecycle',
      });
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
      const next = authority.claimLifecycle(
        'thread',
        '2030-01-01T00:00:01.000Z',
      );
      expect(next.kind).toBe(
        retired ? 'owner' : mode === 'lifecycle' ? 'busy' : 'active-turn',
      );
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
    },
  );
  test('reconcile preserves a newer reused-ID boundary when an older turn terminal arrives late', () => {
    const path = databasePath();
    const store = open(path);
    const authority = store.sessionTurnBoundaryAuthority();
    const claimed = authority.claim('thread', '2026-10-13T02:00:00.000Z');
    if (claimed.kind !== 'owner') throw new Error('Expected boundary owner');
    expect(claimed.claim.beginInvocation('2026-10-13T02:01:00.000Z')).toEqual({
      kind: 'applied',
    });
    expect(
      claimed.claim.accepted('provider-reused', '2026-10-13T02:02:00.000Z'),
    ).toEqual({ kind: 'applied' });
    const oldTerminal: CanonicalRuntimeEvent = {
      eventId: 'delayed-old-generation',
      provider: 'claude',
      threadId: 'thread',
      turnId: 'provider-reused',
      method: 'turn.completed',
      createdAt: '2026-10-13T01:00:00.000Z',
    };
    store.appendEvent(oldTerminal);
    expect(authority.hasPossibleEffect('thread')).toEqual({
      kind: 'available',
      active: true,
    });
    store.appendEvent({
      ...oldTerminal,
      eventId: 'current-generation-terminal',
      createdAt: '2026-10-13T03:00:00.000Z',
    });
    expect(authority.hasPossibleEffect('thread')).toEqual({
      kind: 'available',
      active: false,
    });
  });
  test('an unpersisted session terminal answers applied but keeps the fenced boundary', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T02:00:00.000Z'));
    const path = databasePath();
    const store = open(path);
    invoking(store);
    vi.setSystemTime(new Date('2026-10-13T03:00:00.000Z'));
    const event = terminal('session.exited');
    const authority = store.sessionTurnBoundaryAuthority();
    expect(store.readGlobalSequence(event.eventId)).toBeUndefined();
    expect(authority.observe(event)).toEqual({ kind: 'applied' });
    expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
    expect(authority.hasPossibleEffect('thread')).toEqual({
      kind: 'available',
      active: true,
    });
    store.appendEvent(event);
    expect(authority.observe(event)).toEqual({ kind: 'applied' });
    expect(boundaries(path)).toEqual([]);
    expect(authority.hasPossibleEffect('thread')).toEqual({
      kind: 'available',
      active: false,
    });
  });
  for (const method of ['session.exited', 'runtime.error'] as const) {
    test.each(['observe', 'read', 'restart'] as const)(
      `${method} after a backward clock step retires only the earlier boundary (%s)`,
      (mode) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-13T02:00:00.000Z'));
        const path = databasePath();
        const store = open(path);
        invoking(store);
        const other = store
          .sessionTurnBoundaryAuthority()
          .claim('other-thread', new Date().toISOString());
        if (other.kind !== 'owner') throw new Error('Expected unrelated owner');
        expect(other.claim.beginInvocation(new Date().toISOString())).toEqual({
          kind: 'applied',
        });
        vi.setSystemTime(new Date('2026-10-13T01:00:00.000Z'));
        const event = terminal(method);
        store.appendEvent(event);
        const current = settle(store, path, event, mode);
        expect(boundaries(path)).toEqual(
          mode === 'read'
            ? [{ thread_id: 'other-thread' }, { thread_id: 'thread' }]
            : [{ thread_id: 'other-thread' }],
        );
        expect(
          current.sessionTurnBoundaryAuthority().hasPossibleEffect('thread'),
        ).toEqual({ kind: 'available', active: false });
        expect(
          current
            .sessionTurnBoundaryAuthority()
            .hasPossibleEffect('other-thread'),
        ).toEqual({ kind: 'available', active: true });
      },
    );
    test.each(['observe', 'read', 'restart'] as const)(
      `${method} persisted before a backward-clock claim does not retire it (%s)`,
      (mode) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-13T02:00:00.000Z'));
        const path = databasePath();
        const store = open(path);
        const event = terminal(method);
        store.appendEvent(event);
        vi.setSystemTime(new Date('2026-10-13T01:00:00.000Z'));
        invoking(store);
        const current = settle(store, path, event, mode);
        expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
        expect(
          current.sessionTurnBoundaryAuthority().hasPossibleEffect('thread'),
        ).toEqual({ kind: 'available', active: true });
      },
    );
  }
  test('an engine-opened boundary captures the durable head inside its start append', () => {
    const path = databasePath();
    const store = open(path);
    const prior = {
      ...terminal('session.exited'),
      threadId: 'deleted-thread',
      sessionId: 'deleted-thread',
    };
    store.appendEvent(prior);
    const head = store.headGlobalSequence();
    store.deleteThread('deleted-thread');
    const prepared = store
      .sessionTurnBoundaryAuthority()
      .prepareProviderTurn('thread', 'engine-turn', '2026-10-13T02:00:00.000Z');
    store.appendEvent(
      {
        eventId: 'engine-start',
        provider: 'claude',
        threadId: 'thread',
        method: 'turn.started',
        turnId: 'engine-turn',
        createdAt: '2026-10-13T02:00:00.000Z',
      },
      [],
      () => {
        expect(prepared.record()).toEqual({ kind: 'applied' });
      },
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        db
          .prepare(
            'SELECT created_sequence FROM orchestration_turn_boundaries WHERE thread_id=?',
          )
          .get('thread'),
      ).toEqual({ created_sequence: head });
    } finally {
      db.close();
    }
    const event = {
      ...terminal('session.exited'),
      eventId: 'engine-exit',
      createdAt: '2026-10-13T01:00:00.000Z',
    };
    store.appendEvent(event);
    expect(store.sessionTurnBoundaryAuthority().observe(event)).toEqual({
      kind: 'applied',
    });
    expect(boundaries(path)).toEqual([]);
  });
  test.each(['accepted', 'indeterminate'] as const)(
    'a legacy %s boundary retains timestamp retirement across boots',
    (state) => {
      const path = databasePath();
      const db = new DatabaseSync(path);
      db.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
      db.prepare(`INSERT INTO orchestration_turn_boundaries
      (boundary_id, thread_id, state, provider_turn_id, owner_id, owner_pid, owner_birth, owner_identity_kind, created_at, updated_at)
      VALUES ('legacy', 'thread', ?, 'turn', 'dead-owner', 2147483647, NULL, 'unverified', '2026-10-13T02:00:00.000Z', '2026-10-13T02:00:00.000Z')`).run(
        state,
      );
      db.close();
      let store = open(path);
      const old = {
        ...terminal('session.exited'),
        createdAt: '2026-10-13T01:00:00.000Z',
      };
      store.appendEvent(old);
      for (let boot = 0; boot < 2; boot++) {
        expect(store.sessionTurnBoundaryAuthority().observe(old)).toEqual({
          kind: 'applied',
        });
        expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
        expect(
          store.sessionTurnBoundaryAuthority().hasPossibleEffect('thread'),
        ).toEqual({ kind: 'available', active: true });
        expect(store.close()).toEqual({ kind: 'closed' });
        store = open(path);
      }
      const later = {
        ...old,
        eventId: 'later-terminal',
        createdAt: '2026-10-13T03:00:00.000Z',
      };
      store.appendEvent(later);
      expect(
        store.sessionTurnBoundaryAuthority().hasPossibleEffect('thread'),
      ).toEqual({
        kind: 'available',
        active: false,
      });
      expect(boundaries(path)).toEqual([{ thread_id: 'thread' }]);
      expect(store.sessionTurnBoundaryAuthority().observe(later)).toEqual({
        kind: 'applied',
      });
      expect(boundaries(path)).toEqual([]);
      expect(
        store.sessionTurnBoundaryAuthority().hasPossibleEffect('thread'),
      ).toEqual({ kind: 'available', active: false });
    },
  );
});
