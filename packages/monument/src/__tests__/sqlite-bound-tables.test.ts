import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { KernelContext } from '../port.js';
import {
  openSqliteKernelStorage,
  SqliteKernelConfigurationError,
  type SqliteKernelStorage,
  type SqliteKernelTables,
} from '../sqlite.js';
import { createFakeProcessTable } from '../testing/index.js';

/** A host that predates the kernel: its own names, `token` for the owner id. */
const HOST_SCHEMA = `
CREATE TABLE host_dedup (
  dedup_key TEXT PRIMARY KEY, value TEXT, created_at INTEGER NOT NULL, owner_json TEXT
);
CREATE TABLE host_dedup_expired (
  dedup_key TEXT PRIMARY KEY, expired_at INTEGER NOT NULL
);
CREATE TABLE host_keys (
  caller_session_id TEXT NOT NULL, tool TEXT NOT NULL, request_key TEXT NOT NULL,
  digest TEXT NOT NULL, decision TEXT, result_json TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (caller_session_id, tool, request_key)
);`;

const BOUND: SqliteKernelTables = {
  turnDedup: {
    table: 'host_dedup',
    tombstoneTable: 'host_dedup_expired',
    ownerIdField: 'token',
    ownerErrorMessage: 'Invalid host claim owner_json',
    legacyUntrackedKeyPrefixes: ['chat:'],
  },
  requestKeys: { table: 'host_keys', resultColumn: 'result_json' },
  turnBoundary: 'unused',
  inbox: 'unused',
};

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});

function host(schema = HOST_SCHEMA) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  open.push(() => db.close());
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function storage(
  db: DatabaseSync,
  tables: SqliteKernelTables = BOUND,
): SqliteKernelStorage {
  return openSqliteKernelStorage({ database: db, tables });
}

function context(processes = createFakeProcessTable()): KernelContext {
  return { liveness: processes.liveness };
}

