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

it('offline audit reports settled S, moved receipts, applied damage and orphan BLOB damage without repair', async () => {
  const { auditAgentRuntimeStore, openSqliteRuntimeProjection } = await import(
    '../sqlite.js'
  );
  const { drainModelOutbox } = await import('../index.js');
  const f = await completedGeneration();
  cleanup.push(() => f.close());
  const sink = openSqliteRuntimeProjection({
    database: f.database,
    bodies: f.bodies,
    policy: DEFAULT_MODEL_POLICY,
    host: f.host,
  });
  cleanup.push(() => sink.close());
  const settled = await f.storage.execute(
    operation({ type: 'finish', key, expected: f.fence, status: 'completed' }),
    f.context,
  );
  if (settled.kind === 'refused') throw Error('settled audit prerequisite');
  await drainModelOutbox(f.storage, sink, key, f.context);
  const image = () =>
    f.database
      .prepare('SELECT name,sql FROM main.sqlite_schema ORDER BY name')
      .all()
      .concat(
        ...[
          'runs',
          'retired',
          'receipts',
          'outbox',
          'projection',
          'bodies',
          'meta',
        ].map((table) =>
          f.database
            .prepare(`SELECT * FROM agent_runtime_${table} ORDER BY rowid`)
            .all(),
        ),
      );
  expect(
    await auditAgentRuntimeStore({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
    }),
  ).toEqual({ status: 'clean', complete: true, issues: [] });
  const id = canonical([key.scopeId, key.conversationId, key.invocationId]);
  const run = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(id)?.record;
  if (typeof run !== 'string') throw Error('audit run bytes');
  f.database
    .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
    .run(canonical({ ...JSON.parse(run), unexpected: true }), id);
  const damaged = image();
  const audit = await auditAgentRuntimeStore({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
  });
  expect(audit.status).toBe('damaged');
  expect(audit.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table: 'agent_runtime_runs' }),
    ]),
  );
  expect(image()).toEqual(damaged);
  f.database
    .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
    .run(run, id);
  const receiptId = canonical([id, f.begin.operationId]);
  f.database
    .prepare('UPDATE agent_runtime_receipts SET id=? WHERE id=?')
    .run('orphan-not-json', receiptId);
  const replay = await f.storage.execute(f.begin, f.context);
  expect(replay.kind).not.toBe('execute');
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('damaged');
  f.database
    .prepare('UPDATE agent_runtime_receipts SET id=? WHERE id=?')
    .run(receiptId, 'orphan-not-json');
  const applied = f.database
    .prepare('SELECT id,record FROM agent_runtime_projection LIMIT 1')
    .get();
  if (typeof applied?.record !== 'string') throw Error('applied bytes');
  f.database
    .prepare('UPDATE agent_runtime_projection SET record=? WHERE id=?')
    .run('{}', applied.id!);
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).issues,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ category: 'projection' }),
    ]),
  );
  f.database
    .prepare('UPDATE agent_runtime_projection SET record=? WHERE id=?')
    .run(applied.record, applied.id!);
  const orphanBytes = new TextEncoder().encode(
    '{"type":"text-delta","id":"orphan","delta":"A"}',
  );
  const orphan = await f.bodies.put('runtime-ai-sdk-v3-part/1', orphanBytes);
  const trigger = f.database
    .prepare(
      "SELECT sql FROM main.sqlite_schema WHERE name='agent_runtime_immutable_body'",
    )
    .get()?.sql;
  if (typeof trigger !== 'string') throw Error('immutable trigger');
  f.database.exec('DROP TRIGGER agent_runtime_immutable_body');
  f.database
    .prepare(
      'UPDATE agent_runtime_bodies SET bytes=? WHERE codec=? AND digest=?',
    )
    .run(
      Buffer.from(new TextDecoder().decode(orphanBytes).replace('"A"', '"B"')),
      orphan.codec,
      orphan.digest,
    );
  f.database.exec(trigger);
  const beforeAudit = image();
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).issues,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ category: 'body' })]),
  );
  expect(image()).toEqual(beforeAudit);
  f.database.exec('DROP TRIGGER agent_runtime_immutable_body');
  f.database
    .prepare(
      'UPDATE agent_runtime_bodies SET bytes=? WHERE codec=? AND digest=?',
    )
    .run(orphanBytes, orphan.codec, orphan.digest);
  f.database.exec(trigger);
  expect(
    await auditAgentRuntimeStore({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
    }),
  ).toEqual({ status: 'clean', complete: true, issues: [] });
});

