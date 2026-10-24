import { DatabaseSync } from 'node:sqlite';
import type { KernelCommand, OwnerLiveness } from '@kontourai/monument';
import { openSqliteKernelStorage } from '@kontourai/monument/sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { ORCHESTRATION_EVENT_STORE_MIGRATION } from '../../domain/migrations/003-orchestration-events.js';
import {
  createSqliteTurnDedupPersistence,
  STATION_TURN_DEDUP_KERNEL_TABLES,
} from '../orchestration/sqlite-turn-dedup-persistence.js';
import {
  awaitTurnResolution,
  type TurnIdempotencyPersistence,
  TurnIdempotencyStore,
} from '../turn-idempotency.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * Station's own dedup tables on an in-memory connection, behind Monument's
 * adapter: the algorithm independent of any file. The algorithm itself is
 * Monument's, so this proves Station's use of it (the owner it records, the
 * tracking it asks for, how it maps each answer); the rules have their own
 * conformance suite.
 */
class InMemoryTurnIdempotencyPersistence implements TurnIdempotencyPersistence {
  private readonly database = new DatabaseSync(':memory:');
  private readonly persistence: TurnIdempotencyPersistence;

  constructor() {
    databases.push(this.database);
    this.database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    this.persistence = createSqliteTurnDedupPersistence({
      db: this.database,
    });
  }

  execute<C extends KernelCommand>(command: C, liveness: OwnerLiveness) {
    return this.persistence.execute(command, liveness);
  }

  /** The stored record, as Monument decodes it. */
  read(key: string) {
    const read = this.persistence.execute(
      { type: 'turnDedup.read', key },
      () => 'unknown',
    );
    return read.kind === 'found' ? read.record : undefined;
  }

  prepare(
    key: string,
    disposition?: 'cancelled' | 'definitively-refused',
  ): void {
    const row = this.read(key);
    if (!row?.owner) throw new Error('Expected the actual claimed owner.');
    const kernel = openSqliteKernelStorage({
      database: this.database,
      tables: {
        turnDedup: STATION_TURN_DEDUP_KERNEL_TABLES.turnDedup,
        requestKeys: 'unused',
        inbox: 'unused',
      },
    });
    const context = { liveness: () => 'unknown' as const };
    const at = (value: number) => new Date(value).toISOString();
    const intent = {
      invocationId: `invocation:${key}`,
      inputDigest: 'input',
      intentDigest: 'envelope',
      bodyRef: 'body',
      dedupKey: key,
    };
    expect(
      kernel.executeSync(
        {
          type: 'turnBoundary.create',
          boundaryId: key,
          threadId: 'thread',
          state: 'reserved',
          purpose: 'turn',
          owner: row.owner,
          now: at(2),
        },
        context,
      ),
    ).toEqual({ kind: 'applied' });
    expect(
      kernel.executeSync(
        {
          type: 'turnBoundary.prepare',
          boundaryId: key,
          ownerId: row.owner.id,
          dedupOwnerId: row.owner.id,
          intent,
          now: at(3),
        },
        context,
      ),
    ).toEqual({ kind: 'applied' });
    if (disposition === undefined) return;
    if (disposition === 'definitively-refused')
      expect(
        kernel.executeSync(
          {
            type: 'turnBoundary.beginInvocation',
            boundaryId: key,
            ownerId: row.owner.id,
            dedupOwnerId: row.owner.id,
            intent,
            now: at(4),
          },
          context,
        ),
      ).toEqual({ kind: 'applied' });
    expect(
      kernel.executeSync(
        {
          type:
            disposition === 'cancelled'
              ? 'turnBoundary.cancelPrepared'
              : 'turnBoundary.recordDefinitiveRefusal',
          boundaryId: key,
          intent,
          boundary: {
            owner: row.owner,
            createdAt: at(2),
            updatedAt: at(disposition === 'cancelled' ? 3 : 4),
          },
          dedup: {
            owner: row.owner,
            createdAt: row.createdAt,
            updatedAt: at(3),
          },
          settlementId: `settlement:${key}`,
          now: at(5),
        },
        context,
      ),
    ).toEqual({ kind: 'applied' });
  }