describe('node:sqlite adapter bound to a host schema', () => {
  it('reads and writes the host tables, in the host encoding, and creates none of its own', () => {
    const db = host();
    const kernel = storage(db);
    const processes = createFakeProcessTable();
    const owner = processes.spawn();
    expect(
      kernel.executeSync(
        {
          type: 'turnDedup.claim',
          key: 'k',
          owner,
          now: 5,
          tracking: 'tracked',
        },
        context(processes),
      ),
    ).toEqual({ kind: 'claimed', reclaimed: false });
    expect(
      kernel.executeSync(
        {
          type: 'requestKeys.claim',
          id: { callerSessionId: 'c', tool: 't', key: 'r' },
          digest: 'd',
          now: 5,
        },
        context(processes),
      ),
    ).toEqual({ kind: 'claimed' });
    kernel.executeSync(
      {
        type: 'requestKeys.complete',
        id: { callerSessionId: 'c', tool: 't', key: 'r' },
        result: '{"ok":true}',
      },
      context(processes),
    );

    const row = db.prepare('SELECT * FROM host_dedup').get() as {
      owner_json: string;
    };
    // The owner id is stored under the host's field name, never as `id`, so a
    // writer from before the kernel reads the row as it always did.
    expect(JSON.parse(row.owner_json)).toEqual({
      pid: owner.pid,
      identityKind: 'exact',
      birth: owner.identityKind === 'exact' ? owner.birth : undefined,
      token: owner.id,
      invocation: 'pending',
    });
    expect(db.prepare('SELECT result_json FROM host_keys').get()).toEqual({
      result_json: '{"ok":true}',
    });
    // Nothing of the kernel's own, not even its version table.
    expect(
      tableNames(db).filter((name) => name.startsWith('monument_')),
    ).toEqual([]);
  });

  it('reads a row a writer from before the kernel wrote, and a kernel row reads back', () => {
    const db = host();
    const kernel = storage(db);
    const processes = createFakeProcessTable();
    const dead = processes.spawn();
    processes.kill(dead);
    const legacy = (invocation?: unknown) =>
      JSON.stringify({
        pid: dead.pid,
        birth: dead.identityKind === 'exact' ? dead.birth : 'x',
        token: dead.id,
        identityKind: 'exact',
        ...(invocation === undefined ? {} : { invocation }),
      });
    const insert = db.prepare(
      'INSERT INTO host_dedup (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 1, ?)',
    );
    insert.run('thread:none', legacy());
    insert.run('chat:none', legacy());
    insert.run('chat:unknown', legacy('from-the-future'));
    insert.run('chat:begun', legacy('begun'));
    const successor = processes.spawn();
    const claim = (key: string) =>
      kernel.executeSync(
        {
          type: 'turnDedup.claim',
          key,
          owner: successor,
          now: 9,
          tracking: 'tracked',
        },
        context(processes),
      );
    // No invocation record on a key the host never tracked: untracked, so
    // reclaimable. The same absence on any other key is unknown, and a dead
    // owner's unknown claim is never reclaimed.
    expect(claim('chat:none')).toEqual({ kind: 'claimed', reclaimed: true });
    expect(claim('thread:none')).toEqual({ kind: 'indeterminate' });
    // A record that is present but unrecognised fails closed everywhere.
    expect(claim('chat:unknown')).toEqual({ kind: 'indeterminate' });
    expect(claim('chat:begun')).toEqual({ kind: 'indeterminate' });
    // An ownerless row has no owner to prove dead.
    db.prepare(
      'INSERT INTO host_dedup (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 1, NULL)',
    ).run('chat:ownerless');
    expect(claim('chat:ownerless')).toEqual({ kind: 'contended' });
  });

  it("refuses a malformed owner with the host's own message and leaves the row alone", () => {
    const db = host();
    const kernel = storage(db);
    db.prepare(
      'INSERT INTO host_dedup (dedup_key, value, created_at, owner_json) VALUES (?, NULL, 1, ?)',
    ).run('k', '{"pid":"not-a-pid"}');
    const processes = createFakeProcessTable();
    for (const owner of ['{"pid":"not-a-pid"}', 'not json']) {
      db.prepare('UPDATE host_dedup SET owner_json = ?').run(owner);
      expect(() =>
        kernel.executeSync(
          {
            type: 'turnDedup.claim',
            key: 'k',
            owner: processes.spawn(),
            now: 2,
            tracking: 'tracked',
          },
          context(processes),
        ),
      ).toThrow('Invalid host claim owner_json');
      expect(db.prepare('SELECT owner_json FROM host_dedup').get()).toEqual({
        owner_json: owner,
      });
    }
  });

  it('refuses to open over a bound table that is missing or lacks a column', () => {
    expect(() => storage(host('CREATE TABLE unrelated (x TEXT)'))).toThrow(
      /bound table host_dedup does not exist/,
    );
    const noResult = HOST_SCHEMA.replace('result_json TEXT, ', '');
    expect(() => storage(host(noResult))).toThrow(
      /bound table host_keys has no column result_json/,
    );
    expect(() => storage(host(noResult))).toThrow(
      SqliteKernelConfigurationError,
    );
  });

  it('accepts only plain identifiers as table names', () => {
    const db = host();
    expect(() =>
      storage(db, {
        requestKeys: {
          table: 'host_keys; DROP TABLE host_keys',
          resultColumn: 'result_json',
        },
      }),
    ).toThrow(/plain SQL identifier/);
    expect(() =>
      storage(db, {
        requestKeys: { table: 'host_keys', resultColumn: 'result_json --' },
      }),
    ).toThrow(/plain SQL identifier/);
    expect(tableNames(db)).toContain('host_keys');
  });

  it('refuses the commands of an area it keeps no tables for', () => {
    const kernel = storage(host());
    expect(() =>
      kernel.executeSync(
        {
          type: 'steerReceipts.read',
          threadId: 'thread',
          clientInputId: 'input',
          inputDigest: 'digest',
        },
        context(),
      ),
    ).toThrow(/keeps no steerReceipts tables/);
    expect(() =>
      kernel.executeSync({ type: 'turnBoundary.list' }, context()),
    ).toThrow(/keeps no turnBoundary tables/);
    expect(() =>
      kernel.executeSync({ type: 'inbox.listOpen' }, context()),
    ).toThrow(/keeps no inbox tables/);
  });

  it('keeps an unbound area on its own tables beside a bound one', () => {
    const db = host();
    const kernel = openSqliteKernelStorage({
      database: db,
      tables: {
        requestKeys: { table: 'host_keys', resultColumn: 'result_json' },
      },
    });
    const processes = createFakeProcessTable();
    expect(
      kernel.executeSync(
        {
          type: 'turnDedup.claim',
          key: 'k',
          owner: processes.spawn(),
          now: 1,
          tracking: 'tracked',
        },
        context(processes),
      ),
    ).toEqual({ kind: 'claimed', reclaimed: false });
    expect(
      db.prepare('SELECT count(*) AS n FROM monument_turn_dedup').get(),
    ).toEqual({
      n: 1,
    });
    expect(db.prepare('SELECT count(*) AS n FROM host_dedup').get()).toEqual({
      n: 0,
    });
  });
});

