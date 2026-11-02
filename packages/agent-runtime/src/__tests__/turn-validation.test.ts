import { createHash } from 'node:crypto';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import {
  createAgentRuntime,
  durableLanguageModel,
  openSqliteAgentJournal,
  runWithAgentTurn,
} from '../index.js';
import {
  agentWire,
  readAgentWire,
  readSqliteAgentFrames,
} from '../internal.js';
import {
  bodyChunkDefinitions,
  bodyDefinitions,
  putAgentBody,
} from '../turn-bodies.js';
import { changeDefinitions } from '../turn-changes.js';
import { finish, key, owner } from './fixture.js';
import { turnFixture } from './turn-fixture.js';

function removeChangeTracking(database: DatabaseSync) {
  for (const row of database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'agent_steps_track_*'",
    )
    .all())
    database.exec(`DROP TRIGGER ${String(row.name)}`);
  database.exec('DROP TABLE agent_steps_changes');
  database.exec('DROP TABLE agent_steps_body_chunks');
  database.exec('DROP TABLE agent_steps_frame_blocks');
  database.exec(
    'DROP TABLE agent_steps_retained; DROP INDEX agent_steps_terminal_age',
  );
  database.exec('DROP TRIGGER agent_steps_bodies_no_delete');
  database.exec(bodyDefinitions[2]);
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function retainedFixture(now?: () => number) {
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
    now,
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
        "UPDATE agent_steps_bodies SET wire=?,byte_length=? WHERE digest=(SELECT json_extract(record,'$.intent.input') FROM agent_steps_effects WHERE id='tool:verified')",
      )
      .run(wire, Buffer.byteLength(wire));
    expect(writer.prepare('SELECT changes() AS n').get()?.n).toBe(1);
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

for (const previous of [8, 9] as const)
  it(`writer ${previous} partials retain their logical bytes when converted into immutable batches`, async () => {
    const f = await turnFixture();
    cleanup.push(() => f.close());
    await f.lease.effect({
      type: 'effectPlan',
      intent: {
        id: 'model:old',
        kind: 'model',
        replay: 'unsafe',
        input: agentWire({ prompt: 'retained' }),
      },
    });
    await f.lease.effect({ type: 'effectBegin', id: 'model:old' });
    await f.lease.effect({
      type: 'effectPartial',
      id: 'model:old',
      part: agentWire({ type: 'text-delta', id: 'a', delta: 'audit' }),
    });
    const { effect } = await f.lease.effect({
      type: 'effectRead',
      id: 'model:old',
    });
    const header = {
      ...effect,
      version: previous === 9 ? 2 : 1,
      intent: { ...effect.intent, input: effect.inputDigest },
      attempts: effect.attempts.map((attempt) => ({
        ...attempt,
        partials:
          previous === 9
            ? [putAgentBody(f.database, agentWire(attempt.partials))]
            : attempt.partials.map((part) => putAgentBody(f.database, part)),
      })),
    };
    f.database
      .prepare('UPDATE agent_steps_effects SET record=? WHERE id=?')
      .run(JSON.stringify(header), 'model:old');
    const changes = f.database
      .prepare('SELECT * FROM agent_steps_changes')
      .all();
    removeChangeTracking(f.database);
    for (const sql of changeDefinitions) f.database.exec(sql);
    for (const row of changes)
      f.database
        .prepare('INSERT INTO agent_steps_changes VALUES(?,?,?,?)')
        .run(row.seq, row.turn_id, row.kind, row.id);
    f.database.exec(
      `DROP TABLE agent_steps_meta; CREATE TABLE agent_steps_meta(id INTEGER PRIMARY KEY CHECK(id=1), writer_format TEXT NOT NULL CHECK(writer_format='agent-steps/${previous}')) STRICT; INSERT INTO agent_steps_meta VALUES(1,'agent-steps/${previous}')`,
    );
    await expect(f.crash.reopen()).resolves.toBeDefined();
    expect(
      (await f.lease.effect({ type: 'effectRead', id: 'model:old' })).effect,
    ).toEqual(effect);
    expect(
      f.database.prepare('SELECT writer_format FROM agent_steps_meta').get()
        ?.writer_format,
    ).toBe('agent-steps/11');
    expect(
      JSON.parse(
        String(
          f.database
            .prepare('SELECT record FROM agent_steps_effects WHERE id=?')
            .get('model:old')?.record,
        ),
      ).version,
    ).toBe(4);
  });

