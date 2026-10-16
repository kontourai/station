import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ORCHESTRATION_EVENT_STORE_MIGRATION } from '../../../domain/migrations/003-orchestration-events.js';
import { TurnIdempotencyStore } from '../../turn-idempotency.js';
import { EventStore } from '../event-store.js';
import {
  chatTurnDedupKey,
  createSqliteTurnDedupPersistence,
  turnDedupKey,
} from '../sqlite-turn-dedup-persistence.js';
import { createTurnDeduplicator } from '../turn-deduplicator.js';

describe('TurnDeduplicator', () => {
  const makeTempDir = trackTempDirs();
  const directories: string[] = [];
  afterEach(() =>
    directories
      .splice(0)
      .forEach((path) => rmSync(path, { recursive: true, force: true })),
  );

  function open(maxEntries?: number) {
    const directory = mkdtempSync(join(tmpdir(), 'station-turn-dedup-'));
    directories.push(directory);
    const store = new EventStore(
      join(directory, 'orchestration.sqlite'),
      maxEntries,
    );
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

  test('upgrades a legacy host schema without fabricating original digests; an old writer invalidates its marker', () => {
    const directory = makeTempDir('station-digest-upgrade-');
    const path = join(directory, 'legacy.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec(
      ORCHESTRATION_EVENT_STORE_MIGRATION.replace(',\n  input_digest TEXT', ''),
    );
    raw
      .prepare(
        'INSERT INTO orchestration_turn_dedup (dedup_key, value, created_at) VALUES (?, ?, ?)',
      )
      .run(turnDedupKey('thread', 'legacy'), 'legacy-turn', 1);
    const store = new EventStore(path);
    try {
      const ledger = store.createTurnDeduplicator();
      expect(
        ledger.claim({
          threadId: 'thread',
          clientTurnId: 'legacy',
          inputDigest: 'v1:retry',
        }),
      ).toEqual({ kind: 'contended', turnId: 'legacy-turn' });
      expect(
        ledger.inspect({
          threadId: 'thread',
          clientTurnId: 'legacy',
          inputDigest: 'v1:different',
        }),
      ).toEqual({ state: 'resolved', value: 'legacy-turn' });
      expect(
        raw
          .prepare(
            'SELECT input_digest FROM orchestration_turn_dedup WHERE dedup_key = ?',
          )
          .get(turnDedupKey('thread', 'legacy')),
      ).toEqual({ input_digest: null });
      const owner = ledger.claim({
        threadId: 'thread',
        clientTurnId: 'known',
        inputDigest: 'v1:A',
      });
      if (owner.kind !== 'owner') throw new Error('expected owner');
      owner.claim.resolve('turn-A');
      raw
        .prepare(
          "UPDATE orchestration_turn_dedup SET owner_json = json_remove(owner_json, '$.inputDigest') WHERE dedup_key = ?",
        )
        .run(turnDedupKey('thread', 'known'));
      expect(
        ledger.claim({
          threadId: 'thread',
          clientTurnId: 'known',
          inputDigest: 'v1:B',
        }),
      ).toEqual({ kind: 'contended', turnId: 'turn-A' });
      const row = raw
        .prepare(
          'SELECT input_digest, owner_json FROM orchestration_turn_dedup WHERE dedup_key = ?',
        )
        .get(turnDedupKey('thread', 'known')) as {
        input_digest: string;
        owner_json: string;
      };
      expect(row.input_digest).toBe('v1:A');
      expect(JSON.parse(row.owner_json)).not.toHaveProperty('inputDigest');
    } finally {
      store.close();
      raw.close();
    }
  });

  test('a waiter never reports a replacement claim with different input as its accepted turn', async () => {
    const { store, ledger } = open();
    try {
      const input = {
        threadId: 'thread',
        clientTurnId: 'K',
        inputDigest: 'v1:A',
      };
      const original = ledger.claim(input);
      if (original.kind !== 'owner') throw new Error('expected original owner');
      const waiting = ledger.awaitResolution({
        ...input,
        intervalMs: 1,
        timeoutMs: 1000,
      });
      original.claim.release();
      const replacement = store
        .createTurnDeduplicator()
        .claim({ ...input, inputDigest: 'v1:B' });
      if (replacement.kind !== 'owner')
        throw new Error('expected replacement owner');
      replacement.claim.resolve('turn-B');
      await expect(waiting).rejects.toMatchObject({
        code: 'client_turn_input_conflict',
      });
    } finally {
      store.close();
    }
  });

  test('inspect: a claim whose owner cannot be proven live or dead reads in flight only for a bounded time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // A tracked directory from the suite's helper; its own store is not
      // the one under test.
      const { directory, store: helperStore } = open();
      helperStore.close();
      const store = new EventStore(
        join(directory, 'unknowable-owner.sqlite'),
        512,
        {
          exact: () => ({ pid: process.pid, start: 'unknowable' }),
          probe: () => ({ state: 'unavailable' }),
        },
      );
      const ledger = store.createTurnDeduplicator();
      expect(ledger.claim({ threadId: 't', clientTurnId: 'k' }).kind).toBe(
        'owner',
      );
      vi.setSystemTime(Date.now() + 14 * 60_000);
      expect(ledger.inspect({ threadId: 't', clientTurnId: 'k' })).toEqual({
        state: 'in-flight',
      });
      vi.setSystemTime(Date.now() + 2 * 60_000);
      // Indeterminate to the lookup, but only by age (#3568): a resend may
      // still join it.
      expect(ledger.inspect({ threadId: 't', clientTurnId: 'k' })).toEqual({
        state: 'indeterminate',
        ageOnly: true,
      });
      // A live owner's claim is bounded the same way.
      const live = open();
      expect(
        live.ledger.claim({ threadId: 't', clientTurnId: 'live' }).kind,
      ).toBe('owner');
      vi.setSystemTime(Date.now() + 16 * 60_000);
      expect(
        live.ledger.inspect({ threadId: 't', clientTurnId: 'live' }),
      ).toEqual({ state: 'indeterminate', ageOnly: true });
      live.store.close();
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('inspect: an owner that gave its claim up after a possible effect reads indeterminate, never in flight', () => {
    const { store, ledger, directory } = open();
    const owner = ledger.claim({ threadId: 't', clientTurnId: 'gave-up' });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    owner.claim.beginInvocation();
    expect(ledger.inspect({ threadId: 't', clientTurnId: 'gave-up' })).toEqual({
      state: 'in-flight',
    });
    owner.claim.retain();
    expect(ledger.inspect({ threadId: 't', clientTurnId: 'gave-up' })).toEqual({
      state: 'indeterminate',
    });
    // Never claimable, and this owner's claim agrees with inspect instead of
    // reading contended (a wait on a claim nothing will resolve).
    expect(ledger.claim({ threadId: 't', clientTurnId: 'gave-up' })).toEqual({
      kind: 'indeterminate',
    });
    // Retain writes nothing durable: another live process still meets the
    // unresolved claim as contended.
    const peer = new EventStore(join(directory, 'orchestration.sqlite'));
    expect(
      peer
        .createTurnDeduplicator()
        .claim({ threadId: 't', clientTurnId: 'gave-up' }),
    ).toEqual({ kind: 'contended', turnId: undefined });
    peer.close();
    store.close();
  });

  test('a key claimed afresh after its thread was deleted is in flight, not the old given-up claim', () => {
    const { store, ledger } = open();
    const owner = ledger.claim({ threadId: 't', clientTurnId: 'reused' });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    owner.claim.beginInvocation();
    owner.claim.retain();
    store.deleteThread('t');
    // The same thread id and key, used again: a new attempt owns it.
    const again = ledger.claim({ threadId: 't', clientTurnId: 'reused' });
    expect(again.kind).toBe('owner');
    expect(ledger.inspect({ threadId: 't', clientTurnId: 'reused' })).toEqual({
      state: 'in-flight',
    });
    expect(ledger.claim({ threadId: 't', clientTurnId: 'reused' })).toEqual({
      kind: 'contended',
      turnId: undefined,
    });
    store.close();
  });

  test("givenUp is never true for another owner's claim of a reused key, however old", () => {
    const { store, ledger, directory } = open();
    const owner = ledger.claim({
      threadId: 't',
      clientTurnId: 'reused-elsewhere',
    });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    owner.claim.beginInvocation();
    owner.claim.retain();
    store.deleteThread('t');
    // Another store on the same database (another owner) claims the key.
    const peer = new EventStore(join(directory, 'orchestration.sqlite'));
    const fresh = peer
      .createTurnDeduplicator()
      .claim({ threadId: 't', clientTurnId: 'reused-elsewhere' });
    expect(fresh.kind).toBe('owner');
    const realNow = Date.now.bind(Date);
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + 16 * 60_000);
    try {
      // The lookup calls a claim this old indeterminate; it is still not
      // one this owner gave up, so a same-key claim here waits on it.
      expect(
        ledger.inspect({ threadId: 't', clientTurnId: 'reused-elsewhere' }),
      ).toEqual({ state: 'indeterminate', ageOnly: true });
      expect(
        ledger.givenUp({ threadId: 't', clientTurnId: 'reused-elsewhere' }),
      ).toBe(false);
      expect(
        ledger.claim({ threadId: 't', clientTurnId: 'reused-elsewhere' }),
      ).toEqual({ kind: 'contended', turnId: undefined });
    } finally {
      clock.mockRestore();
      peer.close();
      store.close();
    }
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

  function restartWithDeadOwners(directory: string) {
    return new EventStore(join(directory, 'orchestration.sqlite'), 512, {
      exact: () => ({ pid: process.pid, start: 'replacement' }),
      probe: () => ({ state: 'dead' }),
    });
  }

  test('reclaims a dead owner claim that never began invoking, and isolates wildcard-like thread ids', () => {
    const first = open();
    first.ledger.claim({ threadId: 'th%', clientTurnId: 'client' });
    first.store.close();
    const restarted = restartWithDeadOwners(first.directory);
    const ledger = restarted.createTurnDeduplicator();
    expect(
      ledger.claim({ threadId: 'th%', clientTurnId: 'client' }),
    ).toMatchObject({ kind: 'owner' });
    expect(
      ledger.claim({ threadId: 'thAnything', clientTurnId: 'client' }),
    ).toMatchObject({ kind: 'owner' });
    restarted.close();
  });

  // #3559: inverted. A dead owner that began invoking may already have handed
  // the turn to the engine, so its claim is never reclaimed.
  test('never reclaims a dead owner claim that began invoking; every retry is indeterminate', () => {
    const first = open();
    const owner = first.ledger.claim({
      threadId: 'thread',
      clientTurnId: 'invoked',
    });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    owner.claim.beginInvocation();
    first.store.close();

    const restarted = restartWithDeadOwners(first.directory);
    const ledger = restarted.createTurnDeduplicator();
    expect(
      ledger.claim({ threadId: 'thread', clientTurnId: 'invoked' }),
    ).toEqual({ kind: 'indeterminate' });
    expect(
      ledger.claim({ threadId: 'thread', clientTurnId: 'invoked' }),
    ).toEqual({ kind: 'indeterminate' });
    restarted.close();
  });

  test('fails closed on a dead owner claim written before invocation was recorded', () => {
    const first = open();
    first.store.close();
    const database = new DatabaseSync(
      join(first.directory, 'orchestration.sqlite'),
    );
    try {
      database
        .prepare(
          `INSERT INTO orchestration_turn_dedup
             (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 0, ?)`,
        )
        .run(
          turnDedupKey('thread', 'legacy'),
          JSON.stringify({
            pid: 999_999_999,
            birth: 'dead-birth',
            token: 'legacy-owner',
            identityKind: 'exact',
          }),
        );
    } finally {
      database.close();
    }

    const restarted = restartWithDeadOwners(first.directory);
    expect(
      restarted
        .createTurnDeduplicator()
        .claim({ threadId: 'thread', clientTurnId: 'legacy' }),
    ).toEqual({ kind: 'indeterminate' });
    restarted.close();
  });

  test('a legacy /chat row keeps the dead-owner reclaim rule while a legacy thread row fails closed', () => {
    const first = open();
    first.store.close();
    const database = new DatabaseSync(
      join(first.directory, 'orchestration.sqlite'),
    );
    try {
      const insert = database.prepare(
        `INSERT INTO orchestration_turn_dedup
           (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 0, ?)`,
      );
      const deadOwner = JSON.stringify({
        pid: 999_999_999,
        birth: 'dead-birth',
        token: 'legacy-owner',
        identityKind: 'exact',
      });
      // `/chat` rows are written only by the facade, which records no
      // invocation, so an unmarked `chat:` row is untracked by construction.
      insert.run(chatTurnDedupKey('legacy-chat'), deadOwner);
      insert.run(turnDedupKey('thread', 'legacy-thread'), deadOwner);
    } finally {
      database.close();
    }

    const restarted = restartWithDeadOwners(first.directory);
    expect(restarted.claimChatTurn('legacy-chat')).toEqual({ claimed: true });
    expect(
      restarted
        .createTurnDeduplicator()
        .claim({ threadId: 'thread', clientTurnId: 'legacy-thread' }),
    ).toEqual({ kind: 'indeterminate' });
    restarted.close();
  });

  // #3581: a /chat claim records invocation like a thread claim does.
  test('a /chat claim whose dead owner began invoking is indeterminate on every retry; one that never began is reclaimed', () => {
    const first = open();
    expect(first.store.claimChatTurn('chat-invoked')).toEqual({
      claimed: true,
    });
    first.store.beginChatTurnInvocation('chat-invoked');
    expect(first.store.claimChatTurn('chat-pending')).toEqual({
      claimed: true,
    });
    first.store.close();

    const restarted = restartWithDeadOwners(first.directory);
    expect(restarted.claimChatTurn('chat-invoked')).toEqual({
      claimed: false,
      outcome: 'indeterminate',
    });
    expect(restarted.claimChatTurn('chat-invoked')).toEqual({
      claimed: false,
      outcome: 'indeterminate',
    });
    expect(restarted.claimChatTurn('chat-pending')).toEqual({ claimed: true });
    restarted.close();
  });

  test('a /chat row carrying an unrecognised invocation record fails closed', () => {
    const first = open();
    first.store.close();
    const database = new DatabaseSync(
      join(first.directory, 'orchestration.sqlite'),
    );
    try {
      database
        .prepare(
          `INSERT INTO orchestration_turn_dedup
             (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 0, ?)`,
        )
        .run(
          chatTurnDedupKey('chat-future'),
          JSON.stringify({
            pid: 999_999_999,
            birth: 'dead-birth',
            token: 'future-owner',
            identityKind: 'exact',
            invocation: 'a-later-state',
          }),
        );
    } finally {
      database.close();
    }
    const restarted = restartWithDeadOwners(first.directory);
    expect(restarted.claimChatTurn('chat-future')).toEqual({
      claimed: false,
      outcome: 'indeterminate',
    });
    restarted.close();
  });

  // #3559: eviction must never make a key claimable again.
  test('an evicted resolved key answers expired, never owner, across restart; tombstones do not count toward the cap', () => {
    const { store, ledger, directory } = open(2);
    const path = join(directory, 'orchestration.sqlite');
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
    for (const clientTurnId of keys) {
      const owner = ledger.claim({ threadId: 'thread', clientTurnId });
      if (owner.kind !== 'owner') throw new Error('expected owner');
      owner.claim.resolve(`turn-${clientTurnId}`);
    }
    for (const clientTurnId of ['k1', 'k2', 'k3'])
      expect(ledger.claim({ threadId: 'thread', clientTurnId })).toEqual({
        kind: 'expired',
      });
    // The two newest stay full rows: the cap counts live rows, not tombstones.
    expect(ledger.claim({ threadId: 'thread', clientTurnId: 'k4' })).toEqual({
      kind: 'contended',
      turnId: 'turn-k4',
    });
    expect(ledger.claim({ threadId: 'thread', clientTurnId: 'k5' })).toEqual({
      kind: 'contended',
      turnId: 'turn-k5',
    });
    store.close();

    // A /chat key evicted the same way answers expired too. Rows created in
    // the same millisecond are evicted in key order, so `chat-a` goes first.
    const { store: chatStore } = open(2);
    for (const clientTurnId of ['chat-a', 'chat-b', 'chat-c']) {
      expect(chatStore.claimChatTurn(clientTurnId)).toEqual({ claimed: true });
      chatStore.resolveChatTurn(clientTurnId, `conversation-${clientTurnId}`);
    }
    expect(chatStore.claimChatTurn('chat-a')).toEqual({
      claimed: false,
      outcome: 'expired',
    });
    expect(chatStore.claimChatTurn('chat-c')).toEqual({
      claimed: false,
      conversationId: 'conversation-chat-c',
    });
    chatStore.close();

    const restarted = new EventStore(path, 2);
    expect(
      restarted
        .createTurnDeduplicator()
        .claim({ threadId: 'thread', clientTurnId: 'k1' }),
    ).toEqual({ kind: 'expired' });
    // Tombstones leave with their thread.
    restarted.deleteThread('thread');
    expect(
      restarted
        .createTurnDeduplicator()
        .claim({ threadId: 'thread', clientTurnId: 'k1' }),
    ).toMatchObject({ kind: 'owner' });
    restarted.close();
  });

  // #3606 review: a tombstone answers only for its own key.
  test('evicting one /chat key never makes a different fresh /chat key answer expired', () => {
    const { store } = open(2);
    for (const clientTurnId of ['chat-a', 'chat-b', 'chat-c']) {
      expect(store.claimChatTurn(clientTurnId)).toEqual({ claimed: true });
      store.resolveChatTurn(clientTurnId, `conversation-${clientTurnId}`);
    }
    expect(store.claimChatTurn('chat-a')).toEqual({
      claimed: false,
      outcome: 'expired',
    });
    expect(store.claimChatTurn('chat-fresh')).toEqual({ claimed: true });
    expect(
      store
        .createTurnDeduplicator()
        .claim({ threadId: 'thread', clientTurnId: 'fresh' }),
    ).toMatchObject({ kind: 'owner' });
    store.close();
  });

  // #3606 review F2: /chat tombstones are time-bounded at 30 days, far past
  // every retry window Station has (the longest is 7 days).
  test('a /chat tombstone past 30 days is removed while one inside the bound still answers expired', () => {
    const { store, directory } = open(2);
    const settle = (clientTurnId: string) => {
      expect(store.claimChatTurn(clientTurnId)).toEqual({ claimed: true });
      store.resolveChatTurn(clientTurnId, `conversation-${clientTurnId}`);
    };
    // c1 and c2 are evicted to tombstones; c3 and c4 stay full rows.
    for (const clientTurnId of ['c1', 'c2', 'c3', 'c4']) settle(clientTurnId);
    const day = 24 * 60 * 60 * 1000;
    const database = new DatabaseSync(join(directory, 'orchestration.sqlite'));
    try {
      const backdate = database.prepare(
        'UPDATE orchestration_turn_dedup_expired SET expired_at = ? WHERE dedup_key = ?',
      );
      backdate.run(Date.now() - 31 * day, chatTurnDedupKey('c1'));
      backdate.run(Date.now() - 29 * day, chatTurnDedupKey('c2'));
    } finally {
      database.close();
    }
    // The next dedup write runs retention.
    settle('c5');
    const tombstones = new DatabaseSync(
      join(directory, 'orchestration.sqlite'),
    );
    try {
      const keys = (
        tombstones
          .prepare('SELECT dedup_key FROM orchestration_turn_dedup_expired')
          .all() as Array<{ dedup_key: string }>
      ).map((row) => row.dedup_key);
      expect(keys).not.toContain(chatTurnDedupKey('c1'));
      expect(keys).toContain(chatTurnDedupKey('c2'));
    } finally {
      tombstones.close();
    }
    expect(store.claimChatTurn('c2')).toEqual({
      claimed: false,
      outcome: 'expired',
    });
    expect(store.claimChatTurn('c1')).toEqual({ claimed: true });
    store.close();
  });

  // #3606 delta review: a thread tombstone outlives the time bound. A
  // session-control start re-drives its unresolved request key forever, with
  // the same clientTurnId, so its thread tombstone must last as long: until
  // deleteThread removes both.
  test('an evicted thread key stays expired past 30 days, so a late re-drive never sends again', () => {
    const { store, ledger, directory } = open(2);
    const outcomes: string[] = [];
    const settle = (clientTurnId: string) => {
      const owner = ledger.claim({ threadId: 'thread', clientTurnId });
      if (clientTurnId === 'a-start') outcomes.push(owner.kind);
      if (owner.kind !== 'owner') throw new Error('expected owner');
      owner.claim.resolve(`turn-${clientTurnId}`);
    };
    // Same-millisecond rows are evicted in key order, so `a-start` goes first.
    settle('a-start');
    settle('k2');
    settle('k3');
    outcomes.push(
      ledger.claim({ threadId: 'thread', clientTurnId: 'a-start' }).kind,
    );
    const database = new DatabaseSync(join(directory, 'orchestration.sqlite'));
    try {
      database
        .prepare(
          'UPDATE orchestration_turn_dedup_expired SET expired_at = ? WHERE dedup_key = ?',
        )
        .run(
          Date.now() - 31 * 24 * 60 * 60 * 1000,
          turnDedupKey('thread', 'a-start'),
        );
    } finally {
      database.close();
    }
    settle('k4');
    outcomes.push(
      ledger.claim({ threadId: 'thread', clientTurnId: 'a-start' }).kind,
    );
    expect(outcomes).toEqual(['owner', 'expired', 'expired']);
    // deleteThread is the bound: it removes the tombstone with the thread.
    store.deleteThread('thread');
    expect(
      ledger.claim({ threadId: 'thread', clientTurnId: 'a-start' }),
    ).toMatchObject({ kind: 'owner' });
    store.close();
  });

  test('keeps an owner handle usable when its first durable resolve rolls back', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    const persistence = createSqliteTurnDedupPersistence({ db: database });
    let failResolve = true;
    const store = new TurnIdempotencyStore({
      execute: (command, liveness) => {
        if (failResolve && command.type === 'turnDedup.resolve') {
          failResolve = false;
          throw new Error('injected rollback');
        }
        return persistence.execute(command, liveness);
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
    database.close();
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