it('unresolved current damage refuses reopen and recovery before any new receipt, then exact restoration works', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const id = canonical([key.scopeId, key.conversationId, key.invocationId]);
  const original = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(id)?.record;
  if (typeof original !== 'string') throw Error('current R bytes');
  const before = f.database
    .prepare('SELECT * FROM agent_runtime_receipts')
    .all();
  for (const record of [
    '{',
    canonical({ ...JSON.parse(original), state: 'future' }),
    canonical({ ...JSON.parse(original), unexpected: true }),
    canonical({
      ...JSON.parse(original),
      spec: {
        ...JSON.parse(original).spec,
        entry: {
          ...JSON.parse(original).spec.entry,
          sourceCutoff: 'wrong-current-link',
        },
      },
    }),
  ]) {
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(record, id);
    expect(() => f.open()).toThrow();
    await expect(
      f.storage.execute(
        operation({
          type: 'takeOver',
          key,
          expected: f.opened.snapshot.fence,
          owner: { ...owner, id: 'new-owner' },
        }),
        { liveness: () => 'dead' },
      ),
    ).rejects.toThrow();
    expect(
      f.database.prepare('SELECT * FROM agent_runtime_receipts').all(),
    ).toEqual(before);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(original, id);
  }
  const port = f.open();
  cleanup.push(() => port.close());
  expect(await port.execute({ type: 'read', key }, f.context)).toMatchObject({
    kind: 'found',
    pins: [],
  });
  const restored = await port.execute(
    operation({
      type: 'takeOver',
      key,
      expected: f.opened.snapshot.fence,
      owner: { ...owner, id: 'new-owner' },
    }),
    { liveness: () => 'dead' },
  );
  expect(restored.kind).toBe('restored');
});

for (const conversationId of [
  'quote"\\,雪\u0000tail',
  'conversation',
  'conversation-long',
])
  it(`binary scoped routing preserves replay, outbox and ready for ${JSON.stringify(conversationId)}`, async () => {
    const { normalizePart, tapeBytes } = await import('../codecs.js');
    const { drainModelOutbox } = await import('../index.js');
    const { openSqliteRuntimeProjection, auditAgentRuntimeStore } =
      await import('../sqlite.js');
    const { parts } = await import('./fixture.js');
    const f = await fixture();
    cleanup.push(() => f.close());
    const r = {
      ...key,
      scopeId: 'scope"\\雪\u0000',
      conversationId,
      invocationId: 'invocation\u0000"',
    };
    const opened = await f.storage.execute(
      operation({
        type: 'open',
        spec: { ...f.opened.snapshot.spec, key: r },
        owner,
      }),
      f.context,
    );
    if (opened.kind !== 'opened') throw Error('routing real open');
    const p = await f.storage.execute(
      operation({
        type: 'pin',
        key: r,
        expected: opened.snapshot.fence,
        pin: f.pin,
      }),
      f.context,
    );
    if (p.kind === 'refused') throw Error('routing pin');
    const command = operation({
      type: 'begin',
      key: r,
      expected: p.fence,
      requestId: f.pin.requestId,
    });
    const b = await f.storage.execute(command, f.context);
    if (b.kind !== 'execute') throw Error('routing grant');
    expect(await f.storage.execute(command, f.context)).toMatchObject({
      kind: 'acknowledged',
      originalGrantId: b.attempt.grantId,
    });
    const tape = await f.bodies.put(
      'runtime-ai-sdk-v3-tape/1',
      tapeBytes(f.pin.requestId, b.attempt.number, parts.map(normalizePart)),
    );
    const c = await f.storage.execute(
      operation({
        type: 'complete',
        key: r,
        expected: b.fence,
        attempt: b.attempt,
        tape,
        lastPartialSequence: -1,
      }),
      f.context,
    );
    if (c.kind === 'refused') throw Error('routing complete');
    expect(
      (
        await f.storage.execute(
          operation({
            type: 'finish',
            key: r,
            expected: c.fence,
            status: 'completed',
          }),
          f.context,
        )
      ).kind,
    ).toBe('applied');
    const sink = openSqliteRuntimeProjection({
      database: f.database,
      bodies: f.bodies,
      policy: DEFAULT_MODEL_POLICY,
      host: f.host,
    });
    cleanup.push(() => sink.close());
    await drainModelOutbox(f.storage, sink, r, f.context);
    expect(await sink.readModelContext(r)).toEqual({
      kind: 'ready',
      tapes: [tape],
    });
    expect(await sink.readAudit(r)).toHaveLength(1);
    expect(await sink.readAudit(key)).toEqual([]);
    expect(
      (
        await auditAgentRuntimeStore({
          database: f.database,
          policy: DEFAULT_MODEL_POLICY,
        })
      ).status,
    ).toBe('clean');
  });

