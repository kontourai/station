import type { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { canonical, digestBytes, encode } from '../encoding.js';
import {
  DEFAULT_MODEL_POLICY,
  drainModelOutbox,
  type RunKey,
} from '../index.js';
import {
  auditAgentRuntimeStore,
  openSqliteModelStorage,
  openSqliteRuntimeProjection,
} from '../sqlite.js';
import { fixture, key, nextOwner, operation, owner } from './fixture.js';
import { completedGeneration } from './r2-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const idOf = (k: RunKey) =>
  canonical([k.scopeId, k.conversationId, k.invocationId]);
const image = (database: DatabaseSync) =>
  ['runs', 'retired', 'receipts', 'outbox', 'projection', 'bodies', 'meta'].map(
    (table) =>
      database
        .prepare(`SELECT * FROM agent_runtime_${table} ORDER BY rowid`)
        .all(),
  );
async function addRun(f: Awaited<ReturnType<typeof fixture>>, k: RunKey) {
  const answer = await f.storage.execute(
    operation({
      type: 'open',
      spec: { ...f.opened.snapshot.spec, key: k },
      owner,
    }),
    f.context,
  );
  if (answer.kind !== 'opened')
    throw Error('actual extra public run prerequisite');
  return answer;
}

it('F1 a reduced session cap preserves existing recovery and drain but refuses new admission', async () => {
  const f = await completedGeneration();
  cleanup.push(() => f.close());
  const s = { ...key, conversationId: 'existing-S' };
  const openedS = await addRun(f, s);
  const before = image(f.database);
  const policy = { ...DEFAULT_MODEL_POLICY, maxOpenRuns: 1 };
  const port = openSqliteModelStorage({
    database: f.database,
    policy,
    host: f.host,
  });
  cleanup.push(() => port.close());
  expect(image(f.database)).toEqual(before);
  expect(await port.execute({ type: 'read', key: s }, f.context)).toMatchObject(
    { kind: 'found', snapshot: openedS.snapshot },
  );
  const newRun = () =>
    port.execute(
      operation({
        type: 'open',
        spec: {
          ...f.opened.snapshot.spec,
          key: { ...key, conversationId: 'new-T' },
        },
        owner,
      }),
      f.context,
    );
  expect(await newRun()).toEqual({ kind: 'refused', reason: 'capacity' });
  const restored = await port.execute(
    operation({ type: 'takeOver', key, expected: f.fence, owner: nextOwner }),
    { liveness: () => 'dead' },
  );
  if (restored.kind !== 'restored') throw Error('existing over-cap recovery');
  expect(
    (
      await port.execute(
        operation({
          type: 'finish',
          key,
          expected: restored.snapshot.fence,
          status: 'completed',
        }),
        f.context,
      )
    ).kind,
  ).toBe('applied');
  const sink = openSqliteRuntimeProjection({
    database: f.database,
    bodies: f.bodies,
    policy,
    host: f.host,
  });
  cleanup.push(() => sink.close());
  await drainModelOutbox(port, sink, key, f.context);
  expect(await sink.readModelContext(key)).toEqual({
    kind: 'ready',
    tapes: [f.tape],
  });
  expect(await newRun()).toEqual({ kind: 'refused', reason: 'capacity' });
  expect(
    (
      await port.execute(
        operation({ type: 'cancel', key: s, expected: openedS.snapshot.fence }),
        f.context,
      )
    ).kind,
  ).toBe('applied');
  expect((await newRun()).kind).toBe('opened');
});

for (const phase of ['admit', 'commit'] as const)
  for (const fault of ['remove', 'insert'] as const)
    it(`F4 ${phase}/${fault} changing an unrelated unresolved control row during pin rolls back all writes`, async () => {
      const f = await fixture();
      cleanup.push(() => f.close());
      const s = { ...key, conversationId: 'other-active-S' };
      await addRun(f, s);
      let reached = 0;
      const port = openSqliteModelStorage({
        database: f.database,
        policy: { ...DEFAULT_MODEL_POLICY, maxOpenRuns: 2 },
        host: f.host,
        participants: [
          {
            name: 'global-control-fault',
            [phase](
              value: { type?: string; command?: { type: string } },
              db: DatabaseSync,
            ) {
              if ((value.type ?? value.command?.type) !== 'pin') return;
              const raw = db
                .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
                .get(idOf(s))?.record;
              if (typeof raw !== 'string') throw Error('real S prerequisite');
              const changed = JSON.parse(raw);
              if (fault === 'remove') {
                changed.state = 'completed';
                changed.settledAt = 1;
                db.prepare(
                  'UPDATE agent_runtime_runs SET record=? WHERE id=?',
                ).run(canonical(changed), idOf(s));
              } else {
                changed.spec.key = { ...s, invocationId: 'injected-control' };
                db.prepare('INSERT INTO agent_runtime_runs VALUES(?,?)').run(
                  idOf(changed.spec.key),
                  canonical(changed),
                );
              }
              reached++;
            },
          },
        ],
      });
      cleanup.push(() => port.close());
      const before = image(f.database);
      await expect(
        port.execute(
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
      expect(image(f.database)).toEqual(before);
      expect(
        await f.storage.execute({ type: 'read', key: s }, f.context),
      ).toMatchObject({ kind: 'found', snapshot: { state: 'open' } });
      expect(
        (
          await f.storage.execute(
            operation({
              type: 'pin',
              key,
              expected: f.opened.snapshot.fence,
              pin: f.pin,
            }),
            f.context,
          )
        ).kind,
      ).toBe('applied');
    });

for (const variant of [
  'terminal-null',
  'open-integer',
  'duplicate-header',
  'real-number',
] as const)
  it(`F2 offline audit reports ${variant} raw header interpretation instead of clean`, async () => {
    const f = await fixture();
    cleanup.push(() => f.close());
    const original = f.database
      .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
      .get(idOf(key))?.record;
    if (typeof original !== 'string') throw Error('actual header bytes');
    const row = JSON.parse(original);
    row.state = 'completed';
    row.settledAt = 1;
    let changed = canonical(row);
    if (variant === 'terminal-null')
      changed = canonical({ ...row, settledAt: null });
    if (variant === 'open-integer')
      changed = canonical({ ...row, state: 'open' });
    if (variant === 'duplicate-header')
      changed = `${changed.slice(0, -1)},"state":"open","settledAt":null}`;
    if (variant === 'real-number')
      changed = changed.replace('"settledAt":1,', '"settledAt":1.0,');
    expect(changed).not.toBe(original);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(changed, idOf(key));
    const before = image(f.database);
    const audit = await auditAgentRuntimeStore({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
    });
    expect(audit.status).not.toBe('clean');
    expect(audit.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'agent_runtime_runs',
          identityDigest: digestBytes(encode(idOf(key))),
        }),
      ]),
    );
    expect(image(f.database)).toEqual(before);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(original, idOf(key));
    expect(
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      }),
    ).toEqual({ status: 'clean', complete: true, issues: [] });
  });

