import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { canonical } from '../encoding.js';
import { DEFAULT_MODEL_POLICY } from '../index.js';
import { auditAgentRuntimeStore, openSqliteModelStorage } from '../sqlite.js';
import { fixture, key, operation } from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const idOf = (k: typeof key) =>
  canonical([k.scopeId, k.conversationId, k.invocationId]);
const image = (database: DatabaseSync) =>
  ['runs', 'retired', 'receipts', 'outbox', 'projection', 'bodies', 'meta'].map(
    (table) =>
      database
        .prepare(`SELECT * FROM agent_runtime_${table} ORDER BY rowid`)
        .all(),
  );
function hostileRewrite(path: string, record: string) {
  const peer = new DatabaseSync(path);
  try {
    peer.function(
      'json_type',
      { deterministic: true },
      (_json, _path) => 'text',
    );
    peer
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(record, idOf(key));
  } finally {
    peer.close();
  }
}
function memberships(database: DatabaseSync) {
  const ddl = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE name='agent_runtime_unresolved'",
    )
    .get()?.sql;
  if (typeof ddl !== 'string' || !ddl.includes(' WHERE '))
    throw Error('actual partial index DDL');
  const predicate = ddl.slice(ddl.indexOf(' WHERE ') + 7);
  const raw = database
    .prepare(`SELECT id FROM agent_runtime_runs NOT INDEXED WHERE ${predicate}`)
    .all();
  const indexed = database
    .prepare(
      `SELECT id FROM agent_runtime_runs INDEXED BY agent_runtime_unresolved WHERE ${predicate}`,
    )
    .all();
  return { raw, indexed };
}
it('F2 offline audit detects actual stale partial-index membership created by a hostile SQLite function', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const original = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(idOf(key))?.record;
  if (typeof original !== 'string') throw Error('actual indexed run');
  const changed = { ...JSON.parse(original), state: 'completed', settledAt: 1 };
  hostileRewrite(f.path, canonical(changed));
  // Fault is a physical index/table disagreement; no fake query answers in the audit connection.
  const { raw, indexed } = memberships(f.database);
  expect(indexed).not.toEqual(raw);
  const before = image(f.database);
  const audit = await auditAgentRuntimeStore({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
  });
  expect(audit.status).toBe('damaged');
  expect(audit.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: 'relationship',
        table: 'agent_runtime_runs',
        code: 'DURABLE_INDEX_DAMAGED',
      }),
    ]),
  );
  expect(image(f.database)).toEqual(before);
});

