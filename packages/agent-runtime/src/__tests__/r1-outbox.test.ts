import { mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { normalizePart, tapeBytes } from '../codecs.js';
import { encode } from '../encoding.js';
import {
  DEFAULT_MODEL_POLICY,
  drainModelOutbox,
  type ModelCommand,
  type ModelResult,
} from '../index.js';
import { openSqliteRuntimeProjection } from '../sqlite.js';
import type {
  ModelContext,
  ModelStorage,
  RuntimeProjectionSink,
} from '../types.js';
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
  const profileDirectory = mkdtempSync(
    join(process.env.STATION_VITEST_HOST_TMPDIR ?? tmpdir(), 'r1-outbox-cpu-'),
  );
  const microseconds = () => Number(process.hrtime.bigint() / 1000n);
  const observations: {
    operation: string;
    ordinal: number;
    startUs: number;
    endUs: number;
    resolved: boolean;
  }[] = [];
  let bookkeepingUs = 0;
  const observe = async <T>(
    operation: string,
    call: () => Promise<T>,
  ): Promise<T> => {
    const startUs = microseconds();
    let resolved = false;
    try {
      const result = await call();
      resolved = true;
      return result;
    } finally {
      const endUs = microseconds();
      observations.push({
        operation,
        ordinal: observations.length,
        startUs,
        endUs,
        resolved,
      });
      bookkeepingUs += microseconds() - endUs;
    }
  };
  const actualStorage = f.storage;
  const observedStorage: ModelStorage = {
    execute<C extends ModelCommand>(
      command: C,
      context: ModelContext,
    ): Promise<ModelResult<C>> {
      return observe(command.type, () =>
        actualStorage.execute(command, context),
      );
    },
    close() {
      return actualStorage.close();
    },
  };
  const observedSink: RuntimeProjectionSink = {
    ...sink,
    apply(entry) {
      return observe('apply', () => sink.apply(entry));
    },
  };
  const profiler = new Session();
  writeSync(
    1,
    `\n[r1-outbox-profile] ${JSON.stringify({ profileDirectory })}\n`,
  );
  writeFileSync(
    join(profileDirectory, 'start.json'),
    JSON.stringify({
      node: process.version,
      defaultSamplingInterval: true,
      setupStartUs: microseconds(),
    }),
    { flag: 'wx' },
  );
  profiler.connect();
  try {
    await profiler.post('Profiler.enable');
    const startBeforeUs = microseconds();
    await profiler.post('Profiler.start');
    const startAfterUs = microseconds();
    trace('drain:enter');
    const drainStartUs = microseconds();
    let drainFailure: { error: unknown } | undefined;
    try {
      await drainModelOutbox(observedStorage, observedSink, key, f.context);
    } catch (error) {
      drainFailure = { error };
    }
    const drainEndUs = microseconds();
    trace('drain:exit');
    const stopBeforeUs = microseconds();
    let profileFailure: { error: unknown } | undefined;
    try {
      const { profile } = await profiler.post('Profiler.stop');
      const stopAfterUs = microseconds();
      const saveStartUs = microseconds();
      writeFileSync(
        join(profileDirectory, 'drain.cpuprofile'),
        JSON.stringify(profile),
        { flag: 'wx' },
      );
      writeFileSync(
        join(profileDirectory, 'observations.json'),
        JSON.stringify({
          startBeforeUs,
          startAfterUs,
          drainStartUs,
          drainEndUs,
          stopBeforeUs,
          stopAfterUs,
          bookkeepingUs,
          drainFailed: drainFailure !== undefined,
          observations,
        }),
        { flag: 'wx' },
      );
      writeFileSync(
        join(profileDirectory, 'saved.json'),
        JSON.stringify({ saveUs: microseconds() - saveStartUs }),
        { flag: 'wx' },
      );
    } catch (error) {
      profileFailure = { error };
    }
    if (drainFailure) {
      if (profileFailure)
        writeSync(
          2,
          `\n[r1-outbox-profile-error] ${String(profileFailure.error)}\n`,
        );
      throw drainFailure.error;
    }
    if (profileFailure) throw profileFailure.error;
  } finally {
    profiler.disconnect();
  }
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
