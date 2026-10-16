import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { KernelCommand, KernelResult } from '../commands.js';
import {
  openSqliteKernelStorage,
  type SqliteTurnBoundaryTable,
} from '../sqlite.js';
import {
  createFakeProcessTable,
  createSqliteKernelHarness,
  createSqliteKernelLocation,
  kernelConformanceCasesFor,
  registerKernelConformance,
} from '../testing/index.js';

const intentColumns = {
  invocationId: 'invocation_id',
  inputDigest: 'input_digest',
  intentDigest: 'intent_digest',
  bodyRef: 'body_ref',
  dedupKey: 'linked_key',
} as const;
const intent = {
  invocationId: 'i',
  inputDigest: 'input',
  intentDigest: 'envelope',
  bodyRef: 'opaque:body',
  dedupKey: 'k',
} as const;
const schema = `CREATE TABLE host_boundaries (
  boundary_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL,
  purpose TEXT NOT NULL, provider_turn_id TEXT, owner_json TEXT,
  owner_id TEXT, owner_pid INTEGER, owner_birth TEXT, owner_identity_kind TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  invocation_id TEXT, input_digest TEXT, intent_digest TEXT, body_ref TEXT, linked_key TEXT
);`;
const cases = kernelConformanceCasesFor(['turnDedup', 'turnBoundary']).filter(
  (entry) => entry.name.startsWith('prepared intent:'),
);

for (const ownerEncoding of ['json', 'columns'] as const) {
  const binding: SqliteTurnBoundaryTable = {
    table: 'host_boundaries',
    ownerEncoding,
    terminalFacts: 'kernel',
    intentColumns,
  };
  for (const via of ['execute', 'executeSync'] as const) {
    registerKernelConformance(
      { describe, it },
      createSqliteKernelHarness({
        name: `prepared ${ownerEncoding} (${via})`,
        via,
        tables: {
          turnBoundary: binding,
          requestKeys: 'unused',
          inbox: 'unused',
        },
        prepare: (db) => db.exec(schema),
      }),
      cases,
    );

    it(`${ownerEncoding} ${via}: a failed boundary write rolls back the dedup begin, including after reopen`, async () => {
      const location = createSqliteKernelLocation({
        tables: {
          turnBoundary: binding,
          requestKeys: 'unused',
          inbox: 'unused',
        },
        prepare: (db) => db.exec(schema),
      });
      const db = new DatabaseSync(location.path);
      const storage = openSqliteKernelStorage({
        database: db,
        tables: {
          turnBoundary: binding,
          requestKeys: 'unused',
          inbox: 'unused',
        },
      });
      const processes = createFakeProcessTable();
      const owner = processes.spawn();
      const context = { liveness: processes.liveness };
      const run = async <C extends KernelCommand>(
        command: C,
      ): Promise<KernelResult<C>> =>
        via === 'executeSync'
          ? storage.executeSync(command, context)
          : storage.execute(command, context);
      try {
        expect(
          await run({
            type: 'turnDedup.claim',
            key: 'k',
            owner,
            tracking: 'tracked',
            now: 1,
          }),
        ).toEqual({ kind: 'claimed', reclaimed: false });
        expect(
          await run({
            type: 'turnBoundary.create',
            boundaryId: 'b',
            threadId: 't',
            purpose: 'turn',
            state: 'reserved',
            owner,
            now: '1',
          }),
        ).toEqual({ kind: 'applied' });
        expect(
          await run({
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            dedupOwnerId: owner.id,
            intent,
            now: '2',
          }),
        ).toEqual({ kind: 'applied' });
        db.exec(`CREATE TRIGGER fail_boundary_begin BEFORE UPDATE ON host_boundaries
          WHEN NEW.state = 'invoking' BEGIN
          SELECT CASE WHEN json_extract((SELECT owner_json FROM monument_turn_dedup WHERE dedup_key = 'k'), '$.invocation') != 'begun'
            THEN RAISE(ABORT, 'dedup write was not reached') END;
          SELECT RAISE(ABORT, 'failure after dedup begin write'); END;`);
        const begin = {
          type: 'turnBoundary.beginInvocation',
          boundaryId: 'b',
          ownerId: owner.id,
          dedupOwnerId: owner.id,
          intent,
          now: '3',
        } as const;
        await expect(run(begin)).rejects.toThrow(
          'failure after dedup begin write',
        );
        expect(await run({ type: 'turnDedup.read', key: 'k' })).toMatchObject({
          kind: 'found',
          record: { invocation: 'pending', preparedInvocationId: 'i' },
        });
        expect(await run({ type: 'turnBoundary.list' })).toMatchObject({
          kind: 'records',
          records: [{ state: 'prepared', intent }],
        });
        db.exec('DROP TRIGGER fail_boundary_begin');
        await storage.close();
        const reopened = openSqliteKernelStorage({
          path: location.path,
          tables: {
            turnBoundary: binding,
            requestKeys: 'unused',
            inbox: 'unused',
          },
        });
        try {
          expect(
            await reopened.execute(
              { type: 'turnDedup.read', key: 'k' },
              context,
            ),
          ).toMatchObject({ kind: 'found', record: { invocation: 'pending' } });
          expect(await reopened.execute(begin, context)).toEqual({
            kind: 'applied',
          });
        } finally {
          await reopened.close();
        }
      } finally {
        await storage.close();
        db.close();
        await location.dispose();
      }
    });
  }
}

