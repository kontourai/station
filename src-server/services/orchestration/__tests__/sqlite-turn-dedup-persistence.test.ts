import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import { createSqliteSessionControlRequestKeys } from '../session-control-request-keys.js';
import {
  chatTurnDedupKey,
  turnDedupKey,
} from '../sqlite-turn-dedup-persistence.js';

/**
 * What Station keeps of the turn-dedup rules is where the rows live and how
 * they are written: Monument decides, and these tests pin the seam, through a
 * real EventStore and its real tables.
 */
describe('turn dedup over Station tables', () => {
  const makeTempDir = trackTempDirs();
  function open() {
    const file = join(
      makeTempDir('station-dedup-seam-'),
      'orchestration.sqlite',
    );
    return { store: new EventStore(file), file };
  }
  const rows = (file: string, sql: string, ...params: string[]) => {
    const database = new DatabaseSync(file);
    try {
      return database.prepare(sql).all(...params);
    } finally {
      database.close();
    }
  };

  test('writes the owner under the name an older binary reads, with the invocation beside it', () => {
    const { store, file } = open();
    expect(store.claimChatTurn('turn-a')).toEqual({ claimed: true });
    store.beginChatTurnInvocation('turn-a');
    store.close();
    const [row] = rows(
      file,
      'SELECT owner_json AS ownerJson FROM orchestration_turn_dedup WHERE dedup_key = ?',
      chatTurnDedupKey('turn-a'),
    ) as Array<{ ownerJson: string }>;
    const owner = JSON.parse(row?.ownerJson ?? 'null') as Record<
      string,
      unknown
    >;
    // The shape the pre-#3559 writer parses: pid, token, identityKind (and
    // birth for an exact owner). Anything it needs missing makes it throw.
    expect(owner).toMatchObject({
      pid: process.pid,
      identityKind: expect.stringMatching(/^(exact|unverified)$/),
      invocation: 'begun',
    });
    expect(typeof owner.token).toBe('string');
    expect(owner.token).not.toBe('');
    expect(owner).not.toHaveProperty('id');
  });

  test('creates nothing of Monument next to the Station tables', () => {
    const { store, file } = open();
    store.claimChatTurn('turn-a');
    store.sessionControlRequestKeys();
    store.close();
    expect(
      rows(
        file,
        "SELECT name FROM sqlite_master WHERE name LIKE 'monument\\_%' ESCAPE '\\'",
      ),
    ).toEqual([]);
  });

  // #3611: the old statement compared UTF-16 code units against SQLite's
  // characters, so a thread id holding a character outside the BMP kept its
  // claims after deleteThread. Monument compares the stored bytes.
  test('deleteThread forgets the claims and tombstones of a thread id outside the BMP', () => {
    const { store } = open();
    const ledger = store.createTurnDeduplicator();
    const replacementInput = {
      threadId: 't\ufffdx',
      clientInputId: 'retained',
      input: 'keep this receipt',
    };
    expect(store.claimSteerInput(replacementInput)).toBe(true);
    store.confirmSteerInput(replacementInput, 'retained-turn');
    const validInput = { ...replacementInput, threadId: 't\u{1f600}' };
    expect(store.claimSteerInput(validInput)).toBe(true);
    for (const threadId of ['t\u{1f600}', 't\ud800x']) {
      expect(ledger.claim({ threadId, clientTurnId: 'a' })).toMatchObject({
        kind: 'owner',
      });
      store.deleteThread(threadId);
      expect(ledger.claim({ threadId, clientTurnId: 'a' })).toMatchObject({
        kind: 'owner',
      });
    }
    expect(store.readSteerInput(validInput)).toBeUndefined();
    expect(store.readSteerInput(replacementInput)).toMatchObject({
      outcome: 'steered',
      turnId: 'retained-turn',
    });
    store.close();
  });

  test('deleteThread leaves the same-looking thread of another id alone', () => {
    const { store } = open();
    const ledger = store.createTurnDeduplicator();
    ledger.claim({ threadId: 't\u{1f600}', clientTurnId: 'a' });
    ledger.claim({ threadId: 't\u{1f600}x', clientTurnId: 'a' });
    store.deleteThread('t\u{1f600}');
    expect(
      ledger.claim({ threadId: 't\u{1f600}x', clientTurnId: 'a' }),
    ).toEqual({
      kind: 'contended',
      turnId: undefined,
    });
    store.close();
  });

  test('the dedup rows leave in the same transaction as the rest of the thread', () => {
    const { store, file } = open();
    const ledger = store.createTurnDeduplicator();
    ledger.claim({ threadId: 'thread', clientTurnId: 'a' });
    // Fail deleteThread's own COMMIT, but only once the dedup step has run as
    // a savepoint inside its transaction. If the dedup step opened a
    // transaction of its own instead, its COMMIT would pass untouched, the
    // host's COMMIT would not be the one that fails, and this would not throw.
    const inner = store as unknown as { db: DatabaseSync };
    const exec = inner.db.exec.bind(inner.db);
    let dedupStepJoined = false;
    inner.db.exec = ((sql: string) => {
      if (sql.startsWith('RELEASE')) dedupStepJoined = true;
      if (sql === 'COMMIT' && dedupStepJoined)
        throw new Error('injected commit failure');
      return exec(sql);
    }) as typeof inner.db.exec;
    expect(() => store.deleteThread('thread')).toThrow(
      'injected commit failure',
    );
    inner.db.exec = exec;
    expect(
      rows(
        file,
        'SELECT dedup_key FROM orchestration_turn_dedup WHERE dedup_key = ?',
        turnDedupKey('thread', 'a'),
      ),
    ).toHaveLength(1);
    store.close();
  });

  // The store owns its connection's settings. In a test worker that includes
  // the fixture's `synchronous = OFF` (sqlite-fixture-durability.ts), which
  // opening the kernels must not undo: it would slow every store a test builds.
  test("opening the kernels leaves the connection's own pragmas alone", () => {
    const { store } = open();
    const db = (store as unknown as { db: DatabaseSync }).db;
    const pragma = (name: string) =>
      Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
    const before = {
      synchronous: pragma('synchronous'),
      busyTimeout: pragma('busy_timeout'),
      journalMode: pragma('journal_mode'),
    };
    store.sessionControlRequestKeys();
    expect(before.synchronous).toBe(0);
    expect({
      synchronous: pragma('synchronous'),
      busyTimeout: pragma('busy_timeout'),
      journalMode: pragma('journal_mode'),
    }).toEqual(before);
    store.close();
  });

  test('refuses an invalid retention limit when the store is built, not at its first claim', () => {
    const file = join(
      makeTempDir('station-dedup-limit-'),
      'orchestration.sqlite',
    );
    for (const maxEntries of [0, 1.5])
      expect(() => new EventStore(file, maxEntries)).toThrow(RangeError);
    const { store } = open();
    const db = (store as unknown as { db: DatabaseSync }).db;
    expect(() =>
      createSqliteSessionControlRequestKeys(db, { limits: { perCaller: 0 } }),
    ).toThrow(RangeError);
    store.close();
  });
});
