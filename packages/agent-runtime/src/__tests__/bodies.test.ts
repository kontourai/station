import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { canonical, encode, hash } from '../encoding.js';
import { type BodyRef, DEFAULT_MODEL_POLICY } from '../index.js';
import { openSqliteModelStorage, openSqliteRuntimeBodies } from '../sqlite.js';
import { fixture, key, operation } from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
it('immutable SQLite bytes survive a separate connection reopen and reject UPDATE', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const bytes = encode({ type: 'text-delta', id: 'a', delta: 'DURABLE-BYTES' });
  const ref = await f.bodies.put('runtime-ai-sdk-v3-part/1', bytes);
  bytes.fill(0);
  const peer = new DatabaseSync(f.path);
  try {
    peer.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    const bodies = openSqliteRuntimeBodies({
      database: peer,
      policy: DEFAULT_MODEL_POLICY,
    });
    expect(await bodies.read(ref)).toEqual(
      encode({ type: 'text-delta', id: 'a', delta: 'DURABLE-BYTES' }),
    );
    expect(() =>
      peer
        .prepare('UPDATE agent_runtime_bodies SET bytes=bytes WHERE digest=?')
        .run(ref.digest),
    ).toThrow('immutable runtime body');
    await bodies.close();
  } finally {
    peer.close();
  }
});
it('body insert failure rolls back without an acknowledgment or adopted request', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  f.database.exec(
    "CREATE TRIGGER runtime_body_failure BEFORE INSERT ON agent_runtime_bodies BEGIN SELECT RAISE(ABORT,'body write rejected'); END;",
  );
  await expect(
    f.bodies.put(
      'runtime-ai-sdk-v3-part/1',
      encode({ type: 'text-delta', id: 'a', delta: 'new' }),
    ),
  ).rejects.toThrow('body write rejected');
  expect(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM agent_runtime_bodies WHERE codec='runtime-ai-sdk-v3-part/1'",
      )
      .get()?.n,
  ).toBe(0);
  expect(
    await f.storage.execute({ type: 'read', key }, f.context),
  ).toMatchObject({ pins: [] });
});
it('a damaged immutable ref cannot be adopted by pin', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const original = await f.bodies.read(f.pin.request);
  const trigger = String(
    f.database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='agent_runtime_immutable_body'",
      )
      .get()?.sql,
  );
  f.database.exec('DROP TRIGGER agent_runtime_immutable_body');
  f.database
    .prepare('UPDATE agent_runtime_bodies SET bytes=? WHERE digest=?')
    .run(
      Buffer.from(
        new TextDecoder().decode(original).replace('COMPOSED-A', 'COMPOSED-B'),
      ),
      f.pin.request.digest,
    );
  f.database.exec(trigger);
  await expect(
    f.storage.execute(
      operation({
        type: 'pin',
        key,
        expected: f.opened.snapshot.fence,
        pin: f.pin,
      }),
      f.context,
    ),
  ).rejects.toThrow('DURABLE_BODY_DAMAGED');
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_receipts').get()
      ?.n,
  ).toBe(1);
});
it('journal receipt and outbox roll back when SQLite fails the final emitting table write', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const p = await f.storage.execute(
    operation({
      type: 'pin',
      key,
      expected: f.opened.snapshot.fence,
      pin: f.pin,
    }),
    f.context,
  );
  if (p.kind === 'refused') throw Error('pin prerequisite');
  const b = await f.storage.execute(
    operation({
      type: 'begin',
      key,
      expected: p.fence,
      requestId: f.pin.requestId,
    }),
    f.context,
  );
  if (b.kind !== 'execute') throw Error('begin prerequisite');
  const body = await f.bodies.put(
    'runtime-ai-sdk-v3-part/1',
    encode({ type: 'stream-start', warnings: [] }),
  );
  f.database.exec(
    "CREATE TRIGGER runtime_outbox_failure BEFORE INSERT ON agent_runtime_outbox BEGIN SELECT RAISE(ABORT,'outbox write rejected'); END;",
  );
  const c = operation({
    type: 'partial',
    key,
    expected: b.fence,
    attempt: b.attempt,
    sequence: 0,
    body,
  });
  await expect(f.storage.execute(c, f.context)).rejects.toThrow(
    'outbox write rejected',
  );
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_receipts').get()
      ?.n,
  ).toBe(3);
  expect(
    await f.storage.execute({ type: 'listOutbox', key, limit: 10 }, f.context),
  ).toEqual({ kind: 'listed', entries: [], throughPosition: -1 });
  f.database.exec('DROP TRIGGER runtime_outbox_failure');
  expect(await f.storage.execute(c, f.context)).toMatchObject({
    kind: 'applied',
  });
});
it('unsupported nested transaction and future schema refuse without changing host pragmas', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  f.database.exec('BEGIN');
  await expect(
    f.bodies.put(
      'runtime-ai-sdk-v3-part/1',
      encode({ type: 'stream-start', warnings: [] }),
    ),
  ).rejects.toThrow('DURABLE_NESTED_TRANSACTION');
  f.database.exec('ROLLBACK');
  f.database.exec(
    'PRAGMA ignore_check_constraints=ON; UPDATE agent_runtime_meta SET schema_version=3; PRAGMA ignore_check_constraints=OFF;',
  );
  expect(() =>
    openSqliteModelStorage({
      database: f.database,
      host: f.host,
      policy: DEFAULT_MODEL_POLICY,
    }),
  ).toThrow('DURABLE_WRITER_UNSUPPORTED');
  expect(f.database.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2);
});
it('fixed participant sees actual decision rows before throwing and rolls them back', async () => {
  let seen = 0;
  const f = await fixture('sqlite', [
    {
      name: 'real-host-participant',
      commit({ command }, db) {
        if (command.type === 'pin') {
          seen = Number(
            db.prepare('SELECT count(*) AS n FROM agent_runtime_receipts').get()
              ?.n,
          );
          throw Error('participant after writes');
        }
      },
    },
  ]);
  cleanup.push(() => f.close());
  await expect(
    f.storage.execute(
      operation({
        type: 'pin',
        key,
        expected: f.opened.snapshot.fence,
        pin: f.pin,
      }),
      f.context,
    ),
  ).rejects.toThrow('participant after writes');
  expect(seen).toBe(2);
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_receipts').get()
      ?.n,
  ).toBe(1);
});
it('an already-open host wrapper refuses current future writer schema and disabled foreign keys', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  f.database.exec(
    'PRAGMA ignore_check_constraints=ON;UPDATE agent_runtime_meta SET schema_version=3;PRAGMA ignore_check_constraints=OFF;',
  );
  await expect(
    f.storage.execute({ type: 'read', key }, f.context),
  ).rejects.toThrow('DURABLE_WRITER_UNSUPPORTED');
  await expect(f.bodies.read(f.pin.request)).rejects.toThrow(
    'DURABLE_WRITER_UNSUPPORTED',
  );
  f.database.exec(
    'PRAGMA ignore_check_constraints=ON;UPDATE agent_runtime_meta SET schema_version=2;PRAGMA ignore_check_constraints=OFF;PRAGMA foreign_keys=OFF;',
  );
  await expect(
    f.storage.execute({ type: 'read', key }, f.context),
  ).rejects.toThrow('DURABLE_SQLITE_POLICY_REQUIRED');
  f.database.exec(
    'PRAGMA foreign_keys=ON;DROP TRIGGER agent_runtime_immutable_body;',
  );
  await expect(
    f.storage.execute({ type: 'read', key }, f.context),
  ).rejects.toThrow('DURABLE_SCHEMA_UNSUPPORTED');
});
it('global neighboring conversation occupancy and capacity survive transaction-local delta writes', async () => {
  const { openSqliteModelStorage } = await import('../sqlite.js');
  const { DEFAULT_MODEL_POLICY } = await import('../index.js');
  const f = await fixture();
  cleanup.push(() => f.close());
  const storage = openSqliteModelStorage({
    database: f.database,
    host: f.host,
    policy: { ...DEFAULT_MODEL_POLICY, maxOpenRuns: 1 },
  });
  cleanup.push(() => storage.close());
  const original = f.opened.snapshot.spec;
  expect(
    await storage.execute(
      operation({
        type: 'open',
        spec: { ...original, key: { ...key, invocationId: 'neighbor' } },
        owner: { ...f.opened.snapshot.fence.owner, id: 'neighbor' },
      }),
      f.context,
    ),
  ).toEqual({ kind: 'refused', reason: 'busy' });
  expect(
    await storage.execute(
      operation({
        type: 'open',
        spec: { ...original, key: { ...key, conversationId: 'second' } },
        owner: { ...f.opened.snapshot.fence.owner, id: 'second' },
      }),
      f.context,
    ),
  ).toEqual({ kind: 'refused', reason: 'capacity' });
  expect(
    await f.storage.execute({ type: 'read', key }, f.context),
  ).toMatchObject({ snapshot: { spec: original } });
});
for (const commandType of ['pin', 'acknowledge'] as const)
  it(`a participant cannot leave a BLOB damaged after ${commandType} behind a restored schema`, async () => {
    let request: BodyRef | undefined;
    const f = await fixture('sqlite', [
      {
        name: 'host-body-corruption',
        commit({ command }, db) {
          if (command.type !== commandType) return;
          const ref = command.type === 'pin' ? command.pin.request : request;
          if (!ref) throw Error('actual request prerequisite');
          const trigger = String(
            db
              .prepare(
                "SELECT sql FROM sqlite_schema WHERE name='agent_runtime_immutable_body'",
              )
              .get()?.sql,
          );
          const row = db
            .prepare('SELECT bytes FROM agent_runtime_bodies WHERE digest=?')
            .get(ref.digest);
          if (!(row?.bytes instanceof Uint8Array))
            throw Error('actual body prerequisite');
          const changed = Buffer.from(
            new TextDecoder()
              .decode(row.bytes)
              .replace('COMPOSED-A', 'COMPOSED-B'),
          );
          db.exec('DROP TRIGGER agent_runtime_immutable_body');
          db.prepare(
            'UPDATE agent_runtime_bodies SET bytes=? WHERE digest=?',
          ).run(changed, ref.digest);
          db.exec(trigger);
        },
      },
    ]);
    cleanup.push(() => f.close());
    request = f.pin.request;
    const pin = operation({
      type: 'pin',
      key,
      expected: f.opened.snapshot.fence,
      pin: f.pin,
    });
    const execute = async () => {
      if (commandType === 'pin') return f.storage.execute(pin, f.context);
      const pinned = await f.storage.execute(pin, f.context);
      if (pinned.kind === 'refused') throw Error('pin prerequisite');
      const begun = await f.storage.execute(
        operation({
          type: 'begin',
          key,
          expected: pinned.fence,
          requestId: f.pin.requestId,
        }),
        f.context,
      );
      if (begun.kind !== 'execute') throw Error('begin prerequisite');
      const body = await f.bodies.put(
        'runtime-ai-sdk-v3-part/1',
        encode({ type: 'stream-start', warnings: [] }),
      );
      const partial = await f.storage.execute(
        operation({
          type: 'partial',
          key,
          expected: begun.fence,
          attempt: begun.attempt,
          sequence: 0,
          body,
        }),
        f.context,
      );
      if (partial.kind === 'refused') throw Error('partial prerequisite');
      const list = await f.storage.execute(
        { type: 'listOutbox', key, limit: 10 },
        f.context,
      );
      if (list.kind !== 'listed' || !list.entries[0])
        throw Error('projection prerequisite');
      const entry = list.entries[0];
      return f.storage.execute(
        operation({
          type: 'acknowledge',
          key,
          projectionId: entry.id,
          projectionDigest: hash(entry),
        }),
        f.context,
      );
    };
    await expect(execute()).rejects.toThrow('DURABLE_BODY_DAMAGED');
    expect(await f.bodies.read(f.pin.request)).toBeInstanceOf(Uint8Array);
    expect(
      f.database
        .prepare('SELECT count(*) AS n FROM agent_runtime_receipts')
        .get()?.n,
    ).toBe(commandType === 'pin' ? 1 : 4);
  });

