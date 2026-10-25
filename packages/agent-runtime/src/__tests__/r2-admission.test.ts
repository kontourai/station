import { afterEach, expect, it } from 'vitest';
import { bindDurableAiSdkModel } from '../ai-sdk.js';
import { entryData, normalizePart, tapeBytes } from '../codecs.js';
import { digestBytes, encode } from '../encoding.js';
import { createModelRuntime } from '../index.js';
import { nextOwner, operation, parts } from './fixture.js';
import { deferred, nativeOptions, runtimeFixture } from './r1-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
for (const current of ['1', '2'] as const)
  for (const presentation of ['1', '2'] as const)
    it(`R2.1 fresh grant retains private A with current ${current} public ${presentation} after held final read`, async () => {
      const entered = deferred();
      const release = deferred();
      let grants = 0;
      let begins = 0;
      let held = false;
      const f = await runtimeFixture({
        storage(s) {
          return {
            async execute(c, ctx) {
              const a = await s.execute(c, ctx);
              if (c.type === 'begin') {
                begins++;
                if (a.kind === 'execute') grants++;
              }
              return a;
            },
            close: () => s.close(),
          };
        },
        bodies(b) {
          return {
            put: b.put,
            async read(ref) {
              if (
                grants &&
                !held &&
                ref.codec === 'runtime-ai-sdk-v3-request/1'
              ) {
                held = true;
                entered.resolve();
                await release.promise;
              }
              return b.read(ref);
            },
          };
        },
      });
      cleanup.push(() => f.close());
      const seen: string[] = [];
      const running = f.control
        .run(async () => {
          const { stream } = await f.guarded.doStream(nativeOptions);
          for await (const p of stream) seen.push(p.type);
        })
        .then(
          () => 'completed',
          () => 'refused',
        );
      await entered.promise;
      const data = entryData(f.entry.entry.body.codec, f.entry.entryBytes);
      const bytes = encode({
        ...data,
        binding: { ...data.binding, connectionRevision: presentation },
      });
      expect(bytes.length).toBe(f.entry.entryBytes.length);
      f.entry.entryBytes.set(bytes);
      f.admission.binding = {
        ...f.admission.binding,
        connectionRevision: current,
      };
      release.resolve();
      const outcome = await running;
      expect(f.calls).toHaveLength(current === '1' ? 1 : 0);
      expect(outcome).toBe(current === '1' ? 'completed' : 'refused');
      expect(begins).toBe(1);
      expect(grants).toBe(1);
      if (current === '1') {
        expect(seen.at(-1)).toBe('finish');
        expect(f.calls[0]!.prompt).toEqual(nativeOptions.prompt);
      }
    });
