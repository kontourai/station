import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createSqliteRecoveryStorage } from '../recovery-ledger.js';
import {
  createRecoveryHarness,
  createSqliteKernelLocation,
  type RecoveryConformanceHarness,
  recoveryConformanceCases,
  registerRecoveryConformance,
} from '../testing/index.js';

for (const kind of ['memory', 'sqlite'] as const)
  for (const via of ['sync', 'async'] as const)
    registerRecoveryConformance(
      { describe, it },
      createRecoveryHarness(kind, via),
    );

describe('recovery conformance rejects a broken adapter', () => {
  it('catches a store that drops a committed command', async () => {
    const good = createRecoveryHarness('memory', 'async');
    const broken: RecoveryConformanceHarness = {
      name: 'drops the committed image',
      async create() {
        let session = await good.create();
        const sessions = [session];
        return {
          get storage() {
            return session.storage;
          },
          reopen: async () => {
            session = await good.create();
            sessions.push(session);
          },
          markSourceTerminated: (threadId, turnId) =>
            session.markSourceTerminated(threadId, turnId),
          failNextCommit: () => session.failNextCommit(),
          loseNextAcknowledgement: () => session.loseNextAcknowledgement(),
          onNextCommit: (callback) => session.onNextCommit(callback),
          dispose: async () => {
            for (const item of sessions) await item.dispose();
          },
        };
      },
    };
    const persistence = recoveryConformanceCases.find((entry) =>
      entry.name.startsWith('arms idempotently'),
    );
    if (!persistence) throw new Error('missing persistence conformance case');
    await expect(persistence.run(broken)).rejects.toThrow();
  });
});

describe('recovery SQLite binding prerequisites', () => {
  it('requires WAL and a busy timeout, sets FULL, and creates no schema', async () => {
    const memory = new DatabaseSync(':memory:');
    const bind = (db: DatabaseSync) =>
      createSqliteRecoveryStorage({
        db,
        table: 'host_recovery',
        mapRecord: () => {
          throw new Error('unused');
        },
        project: () => undefined,
        sourceTerminalSql: '0',
      });
    expect(() => bind(memory)).toThrow('requires SQLite WAL mode');
    memory.close();

    const location = createSqliteKernelLocation();
    const database = new DatabaseSync(location.path);
    try {
      database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0');
      expect(() => bind(database)).toThrow('requires a positive busy timeout');
      database.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL');
      const before = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all();
      const storage = bind(database);
      expect(database.prepare('PRAGMA synchronous').get()).toEqual({
        synchronous: 2,
      });
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all(),
      ).toEqual(before);
      expect(() =>
        storage.executeSync({ type: 'findRecoveryIntent', args: ['missing'] }),
      ).toThrow(/no such table/);
    } finally {
      database.close();
      await location.dispose();
    }
  });
});