it('F3 malformed early rows do not hide physical receipt and outbox identities behind a complete audit', async () => {
  const f = await completedGeneration();
  cleanup.push(() => f.close());
  const s = { ...key, conversationId: 'later-S' };
  await addRun(f, s);
  const originalRun = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(idOf(key))?.record;
  const receiptId = canonical([idOf(key), f.begin.operationId]);
  const outbox = f.database
    .prepare('SELECT id,record FROM agent_runtime_outbox LIMIT 1')
    .get();
  if (typeof originalRun !== 'string' || typeof outbox?.id !== 'string')
    throw Error('actual physical authorities');
  f.database
    .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
    .run('{', idOf(s));
  f.database
    .prepare('UPDATE agent_runtime_receipts SET id=? WHERE id=?')
    .run('moved-invalid-receipt', receiptId);
  f.database
    .prepare('UPDATE agent_runtime_outbox SET id=? WHERE id=?')
    .run('moved-invalid-outbox', outbox.id);
  const before = image(f.database);
  const audit = await auditAgentRuntimeStore({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
  });
  expect(audit.complete).toBe(false);
  expect(audit.status).not.toBe('clean');
  for (const [table, id] of [
    ['agent_runtime_receipts', 'moved-invalid-receipt'],
    ['agent_runtime_outbox', 'moved-invalid-outbox'],
  ] as const)
    expect(audit.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table,
          identityDigest: digestBytes(encode(id)),
        }),
      ]),
    );
  expect(image(f.database)).toEqual(before);
});

