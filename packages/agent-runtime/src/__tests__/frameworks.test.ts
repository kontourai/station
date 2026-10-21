import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { afterEach, expect, it } from 'vitest';
import {
  createModelRuntime,
  DEFAULT_MODEL_POLICY,
  type ImplementationBinding,
} from '../index.js';
import { openSqliteModelStorage, openSqliteRuntimeBodies } from '../sqlite.js';
import {
  captureStrandsEntry,
  createDurableStrandsConsumer,
} from '../strands.js';
import { captureVoltEntry, createDurableVoltConsumer } from '../voltagent.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const finish: LanguageModelV3StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
const binding = (
  framework: 'voltagent' | 'strands-vercel',
): ImplementationBinding => ({
  framework,
  frameworkVersion: framework === 'voltagent' ? '2.10.0' : '1.19.0',
  adapterDigest: `sha256:${'a'.repeat(64)}`,
  modelImplementationDigest: `sha256:${'b'.repeat(64)}`,
  connectionId: 'scripted',
  connectionRevision: '1',
  provider: 'scripted',
  modelId: 'text',
  transport: 'ai-sdk-v3-stateless/1',
});

for (const framework of ['voltagent', 'strands-vercel'] as const) {
  it(`${framework} constructs its real native consumer and dispatches retained composition`, async () => {
    // A disk-backed adapter is covered separately. SQLite memory still exercises
    // the real BLOB/transaction implementation; it is not OS durability proof.
    const temporary = mkdtempDisposableSync(
      join(tmpdir(), 'runtime-framework-'),
    );
    const directory = temporary.path;
    cleanup.push(() => temporary.remove());
    const database = new DatabaseSync(join(directory, 'host.sqlite'));
    database.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;',
    );
    cleanup.push(() => database.close());
    const policy = DEFAULT_MODEL_POLICY;
    const bodies = openSqliteRuntimeBodies({ database, policy });
    const admission = {
      binding: binding(framework),
      writerGeneration: 'writer-1',
    };
    const storage = openSqliteModelStorage({
      database,
      policy,
      host: () => admission,
    });
    cleanup.push(() => storage.close());
    const runtime = createModelRuntime({
      storage,
      bodies,
      admission: () => admission,
      liveness: () => 'live',
    });
    const calls: LanguageModelV3CallOptions[] = [];
    const model: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'text',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('doGenerate must not run');
      },
      async doStream(options) {
        calls.push(options);
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              for (const part of [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'answer' },
                { type: 'text-delta', id: 'answer', delta: 'COMPLETED' },
                { type: 'text-end', id: 'answer' },
                finish,
              ] satisfies LanguageModelV3StreamPart[])
                controller.enqueue(part);
              controller.close();
            },
          }),
        };
      },
    };
    const entry = await runtime.start({
      key: {
        scopeId: 'scope',
        conversationId: 'conversation',
        invocationId: 'turn',
      },
      owner: { id: 'owner', pid: 123, identityKind: 'exact', birth: 'birth' },
      admission,
      capture: () =>
        framework === 'voltagent'
          ? captureVoltEntry(bodies, {
              version: 1,
              binding: admission.binding,
              sourceCutoff: 'cutoff-A',
              authoredDigest: `sha256:${'c'.repeat(64)}`,
              messages: [
                {
                  id: 'system',
                  role: 'system',
                  parts: [{ type: 'text', text: 'RESOLVED-SYSTEM-A' }],
                },
                {
                  id: 'user',
                  role: 'user',
                  parts: [{ type: 'text', text: 'COMPOSED-A' }],
                },
              ],
              generation: {},
              tools: [],
            })
          : captureStrandsEntry(bodies, {
              version: 1,
              binding: admission.binding,
              sourceCutoff: 'cutoff-A',
              authoredDigest: `sha256:${'c'.repeat(64)}`,
              prefix: [],
              effectiveInput: 'COMPOSED-A',
              systemPrompt: 'RESOLVED-SYSTEM-A',
              vercelConfig: {},
              tools: [],
            }),
    });
    if (framework === 'voltagent') {
      const consumer = createDurableVoltConsumer({ model, runtime, entry });
      await consumer.control.run(async () => {
        const response = await consumer.raw.streamText([
          {
            id: 'system',
            role: 'system',
            parts: [{ type: 'text', text: 'RESOLVED-SYSTEM-A' }],
          },
          {
            id: 'user',
            role: 'user',
            parts: [{ type: 'text', text: 'COMPOSED-A' }],
          },
        ]);
        let output = '';
        for await (const part of response.fullStream)
          if (part.type === 'text-delta') output += part.text;
        expect(output).toBe('COMPLETED');
      });
      await consumer.control.finish('completed');
    } else {
      const consumer = createDurableStrandsConsumer({ model, runtime, entry });
      await consumer.control.run(async () => {
        let output = '';
        for await (const event of consumer.agent.stream('COMPOSED-A'))
          if (
            event.type === 'modelStreamUpdateEvent' &&
            event.event.type === 'modelContentBlockDeltaEvent' &&
            event.event.delta.type === 'textDelta'
          )
            output += event.event.delta.text;
        expect(output).toBe('COMPLETED');
      });
      await consumer.control.finish('completed');
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toEqual([
      { role: 'system', content: 'RESOLVED-SYSTEM-A' },
      { role: 'user', content: [{ type: 'text', text: 'COMPOSED-A' }] },
    ]);
  });
}

