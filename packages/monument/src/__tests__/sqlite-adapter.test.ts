import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSqliteKernelLocation,
  openSqliteKernelStorage,
  SQLITE_KERNEL_SCHEMA_VERSION,
  SqliteKernelConfigurationError,
  type SqliteKernelDatabase,
  type SqliteKernelLocation,
} from '../sqlite.js';
import { createFakeProcessTable } from '../testing/index.js';

const locations: SqliteKernelLocation[] = [];
const location = () => {
  const created = createSqliteKernelLocation();
  locations.push(created);
  return created;
};
afterEach(async () => {
  for (const created of locations.splice(0)) await created.dispose();
});

describe('node:sqlite adapter connection settings', () => {
  it('runs WAL, synchronous FULL and the busy timeout, observed on the connection', async () => {
    const { path } = location();
    const storage = openSqliteKernelStorage({ path, busyTimeoutMs: 1234 });
    expect(storage.pragmas).toEqual({
      journalMode: 'wal',
      synchronous: 'FULL',
      busyTimeoutMs: 1234,
    });
    await storage.close();
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({
        journal_mode: 'wal',
      });
    } finally {
      raw.close();
    }
  });

  it('reports a journal mode other than WAL rather than refusing to open', async () => {
    const storage = openSqliteKernelStorage({ path: ':memory:' });
    expect(storage.pragmas.journalMode).toBe('memory');
    await storage.close();
  });

  it('refuses to open when synchronous does not read back as FULL', () => {
    const real = new DatabaseSync(':memory:');
    const lying: SqliteKernelDatabase = {
      exec: (sql) => real.exec(sql),
      prepare: (sql) =>
        sql === 'PRAGMA synchronous'
          ? {
              get: () => ({ synchronous: 1 }),
              all: () => [],
              run: () => ({ changes: 0 }),
            }
          : real.prepare(sql),
    };
    try {
      expect(() => openSqliteKernelStorage({ database: lying })).toThrow(
        SqliteKernelConfigurationError,
      );
    } finally {
      real.close();
    }
  });

  it('refuses to open when busy_timeout does not read back as set', () => {
    const real = new DatabaseSync(':memory:');
    const lying: SqliteKernelDatabase = {
      exec: (sql) => real.exec(sql),
      prepare: (sql) =>
        sql === 'PRAGMA busy_timeout'
          ? {
              get: () => ({ timeout: 0 }),
              all: () => [],
              run: () => ({ changes: 0 }),
            }
          : real.prepare(sql),
    };
    try {
      expect(() => openSqliteKernelStorage({ database: lying })).toThrow(
        /busy_timeout is 0/,
      );
    } finally {
      real.close();
    }
  });

  it('refuses a busy timeout that is not a positive integer', () => {
    for (const busyTimeoutMs of [0, -1, 1.5])
      expect(() =>
        openSqliteKernelStorage({ path: ':memory:', busyTimeoutMs }),
      ).toThrow(RangeError);
  });

  it('refuses a schema version it does not know', async () => {
    const { path } = location();
    await openSqliteKernelStorage({ path }).close();
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        "UPDATE monument_meta SET value = ? WHERE key = 'schema_version'",
      )
      .run(String(SQLITE_KERNEL_SCHEMA_VERSION + 1));
    raw.close();
    expect(() => openSqliteKernelStorage({ path })).toThrow(/schema version/);
  });
});

