import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { afterEach, expect, it } from 'vitest';
import { agentWire, durableLanguageModel, runWithAgentTurn } from '../index.js';
import { finish, parts } from './fixture.js';
import { gate, turnFixture } from './turn-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const request = {
  prompt: [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'pinned input' }],
    },
  ],
};
it('a mid-stream crash retains an aborted partial and never resends a possibly dispatched request', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const release = gate();
  let calls = 0;
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'model',
    supportedUrls: {},
    async doGenerate() {
      throw Error('not streaming');
    },
    async doStream() {
      calls++;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({
              type: 'text-delta',
              id: 'answer',
              delta: 'partial',
            });
            await release.promise;
            controller.enqueue(finish);
            controller.close();
          },
        }),
      };
    },
  };
  const wrapped = durableLanguageModel(model);
  const response = await runWithAgentTurn(f.lease, () =>
    wrapped.doStream(request),
  );
  const reader = response.stream.getReader();
  expect((await reader.read()).value).toEqual({
    type: 'text-delta',
    id: 'answer',
    delta: 'partial',
  });
  const late = reader.read();
  const failure = expect(late).rejects.toThrow('STALE');
  cleanup.push(async () => {
    release.resolve();
    await failure;
  });
  const restored = await f.recover();
  const recoveryError = await runWithAgentTurn(restored, () =>
    wrapped.doStream(request),
  ).then(
    () => undefined,
    (error) => error,
  );
  expect(calls).toBe(1);
  expect(recoveryError?.message).toContain('INDETERMINATE');
  const row = f.database
    .prepare('SELECT record FROM agent_steps_effects')
    .get();
  const effect = JSON.parse(String(row?.record));
  expect(effect.attempts[0]).toMatchObject({
    state: 'aborted',
    partials: [
      agentWire({ type: 'text-delta', id: 'answer', delta: 'partial' }),
    ],
    output: null,
  });
  release.resolve();
  await failure;
});

it('a pinned request proven never dispatched is sent identically after recovery', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const captured = { provider: 'scripted', model: 'model', request };
  await f.lease.effect({
    type: 'effectPlan',
    intent: {
      id: 'model:0',
      kind: 'model',
      replay: 'unsafe',
      input: agentWire(captured),
    },
  });
  const restored = await f.recover();
  const calls: unknown[] = [];
  const model = durableLanguageModel({
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'model',
    supportedUrls: {},
    async doGenerate() {
      throw Error('not streaming');
    },
    async doStream(options) {
      const { abortSignal: _signal, ...input } = options;
      calls.push(input);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
  const response = await runWithAgentTurn(restored, () =>
    model.doStream(request),
  );
  const reader = response.stream.getReader();
  while (!(await reader.read()).done) {}
  expect(calls).toEqual([request]);
});