  /** A row written by something that is not this store, in Station's encoding. */
  seed(key: string, owner: object): void {
    this.database
      .prepare(
        'INSERT INTO orchestration_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 0, ?)',
      )
      .run(key, JSON.stringify(owner));
  }
}

describe('TurnIdempotencyStore (station#1224 offline slice 2 — shared idempotency algorithm)', () => {
  test.each(['cancelled', 'definitively-refused'] as const)(
    'a %s prepared key refuses a new claim and inspection without becoming a provider result',
    (disposition) => {
      const persistence = new InMemoryTurnIdempotencyPersistence();
      const store = new TurnIdempotencyStore(persistence);
      expect(store.claim('settled-key', 1, 'tracked')).toEqual({
        claimed: true,
      });
      persistence.prepare('settled-key', disposition);
      const before = persistence.read('settled-key');
      for (const operation of [
        () => store.claim('settled-key'),
        () => store.inspect('settled-key'),
      ]) {
        try {
          operation();
          throw new Error('Expected settled-key refusal.');
        } catch (error) {
          expect(error).toMatchObject({
            code: 'client_turn_settled',
            disposition,
          });
        }
      }
      expect(persistence.read('settled-key')).toEqual(before);
      expect(before?.value).toBeNull();
    },
  );
  test('a fresh key claims successfully', () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    expect(store.claim('turn-a')).toEqual({ claimed: true });
  });

  test('a resolved claim is returned as a dedup hit, not reclaimed', () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    store.claim('turn-a');
    store.resolve('turn-a', 'result-1');

    expect(store.claim('turn-a')).toEqual({
      claimed: false,
      value: 'result-1',
    });
    expect(store.read('turn-a')).toBe('result-1');
  });

  test('an unresolved (in-flight) claim reports claimed:false with no value', () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    store.claim('turn-a');

    expect(store.claim('turn-a')).toEqual({ claimed: false });
    expect(store.read('turn-a')).toBeUndefined();
  });

  test('releasing an unresolved claim lets a retry genuinely re-claim it', () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    store.claim('turn-a');
    store.release('turn-a');

    expect(store.claim('turn-a')).toEqual({ claimed: true });
  });

  test('releasing a RESOLVED claim is a no-op', () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    store.claim('turn-a');
    store.resolve('turn-a', 'result-1');
    store.release('turn-a');

    expect(store.claim('turn-a')).toEqual({
      claimed: false,
      value: 'result-1',
    });
  });

  test('resolving a never-claimed key is a no-op (nothing to attach the result to)', () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    store.resolve('turn-never-claimed', 'result-1');

    expect(store.claim('turn-never-claimed')).toEqual({ claimed: true });
  });

  test('station#1224 CRITICAL fix: an in-flight claim is NEVER time-based-reclaimed, no matter how much time has passed', () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    store.claim('turn-a', 0);

    // Simulate the original claim being 10 minutes, then 10 hours, old —
    // both were reclaimable under the old (buggy) time-based logic. Neither
    // may reclaim now: only the owner's own release()/resolve(), or
    // clearUnresolved() at the next process start, may ever free this.
    expect(store.claim('turn-a', 10 * 60_000 + 1)).toEqual({ claimed: false });
    expect(store.claim('turn-a', 10 * 60 * 60_000)).toEqual({ claimed: false });
    expect(store.claim('turn-a', Number.MAX_SAFE_INTEGER)).toEqual({
      claimed: false,
    });
  });

  test('HIGH 1: an owner born while exact identity is unavailable is not reclaimed when that live PID later has a different fingerprint', () => {
    const persistence = new InMemoryTurnIdempotencyPersistence();
    let identityAvailable = false;
    const processIdentity = {
      exact: () =>
        identityAvailable
          ? { pid: process.pid, start: 'recovered-birth' }
          : null,
      probe: () => ({
        state: 'exact' as const,
        identity: { pid: process.pid, start: 'recovered-birth' },
      }),
    };
    const first = new TurnIdempotencyStore(persistence, processIdentity);
    expect(first.claim('turn-unverified-owner')).toEqual({ claimed: true });
    expect(persistence.read('turn-unverified-owner')?.owner).toMatchObject({
      identityKind: 'unverified',
    });

    // The next claimant can now read the process birth fingerprint. It must
    // still respect the original unverified owner while that PID is live.
    identityAvailable = true;
    const retry = new TurnIdempotencyStore(persistence, processIdentity);
    expect(retry.claim('turn-unverified-owner')).toEqual({ claimed: false });
  });

  describe('#3559: dead-owner reclaim depends on recorded invocation', () => {
    const alive = {
      exact: () => ({ pid: process.pid, start: 'owner-birth' }),
      probe: () => ({
        state: 'exact' as const,
        identity: { pid: process.pid, start: 'owner-birth' },
      }),
    };
    const dead = {
      exact: () => ({ pid: process.pid, start: 'successor-birth' }),
      probe: () => ({ state: 'dead' as const }),
    };

    test('a prepared linked claim with a dead owner refuses ordinary replay without reclaiming', () => {
      const persistence = new InMemoryTurnIdempotencyPersistence();
      const first = new TurnIdempotencyStore(persistence, alive);
      expect(first.claim('prepared-key', 1, 'tracked')).toEqual({
        claimed: true,
      });
      persistence.prepare('prepared-key');
      const before = persistence.read('prepared-key');
      expect(
        new TurnIdempotencyStore(persistence, dead).claim(
          'prepared-key',
          4,
          'tracked',
        ),
      ).toEqual({ claimed: false, indeterminate: true });
      expect(persistence.read('prepared-key')).toEqual(before);
    });

    test('a tracked claim whose dead owner never began invoking is reclaimed', () => {
      const persistence = new InMemoryTurnIdempotencyPersistence();
      new TurnIdempotencyStore(persistence, alive).claim('k', 0, 'tracked');
      expect(persistence.read('k')?.invocation).toBe('pending');
      expect(
        new TurnIdempotencyStore(persistence, dead).claim('k', 1, 'tracked'),
      ).toEqual({ claimed: true });
    });

    test('a tracked claim whose dead owner began invoking is indeterminate on every retry and keeps its row', () => {
      const persistence = new InMemoryTurnIdempotencyPersistence();
      const owner = new TurnIdempotencyStore(persistence, alive);
      owner.claim('k', 0, 'tracked');
      owner.beginInvocation('k');
      const before = persistence.read('k');
      expect(before?.invocation).toBe('begun');

      const successor = new TurnIdempotencyStore(persistence, dead);
      for (const tracking of ['tracked', 'untracked'] as const) {
        expect(successor.claim('k', 1, tracking)).toEqual({
          claimed: false,
          indeterminate: true,
        });
      }
      expect(persistence.read('k')).toEqual(before);
      // The successor holds no claim, so it can neither settle nor begin it.
      successor.resolve('k', 'late-turn');
      expect(persistence.read('k')).toEqual(before);
      expect(() => successor.beginInvocation('k')).toThrow('not owned');
    });

    test('a live owner that began invoking is still only contended', () => {
      const persistence = new InMemoryTurnIdempotencyPersistence();
      const owner = new TurnIdempotencyStore(persistence, alive);
      owner.claim('k', 0, 'tracked');
      owner.beginInvocation('k');
      const before = persistence.read('k');
      expect(
        new TurnIdempotencyStore(persistence, alive).claim('k', 1, 'tracked'),
      ).toEqual({ claimed: false });
      // A contended claim must not rewrite the live owner's row: losing
      // `begun` here would make the turn reclaimable once that owner dies.
      expect(persistence.read('k')).toEqual(before);
      expect(persistence.read('k')?.invocation).toBe('begun');
      expect(
        new TurnIdempotencyStore(persistence, dead).claim('k', 2, 'tracked'),
      ).toEqual({ claimed: false, indeterminate: true });
    });

    test('a dead owner row with no invocation record is indeterminate', () => {
      const persistence = new InMemoryTurnIdempotencyPersistence();
      persistence.seed('k', {
        pid: 999_999_999,
        birth: 'b',
        token: 't',
        identityKind: 'exact',
      });
      expect(
        new TurnIdempotencyStore(persistence, dead).claim('k', 1, 'tracked'),
      ).toEqual({ claimed: false, indeterminate: true });
    });

    test('an untracked claim keeps the dead-owner reclaim rule', () => {
      const persistence = new InMemoryTurnIdempotencyPersistence();
      new TurnIdempotencyStore(persistence, alive).claim('k', 0);
      expect(persistence.read('k')?.invocation).toBe('untracked');
      expect(new TurnIdempotencyStore(persistence, dead).claim('k', 1)).toEqual(
        { claimed: true },
      );
    });

    test('beginInvocation refuses untracked, resolved and missing claims, and is idempotent for its owner', () => {
      const persistence = new InMemoryTurnIdempotencyPersistence();
      const owner = new TurnIdempotencyStore(persistence, alive);
      expect(() => owner.beginInvocation('missing')).toThrow('not owned');
      owner.claim('untracked', 0);
      expect(() => owner.beginInvocation('untracked')).toThrow('not owned');
      owner.claim('resolved', 0, 'tracked');
      owner.resolve('resolved', 'turn');
      expect(() => owner.beginInvocation('resolved')).toThrow('not owned');

      owner.claim('k', 0, 'tracked');
      owner.beginInvocation('k');
      owner.beginInvocation('k');
      expect(persistence.read('k')?.invocation).toBe('begun');
      // The live owner may still release after begin: it alone knows the
      // provider refused before any effect.
      owner.release('k');
      expect(owner.claim('k', 1, 'tracked')).toEqual({ claimed: true });
    });
  });

  test('independent keys never collide', () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    store.claim('turn-a');
    store.resolve('turn-a', 'result-a');

    expect(store.claim('turn-b')).toEqual({ claimed: true });
  });
});