it('two real connections cannot race global open capacity or same-conversation admission', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = await fixture();
  cleanup.push(() => f.close());
  expect(
    (
      await f.storage.execute(
        operation({
          type: 'finish',
          key,
          expected: f.opened.snapshot.fence,
          status: 'completed',
        }),
        f.context,
      )
    ).kind,
  ).toBe('applied');
  const peer = new DatabaseSync(f.path);
  peer.exec(
    'PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;PRAGMA busy_timeout=0',
  );
  cleanup.push(async () => peer.close());
  const policy = { ...DEFAULT_MODEL_POLICY, maxOpenRuns: 1 };
  const other = openSqliteModelStorage({
    database: peer,
    policy,
    host: f.host,
  });
  cleanup.push(() => other.close());
  const r = { ...key, conversationId: 'race-R' };
  const s = { ...key, conversationId: 'race-S' };
  const competing = operation({
    type: 'open',
    spec: { ...f.opened.snapshot.spec, key: s },
    owner,
  });
  let attempted: Promise<unknown> | undefined;
  const port = openSqliteModelStorage({
    database: f.database,
    policy,
    host: f.host,
    participants: [
      {
        name: 'real-peer-lock',
        admit(command) {
          if (command.type === 'open')
            attempted = other.execute(competing, f.context).then(
              () => 'unexpected-success',
              (error) => String(error),
            );
          return undefined;
        },
      },
    ],
  });
  cleanup.push(() => port.close());
  expect(
    (
      await port.execute(
        operation({
          type: 'open',
          spec: { ...f.opened.snapshot.spec, key: r },
          owner,
        }),
        f.context,
      )
    ).kind,
  ).toBe('opened');
  expect(await attempted).toContain('locked');
  expect(await other.execute(competing, f.context)).toEqual({
    kind: 'refused',
    reason: 'capacity',
  });
  expect(
    await other.execute(
      operation({
        type: 'open',
        spec: {
          ...f.opened.snapshot.spec,
          key: { ...r, invocationId: 'neighbor' },
        },
        owner,
      }),
      f.context,
    ),
  ).toEqual({ kind: 'refused', reason: 'busy' });
});

for (const damage of ['entry-link', 'full-reference'] as const)
  it(`R ${damage} damage refuses the actual read with all durable rows unchanged and restores positively`, async () => {
    const f = await fixture();
    cleanup.push(() => f.close());
    const id = canonical([key.scopeId, key.conversationId, key.invocationId]);
    const original = f.database
      .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
      .get(id)?.record;
    if (typeof original !== 'string') throw Error('actual target R');
    const run = JSON.parse(original);
    if (damage === 'entry-link') run.spec.entry.sourceCutoff = 'foreign-cutoff';
    else run.spec.entry.body.byteLength++;
    const damaged = canonical(run);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(damaged, id);
    const image = () =>
      ['runs', 'retired', 'receipts', 'outbox', 'projection', 'bodies'].map(
        (table) =>
          f.database
            .prepare(`SELECT * FROM agent_runtime_${table} ORDER BY rowid`)
            .all(),
      );
    const before = image();
    await expect(
      f.storage.execute({ type: 'read', key }, f.context),
    ).rejects.toThrow(
      damage === 'entry-link'
        ? 'DURABLE_RECORD_DAMAGED'
        : 'DURABLE_BODY_DAMAGED',
    );
    expect(image()).toEqual(before);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(original, id);
    expect(
      await f.storage.execute({ type: 'read', key }, f.context),
    ).toMatchObject({ kind: 'found' });
  });

it('current writer-generation observation is detached and a later command refuses a changed writer', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const before = f.database.prepare('SELECT * FROM agent_runtime_runs').all();
  f.admission.writerGeneration = 'foreign-writer';
  expect(await f.storage.execute({ type: 'read', key }, f.context)).toEqual({
    kind: 'refused',
    reason: 'unsupported',
  });
  expect(f.database.prepare('SELECT * FROM agent_runtime_runs').all()).toEqual(
    before,
  );
  f.admission.writerGeneration = 'writer-1';
  let calls = 0;
  const port = openSqliteModelStorage({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
    host: () => {
      calls++;
      return f.admission;
    },
  });
  cleanup.push(() => port.close());
  expect(
    (
      await port.execute(
        operation({
          type: 'pin',
          key,
          expected: f.opened.snapshot.fence,
          pin: f.pin,
        }),
        {
          liveness: () => {
            f.admission.writerGeneration = 'revoked-after-observation';
            return 'live';
          },
        },
      )
    ).kind,
  ).toBe('applied');
  expect(calls).toBe(1);
  expect(await port.execute({ type: 'read', key }, f.context)).toEqual({
    kind: 'refused',
    reason: 'unsupported',
  });
  f.admission.writerGeneration = 'writer-1';
  expect(await port.execute({ type: 'read', key }, f.context)).toMatchObject({
    kind: 'found',
    pins: [f.pin],
  });
});

it('offline audit refuses an incomplete read without writing or claiming clean', async () => {
  const { constants } = await import('node:sqlite');
  const { auditAgentRuntimeStore } = await import('../sqlite.js');
  const f = await fixture();
  cleanup.push(() => f.close());
  const before = f.database.prepare('SELECT * FROM agent_runtime_runs').all();
  let reached = 0;
  f.database.setAuthorizer((action, table) => {
    if (action === constants.SQLITE_READ && table === 'agent_runtime_bodies') {
      reached++;
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  try {
    const answer = await auditAgentRuntimeStore({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
    });
    expect(answer.status).toBe('incomplete');
    expect(answer.complete).toBe(false);
    expect(reached).toBeGreaterThan(0);
  } finally {
    f.database.setAuthorizer(null);
  }
  expect(f.database.prepare('SELECT * FROM agent_runtime_runs').all()).toEqual(
    before,
  );
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('clean');
});
