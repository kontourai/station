import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { agentWire } from '../index.js';
import { bodyDefinitions } from '../turn-bodies.js';
import { turnFixture } from './turn-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
for (const peer of [false, true]) {
  it(`a ${peer ? 'peer' : 'same-connection'} body rewrite invalidates verified payloads before another tool can execute`, async () => {
    const f = await turnFixture();
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
    const f = await turnFixture();
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