it('ordinary ACK persists its receipt before only its projection, rolls back both, and replay writes nothing', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const pinned = await f.storage.execute(
    operation({
      type: 'pin',
      key,
      expected: f.opened.snapshot.fence,
      pin: f.pin,
    }),
    f.context,
  );
  if (pinned.kind === 'refused') throw Error('pin prerequisite');
  const begun = await f.storage.execute(
    operation({
      type: 'begin',
      key,
      expected: pinned.fence,
      requestId: f.pin.requestId,
    }),
    f.context,
  );
  if (begun.kind !== 'execute') throw Error('begin prerequisite');
  let fence = begun.fence;
  for (const [sequence, part] of [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'a' },
  ].entries()) {
    const body = await f.bodies.put('runtime-ai-sdk-v3-part/1', encode(part));
    const partial = await f.storage.execute(
      operation({
        type: 'partial',
        key,
        expected: fence,
        attempt: begun.attempt,
        sequence,
        body,
      }),
      f.context,
    );
    if (partial.kind === 'refused') throw Error('partial prerequisite');
    fence = partial.fence;
  }
  expect(
    await f.storage.execute(
      operation({
        type: 'open',
        spec: {
          ...f.opened.snapshot.spec,
          key: { ...key, conversationId: 'neighbor' },
        },
        owner: { ...f.opened.snapshot.fence.owner, id: 'neighbor' },
      }),
      f.context,
    ),
  ).toMatchObject({ kind: 'opened' });
  const list = await f.storage.execute(
    { type: 'listOutbox', key, limit: 10 },
    f.context,
  );
  if (list.kind !== 'listed' || !list.entries[0])
    throw Error('projection prerequisite');
  const entry = list.entries[0];
  const command = operation({
    type: 'acknowledge',
    key,
    projectionId: entry.id,
    projectionDigest: hash(entry),
  });
  const receiptId = canonical([
    canonical([key.scopeId, key.conversationId, key.invocationId]),
    command.operationId,
  ]);
  const snapshot = () => ({
    runs: f.database
      .prepare('SELECT id,record FROM agent_runtime_runs ORDER BY id')
      .all(),
    retired: f.database
      .prepare('SELECT id,record FROM agent_runtime_retired ORDER BY id')
      .all(),
    receipts: f.database
      .prepare('SELECT id,record FROM agent_runtime_receipts ORDER BY id')
      .all(),
    outbox: f.database
      .prepare('SELECT id,record FROM agent_runtime_outbox ORDER BY id')
      .all(),
    projection: f.database
      .prepare('SELECT id,record FROM agent_runtime_projection ORDER BY id')
      .all(),
    bodies: f.database
      .prepare('SELECT * FROM agent_runtime_bodies ORDER BY codec,digest')
      .all(),
  });
  const before = snapshot();
  for (const table of ['runs', 'retired'])
    for (const verb of ['INSERT', 'UPDATE', 'DELETE'])
      f.database.exec(
        `CREATE TRIGGER ack_no_${table}_${verb} BEFORE ${verb} ON agent_runtime_${table} BEGIN SELECT RAISE(ABORT,'ACK wrote unrelated generation'); END;`,
      );
  f.database.exec(`
    CREATE TRIGGER ack_receipt_no_update BEFORE UPDATE ON agent_runtime_receipts BEGIN SELECT RAISE(ABORT,'ACK updated prior receipt'); END;
    CREATE TRIGGER ack_receipt_order BEFORE INSERT ON agent_runtime_receipts WHEN EXISTS(SELECT 1 FROM agent_runtime_outbox WHERE json_extract(record,'$.acknowledged')=1) BEGIN SELECT RAISE(ABORT,'receipt must precede outbox'); END;
    CREATE TRIGGER ack_outbox_scope BEFORE UPDATE ON agent_runtime_outbox WHEN json_extract(OLD.record,'$.position')<>0 BEGIN SELECT RAISE(ABORT,'ACK wrote unrelated projection'); END;
    CREATE TRIGGER ack_outbox_order BEFORE UPDATE ON agent_runtime_outbox WHEN NOT EXISTS(SELECT 1 FROM agent_runtime_receipts WHERE json_extract(record,'$.commandType')='acknowledge') BEGIN SELECT RAISE(ABORT,'outbox preceded receipt'); END;
    CREATE TRIGGER ack_outbox_failure BEFORE UPDATE ON agent_runtime_outbox BEGIN SELECT RAISE(ABORT,'ACK outbox write rejected'); END;
  `);
  await expect(f.storage.execute(command, f.context)).rejects.toThrow(
    'ACK outbox write rejected',
  );
  expect(snapshot()).toEqual(before);
  f.database.exec('DROP TRIGGER ack_outbox_failure');
  expect(await f.storage.execute(command, f.context)).toEqual({
    kind: 'applied',
  });
  const after = snapshot();
  expect(after.runs).toEqual(before.runs);
  expect(after.retired).toEqual(before.retired);
  expect(after.projection).toEqual(before.projection);
  expect(after.bodies).toEqual(before.bodies);
  expect(after.receipts.filter((r) => r.id !== receiptId)).toEqual(
    before.receipts,
  );
  expect(after.receipts).toHaveLength(before.receipts.length + 1);
  expect(after.outbox.filter((r) => r.id !== entry.id)).toEqual(
    before.outbox.filter((r) => r.id !== entry.id),
  );
  const acknowledged = f.database
    .prepare('SELECT record FROM agent_runtime_outbox WHERE id=?')
    .get(entry.id);
  const receipt = f.database
    .prepare('SELECT record FROM agent_runtime_receipts WHERE id=?')
    .get(receiptId);
  if (
    typeof acknowledged?.record !== 'string' ||
    typeof receipt?.record !== 'string'
  )
    throw Error('stored ACK prerequisite');
  expect(JSON.parse(acknowledged.record)).toMatchObject({
    acknowledged: true,
    projection: entry,
  });
  f.database
    .prepare('UPDATE agent_runtime_outbox SET record=? WHERE id=?')
    .run(` ${acknowledged.record} `, entry.id);
  f.database.exec('DROP TRIGGER ack_receipt_no_update');
  f.database
    .prepare('UPDATE agent_runtime_receipts SET record=? WHERE id=?')
    .run(` ${receipt.record} `, receiptId);
  f.database.exec(`
    CREATE TRIGGER ack_replay_receipt_insert BEFORE INSERT ON agent_runtime_receipts BEGIN SELECT RAISE(ABORT,'replayed ACK inserted receipt'); END;
    CREATE TRIGGER ack_replay_receipt_update BEFORE UPDATE ON agent_runtime_receipts BEGIN SELECT RAISE(ABORT,'replayed ACK updated receipt'); END;
    CREATE TRIGGER ack_replay_outbox_insert BEFORE INSERT ON agent_runtime_outbox BEGIN SELECT RAISE(ABORT,'replayed ACK inserted outbox'); END;
    CREATE TRIGGER ack_replay_outbox_update BEFORE UPDATE ON agent_runtime_outbox BEGIN SELECT RAISE(ABORT,'replayed ACK updated outbox'); END;
  `);
  const replayBefore = snapshot();
  expect(await f.storage.execute(command, f.context)).toEqual({
    kind: 'already-applied',
  });
  expect(snapshot()).toEqual(replayBefore);
});
