import { openAtomicCrashPointStore } from '@kontourai/monument/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizePart, tapeBytes } from '../codecs.js';
import {
  DEFAULT_MODEL_POLICY,
  drainModelOutbox,
  type ModelContext,
  type ModelProtocol,
  type Refused,
} from '../index.js';
import { openSqliteRuntimeProjection } from '../sqlite.js';
import { fixture, key, operation, owner, parts } from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  vi.useRealTimers();
});
const day = 86400000;
const epoch = Date.UTC(2026, 0, 1);
async function settled(participants: Parameters<typeof fixture>[1] = []) {
  const f = await fixture('sqlite', participants);
  cleanup.push(() => f.close());
  const sink = openSqliteRuntimeProjection({
    database: f.database,
    bodies: f.bodies,
    host: f.host,
    policy: DEFAULT_MODEL_POLICY,
  });
  cleanup.push(() => sink.close());
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
  const tape = await f.bodies.put(
    'runtime-ai-sdk-v3-tape/1',
    tapeBytes(f.pin.requestId, 1, parts.map(normalizePart)),
  );
  const c = await f.storage.execute(
    operation({
      type: 'complete',
      key,
      expected: b.fence,
      attempt: b.attempt,
      tape,
      lastPartialSequence: -1,
    }),
    f.context,
  );
  if (c.kind === 'refused') throw Error('complete prerequisite');
  const finished = await f.storage.execute(
    operation({ type: 'finish', key, expected: c.fence, status: 'completed' }),
    f.context,
  );
  if (finished.kind === 'refused') throw Error('finish prerequisite');
  return { f, sink, tape };
}
it('retention compacts at seven days and irreversibly refuses after thirty while preserving audit BLOBs', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(epoch);
  const { f, sink, tape } = await settled();
  await drainModelOutbox(f.storage, sink, key, f.context);
  const audit = await sink.readAudit(key);
  const bytes = await f.bodies.read(tape);
  const before = Number(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_bodies').get()
      ?.n,
  );
  vi.setSystemTime(epoch + 7 * day - 1);
  expect(
    await f.storage.execute(
      operation({ type: 'open', spec: f.opened.snapshot.spec, owner }),
      f.context,
    ),
  ).toMatchObject({ kind: 'existing' });
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()?.n,
  ).toBe(1);
  vi.setSystemTime(epoch + 7 * day);
  expect(await f.storage.execute({ type: 'read', key }, f.context)).toEqual({
    kind: 'refused',
    reason: 'expired',
  });
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()?.n,
  ).toBe(1);
  const originalSpec = f.opened.snapshot.spec;
  const open = operation({ type: 'open', spec: originalSpec, owner });
  expect(await f.storage.execute(open, f.context)).toEqual({
    kind: 'refused',
    reason: 'expired',
  });
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()?.n,
  ).toBe(0);
  expect(await f.storage.execute({ type: 'read', key }, f.context)).toEqual({
    kind: 'refused',
    reason: 'expired',
  });
  expect(await sink.readModelContext(key)).toEqual({ kind: 'unavailable' });
  expect(await sink.readAudit(key)).toEqual(audit);
  expect(await f.bodies.read(tape)).toEqual(bytes);
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_bodies').get()
      ?.n,
  ).toBe(before);
  expect(
    JSON.parse(
      String(
        f.database.prepare('SELECT record FROM agent_runtime_retired').get()
          ?.record,
      ),
    ).kind,
  ).toBe('tombstone');
  vi.setSystemTime(epoch + 30 * day);
  expect(await f.storage.execute(open, f.context)).toEqual({
    kind: 'refused',
    reason: 'expired',
  });
  expect(
    await f.storage.execute(
      operation({ type: 'open', spec: originalSpec, owner }),
      f.context,
    ),
  ).toEqual({ kind: 'refused', reason: 'expired' });
  expect(await sink.readAudit(key)).toEqual(audit);
  expect(
    JSON.parse(
      String(
        f.database.prepare('SELECT record FROM agent_runtime_retired').get()
          ?.record,
      ),
    ).kind,
  ).toBe('expired');
});
it('retention keeps unacked and lagging sink authority and rolls maintenance back after actual decision writes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(epoch);
  const { f, sink } = await settled();
  vi.setSystemTime(epoch + 7 * day);
  expect(
    await f.storage.execute(
      operation({ type: 'open', spec: f.opened.snapshot.spec, owner }),
      f.context,
    ),
  ).toMatchObject({ kind: 'refused' });
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()?.n,
  ).toBe(1);
  await drainModelOutbox(f.storage, sink, key, f.context);
  await f.storage.close();
  const crash = await openAtomicCrashPointStore<
    ModelProtocol,
    ModelContext,
    never,
    Refused
  >({
    open: (o) => Promise.resolve(f.open(o?.participants)),
    async dispose() {},
  });
  cleanup.push(() => crash.dispose());
  const oldReceipts = f.database
    .prepare('SELECT id,record FROM agent_runtime_receipts ORDER BY id')
    .all();
  const command = operation({
    type: 'open',
    spec: f.opened.snapshot.spec,
    owner,
  });
  crash.failNextCommit(Error('maintenance after writes'));
  await expect(crash.storage.execute(command, f.context)).rejects.toThrow(
    'maintenance after writes',
  );
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()?.n,
  ).toBe(1);
  expect(
    f.database
      .prepare('SELECT id,record FROM agent_runtime_receipts ORDER BY id')
      .all(),
  ).toEqual(oldReceipts);
  expect(await crash.storage.execute(command, f.context)).toEqual({
    kind: 'refused',
    reason: 'expired',
  });
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()?.n,
  ).toBe(0);
});
for (const kind of ['memory', 'sqlite'] as const)
  it(`retention ${kind} never evicts an unresolved run and read is not maintenance`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(epoch);
    const f = await fixture(kind);
    cleanup.push(() => f.close());
    vi.setSystemTime(epoch + 100 * day);
    expect(
      await f.storage.execute({ type: 'read', key }, f.context),
    ).toMatchObject({ kind: 'found', snapshot: { state: 'open' } });
    expect(
      await f.storage.execute(
        operation({ type: 'open', spec: f.opened.snapshot.spec, owner }),
        f.context,
      ),
    ).toMatchObject({ kind: 'existing' });
  });
