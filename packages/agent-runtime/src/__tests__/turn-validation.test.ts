import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createAgentRuntime, openSqliteAgentJournal } from '../index.js';
import { agentWire } from '../internal.js';
import { bodyDefinitions } from '../turn-bodies.js';
import { key, owner } from './fixture.js';
import { turnFixture } from './turn-fixture.js';

function removeChangeTracking(database: DatabaseSync) {
  for (const row of database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'agent_steps_track_*'",
    )
    .all())
    database.exec(`DROP TRIGGER ${String(row.name)}`);
  database.exec('DROP TABLE agent_steps_changes');
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function retainedFixture() {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'agent-retained-'));
  const database = new DatabaseSync(join(dir.path, 'journal.sqlite'));
  database.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON',
  );
  const journal = openSqliteAgentJournal({ database });
  const runtime = createAgentRuntime({
    journal,
    owner,
    liveness: () => 'live',
    implementation: 'validation/1',
  });
  const lease = await runtime.start({
    key,
    input: 'input',
    implementation: 'validation/1',
  });
  return {
    database,
    lease,
    runtime,
    async close() {
      await journal.close();
      database.close();
      dir.remove();
    },
  };
}
for (const peer of [false, true]) {
  it(`a ${peer ? 'peer' : 'same-connection'} body rewrite invalidates verified payloads before another tool can execute`, async () => {
    const f = await retainedFixture();
    cleanup.push(() => f.close());
    const tool = {
      id: 'tool:verified',
      input: { value: 'original' },
      replay: 'unsafe' as const,
    };
    expect(await f.lease.tool(tool, async () => 'result')).toBe('result');
    const file = f.database.prepare('PRAGMA database_list').get()?.file;
    if (typeof file !== 'string') throw Error('Real database prerequisite');
    const writer = peer ? new DatabaseSync(file) : f.database;
    if (peer) cleanup.push(() => writer.close());
    const wire = agentWire({ value: 'changed' });
    writer.exec('BEGIN IMMEDIATE; DROP TRIGGER agent_steps_bodies_no_update');
    writer
      .prepare(
        'UPDATE agent_steps_bodies SET wire=?,byte_length=? WHERE wire=?',
      )
      .run(wire, Buffer.byteLength(wire), agentWire(tool.input));
    writer.exec(bodyDefinitions[1]);
    writer.exec('COMMIT');
    let ran = false;
    await expect(
      f.lease.tool({ ...tool, id: 'tool:next' }, async () => {
        ran = true;
      }),
    ).rejects.toThrow('BODY_DAMAGED');
    expect(ran).toBe(false);
  });
}
for (const peer of [false, true]) {
  it(`a ${peer ? 'foreign' : 'local'} completed-header rewrite is validated before a new effect`, async () => {
    const f = await retainedFixture();
    cleanup.push(() => f.close());
    await f.lease.tool(
      { id: 'tool:prior', input: 'value', replay: 'unsafe' },
      async () => 'result',
    );
    const file = f.database.prepare('PRAGMA database_list').get()?.file;
    if (typeof file !== 'string') throw Error('Real database prerequisite');
    const writer = peer ? new DatabaseSync(file) : f.database;
    if (peer) cleanup.push(() => writer.close());
    writer.exec(
      "UPDATE agent_steps_effects SET record=json_set(record,'$.inputDigest','damaged')",
    );
    let ran = false;
    await expect(
      f.lease.tool(
        { id: 'tool:next', input: 'value', replay: 'unsafe' },
        async () => {
          ran = true;
        },
      ),
    ).rejects.toThrow('EFFECT_DAMAGED');
    expect(ran).toBe(false);
  });
}
it('writer 6 migration keeps the logical request/result bytes and refuses mutable bodies', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const intent = {
    id: 'tool:legacy',
    input: { text: 'retained' },
    replay: 'unsafe' as const,
  };
  await f.lease.tool(intent, async () => ({ text: 'result' }));
  const { effect } = await f.lease.effect({
    type: 'effectRead',
    id: intent.id,
  });
  f.database
    .prepare('UPDATE agent_steps_effects SET record=?')
    .run(JSON.stringify(effect));
  removeChangeTracking(f.database);
  f.database.exec(
    "DROP INDEX agent_steps_effect_states; DROP TABLE agent_steps_bodies; DROP TABLE agent_steps_meta; CREATE TABLE agent_steps_meta(id INTEGER PRIMARY KEY CHECK(id=1), writer_format TEXT NOT NULL CHECK(writer_format='agent-steps/6')) STRICT; INSERT INTO agent_steps_meta VALUES(1,'agent-steps/6')",
  );
  await f.crash.reopen();
  const restored = await f.lease.effect({ type: 'effectRead', id: intent.id });
  expect(restored.effect).toEqual(effect);
  expect(() =>
    f.database.exec("UPDATE agent_steps_bodies SET wire='{}'"),
  ).toThrow('immutable agent body');
});

it('a foreign write to another turn does not reread the selected turn payload history', async () => {
  const f = await retainedFixture();
  cleanup.push(() => f.close());
  await f.lease.tool(
    { id: 'tool:prior', input: 'shared', replay: 'unsafe' },
    async () => 'shared',
  );
  const file = f.database.prepare('PRAGMA database_list').get()?.file;
  if (typeof file !== 'string') throw Error('Real database prerequisite');
  const peer = new DatabaseSync(file);
  cleanup.push(() => peer.close());
  peer.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
  const journal = openSqliteAgentJournal({ database: peer });
  const runtime = createAgentRuntime({
    journal,
    owner: { ...owner, id: 'peer' },
    liveness: () => 'live',
    implementation: 'validation/1',
  });
  await runtime.start({
    key: { ...key, conversationId: 'other' },
    input: 'other',
    implementation: 'validation/1',
  });
  let bodyReads = 0;
  f.database.setAuthorizer((_action, table) => {
    if (table === 'agent_steps_bodies') bodyReads++;
    return constants.SQLITE_OK;
  });
  try {
    await f.lease.assertCurrent();
  } finally {
    f.database.setAuthorizer(null);
  }
  expect(bodyReads).toBe(0);
});
it('observing another turn cannot acknowledge an unchecked foreign change to this turn', async () => {
  const f = await retainedFixture();
  cleanup.push(() => f.close());
  const other = await f.runtime.start({
    key: { ...key, conversationId: 'other' },
    input: 'other',
    implementation: 'validation/1',
  });
  await f.lease.tool(
    { id: 'tool:prior', input: 'shared', replay: 'unsafe' },
    async () => 'shared',
  );
  const file = f.database.prepare('PRAGMA database_list').get()?.file;
  if (typeof file !== 'string') throw Error('Real database prerequisite');
  const peer = new DatabaseSync(file);
  cleanup.push(() => peer.close());
  peer.exec(
    "UPDATE agent_steps_effects SET record=json_set(record,'$.inputDigest','damaged')",
  );
  await other.assertCurrent();
  await expect(f.lease.assertCurrent()).rejects.toThrow('EFFECT_DAMAGED');
});
it('deleting an old receipt cannot remint an effect after a retained connection observes the change', async () => {
  const f = await retainedFixture();
  cleanup.push(() => f.close());
  await f.lease.tool(
    { id: 'tool:prior', input: 'shared', replay: 'unsafe' },
    async () => 'shared',
  );
  f.database.exec('DELETE FROM agent_steps_effects');
  await expect(f.lease.assertCurrent()).rejects.toThrow(
    'CHANGED_EFFECT_MISSING',
  );
});