for (const framework of ['voltagent', 'strands-vercel'] as const) {
  it(`${framework} restores A after ambient B, retains aborted audit and seeds a subsequent native prompt from ready completion`, async () => {
    const { fixture, owner, nextOwner, parts } = await import('./fixture.js');
    const { drainModelOutbox } = await import('../index.js');
    const { openSqliteRuntimeProjection } = await import('../sqlite.js');
    const { readTape } = await import('../ai-sdk.js');
    const f = await fixture();
    cleanup.push(() => f.close());
    const admitted = {
      binding: binding(framework),
      writerGeneration: 'writer-1',
    };
    const host = () => admitted;
    let storage = openSqliteModelStorage({
      database: f.database,
      host,
      policy: DEFAULT_MODEL_POLICY,
    });
    cleanup.push(() => storage.close());
    const runKey = {
      scopeId: 'scope',
      conversationId: 'native-recovery',
      invocationId: 'original',
    };
    let ambient = 'COMPOSED-A';
    let captures = 0;
    let firstController:
      | ReadableStreamDefaultController<LanguageModelV3StreamPart>
      | undefined;
    let signal!: () => void;
    const textSeen = new Promise<void>((r) => {
      signal = r;
    });
    const calls: LanguageModelV3CallOptions[] = [];
    const model: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'text',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('unsupported generate');
      },
      async doStream(options) {
        calls.push(options);
        const first = calls.length === 1;
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              if (first) {
                firstController = c;
                for (const p of parts.slice(0, 3))
                  c.enqueue(
                    p.type === 'text-delta'
                      ? { ...p, delta: 'OLD-PARTIAL' }
                      : p,
                  );
              } else {
                for (const p of parts) c.enqueue(p);
                c.close();
              }
            },
          }),
        };
      },
    };
    const capture = async () => {
      captures++;
      return framework === 'voltagent'
        ? captureVoltEntry(f.bodies, {
            version: 1,
            binding: admitted.binding,
            sourceCutoff: 'immutable-A',
            authoredDigest: `sha256:${'c'.repeat(64)}`,
            messages: [
              {
                id: 'user',
                role: 'user',
                parts: [{ type: 'text', text: ambient }],
              },
            ],
            generation: {},
            tools: [],
          })
        : captureStrandsEntry(f.bodies, {
            version: 1,
            binding: admitted.binding,
            sourceCutoff: 'immutable-A',
            authoredDigest: `sha256:${'c'.repeat(64)}`,
            prefix: [],
            effectiveInput: ambient,
            systemPrompt: '',
            vercelConfig: {},
            tools: [],
          });
    };
    const firstRuntime = createModelRuntime({
      storage,
      bodies: f.bodies,
      admission: host,
      liveness: () => 'live',
    });
    const entry = await firstRuntime.start({
      key: runKey,
      owner,
      admission: admitted,
      capture,
    });
    const consume = async (
      runtime: ReturnType<typeof createModelRuntime>,
      entry: Awaited<ReturnType<typeof firstRuntime.start>>,
      input: string,
      onText?: (text: string) => void,
    ) => {
      let output = '';
      if (framework === 'voltagent') {
        const c = createDurableVoltConsumer({ runtime, entry, model });
        await c.control.run(async () => {
          const response = await c.raw.streamText([
            {
              id: 'user',
              role: 'user',
              parts: [{ type: 'text', text: input }],
            },
          ]);
          for await (const p of response.fullStream)
            if (p.type === 'text-delta') {
              output += p.text;
              onText?.(p.text);
            }
        });
      } else {
        const c = createDurableStrandsConsumer({ runtime, entry, model });
        await c.control.run(async () => {
          for await (const p of c.agent.stream(input))
            if (
              p.type === 'modelStreamUpdateEvent' &&
              p.event.type === 'modelContentBlockDeltaEvent' &&
              p.event.delta.type === 'textDelta'
            ) {
              output += p.event.delta.text;
              onText?.(p.event.delta.text);
            }
        });
      }
      return output;
    };
    cleanup.push(async () => {
      firstController?.error(new Error('cleanup old process'));
    });
    const old = consume(firstRuntime, entry, 'COMPOSED-A', () =>
      signal(),
    ).catch(() => 'crashed');
    await textSeen;
    const observed = await storage.execute(
      { type: 'read', key: runKey },
      { liveness: () => 'live' },
    );
    if (observed.kind !== 'found')
      throw new Error('observed generation missing');
    await storage.close();
    ambient = 'COMPOSED-B';
    storage = openSqliteModelStorage({
      database: f.database,
      host,
      policy: DEFAULT_MODEL_POLICY,
    });
    const restoredRuntime = createModelRuntime({
      storage,
      bodies: f.bodies,
      admission: host,
      liveness: (o) => (o.id === owner.id ? 'dead' : 'live'),
    });
    const restored = await restoredRuntime.restore({
      key: runKey,
      observed: observed.snapshot.fence,
      owner: nextOwner,
      admission: admitted,
    });
    expect(await consume(restoredRuntime, restored, 'COMPOSED-A')).toBe(
      'COMPLETED',
    );
    await restoredRuntime.bind(restored).finish('completed');
    expect(captures).toBe(1);
    expect(ambient).toBe('COMPOSED-B');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toEqual(calls[0]?.prompt);
    const sink = openSqliteRuntimeProjection({
      database: f.database,
      bodies: f.bodies,
      host,
      policy: DEFAULT_MODEL_POLICY,
    });
    cleanup.push(() => sink.close());
    await drainModelOutbox(storage, sink, runKey, { liveness: () => 'live' });
    const audit = await sink.readAudit(runKey);
    expect(audit.some((p) => p.kind === 'aborted' && p.attempt === 1)).toBe(
      true,
    );
    const ready = await sink.readModelContext(runKey);
    expect(ready.kind).toBe('ready');
    if (ready.kind !== 'ready') throw new Error('ready continuation required');
    const completedText = (
      await Promise.all(
        ready.tapes.map(async (ref) =>
          readTape(await f.bodies.read(ref))
            .parts.flatMap((p) =>
              p.type === 'text-delta' && 'delta' in p ? [p.delta] : [],
            )
            .join(''),
        ),
      )
    ).join('');
    expect(completedText).toBe('COMPLETED');
    const nextKey = { ...runKey, invocationId: 'subsequent' };
    const nextRuntime = createModelRuntime({
      storage,
      bodies: f.bodies,
      admission: host,
      liveness: () => 'live',
    });
    const nextEntry = await nextRuntime.start({
      key: nextKey,
      owner: { ...nextOwner, id: 'third' },
      admission: admitted,
      capture: () =>
        framework === 'voltagent'
          ? captureVoltEntry(f.bodies, {
              version: 1,
              binding: admitted.binding,
              sourceCutoff: 'next',
              authoredDigest: `sha256:${'c'.repeat(64)}`,
              messages: [
                {
                  id: 'previous-completion',
                  role: 'assistant',
                  parts: [{ type: 'text', text: completedText }],
                },
                {
                  id: 'user',
                  role: 'user',
                  parts: [{ type: 'text', text: 'NEXT' }],
                },
              ],
              generation: {},
              tools: [],
            })
          : captureStrandsEntry(f.bodies, {
              version: 1,
              binding: admitted.binding,
              sourceCutoff: 'next',
              authoredDigest: `sha256:${'c'.repeat(64)}`,
              prefix: [
                { role: 'assistant', content: [{ text: completedText }] },
              ],
              effectiveInput: 'NEXT',
              systemPrompt: '',
              vercelConfig: {},
              tools: [],
            }),
    });
    if (framework === 'voltagent') {
      const c = createDurableVoltConsumer({
        runtime: nextRuntime,
        entry: nextEntry,
        model,
      });
      await c.control.run(async () => {
        const response = await c.raw.streamText([
          {
            id: 'previous-completion',
            role: 'assistant',
            parts: [{ type: 'text', text: completedText }],
          },
          { id: 'user', role: 'user', parts: [{ type: 'text', text: 'NEXT' }] },
        ]);
        for await (const _ of response.fullStream) {
        }
      });
    } else await consume(nextRuntime, nextEntry, 'NEXT');
    expect(calls[2]?.prompt).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'COMPLETED' }] },
      { role: 'user', content: [{ type: 'text', text: 'NEXT' }] },
    ]);
    firstController?.error(new Error('simulated old process death'));
    await old;
  });
}