it('maintenance participant observes actual compacted rows and never runs on reads or ordinary refusals', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(epoch);
  const observed: { type: string; runs: number; expiredReceipts: number }[] =
    [];
  const { f, sink } = await settled([
    {
      name: 'host-retention',
      maintenance({ command }, db) {
        observed.push({
          type: command.type,
          runs: Number(
            db.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()?.n,
          ),
          expiredReceipts: Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM agent_runtime_receipts WHERE json_extract(record,'$.answer.reason')='expired'",
              )
              .get()?.n,
          ),
        });
      },
    },
  ]);
  await drainModelOutbox(f.storage, sink, key, f.context);
  vi.setSystemTime(epoch + 7 * day);
  await f.storage.execute({ type: 'read', key }, f.context);
  await f.storage.execute({ type: 'listOutbox', key, limit: 10 }, f.context);
  expect(observed).toEqual([]);
  const conflict = {
    ...f.opened.snapshot.spec,
    entry: { ...f.opened.snapshot.spec.entry, sourceCutoff: 'WRONG' },
  };
  expect(
    await f.storage.execute(
      operation({ type: 'open', spec: conflict, owner }),
      f.context,
    ),
  ).toEqual({ kind: 'refused', reason: 'conflict' });
  expect(observed).toEqual([]);
  // Six real receipts: open, pin, begin, complete, finish and projection acknowledgment.
  expect(
    f.database.prepare('SELECT count(*) AS n FROM agent_runtime_receipts').get()
      ?.n,
  ).toBe(6);
  await f.storage.execute(
    operation({ type: 'open', spec: f.opened.snapshot.spec, owner }),
    f.context,
  );
  expect(observed).toEqual([{ type: 'open', runs: 0, expiredReceipts: 6 }]);
  await f.storage.execute(
    operation({ type: 'open', spec: f.opened.snapshot.spec, owner }),
    f.context,
  );
  expect(observed).toHaveLength(1);
});
it.each(['open', 'acknowledge'] as const)(
  'acknowledgment alone cannot compact while the sink lags; %s later preserves full maintenance',
  async (trigger) => {
    const { hash } = await import('../encoding.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(epoch);
    let failMaintenance = false;
    const observed: { command: string; runs: number; expired: number }[] = [];
    const { f, sink } = await settled([
      {
        name: 'actual-ACK-maintenance',
        maintenance({ command }, db) {
          observed.push({
            command: command.type,
            runs: Number(
              db.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()
                ?.n,
            ),
            expired: Number(
              db
                .prepare(
                  "SELECT count(*) AS n FROM agent_runtime_receipts WHERE json_extract(record,'$.answer.reason')='expired'",
                )
                .get()?.n,
            ),
          });
          if (failMaintenance) throw Error('actual ACK maintenance rollback');
        },
      },
    ]);
    const list = await f.storage.execute(
      { type: 'listOutbox', key, limit: 10 },
      f.context,
    );
    if (list.kind !== 'listed') throw Error('outbox prerequisite');
    for (const entry of list.entries)
      await f.storage.execute(
        operation({
          type: 'acknowledge',
          key,
          projectionId: entry.id,
          projectionDigest: hash(entry),
        }),
        f.context,
      );
    vi.setSystemTime(epoch + 7 * day);
    await f.storage.execute(
      operation({ type: 'open', spec: f.opened.snapshot.spec, owner }),
      f.context,
    );
    expect(
      f.database.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()
        ?.n,
    ).toBe(1);
    expect(await sink.readModelContext(key)).toEqual({ kind: 'unavailable' });
    for (const entry of list.entries) await sink.apply(entry);
    const entry = list.entries[0];
    if (!entry) throw Error('actual projection prerequisite');
    const command =
      trigger === 'open'
        ? operation({ type: 'open', spec: f.opened.snapshot.spec, owner })
        : operation({
            type: 'acknowledge',
            key,
            projectionId: entry.id,
            projectionDigest: hash(entry),
          });
    const before = {
      runs: f.database
        .prepare('SELECT id,record FROM agent_runtime_runs ORDER BY id')
        .all(),
      receipts: f.database
        .prepare('SELECT id,record FROM agent_runtime_receipts ORDER BY id')
        .all(),
      outbox: f.database
        .prepare('SELECT id,record FROM agent_runtime_outbox ORDER BY id')
        .all(),
    };
    if (trigger === 'acknowledge') {
      failMaintenance = true;
      await expect(f.storage.execute(command, f.context)).rejects.toThrow(
        'actual ACK maintenance rollback',
      );
      expect(
        f.database
          .prepare('SELECT id,record FROM agent_runtime_runs ORDER BY id')
          .all(),
      ).toEqual(before.runs);
      expect(
        f.database
          .prepare('SELECT id,record FROM agent_runtime_receipts ORDER BY id')
          .all(),
      ).toEqual(before.receipts);
      expect(
        f.database
          .prepare('SELECT id,record FROM agent_runtime_outbox ORDER BY id')
          .all(),
      ).toEqual(before.outbox);
      expect(
        f.database.prepare('SELECT * FROM agent_runtime_retired').all(),
      ).toEqual([]);
      failMaintenance = false;
    }
    expect(await f.storage.execute(command, f.context)).toEqual({
      kind: 'refused',
      reason: 'expired',
    });
    expect(
      f.database.prepare('SELECT count(*) AS n FROM agent_runtime_runs').get()
        ?.n,
    ).toBe(0);
    expect(observed).toEqual(
      Array.from({ length: trigger === 'acknowledge' ? 2 : 1 }, () => ({
        command: trigger,
        runs: 0,
        expired: before.receipts.length,
      })),
    );
    expect(
      f.database
        .prepare('SELECT count(*) AS n FROM agent_runtime_retired')
        .get()?.n,
    ).toBe(1);
    expect(
      f.database
        .prepare('SELECT id,record FROM agent_runtime_outbox ORDER BY id')
        .all(),
    ).toEqual(before.outbox);
  },
);
for (const kind of ['memory', 'sqlite'] as const)
  it(`retention ${kind} maintenance observes the real expired command and detaches its view`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(epoch);
    const f = await fixture(kind);
    cleanup.push(() => f.close());
    const cancelled = await f.storage.execute(
      operation({ type: 'cancel', key, expected: f.opened.snapshot.fence }),
      f.context,
    );
    if (cancelled.kind === 'refused') throw Error('cancel prerequisite');
    await f.storage.close();
    let stages = 0;
    const crash = await openAtomicCrashPointStore<
      ModelProtocol,
      ModelContext,
      never,
      Refused
    >({
      open: (o) =>
        Promise.resolve(
          f.open([
            {
              name: 'actual-retention',
              maintenance({ command }) {
                stages++;
                expect(command.type).toBe('open');
                Object.assign(
                  command.type === 'open' ? command.spec.entry : {},
                  { sourceCutoff: 'VIEW-MUTATION' },
                );
              },
            },
            ...(o?.participants ?? []),
          ]),
        ),
      async dispose() {},
    });
    cleanup.push(() => crash.dispose());
    vi.setSystemTime(epoch + 7 * day);
    const command = operation({
      type: 'open',
      spec: f.opened.snapshot.spec,
      owner,
    });
    crash.failNextCommit(Error('maintenance rollback'));
    await expect(crash.storage.execute(command, f.context)).rejects.toThrow(
      'maintenance rollback',
    );
    // A read at the expired window correctly refuses; inspect rollback before
    // the replay cutoff, then restore the clock before the maintenance retry.
    vi.setSystemTime(epoch + 6 * day);
    expect(
      await crash.storage.execute({ type: 'read', key }, f.context),
    ).toMatchObject({ snapshot: { spec: { entry: { sourceCutoff: 'A' } } } });
    vi.setSystemTime(epoch + 7 * day);
    expect(await crash.storage.execute(command, f.context)).toEqual({
      kind: 'refused',
      reason: 'expired',
    });
    expect(stages).toBe(2);
    expect(command.spec.entry.sourceCutoff).toBe('A');
  });
