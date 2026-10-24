import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { KernelCommand } from '../commands.js';
import type { KernelContext } from '../port.js';
import {
  openSqliteKernelStorage,
  type SqliteKernelDatabase,
  type SqliteKernelTables,
} from '../sqlite.js';
import {
  createSqliteKernelLocation,
  hostBoundaryConformanceCases,
  KernelCrashError,
  kernelConformanceCasesFor,
  openCrashPointStore,
  registerKernelConformance,
} from '../testing/index.js';

const schema = `CREATE TABLE host_boundaries (
 boundary_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL,
 purpose TEXT NOT NULL, provider_turn_id TEXT, owner_id TEXT, owner_pid INTEGER,
 owner_birth TEXT, owner_identity_kind TEXT, owner_json TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_sequence INTEGER
);
CREATE TABLE host_head (value INTEGER); INSERT INTO host_head VALUES (17);
CREATE TABLE host_events (id TEXT PRIMARY KEY, thread TEXT, turn TEXT, sequence INTEGER);
`;
const owner = { id: 'owner', pid: 27, identityKind: 'unverified' } as const;
const callbacks: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of callbacks.splice(0).reverse()) await close();
});
function tables(
  ownerEncoding: 'json' | 'columns' = 'columns',
  terminalFacts: 'kernel' | 'host' = 'host',
): SqliteKernelTables {
  return {
    turnDedup: 'unused',
    requestKeys: 'unused',
    // #3568: the inbox is another machine this storage does not own.
    inbox: 'unused',
    steerReceipts: 'unused',
    turnBoundary: {
      table: 'host_boundaries',
      ownerEncoding,
      terminalFacts,
      ...(terminalFacts === 'host'
        ? {
            terminalSeen: (db, thread, turn) =>
              facts(db).terminalSeen(thread, turn),
            terminalSequence: (db, thread, id) =>
              facts(db).terminalSequence(thread, id),
            creationSequence: {
              column: 'created_sequence',
              read: (db) =>
                Number(
                  (
                    db.prepare('SELECT value FROM host_head').get() as {
                      value: number;
                    }
                  ).value,
                ),
            },
          }
        : {}),
    },
  };
}
function facts(db: SqliteKernelDatabase) {
  return {
    terminalSeen: (thread: string, turn: string) => {
      expect(db.isTransaction).toBe(true);
      return !!db
        .prepare('SELECT 1 FROM host_events WHERE thread = ? AND turn = ?')
        .get(thread, turn);
    },
    terminalSequence: (thread: string, id: string | undefined) => {
      expect(db.isTransaction).toBe(true);
      return (
        db
          .prepare(
            'SELECT sequence FROM host_events WHERE thread = ? AND id = ?',
          )
          .get(thread, id ?? null) as { sequence: number } | undefined
      )?.sequence;
    },
  };
}
function context() {
  return { liveness: () => 'unknown' as const };
}
const create = (boundaryId = 'b') =>
  ({
    type: 'turnBoundary.create',
    boundaryId,
    threadId: 't',
    state: 'prepared',
    purpose: 'turn',
    owner,
    now: '2030',
  }) as const;
