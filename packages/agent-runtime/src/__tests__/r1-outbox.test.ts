import { writeSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { normalizePart, tapeBytes } from '../codecs.js';
import { encode } from '../encoding.js';
import { DEFAULT_MODEL_POLICY, drainModelOutbox } from '../index.js';
import { openSqliteRuntimeProjection } from '../sqlite.js';
import { finish, fixture, key, operation } from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
it('R1.6 one drain applies more than 1024 real settled projections and reaches ready', async () => {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const trace = (phase: string, completedPartials?: number) => {
    const cpu = process.cpuUsage(cpuStarted);
    writeSync(
      1,
      `\n[r1-outbox-phase] ${JSON.stringify({
        phase,
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        completedPartials,
      })}\n`,
    );
  };
  trace('case:enter');
  trace('fixture:enter');
  const f = await fixture();
  trace('fixture:exit');
  cleanup.push(() => f.close());
  trace('sink:enter');
  const sink = openSqliteRuntimeProjection({
    database: f.database,
    bodies: f.bodies,
    host: f.host,
    policy: DEFAULT_MODEL_POLICY,
  });
  cleanup.push(() => sink.close());
  trace('sink:exit');
  trace('pin:enter');
  const pin = await f.storage.execute(
    operation({
      type: 'pin',
      key,
      expected: f.opened.snapshot.fence,
      pin: f.pin,
    }),
    f.context,
  );
  if (pin.kind === 'refused') throw Error('pin prerequisite');
  trace('pin:exit');
  trace('begin:enter');
  const begun = await f.storage.execute(
    operation({
      type: 'begin',
      key,
      expected: pin.fence,
      requestId: f.pin.requestId,
    }),
    f.context,
  );
  if (begun.kind !== 'execute') throw Error('begin prerequisite');
  trace('begin:exit');
  trace('part-bodies:enter');
  let fence = begun.fence;
  const wire = [
    normalizePart({ type: 'text-start', id: 'text' }),
    ...Array.from({ length: 1024 }, () =>
      normalizePart({ type: 'text-delta', id: 'text', delta: 'x' }),
    ),
    normalizePart({ type: 'text-end', id: 'text' }),
  ];
  const start = await f.bodies.put('runtime-ai-sdk-v3-part/1', encode(wire[0]));
  const delta = await f.bodies.put('runtime-ai-sdk-v3-part/1', encode(wire[1]));
  const end = await f.bodies.put(
    'runtime-ai-sdk-v3-part/1',
    encode(wire.at(-1)),
  );
  trace('part-bodies:exit');
  trace('partials:enter');
  for (let sequence = 0; sequence < wire.length; sequence++) {
    const body =
      sequence === 0 ? start : sequence === wire.length - 1 ? end : delta;
    const ack = await f.storage.execute(
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
    if (ack.kind === 'refused') throw Error('partial prerequisite');
    fence = ack.fence;
    if ((sequence + 1) % 128 === 0 || sequence + 1 === wire.length)
      trace('partials:progress', sequence + 1);
  }
  trace('partials:exit', wire.length);
  trace('tape:enter');
  const tape = await f.bodies.put(
    'runtime-ai-sdk-v3-tape/1',
    tapeBytes(f.pin.requestId, 1, [...wire, normalizePart(finish)]),
  );
  trace('tape:exit');
  trace('complete:enter');
  const complete = await f.storage.execute(
    operation({
      type: 'complete',
      key,
      expected: fence,
      attempt: begun.attempt,
      tape,
      lastPartialSequence: wire.length - 1,
    }),
    f.context,
  );
  if (complete.kind === 'refused') throw Error('complete prerequisite');
  trace('complete:exit');
  trace('finish:enter');
  await f.storage.execute(
    operation({
      type: 'finish',
      key,
      expected: complete.fence,
      status: 'completed',
    }),
    f.context,
  );
  trace('finish:exit');
  trace('drain:enter');
  await drainModelOutbox(f.storage, sink, key, f.context);
  trace('drain:exit');
  trace('audit:enter');
  expect((await sink.readAudit(key)).map((p) => p.sequence)).toEqual([
    ...Array.from({ length: 1026 }, (_, i) => i),
    0,
  ]);
  trace('audit:exit');
  trace('ready:enter');
  expect(await sink.readModelContext(key)).toEqual({
    kind: 'ready',
    tapes: [tape],
  });
  trace('ready:exit');
  trace('case:exit');
});
it('R1.6 initial outbox window leaves a legitimate same-run concurrent append for the next drain', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const sink = openSqliteRuntimeProjection({
    database: f.database,
    bodies: f.bodies,
    host: f.host,
    policy: DEFAULT_MODEL_POLICY,
  });
  cleanup.push(() => sink.close());
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
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 'a' },
  ].entries()) {
    const body = await f.bodies.put('runtime-ai-sdk-v3-part/1', encode(part));
    const ack = await f.storage.execute(
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
    if (ack.kind === 'refused') throw Error('partial prerequisite');
    fence = ack.fence;
  }
  let appended = false;
  await drainModelOutbox(
    f.storage,
    {
      ...sink,
      async apply(entry) {
        if (!appended) {
          appended = true;
          const body = await f.bodies.put(
            'runtime-ai-sdk-v3-part/1',
            encode({ type: 'text-delta', id: 'a', delta: 'LATE' }),
          );
          const ack = await f.storage.execute(
            operation({
              type: 'partial',
              key,
              expected: fence,
              attempt: begun.attempt,
              sequence: 2,
              body,
            }),
            f.context,
          );
          if (ack.kind === 'refused')
            throw Error('concurrent append prerequisite');
        }
        await sink.apply(entry);
      },
    },
    key,
    f.context,
  );
  expect((await sink.readAudit(key)).map((p) => p.sequence)).toEqual([0, 1]);
  const remaining = await f.storage.execute(
    { type: 'listOutbox', key, limit: 10 },
    f.context,
  );
  expect(remaining).toMatchObject({
    kind: 'listed',
    throughPosition: 2,
    entries: [{ sequence: 2 }],
  });
  await drainModelOutbox(f.storage, sink, key, f.context);
  expect((await sink.readAudit(key)).map((p) => p.sequence)).toEqual([0, 1, 2]);
});