describe('awaitTurnResolution', () => {
  test('resolves as soon as another caller writes the value', async () => {
    const persistence = new InMemoryTurnIdempotencyPersistence();
    const store = new TurnIdempotencyStore(persistence);
    store.claim('turn-a');

    const waiter = awaitTurnResolution(store, 'turn-a', 2000, 10);
    setTimeout(() => store.resolve('turn-a', 'result-late'), 30);

    await expect(waiter).resolves.toBe('result-late');
  });

  test('times out returning undefined when the claim never resolves', async () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    store.claim('turn-a');

    await expect(
      awaitTurnResolution(store, 'turn-a', 30, 10),
    ).resolves.toBeUndefined();
  });

  test('station#1224 CRITICAL fix — the missing test: the underlying operation executes EXACTLY ONCE when the original owner resolves AFTER a concurrent caller has already started polling', async () => {
    const store = new TurnIdempotencyStore(
      new InMemoryTurnIdempotencyPersistence(),
    );
    let executions = 0;

    // Simulates the real dispatch: claim, then (if owned) actually execute.
    async function attempt(key: string): Promise<string> {
      const claim = store.claim(key);
      if (!claim.claimed) {
        const resolved =
          claim.value ?? (await awaitTurnResolution(store, key, 2000, 10));
        if (!resolved) throw new Error('still processing, retry');
        return resolved;
      }
      executions += 1;
      // A long-running turn: resolves well after a concurrent caller has
      // already started polling below.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = `result-${executions}`;
      store.resolve(key, result);
      return result;
    }

    const first = attempt('turn-concurrent');
    // Let the first attempt's claim land before the second starts polling.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = attempt('turn-concurrent');

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(executions).toBe(1);
    expect(secondResult).toBe(firstResult);
  });
});