it('bound intent columns are optional, validated when configured, and fixed at open', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    schema.replace(
      ',\n  invocation_id TEXT, input_digest TEXT, intent_digest TEXT, body_ref TEXT, linked_key TEXT',
      '',
    ),
  );
  const binding: SqliteTurnBoundaryTable = {
    table: 'host_boundaries',
    ownerEncoding: 'json',
    terminalFacts: 'kernel',
  };
  const tables = {
    turnBoundary: binding,
    turnDedup: 'unused',
    requestKeys: 'unused',
    inbox: 'unused',
  } as const;
  const storage = openSqliteKernelStorage({ database: db, tables });
  const owner = { id: 'o', pid: 1, identityKind: 'unverified' } as const;
  const context = { liveness: () => 'dead' as const };
  try {
    expect(
      storage.executeSync(
        {
          type: 'turnBoundary.create',
          boundaryId: 'legacy',
          threadId: 't',
          purpose: 'turn',
          state: 'prepared',
          owner,
          now: '1',
        },
        context,
      ),
    ).toEqual({ kind: 'applied' });
    expect(() =>
      openSqliteKernelStorage({
        database: db,
        tables: { ...tables, turnBoundary: { ...binding, intentColumns } },
      }),
    ).toThrow('invocation_id');
    db.exec('ALTER TABLE host_boundaries ADD COLUMN invocation_id TEXT');
    expect(() =>
      openSqliteKernelStorage({
        database: db,
        tables: {
          ...tables,
          turnBoundary: {
            ...binding,
            intentColumns: { ...intentColumns, bodyRef: 'state' },
          },
        },
      }),
    ).toThrow();
    const columns: { -readonly [K in keyof typeof intentColumns]: string } = {
      ...intentColumns,
    };
    db.exec(
      'ALTER TABLE host_boundaries ADD COLUMN input_digest TEXT; ALTER TABLE host_boundaries ADD COLUMN intent_digest TEXT; ALTER TABLE host_boundaries ADD COLUMN body_ref TEXT; ALTER TABLE host_boundaries ADD COLUMN linked_key TEXT',
    );
    const configured = openSqliteKernelStorage({
      database: db,
      tables: {
        ...tables,
        turnBoundary: { ...binding, intentColumns: columns },
      },
    });
    columns.bodyRef = 'bad_after_open';
    try {
      expect(
        configured.executeSync(
          {
            type: 'turnBoundary.create',
            boundaryId: 'new',
            threadId: 'u',
            purpose: 'turn',
            state: 'reserved',
            owner,
            now: '1',
          },
          context,
        ),
      ).toEqual({ kind: 'applied' });
      const { dedupKey: _, ...keyless } = intent;
      expect(
        configured.executeSync(
          {
            type: 'turnBoundary.prepare',
            boundaryId: 'new',
            ownerId: owner.id,
            intent: keyless,
            now: '2',
          },
          context,
        ),
      ).toEqual({ kind: 'applied' });
      expect(
        db
          .prepare(
            "SELECT body_ref FROM host_boundaries WHERE boundary_id = 'new'",
          )
          .get(),
      ).toEqual({ body_ref: 'opaque:body' });
    } finally {
      await configured.close();
    }
  } finally {
    await storage.close();
    db.close();
  }
});

