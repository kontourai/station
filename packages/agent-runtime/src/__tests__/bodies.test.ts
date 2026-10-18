import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encode } from '../encoding.js';
import { DEFAULT_MODEL_POLICY } from '../index.js';
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
it('a participant cannot leave a newly adopted BLOB damaged behind a restored schema', async () => {
  const f = await fixture('sqlite', [
    {
      name: 'host-body-corruption',
      commit({ command }, db) {
        if (command.type !== 'pin') return;
        const trigger = String(
          db
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE name='agent_runtime_immutable_body'",
            )
            .get()?.sql,
        );
        const row = db
          .prepare('SELECT bytes FROM agent_runtime_bodies WHERE digest=?')
          .get(command.pin.request.digest);
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
        ).run(changed, command.pin.request.digest);
        db.exec(trigger);
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
  ).rejects.toThrow('DURABLE_BODY_DAMAGED');
  expect(await f.bodies.read(f.pin.request)).toBeInstanceOf(Uint8Array);
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_receipts').get()
      ?.n,
  ).toBe(1);
});
