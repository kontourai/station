import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { afterEach, expect, it } from 'vitest';
import { durableLanguageModel } from '../index.js';
import { parts } from './fixture.js';
import { turnFixture } from './turn-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('provider affinity survives recovery without reviving a dead writer', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const original = f.lease.providerSessionId;
  const restored = await f.recover();
  expect(restored.providerSessionId).toBe(original);
  await restored.run(async () => {});
  await expect(
    f.runtime.start({
      key: { ...f.key, invocationId: 'next' },
      implementation: 'station-agent/1',
      input: 'next input',
    }),
  ).rejects.toThrow('UNKNOWN-OWNER');
  // The original process is dead: an old writer must not open the next turn.
  const row = f.database
    .prepare(
      'SELECT provider_session_id FROM agent_steps_affinity WHERE scope=? AND conversation=?',
    )
    .get(f.key.scopeId, f.key.conversationId);
  expect(row?.provider_session_id).toBe(original);
});

it('provider affinity reaches the native model boundary and new conversations never inherit it', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const seen: LanguageModelV3CallOptions[] = [];
  const model = durableLanguageModel(
    {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'model',
      supportedUrls: {},
      async doGenerate() {
        throw Error('stream only');
      },
      async doStream(options) {
        seen.push(options);
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      },
    },
    { affinity: (id) => ({ scripted: { sessionId: id } }) },
  );
  await f.lease.run(async () => {
    const response = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    const reader = response.stream.getReader();
    while (!(await reader.read()).done) {}
  });
  const next = await f.runtime.start({
    key: { ...f.key, invocationId: 'next' },
    implementation: 'station-agent/1',
    input: 'next input',
  });
  expect(next.providerSessionId).toBe(f.lease.providerSessionId);
  const children = await Promise.all(
    ['child😀', 'child\uE000'].map((conversationId) =>
      f.runtime.start({
        key: { ...f.key, conversationId },
        implementation: 'station-agent/1',
        input: conversationId,
      }),
    ),
  );
  expect(
    new Set([
      f.lease.providerSessionId,
      ...children.map((child) => child.providerSessionId),
    ]).size,
  ).toBe(3);
  expect(seen[0]?.providerOptions).toEqual({
    scripted: { sessionId: f.lease.providerSessionId },
  });
});