it('F6 a schema-valid selected receipt identity swap refuses with the selected-state code', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  let reached = 0;
  const port = openSqliteModelStorage({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
    host: f.host,
    participants: [
      {
        name: 'selected-identity-fault',
        commit({ command }, db) {
          if (command.type !== 'pin') return;
          const id = canonical([idOf(key), command.operationId]);
          const original = db
            .prepare('SELECT record FROM agent_runtime_receipts WHERE id=?')
            .get(id)?.record;
          if (typeof original !== 'string')
            throw Error('actual committed receipt');
          const receipt = JSON.parse(original);
          receipt.operationId = 'swapped-operation';
          db.prepare(
            'UPDATE agent_runtime_receipts SET id=?,record=? WHERE id=?',
          ).run(
            canonical([idOf(key), receipt.operationId]),
            canonical(receipt),
            id,
          );
          reached++;
        },
      },
    ],
  });
  cleanup.push(() => port.close());
  const before = image(f.database);
  await expect(
    port.execute(
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
  expect(image(f.database)).toEqual(before);
});

it('F7 unprepared or non-durable diagnostic connections return incomplete without repair', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const before = image(f.database);
  f.database.exec('DROP INDEX agent_runtime_unresolved');
  expect(
    await auditAgentRuntimeStore({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
    }),
  ).toMatchObject({
    status: 'incomplete',
    complete: false,
    issues: [
      {
        category: 'namespace',
        table: 'sqlite_schema',
        code: 'DURABLE_SCHEMA_UNSUPPORTED',
      },
    ],
  });
  expect(
    f.database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='agent_runtime_unresolved'",
      )
      .get(),
  ).toBeUndefined();
  expect(image(f.database)).toEqual(before);
  const prepared = openSqliteModelStorage({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
    host: f.host,
  });
  cleanup.push(() => prepared.close());
  f.database.exec('PRAGMA foreign_keys=OFF');
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('incomplete');
  expect(f.database.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(0);
  f.database.exec('PRAGMA foreign_keys=ON');
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('clean');
});

it('F3 truncated issue enumeration retains damage with complete false and leaves every row untouched', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const row = f.database
    .prepare('SELECT record FROM agent_runtime_receipts LIMIT 1')
    .get()?.record;
  if (typeof row !== 'string')
    throw Error('actual receipt bytes before corruption copies');
  for (let index = 0; index < 129; index++)
    f.database
      .prepare('INSERT INTO agent_runtime_receipts VALUES(?,?)')
      .run(`fault-orphan-${index}`, row);
  const before = image(f.database);
  const audit = await auditAgentRuntimeStore({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
  });
  expect(audit).toMatchObject({ status: 'damaged', complete: false });
  expect(audit.issues).toHaveLength(128);
  expect(image(f.database)).toEqual(before);
});