it('400 individually committed text chunks retain bounded storage and an exact aborted prefix', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  await f.lease.effect({
    type: 'effectPlan',
    intent: {
      id: 'paced',
      kind: 'model',
      replay: 'unsafe',
      input: agentWire('prompt'),
    },
  });
  await f.lease.effect({ type: 'effectBegin', id: 'paced' });
  f.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const diskBytes = () =>
    Number(f.database.prepare('PRAGMA page_count').get()?.page_count) *
    Number(f.database.prepare('PRAGMA page_size').get()?.page_size);
  const before = diskBytes();
  const parts: string[] = [];
  let textBytes = 0;
  for (let index = 0; index < 400; index++) {
    const delta = `token-${index}: `.padEnd(64, 'text ');
    textBytes += Buffer.byteLength(delta);
    const part = agentWire({ type: 'text-delta', id: 'a', delta });
    parts.push(part);
    await f.lease.effect({ type: 'effectPartial', id: 'paced', part });
  }
  f.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  expect(diskBytes() - before).toBeLessThanOrEqual(2 * textBytes + 128 * 1024);
  expect(
    Number(
      f.database.prepare('SELECT count(*) AS n FROM agent_steps_changes').get()
        ?.n,
    ),
  ).toBeLessThanOrEqual(8);
  expect(
    Number(
      f.database.prepare('SELECT count(*) AS n FROM agent_steps_bodies').get()
        ?.n,
    ),
  ).toBeLessThanOrEqual(8);
  expect(() => f.database.exec('DELETE FROM agent_steps_changes')).toThrow(
    'immutable latest agent change',
  );
  const recovered = await f.recover();
  const { effect } = await recovered.effect({
    type: 'effectRead',
    id: 'paced',
  });
  expect(effect.state).toBe('indeterminate');
  expect(effect.attempts[0]?.state).toBe('aborted');
  expect(effect.attempts[0]?.partials).toEqual(parts);
});

it('a pure host clock keeps selected commands independent of retained body history', async () => {
  const f = await retainedFixture(() => 1_000);
  cleanup.push(() => f.close());
  await f.lease.tool(
    { id: 'clock-history', input: 'input', replay: 'unsafe' },
    async () => 'result',
  );
  let reads = 0;
  f.database.setAuthorizer((_action, table) => {
    if (table === 'agent_steps_bodies') reads++;
    return constants.SQLITE_OK;
  });
  try {
    await f.lease.frame('clock-frame', 'data: {}\n\n');
  } finally {
    f.database.setAuthorizer(null);
  }
  expect(reads).toBe(0);
});

it('a host clock cannot change durable state inside its timestamp callback', async () => {
  let mutate = () => {};
  const f = await retainedFixture(() => {
    mutate();
    return 1_000;
  });
  cleanup.push(() => f.close());
  f.database.exec('CREATE TABLE clock_probe(value INTEGER) STRICT');
  mutate = () => {
    f.database.exec('INSERT INTO clock_probe VALUES(1)');
  };
  await expect(f.lease.frame('clock-mutation', 'data: {}\n\n')).rejects.toThrow(
    'CLOCK_CHANGED_STATE',
  );
  mutate = () => {};
  await f.lease.assertCurrent();
  expect(
    f.database.prepare('SELECT count(*) AS n FROM clock_probe').get()?.n,
  ).toBe(0);
});

it('growing request histories share immutable chunks and refuse damaged chunk bytes', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const wires: string[] = [];
  let history = '';
  for (let index = 0; index < 24; index++) {
    history += `message-${index}:`.padEnd(4096, 'Greek λ and emoji 🌻 ');
    const wire = agentWire({ messages: history });
    wires.push(wire);
    await f.lease.tool(
      {
        id: `history:${index}`,
        replay: 'unsafe',
        input: { messages: history },
      },
      async () => null,
    );
  }
  const stored =
    Number(
      f.database
        .prepare(
          'SELECT sum(length(CAST(wire AS BLOB))) AS n FROM agent_steps_bodies',
        )
        .get()?.n,
    ) +
    Number(
      f.database
        .prepare(
          'SELECT sum(length(CAST(wire AS BLOB))) AS n FROM agent_steps_body_chunks',
        )
        .get()?.n,
    );
  expect(stored).toBeLessThan(
    2 * Buffer.byteLength(wires.at(-1)!) + 24 * 16 * 1024,
  );
  expect(stored).toBeLessThan(
    wires.reduce((n, wire) => n + Buffer.byteLength(wire), 0) / 2,
  );
  await f.crash.reopen();
  for (let index = 0; index < wires.length; index++) {
    const { effect } = await f.lease.effect({
      type: 'effectRead',
      id: `history:${index}`,
    });
    expect(effect.intent.input).toBe(wires[index]);
  }
  f.database.exec('DROP TRIGGER agent_steps_body_chunks_no_update');
  const changed = agentWire('changed');
  f.database
    .prepare(
      'UPDATE agent_steps_body_chunks SET wire=?,byte_length=? WHERE digest=(SELECT digest FROM agent_steps_body_chunks LIMIT 1)',
    )
    .run(changed, Buffer.byteLength(changed));
  f.database.exec(bodyChunkDefinitions[1]);
  await expect(f.lease.assertCurrent()).rejects.toThrow('CHUNK_DAMAGED');
});

it('a retained schema proof cannot hide a removed immutable-body trigger', async () => {
  const f = await retainedFixture();
  cleanup.push(() => f.close());
  await f.lease.assertCurrent();
  f.database.exec('DROP TRIGGER agent_steps_bodies_no_delete');
  await expect(f.lease.assertCurrent()).rejects.toThrow('WRITER_UNSUPPORTED');
});