describe('executeSync inside the host transaction', () => {
  const claim = (key: string, processes = createFakeProcessTable()) =>
    ({
      type: 'turnDedup.claim',
      key,
      owner: processes.spawn(),
      now: 1,
      tracking: 'tracked',
    }) as const;
  const forget = { type: 'turnDedup.forgetPrefix', prefix: 'a::' } as const;
  const rows = (db: DatabaseSync) =>
    (db.prepare('SELECT count(*) AS n FROM host_dedup').get() as { n: number })
      .n;

  it('is refused unless the caller says it may join', () => {
    const db = host();
    const kernel = storage(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      expect(() => kernel.executeSync(claim('k'), context())).toThrow(
        /already holds/,
      );
    } finally {
      db.exec('ROLLBACK');
    }
  });

  it('commits and rolls back with the host transaction', () => {
    const db = host();
    const kernel = storage(db);
    kernel.executeSync(claim('a::1'), context());
    kernel.executeSync(claim('a::2'), context());
    kernel.executeSync(claim('b::1'), context());

    db.exec('BEGIN IMMEDIATE');
    expect(
      kernel.executeSync(forget, context(), { withinHostTransaction: true }),
    ).toEqual({ kind: 'applied', removed: 2 });
    expect(rows(db)).toBe(1);
    db.exec('ROLLBACK');
    expect(rows(db)).toBe(3);

    db.exec('BEGIN IMMEDIATE');
    kernel.executeSync(forget, context(), { withinHostTransaction: true });
    db.exec('COMMIT');
    expect(rows(db)).toBe(1);
  });

  it('undoes only itself when it fails or a participant refuses', () => {
    const db = host();
    let refuse = false;
    let fail = false;
    const kernel = openSqliteKernelStorage({
      database: db,
      tables: BOUND,
      participants: [
        {
          name: 'guard',
          admit: () => (refuse ? { refuse: 'sealed' } : undefined),
          commit: () => {
            if (fail) throw new Error('boom');
          },
        },
      ],
    });
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO host_dedup VALUES ('host-own', 'v', 1, NULL)");
    refuse = true;
    expect(
      kernel.executeSync(claim('k1'), context(), {
        withinHostTransaction: true,
      }),
    ).toMatchObject({ kind: 'refused', participant: 'guard' });
    refuse = false;
    fail = true;
    expect(() =>
      kernel.executeSync(claim('k2'), context(), {
        withinHostTransaction: true,
      }),
    ).toThrow('boom');
    fail = false;
    expect(db.isTransaction).toBe(true);
    kernel.executeSync(claim('k3'), context(), { withinHostTransaction: true });
    db.exec('COMMIT');
    expect(
      (
        db
          .prepare('SELECT dedup_key FROM host_dedup ORDER BY dedup_key')
          .all() as Array<{
          dedup_key: string;
        }>
      ).map((row) => row.dedup_key),
    ).toEqual(['host-own', 'k3']);
  });

  it('runs as an ordinary transaction when the host holds none', () => {
    const db = host();
    const kernel = storage(db);
    kernel.executeSync(claim('a::1'), context(), {
      withinHostTransaction: true,
    });
    expect(db.isTransaction).toBe(false);
    expect(rows(db)).toBe(1);
  });
});

const STEER_TABLES: SqliteKernelTables = {
  turnDedup: 'unused',
  turnBoundary: 'unused',
  requestKeys: 'unused',
  inbox: 'unused',
  steerReceipts: { table: 'host_steer_inputs' },
};
const STEER_COLUMNS = `thread_id TEXT NOT NULL, client_input_id TEXT NOT NULL,
  input_digest TEXT NOT NULL, confirmed_turn_id TEXT`;

