import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
} from '@ai-sdk/provider';
import { BeforeModelCallEvent, InvokeModelStage } from '@strands-agents/sdk';
import { afterEach, expect, it } from 'vitest';
import { createModelRuntime, DEFAULT_MODEL_POLICY } from '../index.js';
import { openSqliteModelStorage } from '../sqlite.js';
import {
  captureStrandsEntry,
  createDurableStrandsConsumer,
} from '../strands.js';
import { captureVoltEntry, createDurableVoltConsumer } from '../voltagent.js';
import { fixture, owner, parts } from './fixture.js';
import { deferred } from './r1-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
it('Strands public hook and middleware registration refuse before after and inside native dispatch initialization scope', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const binding = {
    ...f.admission.binding,
    framework: 'strands-vercel' as const,
    frameworkVersion: '1.19.0' as const,
  };
  const admission = { binding, writerGeneration: 'writer-1' };
  const host = () => admission;
  const storage = openSqliteModelStorage({
    database: f.database,
    host,
    policy: DEFAULT_MODEL_POLICY,
  });
  cleanup.push(() => storage.close());
  const runtime = createModelRuntime({
    storage,
    bodies: f.bodies,
    admission: host,
    liveness: () => 'live',
  });
  const entry = await runtime.start({
    key: {
      scopeId: 'scope',
      conversationId: 'hook-negative',
      invocationId: 'turn',
    },
    owner,
    admission,
    capture: () =>
      captureStrandsEntry(f.bodies, {
        version: 1,
        binding,
        sourceCutoff: 'A',
        authoredDigest: `sha256:${'c'.repeat(64)}`,
        prefix: [],
        effectiveInput: 'INPUT',
        systemPrompt: '',
        vercelConfig: {},
        tools: [],
      }),
  });
  let callbacks = 0;
  let calls = 0;
  let insideChecked = false;
  let consumer: ReturnType<typeof createDurableStrandsConsumer>;
  const rejectRegistration = () => {
    expect(() =>
      consumer.agent.addHook(BeforeModelCallEvent, () => {
        callbacks++;
      }),
    ).toThrow('DURABLE_HOOKS_UNSUPPORTED');
    expect(() =>
      consumer.agent.addMiddleware(InvokeModelStage.Input, (context) => {
        callbacks++;
        return context;
      }),
    ).toThrow('DURABLE_HOOKS_UNSUPPORTED');
  };
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'text',
    supportedUrls: {},
    async doGenerate() {
      throw Error('unsupported');
    },
    async doStream() {
      calls++;
      rejectRegistration();
      insideChecked = true;
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
  consumer = createDurableStrandsConsumer({ runtime, entry, model });
  rejectRegistration();
  await consumer.control.run(async () => {
    for await (const _ of consumer.agent.stream('INPUT')) {
    }
  });
  rejectRegistration();
  expect(calls).toBe(1);
  expect(insideChecked).toBe(true);
  expect(callbacks).toBe(0);
});
for (const framework of ['voltagent', 'strands-vercel'] as const)
  it(`${framework} two interleaved real consumers preserve distinct private binding and prompt`, async () => {
    const f = await fixture();
    cleanup.push(() => f.close());
    const binding = {
      ...f.admission.binding,
      framework,
      frameworkVersion:
        framework === 'voltagent' ? ('2.10.0' as const) : ('1.19.0' as const),
    };
    const admission = { binding, writerGeneration: 'writer-1' };
    const host = () => admission;
    const storage = openSqliteModelStorage({
      database: f.database,
      host,
      policy: DEFAULT_MODEL_POLICY,
    });
    cleanup.push(() => storage.close());
    const runtime = createModelRuntime({
      storage,
      bodies: f.bodies,
      admission: host,
      liveness: () => 'live',
    });
    const both = deferred();
    const release = deferred();
    const calls: LanguageModelV3CallOptions[] = [];
    const model: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'text',
      supportedUrls: {},
      async doGenerate() {
        throw Error('unsupported');
      },
      async doStream(o) {
        calls.push(o);
        if (calls.length === 2) both.resolve();
        await release.promise;
        const input = o.prompt[0];
        if (input?.role !== 'user' || input.content[0]?.type !== 'text')
          throw Error('native prompt prerequisite');
        const answer = input.content[0].text;
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of parts)
                c.enqueue(
                  p.type === 'text-delta' ? { ...p, delta: answer } : p,
                );
              c.close();
            },
          }),
        };
      },
    };
    const run = async (input: string) => {
      const entry = await runtime.start({
        key: { scopeId: 'scope', conversationId: input, invocationId: 'turn' },
        owner: { ...owner, id: input },
        admission,
        capture: () =>
          framework === 'voltagent'
            ? captureVoltEntry(f.bodies, {
                version: 1,
                binding,
                sourceCutoff: input,
                authoredDigest: `sha256:${'c'.repeat(64)}`,
                messages: [
                  {
                    id: 'u',
                    role: 'user',
                    parts: [{ type: 'text', text: input }],
                  },
                ],
                generation: {},
                tools: [],
              })
            : captureStrandsEntry(f.bodies, {
                version: 1,
                binding,
                sourceCutoff: input,
                authoredDigest: `sha256:${'c'.repeat(64)}`,
                prefix: [],
                effectiveInput: input,
                systemPrompt: '',
                vercelConfig: {},
                tools: [],
              }),
      });
      let output = '';
      if (framework === 'voltagent') {
        const c = createDurableVoltConsumer({ runtime, entry, model });
        await c.control.run(async () => {
          const r = await c.raw.streamText([
            { id: 'u', role: 'user', parts: [{ type: 'text', text: input }] },
          ]);
          for await (const p of r.fullStream)
            if (p.type === 'text-delta') output += p.text;
        });
      } else {
        const c = createDurableStrandsConsumer({ runtime, entry, model });
        await c.control.run(async () => {
          for await (const p of c.agent.stream(input))
            if (
              p.type === 'modelStreamUpdateEvent' &&
              p.event.type === 'modelContentBlockDeltaEvent' &&
              p.event.delta.type === 'textDelta'
            )
              output += p.event.delta.text;
        });
      }
      return output;
    };
    const first = run('PRIVATE-A');
    const second = run('PRIVATE-B');
    try {
      await both.promise;
      expect(calls.map((c) => c.prompt)).toEqual(
        expect.arrayContaining([
          [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE-A' }] }],
          [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE-B' }] }],
        ]),
      );
    } finally {
      release.resolve();
    }
    expect(await Promise.all([first, second])).toEqual([
      'PRIVATE-A',
      'PRIVATE-B',
    ]);
  });
