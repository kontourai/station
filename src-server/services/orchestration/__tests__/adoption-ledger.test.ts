import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';

describe('AdoptionLedger', () => {
  const directories: string[] = [];
  afterEach(() =>
    directories
      .splice(0)
      .forEach((path) => rmSync(path, { recursive: true, force: true })),
  );

  function open() {
    const directory = mkdtempSync(join(tmpdir(), 'station-adoption-ledger-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    return { directory, store, ledger: store.createAdoptionLedger() };
  }

  function input(sourceThreadId = 'external:claude:source') {
    return {
      sourceThreadId,
      targetThreadId: 'station-child',
      ownerId: 'owner-a',
      ownerPid: 101,
      provider: 'claude' as const,
      sourceSessionId: 'vendor-source',
      sourceKind: 'claude-transcript',
      cwd: '/workspace/project/packages/app',
      projectRoot: '/workspace/project',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
  }

  test('gives only the winner an owner capability and advances legal facts durably', () => {
    const { store, ledger } = open();
    const winner = ledger.reserve(input());
    const foreign = store.createAdoptionLedger().reserve({
      ...input(),
      targetThreadId: 'other-child',
      ownerId: 'owner-b',
      ownerPid: 202,
    });
    expect(winner.kind).toBe('owner');
    expect(foreign).toEqual({ kind: 'contended' });
    if (winner.kind !== 'owner') throw new Error('expected owner');
    winner.adoption.recordFlowRun('session-station-child', false);
    winner.adoption.markForking();
    winner.adoption.recordProviderCursor('vendor-child');
    expect(ledger.reservations()).toEqual([
      expect.objectContaining({
        status: 'forking',
        providerResumeCursor: 'vendor-child',
        flowRunId: 'session-station-child',
        flowCleanupComplete: false,
      }),
    ]);
    expect(ledger.reservesProviderCursor('claude', 'vendor-child')).toBe(true);
    store.close();
  });

  test('persists through restart, reclaims only the recorded owner, and forbids foreign settlement', () => {
    const first = open();
    const reserved = first.ledger.reserve(input('source%_literal'));
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    reserved.adoption.markForking();
    first.store.close();

    const restarted = new EventStore(
      join(first.directory, 'orchestration.sqlite'),
    );
    const ledger = restarted.createAdoptionLedger();
    const reservation = ledger.reservations()[0]!;
    expect(
      ledger.reclaim({
        reservation: { ...reservation, ownerId: 'foreign' },
        ownerId: 'owner-b',
        ownerPid: 202,
      }),
    ).toEqual({ kind: 'contended' });
    const reclaimed = ledger.reclaim({
      reservation,
      ownerId: 'owner-b',
      ownerPid: 202,
    });
    expect(reclaimed.kind).toBe('owner');
    if (reclaimed.kind !== 'owner') throw new Error('expected reclaimed owner');
    reclaimed.adoption.markRollbackPending();
    reclaimed.adoption.markProviderCleanupComplete();
    expect(reclaimed.adoption.completeCleanup().kind).toBe('applied');
    expect(ledger.reservations()).toEqual([]);
    restarted.close();
  });

  test('fences duplicate reclaimers across independent SQLite connections and keeps stale claims inert', () => {
    const first = open();
    const reserved = first.ledger.reserve(input('source-cross-claim'));
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    const staleSnapshot = first.ledger.reservations()[0]!;
    const secondStore = new EventStore(
      join(first.directory, 'orchestration.sqlite'),
    );
    const second = secondStore.createAdoptionLedger();

    const firstReclaim = first.ledger.reclaim({
      reservation: staleSnapshot,
      ownerId: 'replacement',
      ownerPid: 202,
    });
    const secondReclaim = second.reclaim({
      reservation: staleSnapshot,
      ownerId: 'replacement',
      ownerPid: 202,
    });
    expect([firstReclaim.kind, secondReclaim.kind].sort()).toEqual([
      'contended',
      'owner',
    ]);
    expect(reserved.adoption.markForking()).toEqual({
      kind: 'ownership-lost',
    });
    const winner =
      firstReclaim.kind === 'owner'
        ? firstReclaim.adoption
        : secondReclaim.kind === 'owner'
          ? secondReclaim.adoption
          : undefined;
    if (!winner) throw new Error('expected one owner');
    const exposed = winner.reservation as {
      ownerToken: string;
      ownerId: string;
    };
    expect(Object.isFrozen(exposed)).toBe(true);
    expect(() => {
      exposed.ownerToken = staleSnapshot.ownerToken;
      exposed.ownerId = 'forged';
    }).toThrow();
    expect(winner.recordFlowRun('replacement-flow', false).kind).toBe(
      'applied',
    );
    expect(winner.markForking().kind).toBe('applied');
    secondStore.close();
    first.store.close();
  });

  test('rejects illegal state changes and preserves the first provider cursor tombstone', () => {
    const { store, ledger } = open();
    const reserved = ledger.reserve(input());
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    expect(reserved.adoption.recordProviderCursor('too-early')).toEqual({
      kind: 'invalid-transition',
      reason: 'must-fork-before-provider-cursor',
    });
    reserved.adoption.recordFlowRun('flow', false);
    reserved.adoption.markForking();
    expect(reserved.adoption.recordFlowRun('late-flow', false)).toEqual({
      kind: 'invalid-transition',
      reason: 'flow-binding-must-precede-fork',
    });
    expect(reserved.adoption.recordProviderCursor('first').kind).toBe(
      'applied',
    );
    expect(reserved.adoption.recordProviderCursor('second')).toEqual({
      kind: 'invalid-transition',
      reason: 'provider-cursor-conflict',
    });
    expect(ledger.reservesProviderCursor('claude', 'first')).toBe(true);
    expect(ledger.reservesProviderCursor('claude', 'second')).toBe(false);
    expect(reserved.adoption.markRollbackPending().kind).toBe('applied');
    expect(reserved.adoption.markForking()).toEqual({
      kind: 'invalid-transition',
      reason: 'rollback-is-terminal',
    });
    expect(reserved.adoption.completeCleanup()).toEqual({
      kind: 'invalid-transition',
      reason: 'cleanup-is-incomplete',
    });
    store.close();
  });

  test('refuses commit until fork and provider cursor facts are durable', () => {
    const { store, ledger } = open();
    const reserved = ledger.reserve(input());
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    const child = {
      provider: 'claude' as const,
      threadId: 'station-child',
      status: 'ready' as const,
      resumeCursor: 'vendor-child',
      continuationSourceThreadId: 'external:claude:source',
      createdAt: '2026-07-22T00:00:01.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    };
    expect(reserved.adoption.commit(child)).toEqual({
      kind: 'invalid-transition',
      reason: 'commit-requires-fork',
    });
    reserved.adoption.markForking();
    expect(reserved.adoption.commit(child)).toEqual({
      kind: 'invalid-transition',
      reason: 'commit-requires-provider-cursor',
    });
    reserved.adoption.recordProviderCursor('vendor-child');
    expect(
      reserved.adoption.commit({ ...child, resumeCursor: 'other' }),
    ).toEqual({
      kind: 'invalid-transition',
      reason: 'commit-child-mismatch',
    });
    expect(
      reserved.adoption.commit({
        ...child,
        continuationSourceThreadId: 'other-source',
      }),
    ).toEqual({
      kind: 'invalid-transition',
      reason: 'commit-child-mismatch',
    });
    expect(
      reserved.adoption.commit({
        ...child,
        continuationSourceThreadId: undefined,
      }),
    ).toEqual({
      kind: 'invalid-transition',
      reason: 'commit-child-mismatch',
    });
    expect(ledger.reservations()).toHaveLength(1);
    store.close();
  });

  test('rolls back a failed transition refresh and permits only its exact retry', () => {
    const { store, ledger } = open();
    const reserved = ledger.reserve(input());
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    const db = (store as unknown as { db: { prepare(sql: string): unknown } })
      .db;
    const prepare = db.prepare.bind(db);
    let failRefresh = true;
    (db as unknown as { prepare(sql: string): unknown }).prepare = (sql) => {
      if (failRefresh && sql.startsWith('SELECT source_thread_id')) {
        failRefresh = false;
        throw new Error('injected transition refresh failure');
      }
      return prepare(sql);
    };
    expect(() => reserved.adoption.recordFlowRun('flow', false)).toThrow(
      'injected transition refresh failure',
    );
    expect(ledger.reservations()[0]).not.toHaveProperty('flowRunId');
    expect(reserved.adoption.markForking()).toEqual({
      kind: 'invalid-transition',
      reason: 'retry-must-match-failed-transition',
    });
    expect(reserved.adoption.recordFlowRun('flow', false).kind).toBe('applied');
    store.close();
  });

  test('rolls back a failed reclaim refresh so another claimant can acquire it', () => {
    const { store, ledger } = open();
    const reserved = ledger.reserve(input());
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    const snapshot = ledger.reservations()[0]!;
    const db = (store as unknown as { db: { prepare(sql: string): unknown } })
      .db;
    const prepare = db.prepare.bind(db);
    let failRefresh = true;
    (db as unknown as { prepare(sql: string): unknown }).prepare = (sql) => {
      if (failRefresh && sql.startsWith('SELECT source_thread_id')) {
        failRefresh = false;
        throw new Error('injected reclaim refresh failure');
      }
      return prepare(sql);
    };
    expect(() =>
      ledger.reclaim({
        reservation: snapshot,
        ownerId: 'replacement',
        ownerPid: 202,
      }),
    ).toThrow('injected reclaim refresh failure');
    expect(
      ledger.reclaim({
        reservation: snapshot,
        ownerId: 'replacement',
        ownerPid: 202,
      }),
    ).toMatchObject({ kind: 'owner' });
    store.close();
  });

  test('keeps wildcard-like source ids isolated and atomically commits only a complete child', () => {
    const { store, ledger } = open();
    const literal = ledger.reserve(input('source%_'));
    const distinct = ledger.reserve({
      ...input('sourceXX'),
      targetThreadId: 'other-child',
    });
    if (literal.kind !== 'owner' || distinct.kind !== 'owner') {
      throw new Error('expected owners');
    }
    literal.adoption.markForking();
    literal.adoption.recordProviderCursor('literal-child');
    expect(ledger.reservesProviderCursor('claude', 'literal-child')).toBe(true);
    expect(ledger.reservations()).toHaveLength(2);
    literal.adoption.commit({
      provider: 'claude',
      threadId: 'station-child',
      status: 'ready',
      resumeCursor: 'literal-child',
      continuationSourceThreadId: 'source%_',
      createdAt: '2026-07-22T00:00:01.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    });
    expect(ledger.reservations()).toEqual([
      expect.objectContaining({ sourceThreadId: 'sourceXX' }),
    ]);
    expect(store.readSessions()).toContainEqual(
      expect.objectContaining({ threadId: 'station-child' }),
    );
    store.close();
  });

  test('rolls back the whole commit when its durable child write fails', () => {
    const { store, ledger } = open();
    const reserved = ledger.reserve(input());
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    reserved.adoption.markForking();
    reserved.adoption.recordProviderCursor('vendor-child');
    const db = (store as unknown as { db: { prepare(sql: string): unknown } })
      .db;
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare(sql: string): unknown }).prepare = (sql) => {
      if (sql.includes('INSERT INTO provider_session_state')) {
        throw new Error('injected child write failure');
      }
      return prepare(sql);
    };
    expect(() =>
      reserved.adoption.commit({
        provider: 'claude',
        threadId: 'station-child',
        status: 'ready',
        resumeCursor: 'vendor-child',
        continuationSourceThreadId: 'external:claude:source',
        createdAt: '2026-07-22T00:00:01.000Z',
        updatedAt: '2026-07-22T00:00:01.000Z',
      }),
    ).toThrow('Adoption commit rolled back');
    expect(ledger.reservations()).toEqual([
      expect.objectContaining({ sourceThreadId: 'external:claude:source' }),
    ]);
    expect(store.readSessionByThread('station-child')).toBeUndefined();
    expect(reserved.adoption.markRollbackPending().kind).toBe('applied');
    expect(reserved.adoption.markFlowCleanupComplete().kind).toBe('applied');
    expect(reserved.adoption.markProviderCleanupComplete().kind).toBe(
      'applied',
    );
    expect(reserved.adoption.completeCleanup().kind).toBe('applied');
    expect(ledger.reservations()).toEqual([]);
    store.close();
  });
});