for (const damage of ['invalid-json', 'missing-settledAt'] as const)
  for (const first of ['finish', 'drain'] as const)
    it(`R2 unrelated settled S ${damage} does not block R ${first}, finishing or ACK/drain`, async () => {
      const f = await completedGeneration();
      cleanup.push(() => f.close());
      const s = { ...key, conversationId: 'unrelated-settled-S' };
      const opened = await addRun(f, s);
      expect(
        (
          await f.storage.execute(
            operation({
              type: 'finish',
              key: s,
              expected: opened.snapshot.fence,
              status: 'completed',
            }),
            f.context,
          )
        ).kind,
      ).toBe('applied');
      const original = f.database
        .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
        .get(idOf(s))?.record;
      if (typeof original !== 'string') throw Error('actual settled S');
      const bad = JSON.parse(original);
      delete bad.settledAt;
      const corrupted = damage === 'invalid-json' ? '{' : canonical(bad);
      f.database
        .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
        .run(corrupted, idOf(s));
      const sink = openSqliteRuntimeProjection({
        database: f.database,
        bodies: f.bodies,
        policy: DEFAULT_MODEL_POLICY,
        host: f.host,
      });
      cleanup.push(() => sink.close());
      const finish = () =>
        f.storage.execute(
          operation({
            type: 'finish',
            key,
            expected: f.fence,
            status: 'completed',
          }),
          f.context,
        );
      const drain = () => drainModelOutbox(f.storage, sink, key, f.context);
      if (first === 'finish') {
        expect((await finish()).kind).toBe('applied');
        await drain();
      } else {
        await drain();
        expect((await finish()).kind).toBe('applied');
      }
      expect(await sink.readModelContext(key)).toEqual({
        kind: 'ready',
        tapes: [f.tape],
      });
      expect(
        f.database
          .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
          .get(idOf(s))?.record,
      ).toBe(corrupted);
      const beforeAdmission = image(f.database);
      await expect(
        f.storage.execute(
          operation({
            type: 'open',
            spec: {
              ...f.opened.snapshot.spec,
              key: { ...key, conversationId: 'new-admission-T' },
            },
            owner,
          }),
          f.context,
        ),
      ).rejects.toThrow();
      expect(image(f.database)).toEqual(beforeAdmission);
      expect(
        (
          await auditAgentRuntimeStore({
            database: f.database,
            policy: DEFAULT_MODEL_POLICY,
          })
        ).status,
      ).toBe('damaged');
      f.database
        .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
        .run(original, idOf(s));
      const reopened = f.open();
      cleanup.push(() => reopened.close());
      expect(
        await reopened.execute({ type: 'read', key }, f.context),
      ).toMatchObject({ kind: 'found', snapshot: { state: 'completed' } });
      expect(
        await auditAgentRuntimeStore({
          database: f.database,
          policy: DEFAULT_MODEL_POLICY,
        }),
      ).toEqual({ status: 'clean', complete: true, issues: [] });
    });

for (const fault of ['duplicate', 'mispaired', 'real-number'] as const)
  it(`R2 current R ${fault} header refuses at execute and exact restoration succeeds`, async () => {
    const f = await fixture();
    cleanup.push(() => f.close());
    const original = f.database
      .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
      .get(idOf(key))?.record;
    if (typeof original !== 'string') throw Error('actual current R header');
    let corrupted = original;
    if (fault === 'duplicate')
      corrupted = `${original.slice(0, -1)},"state":"open","settledAt":null}`;
    else {
      const changed = JSON.parse(original);
      changed.settledAt = 1;
      if (fault === 'real-number') changed.state = 'completed';
      corrupted = canonical(changed);
      if (fault === 'real-number')
        corrupted = corrupted.replace('"settledAt":1,', '"settledAt":1.0,');
    }
    expect(corrupted).not.toBe(original);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(corrupted, idOf(key));
    const before = image(f.database);
    await expect(
      f.storage.execute({ type: 'read', key }, f.context),
    ).rejects.toThrow('DURABLE_RECORD_DAMAGED');
    expect(image(f.database)).toEqual(before);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(original, idOf(key));
    expect(
      await f.storage.execute({ type: 'read', key }, f.context),
    ).toMatchObject({ kind: 'found', pins: [] });
  });

it('R2 detected receipt damage is damaged with complete enumeration, not operationally incomplete', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const row = f.database
    .prepare('SELECT id,record FROM agent_runtime_receipts LIMIT 1')
    .get();
  if (typeof row?.id !== 'string') throw Error('actual saved receipt');
  f.database
    .prepare('UPDATE agent_runtime_receipts SET id=? WHERE id=?')
    .run('broken-receipt-id', row.id);
  const before = image(f.database);
  const answer = await auditAgentRuntimeStore({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
  });
  expect(answer.status).toBe('damaged');
  expect(answer.complete).toBe(true);
  expect(answer.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        table: 'agent_runtime_receipts',
        disposition: 'damage',
        identityDigest: digestBytes(encode('broken-receipt-id')),
      }),
    ]),
  );
  expect(image(f.database)).toEqual(before);
  f.database
    .prepare('UPDATE agent_runtime_receipts SET id=? WHERE id=?')
    .run(row.id, 'broken-receipt-id');
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('clean');
});

