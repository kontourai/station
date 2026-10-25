import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { canonical } from '../encoding.js';
import { DEFAULT_MODEL_POLICY } from '../index.js';
import { auditAgentRuntimeStore } from '../sqlite.js';
import { fixture, key } from './fixture.js';

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
it('F2 offline audit detects actual stale partial-index membership created by a hostile SQLite function', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const original = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(idOf(key))?.record;
  if (typeof original !== 'string') throw Error('actual indexed run');
  const changed = { ...JSON.parse(original), state: 'completed', settledAt: 1 };
  const peer = new DatabaseSync(f.path);
  try {
    peer.function(
      'json_type',
      { deterministic: true },
      (_json, _path) => 'text',
    );
    peer
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(canonical(changed), idOf(key));
  } finally {
    peer.close();
  }
  // Fault is a physical index/table disagreement; no fake query answers in the audit connection.
  const ddl = f.database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE name='agent_runtime_unresolved'",
    )
    .get()?.sql;
  if (typeof ddl !== 'string' || !ddl.includes(' WHERE '))
    throw Error('actual partial index DDL');
  const predicate = ddl.slice(ddl.indexOf(' WHERE ') + 7);
  const raw = f.database
    .prepare(`SELECT id FROM agent_runtime_runs NOT INDEXED WHERE ${predicate}`)
    .all();
  const indexed = f.database
    .prepare(
      `SELECT id FROM agent_runtime_runs INDEXED BY agent_runtime_unresolved WHERE ${predicate}`,
    )
    .all();
  expect(indexed).not.toEqual(raw);
  const before = image(f.database);
  const audit = await auditAgentRuntimeStore({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
  });
  expect(audit.status).not.toBe('clean');
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