function fixture(path = ':memory:', encoding: 'json' | 'columns' = 'columns') {
  const db = new DatabaseSync(path);
  db.exec(schema);
  callbacks.push(() => db.close());
  const storage = openSqliteKernelStorage({
    database: db,
    tables: tables(encoding),
  });
  const ctx = context();
  return {
    db,
    storage,
    run: (command: Parameters<typeof storage.executeSync>[0]) =>
      storage.executeSync(command, ctx),
  };
}
for (const encoding of ['json', 'columns'] as const) {
  it(`${encoding} owners: captures the durable fence once, preserves NULL, and fails closed on a missing event`, () => {
    const { db, run } = fixture(':memory:', encoding);
    expect(run(create())).toEqual({ kind: 'applied' });
    db.exec('UPDATE host_head SET value = 99');
    expect(
      run({
        type: 'turnBoundary.transition',
        boundaryId: 'b',
        ownerId: 'owner',
        from: ['prepared'],
        to: 'invoking',
        now: '2031',
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      db.prepare('SELECT created_sequence FROM host_boundaries').get(),
    ).toEqual({ created_sequence: 17 });
    const observe = {
      type: 'turnBoundary.observeTerminal',
      threadId: 't',
      sessionTerminal: true,
      terminalCreatedAt: '2000',
      terminalEventId: 'exit',
    } as const;
    expect(run(observe)).toEqual({ kind: 'applied' });
    expect(
      run({ type: 'turnBoundary.hasPossibleEffect', threadId: 't' }),
    ).toEqual({ kind: 'available', active: true });
    db.exec("INSERT INTO host_events VALUES ('exit','t',NULL,100)");
    expect(run(observe)).toEqual({ kind: 'applied' });
    expect(
      run({ type: 'turnBoundary.hasPossibleEffect', threadId: 't' }),
    ).toEqual({ kind: 'available', active: false });
    expect(run(create('legacy'))).toEqual({ kind: 'applied' });
    db.exec(
      "UPDATE host_boundaries SET created_sequence = NULL WHERE boundary_id = 'legacy'",
    );
    run({
      type: 'turnBoundary.transition',
      boundaryId: 'legacy',
      ownerId: 'owner',
      from: ['prepared'],
      to: 'invoking',
      now: '2031',
    });
    expect(
      db.prepare('SELECT created_sequence FROM host_boundaries').get(),
    ).toEqual({ created_sequence: null });
    run(observe);
    expect(db.prepare('SELECT boundary_id FROM host_boundaries').all()).toEqual(
      [{ boundary_id: 'legacy' }],
    );
    run({
      ...observe,
      terminalCreatedAt: '2032',
      terminalEventId: 'not-persisted',
    });
    expect(db.prepare('SELECT boundary_id FROM host_boundaries').all()).toEqual(
      [],
    );
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'monument_%'")
        .all(),
    ).toEqual([]);
  });
}
it('an old persisted session terminal cannot retire a new claim at the same fence', () => {
  const { db, run } = fixture();
  db.exec("INSERT INTO host_events VALUES ('exit','t',NULL,17)");
  run(create());
  run({
    type: 'turnBoundary.observeTerminal',
    threadId: 't',
    sessionTerminal: true,
    terminalCreatedAt: '9999',
    terminalEventId: 'exit',
  });
  expect(db.prepare('SELECT boundary_id FROM host_boundaries').all()).toEqual([
    { boundary_id: 'b' },
  ]);
});
it('host turn facts are read in the command transaction and recovery/turn timestamps still delimit generations', () => {
  const { db, run } = fixture();
  run(create());
  run({
    type: 'turnBoundary.transition',
    boundaryId: 'b',
    ownerId: 'owner',
    from: ['prepared'],
    to: 'invoking',
    now: '2031',
  });
  db.exec("INSERT INTO host_events VALUES ('done','t','p',18)");
  expect(
    run({
      type: 'turnBoundary.transition',
      boundaryId: 'b',
      ownerId: 'owner',
      from: ['invoking'],
      to: 'accepted',
      providerTurnId: 'p',
      now: '2032',
    }),
  ).toEqual({ kind: 'ambiguous' });
  expect(db.prepare('SELECT state FROM host_boundaries').get()).toEqual({
    state: 'indeterminate',
  });
  run({ type: 'turnBoundary.forgetThread', threadId: 't' });
  expect(db.prepare('SELECT id FROM host_events').all()).toEqual([
    { id: 'done' },
  ]);
  run({
    type: 'turnBoundary.recordAccepted',
    boundaryId: 'new',
    threadId: 't',
    providerTurnId: 'p',
    owner,
    now: '2040',
  });
  run({
    type: 'turnBoundary.observeTerminal',
    threadId: 't',
    providerTurnId: 'p',
    sessionTerminal: false,
    terminalCreatedAt: '2030',
  });
  expect(db.prepare('SELECT boundary_id FROM host_boundaries').all()).toEqual([
    { boundary_id: 'new' },
  ]);
  run({
    type: 'turnBoundary.observeTerminal',
    threadId: 't',
    providerTurnId: 'p',
    sessionTerminal: false,
    terminalCreatedAt: '2041',
    retire: false,
  });
  expect(db.prepare('SELECT boundary_id FROM host_boundaries').all()).toEqual([
    { boundary_id: 'new' },
  ]);
  run({
    type: 'turnBoundary.observeTerminal',
    threadId: 't',
    providerTurnId: 'p',
    sessionTerminal: false,
    terminalCreatedAt: '2041',
  });
  expect(db.prepare('SELECT boundary_id FROM host_boundaries').all()).toEqual(
    [],
  );
});
it('bound-table configuration refuses missing columns, unsafe names and invalid durable heads without changing data', () => {
  const { db } = fixture();
  db.exec(
    'ALTER TABLE host_boundaries RENAME COLUMN created_sequence TO missing',
  );
  expect(() =>
    openSqliteKernelStorage({ database: db, tables: tables() }),
  ).toThrow('no column created_sequence');
  expect(() =>
    openSqliteKernelStorage({
      database: db,
      tables: {
        turnBoundary: {
          table: 'bad;DROP TABLE host_head',
          ownerEncoding: 'columns',
          terminalFacts: 'host',
          terminalSeen: () => false,
        },
      },
    }),
  ).toThrow('plain SQL identifier');
  db.exec(
    'ALTER TABLE host_boundaries RENAME COLUMN missing TO created_sequence; UPDATE host_head SET value = -1',
  );
  const k = openSqliteKernelStorage({ database: db, tables: tables() });
  expect(() => k.executeSync(create(), context())).toThrow(
    'Invalid boundary creation sequence',
  );
  expect(db.prepare('SELECT * FROM host_boundaries').all()).toEqual([]);
});

it.each(['host', 'kernel'] as const)(
  'the %s terminal authority is fixed at open even with stray JavaScript context fields',
  async (mode) => {
    const db = new DatabaseSync(':memory:');
    callbacks.push(() => db.close());
    db.exec(schema);
    const defaults = openSqliteKernelStorage({ database: db });
    defaults.executeSync(
      {
        type: 'turnBoundary.observeTerminal',
        threadId: 't',
        providerTurnId: 'p',
        sessionTerminal: false,
        terminalCreatedAt: '2020',
      },
      context(),
    );
    await defaults.close();
    const storage = openSqliteKernelStorage({
      database: db,
      tables: tables('columns', mode),
    });
    storage.executeSync(create(), context());
    storage.executeSync(
      {
        type: 'turnBoundary.transition',
        boundaryId: 'b',
        ownerId: owner.id,
        from: ['prepared'],
        to: 'invoking',
        now: '2031',
      },
      context(),
    );
    const strayContext = {
      ...context(),
      terminalSeen: () => mode === 'host',
      terminalSequence: () => 999,
    };
    expect(
      storage.executeSync(
        {
          type: 'turnBoundary.transition',
          boundaryId: 'b',
          ownerId: owner.id,
          from: ['invoking'],
          to: 'accepted',
          providerTurnId: 'p',
          now: '2032',
        },
        strayContext,
      ),
    ).toEqual({ kind: mode === 'kernel' ? 'ambiguous' : 'applied' });
  },
);

it.each([
  'host without terminalSeen',
  'kernel with terminalSeen',
  'kernel with terminalSequence',
  'kernel with retiredBoundaryIds',
] as const)('rejects %s at open', (misconfiguration) => {
  const db = new DatabaseSync(':memory:');
  callbacks.push(() => db.close());
  db.exec(schema);
  const binding = tables().turnBoundary;
  if (!binding || binding === 'unused') throw new Error('Expected binding');
  expect(() =>
    openSqliteKernelStorage({
      database: db,
      tables: {
        turnBoundary: {
          ...binding,
          terminalFacts: misconfiguration.startsWith('host')
            ? 'host'
            : 'kernel',
          terminalSeen:
            misconfiguration === 'kernel with terminalSeen'
              ? () => false
              : undefined,
          terminalSequence:
            misconfiguration === 'kernel with terminalSequence'
              ? () => 17
              : undefined,
          retiredBoundaryIds:
            misconfiguration === 'kernel with retiredBoundaryIds'
              ? () => []
              : undefined,
        },
      },
    }),
  ).toThrow(
    misconfiguration.startsWith('host')
      ? 'require terminalSeen at open'
      : 'cannot have host callbacks',
  );
});

it('accepts a standalone unique boundary identity and supports its upsert', () => {
  const db = new DatabaseSync(':memory:');
  callbacks.push(() => db.close());
  db.exec(schema.replace('boundary_id TEXT PRIMARY KEY', 'boundary_id TEXT'));
  db.exec(
    'CREATE UNIQUE INDEX boundary_identity ON host_boundaries(boundary_id)',
  );
  const storage = openSqliteKernelStorage({ database: db, tables: tables() });
  storage.executeSync(create(), context());
  expect(
    storage.executeSync(
      {
        type: 'turnBoundary.transition',
        boundaryId: 'b',
        ownerId: owner.id,
        from: ['prepared'],
        to: 'invoking',
        now: '2031',
      },
      context(),
    ),
  ).toEqual({ kind: 'applied' });
  expect(db.prepare('SELECT state FROM host_boundaries').get()).toMatchObject({
    state: 'invoking',
  });
});

it.each(['none', 'compound', 'partial'] as const)(
  'rejects a bound identity with only a %s unique index at open',
  (index) => {
    const db = new DatabaseSync(':memory:');
    callbacks.push(() => db.close());
    db.exec(schema.replace('boundary_id TEXT PRIMARY KEY', 'boundary_id TEXT'));
    if (index === 'compound')
      db.exec(
        'CREATE UNIQUE INDEX compound ON host_boundaries(boundary_id, thread_id)',
      );
    if (index === 'partial')
      db.exec(
        "CREATE UNIQUE INDEX partial ON host_boundaries(boundary_id) WHERE state = 'prepared'",
      );
    expect(() =>
      openSqliteKernelStorage({ database: db, tables: tables() }),
    ).toThrow(
      'requires a primary key or non-partial unique index on boundary_id',
    );
  },
);

for (const encoding of ['json', 'columns'] as const) {
  for (const via of ['execute', 'executeSync'] as const) {
    describe(`portable host fence (${encoding}, ${via})`, () => {
      for (const contract of hostBoundaryConformanceCases)
        it(contract.name, async () => {
          await contract.run({
            async createLocation(facts) {
              const binding = tables(encoding).turnBoundary;
              if (!binding || binding === 'unused')
                throw new Error('Expected binding');
              const location = createSqliteKernelLocation({
                via,
                tables: {
                  turnDedup: 'unused',
                  requestKeys: 'unused',
                  // #3568: the inbox is another machine this storage does not own.
                  inbox: 'unused',
                  steerReceipts: 'unused',
                  turnBoundary: {
                    ...binding,
                    terminalSeen: (_db, thread, turn) =>
                      facts.terminalSeen(thread, turn),
                    terminalSequence: (_db, thread, id) =>
                      facts.terminalSequence(thread, id),
                    retiredBoundaryIds: (_db, thread) =>
                      facts.retiredBoundaryIds?.(thread) ?? [],
                  },
                },
                prepare: (db) => db.exec(schema),
              });
              return {
                ...location,
                async setCreationSequence(sequence) {
                  const db = new DatabaseSync(location.path);
                  try {
                    db.prepare('UPDATE host_head SET value = ?').run(sequence);
                  } finally {
                    db.close();
                  }
                },
              };
            },
          });
        });
    });
  }
}

for (const via of ['execute', 'executeSync'] as const) {
  registerKernelConformance(
    { describe, it },
    {
      name: `bound boundary owner columns (${via})`,
      createLocation: async () =>
        createSqliteKernelLocation({
          via,
          tables: tables('columns', 'kernel'),
          prepare: (db) => db.exec(schema),
        }),
    },
    // This host predates intent columns. Configured layouts run the prepared
    // protocol conformance in sqlite-prepared-intent.test.ts.
    kernelConformanceCasesFor(['turnBoundary']).filter(
      (entry) =>
        !entry.name.startsWith('prepared ') &&
        !entry.name.startsWith('invocation terminal:'),
    ),
  );
}

it('WAL reads skip participants and the write lock, while a nested insert reserves it before capturing a fence', async () => {
  const location = createSqliteKernelLocation();
  callbacks.push(() => location.dispose());
  const { db, storage, run } = fixture(location.path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1');
  const peer = new DatabaseSync(location.path);
  callbacks.push(() => peer.close());
  peer.exec('PRAGMA busy_timeout = 1');
  const calls: string[] = [];
  const observing = openSqliteKernelStorage({
    database: db,
    tables: tables(),
    participants: [
      {
        name: 'writing',
        observeReads: true,
        commit: () => {
          calls.push('observed');
        },
      },
    ],
  });
  const ordinary = openSqliteKernelStorage({
    database: db,
    tables: tables(),
    participants: [
      {
        name: 'write-only',
        commit: () => {
          calls.push('write');
        },
      },
    ],
  });
  run(create());
  peer.exec('BEGIN IMMEDIATE');
  try {
    expect(
      storage.executeSync({ type: 'turnBoundary.list' }, context()),
    ).toMatchObject({ kind: 'records', records: [{ boundaryId: 'b' }] });
    expect(
      ordinary.executeSync(
        { type: 'turnBoundary.hasPossibleEffect', threadId: 't' },
        context(),
      ),
    ).toEqual({ kind: 'available', active: true });
    expect(calls).toEqual([]);
    expect(() =>
      observing.executeSync({ type: 'turnBoundary.list' }, context()),
    ).toThrow(/locked/);
  } finally {
    peer.exec('ROLLBACK');
  }
  const binding = tables();
  if (binding.turnBoundary === 'unused' || !binding.turnBoundary)
    throw new Error('Expected bound boundary table');
  const nested = openSqliteKernelStorage({
    database: db,
    tables: {
      ...binding,
      turnBoundary: {
        ...binding.turnBoundary,
        creationSequence: {
          column: 'created_sequence',
          read: () => {
            expect(() => peer.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
            return 23;
          },
        },
      },
    },
  });
  db.exec('SAVEPOINT host_append');
  expect(
    nested.executeSync({ ...create('nested'), threadId: 'other' }, context(), {
      withinHostTransaction: true,
    }),
  ).toEqual({ kind: 'applied' });
  expect(db.isTransaction).toBe(true);
  expect(
    peer
      .prepare(
        "SELECT boundary_id FROM host_boundaries WHERE boundary_id = 'nested'",
      )
      .all(),
  ).toEqual([]);
  db.exec('ROLLBACK TO host_append; RELEASE host_append');
  expect(
    db
      .prepare(
        "SELECT boundary_id FROM host_boundaries WHERE boundary_id = 'nested'",
      )
      .all(),
  ).toEqual([]);
});

for (const primitive of [
  'create',
  'transition',
  'remove',
  'recordAccepted',
  'observeTerminal',
  'reconcile',
  'forgetThread',
] as const) {
  it(`bound ${primitive}: commit failure and a held crash preserve the prefix; successful commit survives reopen`, async () => {
    const location = createSqliteKernelLocation({
      tables: tables('columns', 'kernel'),
      prepare: (db) => db.exec(schema),
    });
    callbacks.push(() => location.dispose());
    const store = await openCrashPointStore(location);
    callbacks.push(() => store.dispose());
    const ctx: KernelContext = { liveness: () => 'dead' };
    await store.storage.execute(create(), ctx);
    await store.storage.execute(
      {
        type: 'turnBoundary.transition',
        boundaryId: 'b',
        ownerId: owner.id,
        from: ['prepared'],
        to: 'invoking',
        now: '2031',
      },
      ctx,
    );
    await store.storage.execute(
      {
        type: 'turnBoundary.recordAccepted',
        boundaryId: 'a',
        threadId: 't',
        providerTurnId: 'p',
        owner,
        now: '2030',
      },
      ctx,
    );
    const listed = await store.storage.execute(
      { type: 'turnBoundary.list' },
      ctx,
    );
    if (listed.kind !== 'records') throw new Error('Expected boundary records');
    const samples: Record<typeof primitive, KernelCommand> = {
      create: { ...create('new'), threadId: 'new-thread' },
      transition: {
        type: 'turnBoundary.transition',
        boundaryId: 'b',
        ownerId: owner.id,
        from: ['invoking'],
        to: 'indeterminate',
        now: '2032',
      },
      remove: {
        type: 'turnBoundary.remove',
        boundaryId: 'b',
        ownerId: owner.id,
        from: ['invoking'],
      },
      recordAccepted: {
        type: 'turnBoundary.recordAccepted',
        boundaryId: 'new',
        threadId: 't',
        providerTurnId: 'q',
        owner,
        now: '2032',
      },
      observeTerminal: {
        type: 'turnBoundary.observeTerminal',
        threadId: 't',
        providerTurnId: 'p',
        sessionTerminal: false,
        terminalCreatedAt: '9999',
      },
      reconcile: {
        type: 'turnBoundary.reconcile',
        now: '2032',
        observed: listed.records.map((row) => ({
          boundaryId: row.boundaryId,
          owner: row.owner,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          verdict: 'dead',
        })),
      },
      forgetThread: { type: 'turnBoundary.forgetThread', threadId: 't' },
    };
    const snapshot = () => {
      const db = new DatabaseSync(location.path, { readOnly: true });
      try {
        return {
          rows: db
            .prepare('SELECT * FROM host_boundaries ORDER BY boundary_id')
            .all(),
          facts: db
            .prepare(
              'SELECT * FROM monument_turn_terminals ORDER BY thread_id, provider_turn_id',
            )
            .all(),
        };
      } finally {
        db.close();
      }
    };
    const before = snapshot();
    const command = samples[primitive];
    store.failNextCommit();
    await expect(store.storage.execute(command, ctx)).rejects.toThrow(
      'Injected commit failure',
    );
    await store.reopen();
    expect(snapshot()).toEqual(before);
    const held = store.holdNextCommit();
    const lost = expect(
      store.storage.execute(command, ctx),
    ).rejects.toBeInstanceOf(KernelCrashError);
    await held.entered;
    await store.crash();
    await lost;
    await store.reopen();
    expect(snapshot()).toEqual(before);
    await store.storage.execute(command, ctx);
    await store.reopen();
    expect(snapshot()).not.toEqual(before);
  });
}

it('column owners round-trip exactly and a legacy birthless owner is not rewritten on transition', () => {
  const { db, storage } = fixture();
  const exact = {
    id: 'exact-owner',
    pid: 27,
    identityKind: 'exact',
    birth: 'process-birth',
  } as const;
  expect(storage.executeSync({ ...create(), owner: exact }, context())).toEqual(
    { kind: 'applied' },
  );
  expect(
    storage.executeSync({ type: 'turnBoundary.list' }, context()),
  ).toMatchObject({
    kind: 'records',
    records: [{ owner: exact, createdSequence: 17 }],
  });
  db.exec(
    'UPDATE host_boundaries SET owner_birth = NULL, created_sequence = NULL',
  );
  expect(
    storage.executeSync(
      {
        type: 'turnBoundary.transition',
        boundaryId: 'b',
        ownerId: exact.id,
        from: ['prepared'],
        to: 'invoking',
        now: '2031',
      },
      context(),
    ),
  ).toEqual({ kind: 'applied' });
  expect(
    db
      .prepare(
        'SELECT owner_identity_kind, owner_birth, created_sequence, created_at FROM host_boundaries',
      )
      .get(),
  ).toEqual({
    owner_identity_kind: 'exact',
    owner_birth: null,
    created_sequence: null,
    created_at: '2030',
  });
  expect(
    storage.executeSync({ type: 'turnBoundary.list' }, context()),
  ).toMatchObject({
    kind: 'records',
    records: [{ owner: { id: exact.id, pid: 27, identityKind: 'unverified' } }],
  });
  const binding = tables();
  const boundary = binding.turnBoundary;
  if (!boundary || boundary === 'unused')
    throw new Error('Expected boundary binding');
  expect(() =>
    openSqliteKernelStorage({
      database: db,
      tables: {
        ...binding,
        turnBoundary: {
          ...boundary,
          creationSequence: { column: 'state', read: () => 42 },
        },
      },
    }),
  ).toThrow('own boundary column');
});
