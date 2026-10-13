import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ORCHESTRATION_EVENT_STORE_MIGRATION } from '../../../domain/migrations/003-orchestration-events.js';
import { EventStore } from '../event-store.js';

describe('session-terminal boundary ordering', () => {
  const roots: string[] = [];
  const stores: EventStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    vi.useRealTimers();
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });
  function databasePath() {
    const root = mkdtempSync(join(tmpdir(), 'boundary-sequence-'));
    roots.push(root);
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
    if (mode === 'observe')
      expect(store.sessionTurnBoundaryAuthority().observe(event)).toEqual({
        kind: 'applied',
      });
    if (mode === 'restart') {
      expect(store.close()).toEqual({ kind: 'closed' });
      return open(path);
    }
    return store;
  }
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
        expect(
          current.sessionTurnBoundaryAuthority().hasPossibleEffect('thread'),
        ).toEqual({ kind: 'available', active: true });
      },
    );
  }
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
      expect(store.sessionTurnBoundaryAuthority().observe(later)).toEqual({
        kind: 'applied',
      });
      expect(
        store.sessionTurnBoundaryAuthority().hasPossibleEffect('thread'),
      ).toEqual({ kind: 'available', active: false });
    },
  );
});
