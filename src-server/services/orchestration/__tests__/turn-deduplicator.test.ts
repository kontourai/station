import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TurnIdempotencyStore } from '../../turn-idempotency.js';
import { EventStore } from '../event-store.js';
import { createTurnDeduplicator } from '../turn-deduplicator.js';

describe('TurnDeduplicator', () => {
  const directories: string[] = [];
  afterEach(() =>
    directories
      .splice(0)
      .forEach((path) => rmSync(path, { recursive: true, force: true })),
  );

  function open() {
    const directory = mkdtempSync(join(tmpdir(), 'station-turn-dedup-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    return { store, ledger: store.createTurnDeduplicator(), directory };
  }

  test('gives only the winning module an owner handle and preserves a resolved claim across restart', () => {
    const first = open();
    const owner = first.ledger.claim({
      threadId: 'thread',
      clientTurnId: 'client',
    });
    const foreign = first.store.createTurnDeduplicator();
    expect(owner.kind).toBe('owner');
    expect(
      foreign.claim({ threadId: 'thread', clientTurnId: 'client' }),
    ).toEqual({ kind: 'contended', turnId: undefined });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    owner.claim.resolve('provider-turn');
    expect(() => owner.claim.release()).toThrow('already settled');
    first.store.close();

    const restarted = new EventStore(
      join(first.directory, 'orchestration.sqlite'),
    );
    expect(
      restarted
        .createTurnDeduplicator()
        .claim({ threadId: 'thread', clientTurnId: 'client' }),
    ).toEqual({ kind: 'contended', turnId: 'provider-turn' });
    restarted.close();
  });

  test('releases only an unresolved owner claim so a failed turn can retry', () => {
    const { store, ledger } = open();
    const owner = ledger.claim({ threadId: 'thread', clientTurnId: 'retry' });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    owner.claim.release();
    expect(
      ledger.claim({ threadId: 'thread', clientTurnId: 'retry' }),
    ).toMatchObject({ kind: 'owner' });
    store.close();
  });

  test('uses tuple-safe keys and bounded await resolution', async () => {
    const { store, ledger } = open();
    const owner = ledger.claim({
      threadId: 'thread::evil',
      clientTurnId: 'id',
    });
    expect(
      ledger.claim({ threadId: 'thread', clientTurnId: 'evil::id' }),
    ).toMatchObject({ kind: 'owner' });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    const waiting = ledger.awaitResolution({
      threadId: 'thread::evil',
      clientTurnId: 'id',
      timeoutMs: 100,
      intervalMs: 1,
    });
    owner.claim.resolve('turn');
    await expect(waiting).resolves.toBe('turn');
    store.close();
  });

  test('reclaims an unresolved dead-process owner after restart and isolates wildcard-like thread ids', () => {
    const first = open();
    first.ledger.claim({ threadId: 'th%', clientTurnId: 'client' });
    first.store.close();
    const restarted = new EventStore(
      join(first.directory, 'orchestration.sqlite'),
      512,
      {
        exact: () => ({ pid: process.pid, start: 'replacement' }),
        probe: () => ({ state: 'dead' }),
      },
    );
    const ledger = restarted.createTurnDeduplicator();
    expect(
      ledger.claim({ threadId: 'th%', clientTurnId: 'client' }),
    ).toMatchObject({ kind: 'owner' });
    expect(
      ledger.claim({ threadId: 'thAnything', clientTurnId: 'client' }),
    ).toMatchObject({ kind: 'owner' });
    restarted.close();
  });

  test('keeps an owner handle usable when its first durable resolve rolls back', () => {
    let record: { value: string | null; createdAt: number } | undefined;
    let failResolve = true;
    const store = new TurnIdempotencyStore({
      read: () => record,
      update: (_key, updater) => {
        const decision = updater(record);
        if (failResolve && record && decision.record?.value !== null) {
          failResolve = false;
          throw new Error('injected rollback');
        }
        record = decision.record;
        return decision.result;
      },
    });
    const ledger = createTurnDeduplicator({
      store,
      keyFor: (thread, id) => `${thread}:${id}`,
    });
    const owner = ledger.claim({ threadId: 'thread', clientTurnId: 'client' });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    expect(() => owner.claim.resolve('turn')).toThrow('injected rollback');
    expect(() => owner.claim.release()).toThrow('intent cannot change');
    expect(() => owner.claim.resolve('different-turn')).toThrow(
      'intent cannot change',
    );
    owner.claim.resolve('turn');
    expect(() => owner.claim.resolve('turn')).toThrow('already settled');
    expect(() => owner.claim.release()).toThrow('already settled');
    expect(
      ledger.claim({ threadId: 'thread', clientTurnId: 'client' }),
    ).toEqual({ kind: 'contended', turnId: 'turn' });
  });

  test('deletes exact wildcard-like thread keys without touching another ledger tuple', () => {
    const { store, ledger } = open();
    ledger.claim({ threadId: 'th%_', clientTurnId: 'client' });
    ledger.claim({ threadId: 'thXX', clientTurnId: 'client' });
    store.deleteThread('th%_');
    expect(
      ledger.claim({ threadId: 'th%_', clientTurnId: 'client' }),
    ).toMatchObject({ kind: 'owner' });
    expect(ledger.claim({ threadId: 'thXX', clientTurnId: 'client' })).toEqual({
      kind: 'contended',
      turnId: undefined,
    });
    store.close();
  });

  test('returns undefined after the bounded await timeout when no owner resolves', async () => {
    const { store, ledger } = open();
    ledger.claim({ threadId: 'thread', clientTurnId: 'pending' });
    const started = Date.now();
    await expect(
      ledger.awaitResolution({
        threadId: 'thread',
        clientTurnId: 'pending',
        timeoutMs: 15,
        intervalMs: 2,
      }),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    store.close();
  });
});