describe('bound steer receipt authority', () => {
  it('requires an unambiguous whole-key uniqueness constraint before reading host rows', () => {
    const db = host(`CREATE TABLE host_steer_inputs (${STEER_COLUMNS});
      INSERT INTO host_steer_inputs VALUES ('thread','input','a',NULL),('thread','input','b','turn');`);
    expect(() => storage(db, STEER_TABLES)).toThrow(/unique|primary key/);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM host_steer_inputs').get(),
    ).toEqual({ count: 2 });
    expect(tableNames(db)).toEqual(['host_steer_inputs']);
  });

  it.each([
    ['thread_id', 'NUMERIC'],
    ['client_input_id', 'INTEGER'],
    ['input_digest', 'REAL'],
    ['confirmed_turn_id', 'BLOB'],
    ['thread_id', 'TEXTINT'],
  ])(
    'rejects non-text affinity for %s declared %s before adopting host rows',
    (field, declaredType) => {
      const columns = [
        'thread_id',
        'client_input_id',
        'input_digest',
        'confirmed_turn_id',
      ];
      const db =
        host(`CREATE TABLE host_steer_inputs (${columns.map((name) => `${name} ${name === field ? declaredType : 'TEXT'}`).join(',')}, PRIMARY KEY(thread_id,client_input_id));
      INSERT INTO host_steer_inputs VALUES ('01','01','01',NULL);`);
      const before = db.prepare('SELECT * FROM host_steer_inputs').all();
      expect(() => storage(db, STEER_TABLES)).toThrow(/TEXT affinity/);
      expect(db.prepare('SELECT * FROM host_steer_inputs').all()).toEqual(
        before,
      );
      expect(tableNames(db)).toEqual(['host_steer_inputs']);
    },
  );

  it.each(['TEXT', 'VARCHAR(128)', 'CLOB', 'TEXTınt'])(
    'preserves numeric-looking string identities with %s affinity',
    (declaredType) => {
      const db = host(`CREATE TABLE host_steer_inputs (
      thread_id ${declaredType} NOT NULL, client_input_id ${declaredType} NOT NULL,
      input_digest ${declaredType} NOT NULL, confirmed_turn_id ${declaredType},
      PRIMARY KEY(thread_id, client_input_id)
    )`);
      const kernel = storage(db, STEER_TABLES);
      for (const id of ['01', '1']) {
        const key = { threadId: id, clientInputId: id, inputDigest: id };
        expect(
          kernel.executeSync(
            { type: 'steerReceipts.claim', ...key },
            context(),
          ),
        ).toEqual({ kind: 'claimed' });
        expect(
          kernel.executeSync(
            { type: 'steerReceipts.confirm', ...key, confirmedTurnId: id },
            context(),
          ),
        ).toEqual({ kind: 'applied' });
        expect(
          kernel.executeSync({ type: 'steerReceipts.read', ...key }, context()),
        ).toEqual({ kind: 'confirmed', turnId: id });
      }
      expect(
        kernel.executeSync(
          { type: 'steerReceipts.forgetThread', threadId: '01' },
          context(),
        ),
      ).toEqual({ kind: 'applied', removed: 1 });
      expect(
        kernel.executeSync(
          {
            type: 'steerReceipts.read',
            threadId: '1',
            clientInputId: '1',
            inputDigest: '1',
          },
          context(),
        ),
      ).toEqual({ kind: 'confirmed', turnId: '1' });
      expect(db.prepare('SELECT * FROM host_steer_inputs').all()).toEqual([
        {
          thread_id: '1',
          client_input_id: '1',
          input_digest: '1',
          confirmed_turn_id: '1',
        },
      ]);
    },
  );

  it.each(['NOCASE', 'RTRIM'])(
    'rejects %s uniqueness that aliases distinct receipt identities',
    (collation) => {
      const db = host(`CREATE TABLE host_steer_inputs (
      thread_id TEXT COLLATE ${collation} NOT NULL,
      client_input_id TEXT COLLATE ${collation} NOT NULL,
      input_digest TEXT NOT NULL, confirmed_turn_id TEXT,
      PRIMARY KEY(thread_id, client_input_id)
    ); INSERT INTO host_steer_inputs VALUES ('Thread', 'Input', 'digest', NULL);`);
      const before = db.prepare('SELECT * FROM host_steer_inputs').all();
      expect(() => storage(db, STEER_TABLES)).toThrow(/BINARY/);
      expect(db.prepare('SELECT * FROM host_steer_inputs').all()).toEqual(
        before,
      );
      expect(tableNames(db)).toEqual(['host_steer_inputs']);
    },
  );

  it.each(['NOCASE', 'RTRIM'])(
    'keeps exact identities when column defaults are %s but uniqueness is BINARY',
    (collation) => {
      const db = host(`CREATE TABLE host_steer_inputs (
      thread_id TEXT COLLATE ${collation} NOT NULL,
      client_input_id TEXT COLLATE ${collation} NOT NULL,
      input_digest TEXT NOT NULL, confirmed_turn_id TEXT,
      PRIMARY KEY(thread_id COLLATE binary, client_input_id COLLATE binary)
    )`);
      const kernel = storage(db, STEER_TABLES);
      const original = {
        threadId: 'Thread',
        clientInputId: 'Input',
        inputDigest: 'digest',
      };
      const otherThread = {
        ...original,
        threadId: collation === 'NOCASE' ? 'thread' : 'Thread ',
      };
      const otherInput = {
        ...original,
        clientInputId: collation === 'NOCASE' ? 'input' : 'Input ',
      };
      expect(
        kernel.executeSync(
          { type: 'steerReceipts.claim', ...original },
          context(),
        ),
      ).toEqual({ kind: 'claimed' });
      for (const key of [otherThread, otherInput]) {
        expect(
          kernel.executeSync({ type: 'steerReceipts.read', ...key }, context()),
        ).toEqual({ kind: 'absent' });
        expect(
          kernel.executeSync(
            { type: 'steerReceipts.confirm', ...key, confirmedTurnId: 'wrong' },
            context(),
          ),
        ).toEqual({ kind: 'stale' });
        expect(
          kernel.executeSync(
            { type: 'steerReceipts.claim', ...key },
            context(),
          ),
        ).toEqual({ kind: 'claimed' });
      }
      expect(
        kernel.executeSync(
          {
            type: 'steerReceipts.confirm',
            ...original,
            confirmedTurnId: 'turn',
          },
          context(),
        ),
      ).toEqual({ kind: 'applied' });
      expect(
        kernel.executeSync(
          {
            type: 'steerReceipts.forgetThread',
            threadId: otherThread.threadId,
          },
          context(),
        ),
      ).toEqual({ kind: 'applied', removed: 1 });
      expect(
        kernel.executeSync(
          { type: 'steerReceipts.read', ...original },
          context(),
        ),
      ).toEqual({ kind: 'confirmed', turnId: 'turn' });
      expect(
        kernel.executeSync(
          { type: 'steerReceipts.read', ...otherInput },
          context(),
        ),
      ).toEqual({ kind: 'indeterminate' });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM host_steer_inputs').get(),
      ).toEqual({ count: 2 });
    },
  );

  it('uses the original host rows, rolls back with the host, and refuses corrupted receipt bytes', () => {
    const db = host(
      `CREATE TABLE host_steer_inputs (${STEER_COLUMNS}, PRIMARY KEY(thread_id,client_input_id));`,
    );
    const kernel = storage(db, STEER_TABLES);
    const key = {
      threadId: 'thread',
      clientInputId: 'input',
      inputDigest: 'digest',
    };
    db.exec('BEGIN IMMEDIATE');
    expect(
      kernel.executeSync({ type: 'steerReceipts.claim', ...key }, context(), {
        withinHostTransaction: true,
      }),
    ).toEqual({ kind: 'claimed' });
    db.exec('ROLLBACK');
    expect(
      kernel.executeSync({ type: 'steerReceipts.read', ...key }, context()),
    ).toEqual({ kind: 'absent' });
    expect(
      kernel.executeSync({ type: 'steerReceipts.claim', ...key }, context()),
    ).toEqual({ kind: 'claimed' });
    expect(db.prepare('SELECT * FROM host_steer_inputs').get()).toEqual({
      thread_id: 'thread',
      client_input_id: 'input',
      input_digest: 'digest',
      confirmed_turn_id: null,
    });
    db.prepare('UPDATE host_steer_inputs SET input_digest = ?').run(
      new Uint8Array([1, 2]),
    );
    const before = db.prepare('SELECT * FROM host_steer_inputs').all();
    expect(() =>
      kernel.executeSync(
        { type: 'steerReceipts.confirm', ...key, confirmedTurnId: 'turn' },
        context(),
      ),
    ).toThrow('Invalid steer receipt row.');
    expect(db.prepare('SELECT * FROM host_steer_inputs').all()).toEqual(before);
    expect(tableNames(db)).toEqual(['host_steer_inputs']);
  });
});