describe('node:sqlite adapter decoding', () => {
  it('fails closed on a dedup row whose invocation is absent or unknown', async () => {
    const { path } = location();
    const processes = createFakeProcessTable();
    const dead = processes.spawn();
    const retry = processes.spawn();
    await openSqliteKernelStorage({ path }).close();
    const raw = new DatabaseSync(path);
    const owner = JSON.stringify(dead);
    // An older writer's upsert replaces owner_json without an invocation
    // record; a corrupted or future value is not one of the three.
    raw
      .prepare(
        'INSERT INTO monument_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 1, ?)',
      )
      .run('absent', owner);
    raw
      .prepare(
        'INSERT INTO monument_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 1, ?)',
      )
      .run('unknown', JSON.stringify({ ...dead, invocation: 'started' }));
    raw
      .prepare(
        'INSERT INTO monument_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 1, ?)',
      )
      .run('pending', JSON.stringify({ ...dead, invocation: 'pending' }));
    raw.close();
    processes.kill(dead);
    const storage = openSqliteKernelStorage({ path });
    const claim = (key: string) =>
      storage.executeSync(
        {
          type: 'turnDedup.claim',
          key,
          owner: retry,
          now: 2,
          tracking: 'tracked',
        },
        { liveness: processes.liveness },
      );
    expect(claim('absent')).toEqual({ kind: 'indeterminate' });
    expect(claim('unknown')).toEqual({ kind: 'indeterminate' });
    // Control: the same row with a recorded `pending` is reclaimable.
    expect(claim('pending')).toEqual({ kind: 'claimed', reclaimed: true });
    await storage.close();
  });

  it('refuses a malformed owner instead of guessing one', async () => {
    const { path } = location();
    const processes = createFakeProcessTable();
    await openSqliteKernelStorage({ path }).close();
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        'INSERT INTO monument_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 1, ?)',
      )
      .run('k', JSON.stringify({ pid: 0, id: 'x', identityKind: 'exact' }));
    raw.close();
    const storage = openSqliteKernelStorage({ path });
    await expect(
      storage.execute(
        { type: 'turnDedup.read', key: 'k' },
        { liveness: processes.liveness },
      ),
    ).rejects.toThrow(/Invalid monument owner/);
    await storage.close();
  });
});

describe('node:sqlite adapter locking', () => {
  it('serves read-only commands while another connection holds the write lock', async () => {
    const { path } = location();
    const storage = openSqliteKernelStorage({ path, busyTimeoutMs: 50 });
    const processes = createFakeProcessTable();
    const context = { liveness: processes.liveness };
    const owner = processes.spawn();
    storage.executeSync(
      { type: 'turnDedup.claim', key: 'k', owner, now: 1, tracking: 'tracked' },
      context,
    );
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA busy_timeout = 50');
    writer.exec('BEGIN IMMEDIATE');
    try {
      expect(
        storage.executeSync({ type: 'turnDedup.read', key: 'k' }, context).kind,
      ).toBe('found');
      expect(
        storage.executeSync({ type: 'turnBoundary.list' }, context).kind,
      ).toBe('records');
      expect(
        storage.executeSync(
          { type: 'turnBoundary.hasPossibleEffect', threadId: 't' },
          context,
        ).kind,
      ).toBe('available');
      // Control: a write command does wait for the lock, and gives up.
      expect(() =>
        storage.executeSync(
          {
            type: 'turnDedup.claim',
            key: 'k2',
            owner,
            now: 1,
            tracking: 'tracked',
          },
          context,
        ),
      ).toThrow(/locked/);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
      await storage.close();
    }
  });
});

describe('node:sqlite adapter on a host-owned UTF-16 database', () => {
  it('deletes by exact prefix in the database encoding', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec("PRAGMA encoding = 'UTF-16le'");
    const storage = openSqliteKernelStorage({ database });
    const processes = createFakeProcessTable();
    const context = { liveness: processes.liveness };
    const owner = processes.spawn();
    for (const key of ['ab::1', 'abc::1', 'n\u0000a::1', 'n\u0000b::1'])
      storage.executeSync(
        { type: 'turnDedup.claim', key, owner, now: 1, tracking: 'tracked' },
        context,
      );
    expect(
      storage.executeSync(
        { type: 'turnDedup.forgetPrefix', prefix: 'ab::' },
        context,
      ),
    ).toEqual({ kind: 'applied', removed: 1 });
    expect(
      storage.executeSync(
        { type: 'turnDedup.forgetPrefix', prefix: 'n\u0000a::' },
        context,
      ),
    ).toEqual({ kind: 'applied', removed: 1 });
    expect(
      storage.executeSync({ type: 'turnDedup.read', key: 'abc::1' }, context)
        .kind,
    ).toBe('found');
    await storage.close();
    database.close();
  });
});

