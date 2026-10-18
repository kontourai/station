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
async function settled() {
  const f = await fixture();
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
  vi.setSystemTime(epoch + 7 * day);
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
