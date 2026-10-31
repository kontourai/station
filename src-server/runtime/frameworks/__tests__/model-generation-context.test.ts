import { Agent, Memory } from '@voltagent/core';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import {
  createAuthorizedTurnCorrelation,
  runWithAuthorizedTurnCorrelation,
} from '../../conversation/authorized-turn-correlation.js';
import { observeDirectModelIdentity } from '../model-generation-identity.js';
import { createVoltAgentLifecycleHooks } from '../voltagent-adapter.js';

const temp = trackTempDirs();
function model(reported = true) {
  return new MockLanguageModelV3({
    modelId: 'same-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          ...(reported
            ? [
                {
                  type: 'response-metadata' as const,
                  id: 'provider-response',
                  modelId: 'same-model',
                  timestamp: new Date('2026-10-30T00:00:00Z'),
                },
              ]
            : []),
          { type: 'text-start' as const, id: 'text' },
          { type: 'text-delta' as const, id: 'text', delta: 'Result' },
          { type: 'text-end' as const, id: 'text' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: {
                total: 120,
                noCache: 100,
                cacheRead: 20,
                cacheWrite: 0,
              },
              outputTokens: { total: 25, text: 25, reasoning: 0 },
            },
          },
        ],
      }),
    }),
  });
}
async function invoke(agent: Agent, sessionId: string) {
  const correlation = createAuthorizedTurnCorrelation({
    accountId: 'owner',
    sessionId,
    clientTurnId: 'request-1',
  });
  await runWithAuthorizedTurnCorrelation(correlation, async () => {
    const result = await agent.streamText('Question', {
      conversationId: sessionId,
      userId: 'owner',
    });
    for await (const _chunk of result.fullStream) {
    }
  });
  return correlation;
}

test('real model step observes last-request input/output and raw reported identity without changing invocation billing usage', async () => {
  const afterModelGeneration = vi.fn(),
    afterInvocation = vi.fn();
  const observed = observeDirectModelIdentity(model(), {
    connectionId: 'direct-connection',
    modelId: 'same-model',
    providerType: 'openai-compat',
    configurationDigest: 'a'.repeat(64),
  });
  const storage = new FileMemoryAdapter({
    projectHomeDir: temp('model-context-'),
  });
  const agent = new Agent({
    name: 'context-agent',
    instructions: 'Answer briefly.',
    model: observed,
    memory: new Memory({ storage }),
    hooks: createVoltAgentLifecycleHooks('context-agent', {
      afterModelGeneration,
      afterInvocation,
    }),
  });
  const correlation = await invoke(agent, 'session-a');
  expect(afterModelGeneration).toHaveBeenCalledTimes(1);
  expect(afterModelGeneration.mock.calls[0][0]).toMatchObject({
    modelId: 'same-model',
    connectionId: 'direct-connection',
    modelIdentitySource: 'provider-response',
    inputTokenAccounting: 'total',
    inputTokens: 120,
    outputTokens: 25,
    invocation: {
      sessionId: 'session-a',
      turnId: correlation.turnId,
      principalId: 'owner',
    },
  });
  expect(afterInvocation.mock.calls[0][0].usage).toMatchObject({
    promptTokens: 120,
    completionTokens: 25,
  });
});

test('AI SDK fallback model identity and a different same-name model instance cannot borrow the prior connection observation', async () => {
  const afterModelGeneration = vi.fn();
  const hooks = createVoltAgentLifecycleHooks('context-agent', {
    afterModelGeneration,
  });
  const storage = new FileMemoryAdapter({
    projectHomeDir: temp('model-context-identity-'),
  });
  const first = new Agent({
    name: 'context-agent-a',
    instructions: 'Answer.',
    model: observeDirectModelIdentity(model(), {
      connectionId: 'connection-a',
      modelId: 'same-model',
      providerType: 'openai-compat',
      configurationDigest: 'a'.repeat(64),
    }),
    memory: new Memory({ storage }),
    hooks,
  });
  await invoke(first, 'session-a');
  const fallback = new Agent({
    name: 'context-agent-b',
    instructions: 'Answer.',
    model: observeDirectModelIdentity(model(false), {
      connectionId: 'connection-b',
      modelId: 'same-model',
      providerType: 'openai-compat',
      configurationDigest: 'b'.repeat(64),
    }),
    memory: new Memory({ storage }),
    hooks,
  });
  await invoke(fallback, 'session-b');
  const unrelated = new Agent({
    name: 'context-agent-c',
    instructions: 'Answer.',
    model: model(),
    memory: new Memory({ storage }),
    hooks,
  });
  await invoke(unrelated, 'session-c');
  expect(
    afterModelGeneration.mock.calls.map(([observation]) => [
      observation.invocation.sessionId,
      observation.connectionId,
      observation.modelIdentitySource,
    ]),
  ).toEqual([
    ['session-a', 'connection-a', 'provider-response'],
    ['session-b', undefined, 'runtime-model'],
    ['session-c', undefined, 'runtime-model'],
  ]);
});