describe('node:sqlite adapter read-only commands with a writing participant', () => {
  it('a participant may write during a read even when another connection commits first', async () => {
    const { path } = location();
    const host = new DatabaseSync(path);
    host.exec('CREATE TABLE IF NOT EXISTS audit (entry TEXT NOT NULL)');
    const storage = openSqliteKernelStorage({
      database: host,
      busyTimeoutMs: 200,
      participants: [
        {
          name: 'audit',
          commit: ({ command }, db) => {
            if (command.type !== 'turnDedup.read') return;
            // Another connection tries to commit while this one reads. It
            // may be refused (this transaction holds the write lock), but it
            // must not invalidate this transaction's own write.
            const other = new DatabaseSync(path);
            try {
              other.exec('PRAGMA busy_timeout = 20');
              other.exec("INSERT INTO audit (entry) VALUES ('other')");
            } catch {
              // Refused while this transaction holds the lock: fine.
            } finally {
              other.close();
            }
            db.prepare('INSERT INTO audit (entry) VALUES (?)').run('read');
          },
        },
      ],
    });
    const processes = createFakeProcessTable();
    expect(
      storage.executeSync(
        { type: 'turnDedup.read', key: 'k' },
        { liveness: processes.liveness },
      ),
    ).toEqual({ kind: 'absent' });
    expect(
      host
        .prepare("SELECT COUNT(*) AS n FROM audit WHERE entry = 'read'")
        .get(),
    ).toEqual({ n: 1 });
    await storage.close();
    host.close();
  });
});

describe('node:sqlite adapter co-commit participants', () => {
  it("commits a host projection's writes with the kernel's, or neither", async () => {
    const { path } = location();
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE host_projection (event TEXT NOT NULL)');
    let failHost = false;
    const storage = openSqliteKernelStorage({
      database,
      participants: [
        {
          name: 'host-projection',
          commit: ({ command, result }, host) => {
            host
              .prepare('INSERT INTO host_projection (event) VALUES (?)')
              .run(`${command.type}:${result.kind}`);
            if (failHost) throw new Error('projection failed');
          },
        },
      ],
    });
    const processes = createFakeProcessTable();
    const context = { liveness: processes.liveness };
    const owner = processes.spawn();
    storage.executeSync(
      { type: 'turnDedup.claim', key: 'a', owner, now: 1, tracking: 'tracked' },
      context,
    );
    failHost = true;
    expect(() =>
      storage.executeSync(
        {
          type: 'turnDedup.claim',
          key: 'b',
          owner,
          now: 1,
          tracking: 'tracked',
        },
        context,
      ),
    ).toThrow('projection failed');
    failHost = false;
    expect(database.prepare('SELECT event FROM host_projection').all()).toEqual(
      [{ event: 'turnDedup.claim:claimed' }],
    );
    expect(
      storage.executeSync({ type: 'turnDedup.read', key: 'b' }, context),
    ).toEqual({ kind: 'absent' });
    await storage.close();
    // The host owns this connection: closing the kernel left it open.
    expect(database.isOpen).toBe(true);
    database.close();
  });

  it('refuses to run inside a transaction the host already holds', async () => {
    const database = new DatabaseSync(':memory:');
    const storage = openSqliteKernelStorage({ database });
    const processes = createFakeProcessTable();
    database.exec('BEGIN');
    expect(() =>
      storage.executeSync(
        { type: 'turnDedup.read', key: 'k' },
        { liveness: processes.liveness },
      ),
    ).toThrow(/already holds/);
    database.exec('ROLLBACK');
    await storage.close();
    database.close();
  });
});
