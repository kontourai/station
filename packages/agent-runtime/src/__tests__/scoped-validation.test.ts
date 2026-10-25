import { afterEach, expect, it } from 'vitest';
import { canonical } from '../encoding.js';
import { DEFAULT_MODEL_POLICY } from '../index.js';
import { openSqliteModelStorage } from '../sqlite.js';
import { fixture, key, operation, owner } from './fixture.js';
import { completedGeneration } from './r2-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('a command on R ignores damaged settled S and still checks R current bytes', async () => {
  const f = await completedGeneration();
  cleanup.push(() => f.close());
  const settled = await f.storage.execute(
    operation({ type: 'finish', key, expected: f.fence, status: 'completed' }),
    f.context,
  );
  if (settled.kind === 'refused') throw Error('real settled S prerequisite');
  const r = { ...key, conversationId: 'independent-R' };
  const opened = await f.storage.execute(
    operation({
      type: 'open',
      spec: { ...f.opened.snapshot.spec, key: r },
      owner,
    }),
    f.context,
  );
  if (opened.kind !== 'opened') throw Error('independent R prerequisite');
  const sId = canonical([key.scopeId, key.conversationId, key.invocationId]);
  const original = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(sId)?.record;
  if (typeof original !== 'string') throw Error('actual settled S row');
  f.database
    .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
    .run(canonical({ ...JSON.parse(original), unexpected: true }), sId);
  expect(
    await f.storage.execute({ type: 'read', key: r }, f.context),
  ).toMatchObject({ kind: 'found', snapshot: opened.snapshot });
  const pinned = await f.storage.execute(
    operation({
      type: 'pin',
      key: r,
      expected: opened.snapshot.fence,
      pin: f.pin,
    }),
    f.context,
  );
  expect(pinned.kind).toBe('applied');
  f.database
    .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
    .run(original, sId);
  expect(
    await f.storage.execute({ type: 'read', key }, f.context),
  ).toMatchObject({ kind: 'found' });
});

for (const phase of ['admit', 'commit'] as const)
  it(`participant ${phase} cannot replace selected R and have its change silently overwritten or admitted`, async () => {
    let reached = 0;
    const change = (db: import('node:sqlite').DatabaseSync) => {
      const id = canonical([key.scopeId, key.conversationId, key.invocationId]);
      const row = db
        .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
        .get(id);
      if (typeof row?.record !== 'string')
        throw Error('selected R prerequisite');
      const run = JSON.parse(row.record);
      run.writerGeneration = 'foreign-writer';
      db.prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?').run(
        canonical(run),
        id,
      );
      reached++;
    };
    const f = await fixture('sqlite', [
      {
        name: 'selected-row-peer',
        [phase](
          value: { type?: string; command?: { type: string } },
          db: import('node:sqlite').DatabaseSync,
        ) {
          if ((value.type ?? value.command?.type) === 'pin') change(db);
        },
      },
    ]);
    cleanup.push(() => f.close());
    const before = f.database
      .prepare('SELECT id,record FROM agent_runtime_runs')
      .all();
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
    ).rejects.toThrow('DURABLE_SELECTED_STATE_CHANGED');
    expect(reached).toBe(1);
    expect(
      f.database.prepare('SELECT id,record FROM agent_runtime_runs').all(),
    ).toEqual(before);
    expect(
      await f.storage.execute({ type: 'read', key }, f.context),
    ).toMatchObject({ pins: [] });
  });

it('open refuses TEMP shadowing without changing the host TEMP namespace', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  f.database.exec(
    'CREATE TEMP TABLE agent_runtime_runs(id TEXT PRIMARY KEY,record TEXT NOT NULL) STRICT',
  );
  const before = f.database.prepare('SELECT * FROM temp.sqlite_schema').all();
  expect(() =>
    openSqliteModelStorage({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
      host: f.host,
    }),
  ).toThrow('DURABLE_SCHEMA_UNSUPPORTED');
  expect(f.database.prepare('SELECT * FROM temp.sqlite_schema').all()).toEqual(
    before,
  );
});