for (const change of ['none', 'revoke', 'writer', 'cancel', 'model'] as const)
  it(`R2 replay held tape read ${change} checks final data release before native parts`, async () => {
    const f = await runtimeFixture();
    cleanup.push(() => f.close());
    const p = await f.storage.execute(
      operation({
        type: 'pin',
        key: f.entry.key,
        expected: f.entry.fence,
        pin: { ...f.pin, entryDigest: f.entry.entry.body.digest },
      }),
      f.context,
    );
    if (p.kind === 'refused') throw Error('real replay pin prerequisite');
    const b = await f.storage.execute(
      operation({
        type: 'begin',
        key: f.entry.key,
        expected: p.fence,
        requestId: f.pin.requestId,
      }),
      f.context,
    );
    if (b.kind !== 'execute') throw Error('historical execute prerequisite');
    const tape = await f.bodies.put(
      'runtime-ai-sdk-v3-tape/1',
      tapeBytes(f.pin.requestId, b.attempt.number, parts.map(normalizePart)),
    );
    const c = await f.storage.execute(
      operation({
        type: 'complete',
        key: f.entry.key,
        expected: b.fence,
        attempt: b.attempt,
        tape,
        lastPartialSequence: -1,
      }),
      f.context,
    );
    if (c.kind === 'refused') throw Error('actual completed tape prerequisite');
    const entered = deferred();
    const release = deferred();
    let replay = false;
    let beginCalls = 0;
    let grants = 0;
    let revoked = false;
    const admission = () => {
      if (revoked) throw Error('host revoked');
      return f.admission;
    };
    const runtime = createModelRuntime({
      admission,
      liveness: (owner) => (owner.id === nextOwner.id ? 'live' : 'dead'),
      storage: {
        async execute(command, context) {
          const answer = await f.storage.execute(command, context);
          if (command.type === 'begin') {
            beginCalls++;
            replay = answer.kind === 'replay';
            if (answer.kind === 'execute') grants++;
          }
          return answer;
        },
        close: () => f.storage.close(),
      },
      bodies: {
        put: f.bodies.put,
        async read(ref) {
          if (replay && ref.codec === 'runtime-ai-sdk-v3-tape/1') {
            entered.resolve();
            await release.promise;
          }
          return f.bodies.read(ref);
        },
      },
    });
    const entry = await runtime.restore({
      key: f.entry.key,
      observed: c.fence,
      owner: nextOwner,
      admission: f.admission,
    });
    const control = runtime.bind(entry);
    const guarded = bindDurableAiSdkModel({ runtime, entry, model: f.model });
    const observed: string[] = [];
    const running = control
      .run(async () => {
        const { stream } = await guarded.doStream(nativeOptions);
        for await (const part of stream) observed.push(part.type);
      })
      .then(
        () => 'completed',
        () => 'refused',
      );
    await entered.promise;
    if (change === 'revoke') revoked = true;
    if (change === 'writer') f.admission.writerGeneration = 'writer-2';
    if (change === 'model') Object.assign(f.model, { modelId: 'changed' });
    const cancelled = change === 'cancel' ? control.cancel() : undefined;
    release.resolve();
    const result = await running;
    if (cancelled) await cancelled;
    expect(observed).toEqual(change === 'none' ? parts.map((p) => p.type) : []);
    expect(result).toBe(change === 'none' ? 'completed' : 'refused');
    expect(f.calls).toHaveLength(0);
    expect(beginCalls).toBe(1);
    expect(grants).toBe(0);
  });

it('start retains verified entry bytes when its reader mutates them during journal open', async () => {
  let alias: Uint8Array | undefined;
  let mutated = false;
  const f = await runtimeFixture({
    bodies(bodies) {
      return {
        ...bodies,
        async read(ref) {
          const bytes = await bodies.read(ref);
          if (!alias && ref.codec === 'runtime-volt-entry/1') {
            alias = new Uint8Array(bytes);
            return alias;
          }
          return bytes;
        },
      };
    },
    storage(storage) {
      return {
        async execute(command, context) {
          const answer = await storage.execute(command, context);
          if (command.type === 'open' && answer.kind === 'opened' && alias) {
            const data = entryData('runtime-volt-entry/1', alias);
            const changed = encode({ ...data, sourceCutoff: 'B' });
            expect(changed.byteLength).toBe(alias.byteLength);
            alias.set(changed);
            mutated = true;
          }
          return answer;
        },
        close: () => storage.close(),
      };
    },
  });
  cleanup.push(() => f.close());
  expect(mutated).toBe(true);
  expect(digestBytes(f.entry.entryBytes)).toBe(f.entry.entry.body.digest);
  expect(
    entryData(f.entry.entry.body.codec, f.entry.entryBytes).sourceCutoff,
  ).toBe('A');
  await f.control.run(async () => {
    const { stream } = await f.guarded.doStream(nativeOptions);
    for await (const _ of stream) {
    }
  });
  await f.control.finish('completed');
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.prompt).toEqual(nativeOptions.prompt);
});

it('restore rejects entry bytes that do not match the stored entry reference', async () => {
  const f = await runtimeFixture();
  cleanup.push(() => f.close());
  let supplied = false;
  const runtime = createModelRuntime({
    storage: f.storage,
    admission: f.host,
    liveness: (candidate) => (candidate.id === nextOwner.id ? 'live' : 'dead'),
    bodies: {
      ...f.bodies,
      async read(ref) {
        const bytes = await f.bodies.read(ref);
        if (ref.digest !== f.entry.entry.body.digest) return bytes;
        const data = entryData(ref.codec, bytes);
        supplied = true;
        return encode({ ...data, sourceCutoff: 'B' });
      },
    },
  });
  await expect(
    runtime.restore({
      key: f.entry.key,
      observed: f.entry.fence,
      owner: nextOwner,
      admission: f.admission,
    }),
  ).rejects.toThrow('DURABLE_BODY_DAMAGED');
  expect(supplied).toBe(true);
});
