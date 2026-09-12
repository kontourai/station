import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OrchestrationCommandReceipt } from '@kontourai/station-contracts/orchestration';
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

  test('upgrades an existing adoption table without dropping an unresolved legacy reservation', () => {
    const first = open();
    const claim = first.ledger.reserve(input());
    if (claim.kind !== 'owner') throw new Error('expected owner');
    claim.adoption.markForking();
    first.store.close();
    const databasePath = join(first.directory, 'orchestration.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(
      'ALTER TABLE provider_session_adoptions DROP COLUMN source_affinity',
    );
    legacy.exec(
      'ALTER TABLE provider_session_adoptions DROP COLUMN source_boundary',
    );
    legacy.close();
    const reopened = new EventStore(databasePath);
    try {
      const ledger = reopened.createAdoptionLedger();
      expect(ledger.reservations()).toEqual([
        expect.objectContaining({
          sourceThreadId: input().sourceThreadId,
          status: 'forking',
        }),
      ]);
      expect(ledger.reservations()[0]?.sourceAffinity).toBeUndefined();
      expect(
        ledger.reserve({
          ...input('new-source'),
          targetThreadId: 'new-child',
          sourceAffinity: { kind: 'remote-source', ref: 'opaque-account' },
        }).kind,
      ).toBe('owner');
      expect(
        ledger.reservations().find((row) => row.sourceThreadId === 'new-source')
          ?.sourceAffinity,
      ).toEqual({ kind: 'remote-source', ref: 'opaque-account' });
    } finally {
      reopened.close();
    }
  });

  test('persists admitted source affinity and boundary before creation and restores immutable recovery context', () => {
    const first = open();
    const sourceAffinity = { kind: 'remote-source', ref: 'opaque-account' };
    const sourceBoundary = {
      kind: 'completed-turn' as const,
      providerTurnId: 'turn/native:one',
      observedEventId: 'observed-completion',
    };
    const reserved = first.ledger.reserve({
      ...input(),
      sourceAffinity,
      sourceBoundary,
    });
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    sourceAffinity.ref = 'caller-mutated';
    sourceBoundary.providerTurnId = 'caller-mutated';
    expect(reserved.adoption.reservation).toMatchObject({
      status: 'pending',
      sourceAffinity: { kind: 'remote-source', ref: 'opaque-account' },
      sourceBoundary: { providerTurnId: 'turn/native:one' },
    });
    expect(Object.isFrozen(reserved.adoption.reservation.sourceAffinity)).toBe(
      true,
    );
    reserved.adoption.markForking();
    first.store.close();
    const reopened = new EventStore(
      join(first.directory, 'orchestration.sqlite'),
    );
    try {
      const ledger = reopened.createAdoptionLedger();
      const persisted = ledger.reservations()[0]!;
      expect(persisted).toMatchObject({
        status: 'forking',
        sourceAffinity: { kind: 'remote-source', ref: 'opaque-account' },
        sourceBoundary: {
          kind: 'completed-turn',
          providerTurnId: 'turn/native:one',
          observedEventId: 'observed-completion',
        },
      });
      const reclaimed = ledger.reclaim({
        reservation: persisted,
        ownerId: 'recovery-owner',
        ownerPid: 303,
      });
      expect(reclaimed.kind).toBe('owner');
      if (reclaimed.kind !== 'owner')
        throw new Error('expected recovery owner');
      expect(reclaimed.adoption.reservation.sourceAffinity).toEqual({
        kind: 'remote-source',
        ref: 'opaque-account',
      });
      expect(
        reclaimed.adoption.reservation.sourceBoundary?.providerTurnId,
      ).toBe('turn/native:one');
    } finally {
      reopened.close();
    }
  });

  test('rejects malformed source context before reserving an adoption', () => {
    const { store, ledger } = open();
    try {
      expect(() =>
        ledger.reserve({
          ...input(),
          sourceAffinity: { kind: 'source', ref: '' },
        }),
      ).toThrow('source affinity');
      expect(() =>
        ledger.reserve({
          ...input(),
          sourceBoundary: {
            kind: 'completed-turn',
            providerTurnId: 'turn',
            observedEventId: 'event',
          },
        }),
      ).toThrow('source boundary');
      expect(ledger.reservations()).toEqual([]);
    } finally {
      store.close();
    }
  });

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
  function forkedChild() {
    return {
      provider: 'claude' as const,
      threadId: 'station-child',
      status: 'ready' as const,
      resumeCursor: 'vendor-child',
      continuationSourceThreadId: 'external:claude:source',
      createdAt: '2026-07-22T00:00:01.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    };
  }

  function commandReceipt(): OrchestrationCommandReceipt {
    return {
      commandId: 'cmd-adopt-1',
      threadId: 'station-child',
      commandType: 'adoptSession',
      status: 'accepted',
      createdAt: '2026-07-22T00:00:01.000Z',
    };
  }

  // The receipt is the second of the two writes `commitOwned` performs inside
  // its own `BEGIN IMMEDIATE`, and until this test nothing exercised it: every
  // other real-SQLite commit here passes one argument, so the receipt branch
  // never executed and could be deleted with the suite still green.
  test('persists the command receipt in the same commit as the child session', () => {
    const { store, ledger } = open();
    const reserved = ledger.reserve(input());
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    reserved.adoption.markForking();
    reserved.adoption.recordProviderCursor('vendor-child');
    expect(store.readCommandReceipt('cmd-adopt-1')).toBeNull();

    expect(reserved.adoption.commit(forkedChild(), commandReceipt()).kind).toBe(
      'applied',
    );

    expect(store.readCommandReceipt('cmd-adopt-1')).toEqual(commandReceipt());
    expect(store.readSessionByThread('station-child')).toMatchObject({
      threadId: 'station-child',
    });
    expect(ledger.reservations()).toEqual([]);
    store.close();
  });

  test('rolls back the child session too when the receipt write fails', () => {
    const { store, ledger } = open();
    const reserved = ledger.reserve(input());
    if (reserved.kind !== 'owner') throw new Error('expected owner');
    reserved.adoption.markForking();
    reserved.adoption.recordProviderCursor('vendor-child');
    const db = (store as unknown as { db: { prepare(sql: string): unknown } })
      .db;
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare(sql: string): unknown }).prepare = (sql) => {
      // Only the receipt INSERT fails. The child write has already landed in
      // the transaction by then, so a surviving session row would mean the
      // commit is not atomic across the two injected cross-group writes.
      if (sql.includes('INTO orchestration_command_receipts')) {
        throw new Error('injected receipt write failure');
      }
      return prepare(sql);
    };

    expect(() =>
      reserved.adoption.commit(forkedChild(), commandReceipt()),
    ).toThrow('Adoption commit rolled back');

    expect(store.readSessionByThread('station-child')).toBeUndefined();
    expect(store.readCommandReceipt('cmd-adopt-1')).toBeNull();
    expect(ledger.reservations()).toEqual([
      expect.objectContaining({ sourceThreadId: 'external:claude:source' }),
    ]);
    store.close();
  });
});
