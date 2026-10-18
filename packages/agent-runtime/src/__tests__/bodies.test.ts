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
  f.database.exec('DROP TRIGGER agent_runtime_immutable_body');
  f.database
    .prepare('UPDATE agent_runtime_bodies SET bytes=? WHERE digest=?')
    .run(
      Buffer.from(
        new TextDecoder()
          .decode(await f.bodies.read(f.pin.request))
          .replace('COMPOSED-A', 'COMPOSED-B'),
      ),
      f.pin.request.digest,
    );
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
  ).toEqual({ kind: 'listed', entries: [] });
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
    'PRAGMA ignore_check_constraints=ON; UPDATE agent_runtime_meta SET schema_version=2; PRAGMA ignore_check_constraints=OFF;',
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