for (const corruption of [
  'begun',
  'unknown',
  'resolved',
  'missing',
  'tombstone',
  'wrong-link',
] as const) {
  it(`resume refuses contradictory ${corruption} dedup evidence and retains the prepared row`, async () => {
    const db = new DatabaseSync(':memory:');
    const storage = openSqliteKernelStorage({ database: db });
    const processes = createFakeProcessTable();
    const owner = processes.spawn();
    const successor = processes.spawn();
    const context = { liveness: processes.liveness };
    try {
      storage.executeSync(
        {
          type: 'turnDedup.claim',
          key: 'k',
          owner,
          tracking: 'tracked',
          now: 1,
        },
        context,
      );
      storage.executeSync(
        {
          type: 'turnBoundary.create',
          boundaryId: 'b',
          threadId: 't',
          purpose: 'turn',
          state: 'reserved',
          owner,
          now: '1',
        },
        context,
      );
      expect(
        storage.executeSync(
          {
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            dedupOwnerId: owner.id,
            intent,
            now: '2',
          },
          context,
        ),
      ).toEqual({ kind: 'applied' });
      if (corruption === 'missing' || corruption === 'tombstone')
        db.exec("DELETE FROM monument_turn_dedup WHERE dedup_key = 'k'");
      if (corruption === 'tombstone')
        db.exec("INSERT INTO monument_turn_dedup_expired VALUES ('k', 3)");
      if (corruption === 'resolved')
        db.exec("UPDATE monument_turn_dedup SET value = 'provider-turn'");
      if (corruption === 'begun' || corruption === 'unknown')
        db.prepare(
          "UPDATE monument_turn_dedup SET owner_json = json_set(owner_json, '$.invocation', ?)",
        ).run(corruption === 'begun' ? 'begun' : 'future');
      if (corruption === 'wrong-link')
        db.exec(
          "UPDATE monument_turn_dedup SET owner_json = json_set(owner_json, '$.preparedInvocationId', 'another-invocation')",
        );
      processes.kill(owner);
      expect(
        storage.executeSync(
          {
            type: 'turnBoundary.resumePrepared',
            boundaryId: 'b',
            intent,
            observed: {
              owner,
              createdAt: '1',
              updatedAt: '2',
              verdict: 'dead',
            },
            owner: successor,
            dedup: {
              previousOwner: owner,
              createdAt: 1,
              updatedAt: '2',
              owner: successor,
            },
            now: '4',
          },
          context,
        ),
      ).toEqual({ kind: 'refused' });
      expect(
        storage.executeSync({ type: 'turnBoundary.list' }, context),
      ).toMatchObject({
        kind: 'records',
        records: [{ state: 'prepared', owner, intent }],
      });
    } finally {
      await storage.close();
      db.close();
    }
  });
}

it('owned version-one migration preserves legacy data and includes reserved in the active-thread unique index', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE monument_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO monument_meta VALUES ('schema_version','1');
    CREATE TABLE monument_turn_boundaries (
      boundary_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL, purpose TEXT NOT NULL,
      provider_turn_id TEXT, owner_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX monument_turn_boundaries_one_invocation ON monument_turn_boundaries(thread_id)
      WHERE state IN ('lifecycle','prepared','invoking','indeterminate');`);
  const owner = { id: 'old', pid: 3, identityKind: 'unverified' } as const;
  db.prepare(
    'INSERT INTO monument_turn_boundaries VALUES (?,?,?,?,?,?,?,?)',
  ).run(
    'legacy',
    't',
    'accepted',
    'turn',
    'provider',
    JSON.stringify(owner),
    '1',
    '2',
  );
  const storage = openSqliteKernelStorage({ database: db });
  try {
    expect(
      storage.executeSync(
        { type: 'turnBoundary.list' },
        { liveness: () => 'unknown' },
      ),
    ).toEqual({
      kind: 'records',
      records: [
        {
          boundaryId: 'legacy',
          threadId: 't',
          state: 'accepted',
          purpose: 'turn',
          providerTurnId: 'provider',
          owner,
          createdAt: '1',
          updatedAt: '2',
        },
      ],
    });
    const insert = db.prepare(
      'INSERT INTO monument_turn_boundaries (boundary_id,thread_id,state,purpose,owner_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    );
    insert.run('r1', 'u', 'reserved', 'turn', JSON.stringify(owner), '3', '3');
    expect(() =>
      insert.run(
        'r2',
        'u',
        'reserved',
        'turn',
        JSON.stringify(owner),
        '3',
        '3',
      ),
    ).toThrow('UNIQUE');
  } finally {
    await storage.close();
    db.close();
  }
});