it('completed turn retention expires replay payloads while preserving its no-redispatch tombstone and live turns', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const text = 'retained text '.repeat(800);
  await f.lease.tool(
    { id: 'finished-tool', input: text, replay: 'unsafe' },
    async () => text,
  );
  await f.lease.frame(
    'text:0',
    `data: ${JSON.stringify({ type: 'text-delta', text })}\n\n`,
  );
  await f.lease.run(async () => {});
  f.advance(7 * 24 * 60 * 60 * 1000 - 1);
  const live = await f.runtime.start({
    key: { ...f.key, invocationId: 'live' },
    input: 'live',
    implementation: 'station-agent/1',
  });
  await live.tool(
    { id: 'live-tool', input: text, replay: 'unsafe' },
    async () => 'live-result',
  );
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_steps_retained').get()
      ?.n,
  ).toBe(0);
  f.advance(1);
  const next = await f.runtime.start({
    key: { ...f.key, conversationId: 'another', invocationId: 'next' },
    input: 'next',
    implementation: 'station-agent/1',
  });
  expect(next).toBeDefined();
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_steps_retained').get()
      ?.n,
  ).toBe(1);
  const original = JSON.parse(
    String(
      f.database
        .prepare('SELECT record FROM agent_steps_turns WHERE id=?')
        .get(JSON.stringify(f.key, Object.keys(f.key).sort()))?.record,
    ),
  );
  expect(original).toMatchObject({
    retired: true,
    state: 'completed',
    spec: { input: '[expired]' },
  });
  expect(await f.runtime.recover(f.key)).toBe('retry');
  const liveEffect = await live.effect({ type: 'effectRead', id: 'live-tool' });
  expect(liveEffect.effect.attempts[0]?.output).toBe(agentWire('live-result'));
  const frames = f.database
    .prepare(
      'SELECT count(*) AS n FROM agent_steps_frame_blocks WHERE turn_id IN (SELECT turn_id FROM agent_steps_retained)',
    )
    .get()?.n;
  expect(frames).toBe(2);
  expect(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM agent_steps_effects WHERE id='finished-tool'",
      )
      .get()?.n,
  ).toBe(0);
});

it('4-byte deltas share completed text with the next prompt and retain exact frame replay within the raw disk budget', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const deltas = Array.from({ length: 400 }, (_, i) =>
    createHash('sha256').update(String(i)).digest('base64url').slice(0, 4),
  );
  const text = deltas.join('');
  let calls = 0;
  const model = durableLanguageModel({
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'storage',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('stream required');
    },
    doStream: async () => {
      calls++;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (calls === 1)
              for (const delta of deltas)
                controller.enqueue({ type: 'text-delta', id: 'answer', delta });
            controller.enqueue(finish);
            controller.close();
          },
        }),
      };
    },
  });
  await f.lease.run(async () => {
    const first = await runWithAgentTurn(f.lease, () =>
      model.doStream({ prompt: [] }),
    );
    const parts = [];
    for await (const part of first.stream)
      if (part.type === 'text-delta') parts.push(part.delta);
    expect(parts).toEqual(deltas);
    await f.lease.frameBatch(
      deltas.map((delta, index) => ({
        id: `answer:${index}`,
        wire: `data: ${JSON.stringify({ type: 'text-delta', id: 'answer', delta })}\n\n`,
      })),
    );
    const next = await runWithAgentTurn(f.lease, () =>
      model.doStream({
        prompt: [{ role: 'assistant', content: [{ type: 'text', text }] }],
      }),
    );
    for await (const _part of next.stream) {
      /* Complete the next native request. */
    }
    const { effect } = await f.lease.effect({
      type: 'effectRead',
      id: 'model:0',
    });
    expect(
      effect.attempts[0]?.partials.map((wire) => JSON.parse(wire)),
    ).toHaveLength(400);
  });
  f.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const disk =
    Number(f.database.prepare('PRAGMA page_count').get()?.page_count) *
    Number(f.database.prepare('PRAGMA page_size').get()?.page_size);
  expect(disk).toBeLessThanOrEqual(
    128 * 1024 + 2 * 16 * 1024 + 3 * Buffer.byteLength(text),
  );
  const storedText = f.database
    .prepare('SELECT wire FROM agent_steps_body_chunks')
    .all()
    .map((row) => readAgentWire(String(row.wire)));
  expect(storedText.every((value) => typeof value === 'string')).toBe(true);
  expect(
    storedText.reduce<number>(
      (bytes, value) => bytes + Buffer.byteLength(String(value)),
      0,
    ),
  ).toBe(Buffer.byteLength(text));
  expect(
    readSqliteAgentFrames({ database: f.database, key: f.key }).map(
      (frame) => JSON.parse(frame.wire.slice(6)).delta,
    ),
  ).toEqual(deltas);
  expect(calls).toBe(2);
});