for (const framework of ['voltagent', 'strands-vercel'] as const) {
  it(`${framework} committed native tool call refuses the actual registered body and settles blocked`, async () => {
    const { fixture, owner } = await import('./fixture.js');
    const { createTool } = await import('@voltagent/core');
    const { z } = await import('zod');
    const { FunctionTool } = await import('@strands-agents/sdk');
    const f = await fixture();
    cleanup.push(() => f.close());
    const admitted = {
      binding: binding(framework),
      writerGeneration: 'writer-1',
    };
    const host = () => admitted;
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
    const tools = [
      {
        type: 'function' as const,
        name: 'probe',
        description: 'Probe',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          additionalProperties: false,
        },
      },
    ];
    const entry = await runtime.start({
      key: {
        scopeId: 'scope',
        conversationId: 'native-tools',
        invocationId: 'tool-turn',
      },
      owner,
      admission: admitted,
      capture: () =>
        framework === 'voltagent'
          ? captureVoltEntry(f.bodies, {
              version: 1,
              binding: admitted.binding,
              sourceCutoff: 'A',
              authoredDigest: `sha256:${'c'.repeat(64)}`,
              messages: [
                {
                  id: 'user',
                  role: 'user',
                  parts: [{ type: 'text', text: 'TOOL' }],
                },
              ],
              generation: {},
              tools,
            })
          : captureStrandsEntry(f.bodies, {
              version: 1,
              binding: admitted.binding,
              sourceCutoff: 'A',
              authoredDigest: `sha256:${'c'.repeat(64)}`,
              prefix: [],
              effectiveInput: 'TOOL',
              systemPrompt: '',
              vercelConfig: {},
              tools,
            }),
    });
    let bodies = 0;
    let calls = 0;
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
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'call',
                  toolName: 'probe',
                  input: '{}',
                },
                {
                  ...finish,
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                },
              ] satisfies LanguageModelV3StreamPart[])
                c.enqueue(p);
              c.close();
            },
          }),
        };
      },
    };
    const control = runtime.bind(entry);
    if (framework === 'voltagent') {
      const consumer = createDurableVoltConsumer({ runtime, entry, model });
      consumer.raw.removeTools(['probe']);
      consumer.raw.addTools([
        createTool({
          name: 'probe',
          description: 'Probe',
          parameters: z.object({}).strict(),
          execute: async () => {
            bodies++;
            return 'EFFECT';
          },
        }),
      ]);
      await control
        .run(async () => {
          const response = await consumer.raw.streamText([
            {
              id: 'user',
              role: 'user',
              parts: [{ type: 'text', text: 'TOOL' }],
            },
          ]);
          for await (const _ of response.fullStream) {
          }
        })
        .catch(() => {});
    } else {
      const consumer = createDurableStrandsConsumer({ runtime, entry, model });
      consumer.agent.toolRegistry.addOrReplace([
        new FunctionTool({
          name: 'probe',
          description: 'Probe',
          inputSchema: tools[0]!.inputSchema,
          callback: () => {
            bodies++;
            return 'EFFECT';
          },
        }),
      ]);
      await control
        .run(async () => {
          for await (const _ of consumer.agent.stream('TOOL')) {
          }
        })
        .catch(() => {});
    }
    expect(calls).toBe(1);
    expect(bodies).toBe(0);
    await expect(control.finish('completed')).rejects.toThrow(
      'DURABLE_RUN_BLOCKED',
    );
    await control.finish('blocked');
    expect(
      await storage.execute(
        { type: 'read', key: entry.key },
        { liveness: () => 'live' },
      ),
    ).toMatchObject({ snapshot: { state: 'blocked' } });
  });
}