for (const framework of ['voltagent', 'strands-vercel'] as const)
  it(`${framework} public cancellation settles the real native consumer and its callbacks`, async () => {
    const f = await fixture();
    cleanup.push(() => f.close());
    const binding = {
      ...f.admission.binding,
      framework,
      frameworkVersion:
        framework === 'voltagent' ? ('2.10.0' as const) : ('1.19.0' as const),
    };
    const admission = { binding, writerGeneration: 'writer-1' };
    const host = () => admission;
    const storage = openSqliteModelStorage({
      database: f.database,
      host,
      policy: DEFAULT_MODEL_POLICY,
    });
    cleanup.push(() => storage.close());
    const runtime = createModelRuntime({
      storage,
      bodies: f.bodies,
      admission: host,
      liveness: () => 'live',
    });
    const entry = await runtime.start({
      key: {
        scopeId: 'scope',
        conversationId: 'native-cancel',
        invocationId: 'turn',
      },
      owner,
      admission,
      capture: () =>
        framework === 'voltagent'
          ? captureVoltEntry(f.bodies, {
              version: 1,
              binding,
              sourceCutoff: 'A',
              authoredDigest: `sha256:${'c'.repeat(64)}`,
              messages: [
                {
                  id: 'u',
                  role: 'user',
                  parts: [{ type: 'text', text: 'INPUT' }],
                },
              ],
              generation: {},
              tools: [],
            })
          : captureStrandsEntry(f.bodies, {
              version: 1,
              binding,
              sourceCutoff: 'A',
              authoredDigest: `sha256:${'c'.repeat(64)}`,
              prefix: [],
              effectiveInput: 'INPUT',
              systemPrompt: '',
              vercelConfig: {},
              tools: [],
            }),
    });
    const textSeen = deferred();
    let upstreamCancelled = false;
    let consumerSettled = false;
    let success = false;
    const model: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'text',
      supportedUrls: {},
      async doGenerate() {
        throw Error('unsupported');
      },
      async doStream() {
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of parts.slice(0, 3)) c.enqueue(p);
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
        };
      },
    };
    const control = runtime.bind(entry);
    const operation = control
      .run(async () => {
        if (framework === 'voltagent') {
          const consumer = createDurableVoltConsumer({ runtime, entry, model });
          const result = await consumer.raw.streamText([
            { id: 'u', role: 'user', parts: [{ type: 'text', text: 'INPUT' }] },
          ]);
          for await (const p of result.fullStream) {
            if (p.type === 'text-delta') textSeen.resolve();
            if (p.type === 'finish') success = true;
          }
        } else {
          const consumer = createDurableStrandsConsumer({
            runtime,
            entry,
            model,
          });
          for await (const p of consumer.agent.stream('INPUT'))
            if (p.type === 'modelStreamUpdateEvent') {
              if (
                p.event.type === 'modelContentBlockDeltaEvent' &&
                p.event.delta.type === 'textDelta'
              )
                textSeen.resolve();
              if (p.event.type === 'modelMessageStopEvent') success = true;
            }
        }
      })
      .catch(() => {})
      .finally(() => {
        consumerSettled = true;
      });
    await textSeen.promise;
    await control.cancel();
    expect(upstreamCancelled).toBe(true);
    await operation;
    expect(consumerSettled).toBe(true);
    expect(success).toBe(false);
    expect(
      await storage.execute({ type: 'read', key: entry.key }, f.context),
    ).toMatchObject({ snapshot: { state: 'cancelled' } });
  });