it('R3 stale current-R physical membership survives an unchanged observed read and refused write', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  let admitted = 0;
  let committed = 0;
  const observed = openSqliteModelStorage({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
    host: f.host,
    participants: [
      {
        name: 'observe-current-membership',
        observeReads: true,
        admit() {
          admitted++;
        },
        commit() {
          committed++;
        },
      },
    ],
  });
  cleanup.push(() => observed.close());
  const original = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(idOf(key))?.record;
  if (typeof original !== 'string') throw Error('actual unresolved R bytes');
  const finished = await f.storage.execute(
    operation({
      type: 'finish',
      key,
      expected: f.opened.snapshot.fence,
      status: 'completed',
    }),
    f.context,
  );
  if (finished.kind !== 'applied') throw Error('actual public R settlement');
  const settled = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(idOf(key))?.record;
  if (typeof settled !== 'string') throw Error('actual settled R bytes');
  const before = image(f.database);
  const expected = {
    kind: 'found',
    pins: [],
    snapshot: {
      spec: f.opened.snapshot.spec,
      fence: finished.fence,
      state: 'completed',
      nextOrdinal: 0,
    },
  };
  expect(await observed.execute({ type: 'read', key }, f.context)).toEqual(
    expected,
  );
  // Reuse exact genuine before/after bytes solely to inject an index fault.
  f.database
    .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
    .run(original, idOf(key));
  hostileRewrite(f.path, settled);
  expect(image(f.database)).toEqual(before);
  expect(memberships(f.database)).toEqual({
    raw: [],
    indexed: [{ id: idOf(key) }],
  });
  admitted = 0;
  committed = 0;
  expect(await observed.execute({ type: 'read', key }, f.context)).toEqual(
    expected,
  );
  expect({ admitted, committed }).toEqual({ admitted: 1, committed: 1 });
  expect(
    await observed.execute(
      operation({
        type: 'pin',
        key,
        expected: finished.fence,
        pin: f.pin,
      }),
      f.context,
    ),
  ).toEqual({ kind: 'refused', reason: 'expired' });
  expect({ admitted, committed }).toEqual({ admitted: 2, committed: 1 });
  expect(image(f.database)).toEqual(before);
  expect(() => f.open()).toThrow('DURABLE_RECORD_DAMAGED');
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('damaged');
  expect(image(f.database)).toEqual(before);
  f.database.exec('REINDEX agent_runtime_unresolved');
  expect(memberships(f.database)).toEqual({ raw: [], indexed: [] });
  expect(image(f.database)).toEqual(before);
  const reopened = f.open();
  cleanup.push(() => reopened.close());
  expect(await reopened.execute({ type: 'read', key }, f.context)).toEqual(
    expected,
  );
  expect(
    await auditAgentRuntimeStore({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
    }),
  ).toEqual({ status: 'clean', complete: true, issues: [] });
});

for (const primary of [11, 26] as const)
  it(`R3 actual SQLite engine damage primary ${primary} is damaged with incomplete enumeration and exact file restoration`, async () => {
    const f = await fixture();
    cleanup.push(() => f.close());
    const before = image(f.database);
    expect(
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      }),
    ).toEqual({ status: 'clean', complete: true, issues: [] });
    f.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const path = join(f.directory, `engine-${primary}.sqlite`);
    copyFileSync(f.path, path);
    const original = readFileSync(path);
    expect(original.subarray(0, 16).toString()).toBe('SQLite format 3\0');
    const damaged = Buffer.from(original);
    if (primary === 11)
      damaged[100] = 0; // Invalid sqlite_schema B-tree page type.
    else damaged[0] = 0; // Invalid SQLite file signature.
    expect(damaged).not.toEqual(original);
    writeFileSync(path, damaged);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      database.exec('PRAGMA foreign_keys=ON');
      let actual: unknown;
      try {
        database.prepare('PRAGMA integrity_check').all();
      } catch (error) {
        actual = error;
      }
      if (
        !(actual instanceof Error) ||
        !('errcode' in actual) ||
        typeof actual.errcode !== 'number'
      )
        throw Error('real SQLite engine error prerequisite absent');
      expect(actual.errcode & 0xff).toBe(primary);
      console.info(
        JSON.stringify({
          case: 'R3-native-engine-error',
          primary,
          errcode: actual.errcode,
          message: actual.message,
        }),
      );
      const audit = await auditAgentRuntimeStore({
        database,
        policy: DEFAULT_MODEL_POLICY,
      });
      expect(audit.status).toBe('damaged');
      expect(audit.complete).toBe(false);
      expect(audit.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'sqlite',
            code: 'DURABLE_SQLITE_DAMAGED',
            disposition: 'damage',
          }),
        ]),
      );
      expect(readFileSync(path)).toEqual(damaged);
    } finally {
      database.close();
    }
    writeFileSync(path, original);
    expect(readFileSync(path)).toEqual(original);
    const restored = new DatabaseSync(path, { readOnly: true });
    try {
      restored.exec('PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON');
      expect(
        await auditAgentRuntimeStore({
          database: restored,
          policy: DEFAULT_MODEL_POLICY,
        }),
      ).toEqual({ status: 'clean', complete: true, issues: [] });
    } finally {
      restored.close();
    }
    expect(image(f.database)).toEqual(before);
  });
