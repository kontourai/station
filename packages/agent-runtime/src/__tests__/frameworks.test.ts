import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createModelRuntime, DEFAULT_MODEL_POLICY, type ImplementationBinding } from '../index.js';
import { openSqliteModelStorage, openSqliteRuntimeBodies } from '../sqlite.js';
import { captureVoltEntry, createDurableVoltConsumer } from '../voltagent.js';
import { captureStrandsEntry, createDurableStrandsConsumer } from '../strands.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const finish: LanguageModelV3StreamPart = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 } } };
const binding = (framework: 'voltagent' | 'strands-vercel'): ImplementationBinding => ({
  framework, frameworkVersion: framework === 'voltagent' ? '2.10.0' : '1.19.0',
  adapterDigest: `sha256:${'a'.repeat(64)}`, modelImplementationDigest: `sha256:${'b'.repeat(64)}`,
  connectionId: 'scripted', connectionRevision: '1', provider: 'scripted', modelId: 'text',
  transport: 'ai-sdk-v3-stateless/1',
});

for (const framework of ['voltagent', 'strands-vercel'] as const) {
  it(`${framework} constructs its real native consumer and dispatches retained composition`, async () => {
    // A disk-backed adapter is covered separately. SQLite memory still exercises
    // the real BLOB/transaction implementation; it is not OS durability proof.
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    cleanup.push(() => database.close());
    const policy = DEFAULT_MODEL_POLICY;
    const bodies = openSqliteRuntimeBodies({ database, policy });
    const admission = { binding: binding(framework), writerGeneration: 'writer-1' };
    const storage = openSqliteModelStorage({ database, policy, host: () => admission });
    cleanup.push(() => storage.close());
    const runtime = createModelRuntime({ storage, bodies, admission: () => admission, liveness: () => 'live' });
    const calls: LanguageModelV3CallOptions[] = [];
    const model: LanguageModelV3 = {
      specificationVersion: 'v3', provider: 'scripted', modelId: 'text', supportedUrls: {},
      async doGenerate() { throw new Error('doGenerate must not run'); },
      async doStream(options) {
        calls.push(options);
        return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
          for (const part of [{ type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'COMPLETED' },
            { type: 'text-end', id: 'answer' }, finish] satisfies LanguageModelV3StreamPart[]) controller.enqueue(part);
          controller.close();
        } }) };
      },
    };
    const entry = await runtime.start({ key: { scopeId: 'scope', conversationId: 'conversation', invocationId: 'turn' },
      owner: { id: 'owner', pid: 123, identityKind: 'exact', birth: 'birth' }, admission,
      capture: () => framework === 'voltagent' ? captureVoltEntry(bodies, {
        version: 1, binding: admission.binding, sourceCutoff: 'cutoff-A', authoredDigest: `sha256:${'c'.repeat(64)}`,
        messages: [{ id: 'system', role: 'system', parts: [{ type: 'text', text: 'RESOLVED-SYSTEM-A' }] },
          { id: 'user', role: 'user', parts: [{ type: 'text', text: 'COMPOSED-A' }] }], generation: {}, tools: [],
      }) : captureStrandsEntry(bodies, {
        version: 1, binding: admission.binding, sourceCutoff: 'cutoff-A', authoredDigest: `sha256:${'c'.repeat(64)}`,
        prefix: [], effectiveInput: 'COMPOSED-A', systemPrompt: 'RESOLVED-SYSTEM-A', vercelConfig: {}, tools: [],
      }),
    });
    if (framework === 'voltagent') {
      const consumer = createDurableVoltConsumer({ model, runtime, entry });
      await consumer.control.run(async () => {
        const response = await consumer.raw.streamText([
          { id: 'system', role: 'system', parts: [{ type: 'text', text: 'RESOLVED-SYSTEM-A' }] },
          { id: 'user', role: 'user', parts: [{ type: 'text', text: 'COMPOSED-A' }] },
        ]);
        let output = '';
        for await (const part of response.fullStream) if (part.type === 'text-delta') output += part.text;
        expect(output).toBe('COMPLETED');
      });
      await consumer.control.finish('completed');
    } else {
      const consumer = createDurableStrandsConsumer({ model, runtime, entry });
      await consumer.control.run(async () => {
        let output = '';
        for await (const event of consumer.agent.stream('COMPOSED-A'))
          if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') output += event.delta.text;
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
