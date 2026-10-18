import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { afterEach, expect, it } from 'vitest';
import { requestBytes } from '../ai-sdk.js';
import { normalizePart, readTape, tapeBytes } from '../codecs.js';
import { canonical } from '../encoding.js';
import { createModelRuntime, type Fence, type RunKey } from '../index.js';
import { runRecordSchema } from '../records.js';
import { captureVoltEntry, createDurableVoltConsumer } from '../voltagent.js';
import {
  fixture,
  key,
  messages,
  nextOwner,
  operation,
  owner,
  parts,
} from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function replayFixture() {
  const f = await fixture();
  cleanup.push(() => f.close());
  // Obtain native request bytes from the production public consumer, not an
  // approximation of the framework's default conversion.
  const native: LanguageModelV3CallOptions[] = [];
  const probe = createModelRuntime({
    storage: f.storage,
    bodies: f.bodies,
    admission: f.host,
    liveness: () => 'live',
  });
  const probeEntry = await probe.start({
    key: { ...key, conversationId: 'native-template' },
    owner,
    admission: f.admission,
    capture: () =>
      captureVoltEntry(f.bodies, {
        version: 1,
        binding: f.admission.binding,
        sourceCutoff: 'A',
        authoredDigest: `sha256:${'c'.repeat(64)}`,
        messages,
        generation: {},
        tools: [],
      }),
  });
  const consumer = createDurableVoltConsumer({
    runtime: probe,
    entry: probeEntry,
    model: {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'text',
      supportedUrls: {},
      async doGenerate() {
        throw Error('unsupported');
      },
      async doStream(options) {
        native.push(options);
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of parts) c.enqueue(p);
              c.close();
            },
          }),
        };
      },
    },
  });
  await consumer.control.run(async () => {
    const response = await consumer.raw.streamText(messages);
    for await (const _ of response.fullStream) {
    }
  });
  expect(native).toHaveLength(1);
  const request = await f.bodies.put(
    'runtime-ai-sdk-v3-request/1',
    requestBytes(native[0]!),
  );
  const complete = async (runKey: RunKey, output: string) => {
    const opened = await f.storage.execute(
      operation({
        type: 'open',
        spec: { ...f.opened.snapshot.spec, key: runKey },
        owner,
      }),
      f.context,
    );
    if (opened.kind !== 'opened' && opened.kind !== 'existing')
      throw Error('actual generation prerequisite');
    const pin = { ...f.pin, requestId: 'same-per-run-request', request };
    const p = await f.storage.execute(
      operation({
        type: 'pin',
        key: runKey,
        expected: opened.snapshot.fence,
        pin,
      }),
      f.context,
    );
    if (p.kind === 'refused') throw Error('actual native pin prerequisite');
    const begin = operation({
      type: 'begin',
      key: runKey,
      expected: p.fence,
      requestId: pin.requestId,
    });
    const b = await f.storage.execute(begin, f.context);
    if (b.kind !== 'execute')
      throw Error('actual historical grant prerequisite');
    const tape = await f.bodies.put(
      'runtime-ai-sdk-v3-tape/1',
      tapeBytes(
        pin.requestId,
        b.attempt.number,
        parts.map((p) =>
          normalizePart(p.type === 'text-delta' ? { ...p, delta: output } : p),
        ),
      ),
    );
    const c = await f.storage.execute(
      operation({
        type: 'complete',
        key: runKey,
        expected: b.fence,
        attempt: b.attempt,
        tape,
        lastPartialSequence: -1,
      }),
      f.context,
    );
    if (c.kind === 'refused')
      throw Error('actual zero-prefix complete prerequisite');
    return { key: runKey, pin, begin, begun: b, tape, fence: c.fence };
  };
  const a = await complete(key, 'OWN-A');
  const b = await complete({ ...key, conversationId: 'foreign' }, 'FOREIGN-B');
  const aBytes = await f.bodies.read(a.tape);
  const bBytes = await f.bodies.read(b.tape);
  expect(a.tape.digest).not.toBe(b.tape.digest);
  expect(readTape(aBytes).requestId).toBe(readTape(bBytes).requestId);
  expect(readTape(aBytes).attempt).toBe(readTape(bBytes).attempt);
  expect(await f.storage.execute(a.begin, f.context)).toEqual({
    kind: 'acknowledged',
    fence: a.begun.fence,
    originalGrantId: a.begun.attempt.grantId,
  });
  const aId = canonical([key.scopeId, key.conversationId, key.invocationId]);
  const row = () => {
    const value = f.database
      .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
      .get(aId)?.record;
    if (typeof value !== 'string') throw Error('actual A row prerequisite');
    return value;
  };
  const run = runRecordSchema.parse(JSON.parse(row()));
  expect(run.settledAt).toBeNull();
  expect(run.state).toBe('running');
  expect(run.pins[0]?.attempts[0]?.partials).toEqual([]);
  expect(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM agent_runtime_receipts WHERE json_extract(record,'$.answer.kind')='replay'",
      )
      .get()?.n,
  ).toBe(0);
  expect(
    f.database
      .prepare('SELECT count(*) AS n FROM agent_runtime_projection')
      .get()?.n,
  ).toBe(0);
  expect(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM agent_runtime_outbox WHERE json_extract(record,'$.acknowledged')=1",
      )
      .get()?.n,
  ).toBe(0);
  const snapshot = () => ({
    runs: f.database
      .prepare('SELECT id,record FROM agent_runtime_runs ORDER BY id')
      .all(),
    receipts: f.database
      .prepare('SELECT id,record FROM agent_runtime_receipts ORDER BY id')
      .all(),
    outbox: f.database
      .prepare('SELECT id,record FROM agent_runtime_outbox ORDER BY id')
      .all(),
    sink: f.database
      .prepare('SELECT id,record FROM agent_runtime_projection ORDER BY id')
      .all(),
    bodies: f.database
      .prepare(
        'SELECT codec,digest,byte_length,bytes,format FROM agent_runtime_bodies ORDER BY codec,digest',
      )
      .all(),
  });
  const mint = async (observed: Fence, replacement = nextOwner) => {
    const beginIds = new Set<string>();
    let grants = 0;
    let providerCalls = 0;
    const runtime = createModelRuntime({
      bodies: f.bodies,
      admission: f.host,
      liveness: (o) => (o.id === observed.owner.id ? 'dead' : 'live'),
      storage: {
        async execute(command, context) {
          if (command.type === 'begin') beginIds.add(command.operationId);
          const answer = await f.storage.execute(command, context);
          if (command.type === 'begin' && answer.kind === 'execute') grants++;
          return answer;
        },
        close: () => f.storage.close(),
      },
    });
    const entry = await runtime.restore({
      key,
      observed,
      owner: replacement,
      admission: f.admission,
    });
    const current = createDurableVoltConsumer({
      runtime,
      entry,
      model: {
        specificationVersion: 'v3',
        provider: 'scripted',
        modelId: 'text',
        supportedUrls: {},
        async doGenerate() {
          throw Error('unsupported');
        },
        async doStream() {
          providerCalls++;
          throw Error('Replay must never dispatch, including aborted signals');
        },
      },
    });
    return {
      beginIds,
      get grants() {
        return grants;
      },
      get providerCalls() {
        return providerCalls;
      },
      async consume() {
        const output: string[] = [];
        let finish = false;
        await current.control
          .run(async () => {
            const response = await current.raw.streamText(messages);
            for await (const p of response.fullStream) {
              if (p.type === 'text-delta') output.push(p.text);
              if (p.type === 'finish') finish = true;
            }
          })
          .catch(() => {});
        return { output: output.join(''), finish };
      },
    };
  };
  return { ...f, a, b, aId, row, snapshot, mint, aBytes, bBytes };
}
for (const boundary of ['journal', 'coordinator'] as const)
  it(`R4.1 ${boundary} refuses same-header foreign completed tape before finish or sink acknowledgment`, async () => {
    const f = await replayFixture();
    const consumer =
      boundary === 'coordinator' ? await f.mint(f.a.fence) : undefined;
    const before = f.snapshot();
    const original = f.row();
    const run = runRecordSchema.parse(JSON.parse(original));
    run.pins[0]!.attempts[0]!.tape = f.b.tape;
    const corrupted = canonical(run);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(corrupted, f.aId);
    const afterInjection = f.snapshot();
    expect(afterInjection.receipts).toEqual(before.receipts);
    expect(afterInjection.outbox).toEqual(before.outbox);
    expect(afterInjection.sink).toEqual(before.sink);
    expect(afterInjection.bodies).toEqual(before.bodies);
    const beginIds = consumer?.beginIds ?? new Set<string>();
    let grants = 0;
    let released = '';
    let finish = false;
    let replay = false;
    if (consumer) {
      const result = await consumer.consume();
      released = result.output;
      finish = result.finish;
      grants = consumer.grants;
      expect(consumer.providerCalls).toBe(0);
    } else {
      const command = operation({
        type: 'begin',
        key,
        expected: f.a.fence,
        requestId: f.a.pin.requestId,
      });
      beginIds.add(command.operationId);
      const answer = await f.storage
        .execute(command, f.context)
        .catch(() => undefined);
      if (answer?.kind === 'execute') grants++;
      if (answer?.kind === 'replay') {
        replay = true;
        released = readTape(await f.bodies.read(answer.tape))
          .parts.flatMap((p) => (p.type === 'text-delta' ? [p.delta] : []))
          .join('');
      }
    }
    expect(beginIds.size).toBe(1);
    expect(grants).toBe(0);
    expect.soft(released).toBe('');
    expect.soft(finish).toBe(false);
    expect.soft(replay).toBe(false);
    const after = f.snapshot();
    expect(after.runs).toEqual(afterInjection.runs);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.sink).toEqual(before.sink);
    expect(after.bodies).toEqual(before.bodies);
    expect.soft(after.receipts).toEqual(before.receipts);
    // The buggy command can legitimately add exactly its attempted replay receipt.
    // Reset only that disposable-fixture side effect before testing exact restore.
    const oldIds = new Set(before.receipts.map((row) => row.id));
    for (const row of after.receipts)
      if (!oldIds.has(row.id)) {
        if (typeof row.id !== 'string') throw Error('actual new receipt ID');
        const tuple: unknown = JSON.parse(row.id);
        if (
          !Array.isArray(tuple) ||
          tuple.length !== 2 ||
          tuple[0] !== f.aId ||
          typeof tuple[1] !== 'string' ||
          !beginIds.has(tuple[1])
        )
          throw Error('unexpected receipt side effect');
        f.database
          .prepare('DELETE FROM agent_runtime_receipts WHERE id=?')
          .run(row.id);
      }
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(original, f.aId);
    expect(f.snapshot()).toEqual(before);
    expect(await f.bodies.read(f.a.tape)).toEqual(f.aBytes);
    expect(await f.bodies.read(f.b.tape)).toEqual(f.bBytes);
    if (boundary === 'journal') {
      const own = await f.storage.execute(
        operation({
          type: 'begin',
          key,
          expected: f.a.fence,
          requestId: f.a.pin.requestId,
        }),
        f.context,
      );
      expect(own).toMatchObject({ kind: 'replay', tape: f.a.tape });
    } else {
      const restored = await f.mint(run.fence, {
        ...nextOwner,
        id: 'exact-restored',
      });
      expect(await restored.consume()).toEqual({
        output: 'OWN-A',
        finish: true,
      });
      expect(restored.providerCalls).toBe(0);
      expect(restored.grants).toBe(0);
    }
  });
it('R4.1 pristine unacked unfinished own replay remains valid in journal and actual restored Volt consumer', async () => {
  const f = await replayFixture();
  const own = await f.storage.execute(
    operation({
      type: 'begin',
      key,
      expected: f.a.fence,
      requestId: f.a.pin.requestId,
    }),
    f.context,
  );
  expect(own).toMatchObject({ kind: 'replay', tape: f.a.tape });
  const consumer = await f.mint(f.a.fence);
  expect(await consumer.consume()).toEqual({ output: 'OWN-A', finish: true });
  expect(consumer.providerCalls).toBe(0);
  expect(consumer.grants).toBe(0);
  expect(consumer.beginIds.size).toBe(1);
});