it('R2 unavailable SQL with no established damage is incomplete with explicit unavailable issues', async () => {
  const { constants } = await import('node:sqlite');
  const f = await fixture();
  cleanup.push(() => f.close());
  const before = image(f.database);
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
    expect(answer.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ disposition: 'unavailable' }),
      ]),
    );
    expect(answer.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ disposition: 'damage' }),
      ]),
    );
  } finally {
    f.database.setAuthorizer(null);
  }
  expect(image(f.database)).toEqual(before);
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('clean');
});

it('R2 preexisting suspect membership above128 permits R settlement/drain while new admission still refuses', async () => {
  const f = await completedGeneration();
  cleanup.push(() => f.close());
  for (let n = 0; n < 129; n++)
    f.database
      .prepare('INSERT INTO agent_runtime_runs VALUES(?,?)')
      .run(idOf({ ...key, conversationId: `fault-suspect-${n}` }), '{');
  const sink = openSqliteRuntimeProjection({
    database: f.database,
    bodies: f.bodies,
    policy: DEFAULT_MODEL_POLICY,
    host: f.host,
  });
  cleanup.push(() => sink.close());
  const suspects = f.database
    .prepare(
      "SELECT id,record FROM agent_runtime_runs WHERE record='{' ORDER BY id",
    )
    .all();
  expect(
    (
      await f.storage.execute(
        operation({
          type: 'finish',
          key,
          expected: f.fence,
          status: 'completed',
        }),
        f.context,
      )
    ).kind,
  ).toBe('applied');
  await drainModelOutbox(f.storage, sink, key, f.context);
  expect(await sink.readModelContext(key)).toEqual({
    kind: 'ready',
    tapes: [f.tape],
  });
  expect(
    f.database
      .prepare(
        "SELECT id,record FROM agent_runtime_runs WHERE record='{' ORDER BY id",
      )
      .all(),
  ).toEqual(suspects);
  await expect(
    f.storage.execute(
      operation({
        type: 'open',
        spec: {
          ...f.opened.snapshot.spec,
          key: { ...key, conversationId: 'new-run' },
        },
        owner,
      }),
      f.context,
    ),
  ).rejects.toThrow('DURABLE_CAPACITY');
  f.database.prepare("DELETE FROM agent_runtime_runs WHERE record='{'").run();
  const reopened = f.open();
  cleanup.push(() => reopened.close());
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('clean');
});

it('R2 canonical physical IDs own new-admission occupancy despite duplicate spec keys in unrelated S', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const s = { ...key, conversationId: 'duplicated-spec-S' };
  await addRun(f, s);
  const original = f.database
    .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
    .get(idOf(s))?.record;
  if (typeof original !== 'string') throw Error('actual S record');
  const run = JSON.parse(original);
  const corrupted = `{"spec":${canonical({ ...run.spec, key: { ...s, conversationId: 'SQL-first-foreign' } })},${original.slice(1)}`;
  f.database
    .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
    .run(corrupted, idOf(s));
  expect(
    (
      await f.storage.execute(
        operation({
          type: 'pin',
          key,
          expected: f.opened.snapshot.fence,
          pin: f.pin,
        }),
        f.context,
      )
    ).kind,
  ).toBe('applied');
  expect(
    await f.storage.execute(
      operation({
        type: 'open',
        spec: {
          ...f.opened.snapshot.spec,
          key: { ...s, invocationId: 'neighbor' },
        },
        owner,
      }),
      f.context,
    ),
  ).toEqual({ kind: 'refused', reason: 'busy' });
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('clean');
  f.database
    .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
    .run(original, idOf(s));
  expect(
    await f.storage.execute({ type: 'read', key: s }, f.context),
  ).toMatchObject({ kind: 'found' });
});

it('R2 callback membership changes beyond128 suspect IDs still roll back without truncating the comparison', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  let reached = 0;
  const port = openSqliteModelStorage({
    database: f.database,
    policy: DEFAULT_MODEL_POLICY,
    host: f.host,
    participants: [
      {
        name: 'late-index-id-fault',
        commit({ command }, db) {
          if (command.type !== 'pin') return;
          db.prepare('INSERT INTO agent_runtime_runs VALUES(?,?)').run(
            idOf({ ...key, conversationId: 'zz-late-callback-fault' }),
            '{',
          );
          reached++;
        },
      },
    ],
  });
  cleanup.push(() => port.close());
  for (let n = 0; n < 129; n++)
    f.database
      .prepare('INSERT INTO agent_runtime_runs VALUES(?,?)')
      .run(idOf({ ...key, conversationId: `fault-suspect-${n}` }), '{');
  const before = image(f.database);
  await expect(
    port.execute(
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
  expect(image(f.database)).toEqual(before);
  expect(
    (
      await f.storage.execute(
        operation({
          type: 'pin',
          key,
          expected: f.opened.snapshot.fence,
          pin: f.pin,
        }),
        f.context,
      )
    ).kind,
  ).toBe('applied');
  f.database.prepare("DELETE FROM agent_runtime_runs WHERE record='{'").run();
  expect(
    (
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      })
    ).status,
  ).toBe('clean');
});

it('R2 per-key audit retains retired receipt/outbox ordering checks without a redundant global pass', async () => {
  const { vi } = await import('vitest');
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const epoch = Date.UTC(2026, 0, 1);
    vi.setSystemTime(epoch);
    const f = await completedGeneration();
    cleanup.push(() => f.close());
    const finished = await f.storage.execute(
      operation({
        type: 'finish',
        key,
        expected: f.fence,
        status: 'completed',
      }),
      f.context,
    );
    if (finished.kind === 'refused') throw Error('actual retirement finish');
    const sink = openSqliteRuntimeProjection({
      database: f.database,
      bodies: f.bodies,
      policy: DEFAULT_MODEL_POLICY,
      host: f.host,
    });
    cleanup.push(() => sink.close());
    await drainModelOutbox(f.storage, sink, key, f.context);
    vi.setSystemTime(epoch + DEFAULT_MODEL_POLICY.settledRetentionMs);
    expect(
      await f.storage.execute(
        operation({ type: 'cancel', key, expected: finished.fence }),
        f.context,
      ),
    ).toEqual({ kind: 'refused', reason: 'expired' });
    expect(
      f.database
        .prepare('SELECT * FROM agent_runtime_retired WHERE id=?')
        .get(idOf(key)),
    ).toBeDefined();
    expect(
      f.database
        .prepare('SELECT * FROM agent_runtime_runs WHERE id=?')
        .get(idOf(key)),
    ).toBeUndefined();
    expect(
      await auditAgentRuntimeStore({
        database: f.database,
        policy: DEFAULT_MODEL_POLICY,
      }),
    ).toEqual({ status: 'clean', complete: true, issues: [] });
    const row = f.database
      .prepare('SELECT id,record FROM agent_runtime_outbox LIMIT 1')
      .get();
    if (typeof row?.record !== 'string')
      throw Error('retained physical outbox');
    f.database
      .prepare('UPDATE agent_runtime_outbox SET record=? WHERE id=?')
      .run(canonical({ ...JSON.parse(row.record), position: 1 }), row.id!);
    const before = image(f.database);
    const audit = await auditAgentRuntimeStore({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
    });
    expect(audit.status).toBe('damaged');
    expect(audit.complete).toBe(false);
    expect(audit.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'relationship',
          identityDigest: digestBytes(encode(idOf(key))),
          disposition: 'damage',
        }),
      ]),
    );
    expect(image(f.database)).toEqual(before);
    f.database
      .prepare('UPDATE agent_runtime_outbox SET record=? WHERE id=?')
      .run(row.record, row.id!);
    expect(
      (
        await auditAgentRuntimeStore({
          database: f.database,
          policy: DEFAULT_MODEL_POLICY,
        })
      ).status,
    ).toBe('clean');
  } finally {
    vi.useRealTimers();
  }
});
