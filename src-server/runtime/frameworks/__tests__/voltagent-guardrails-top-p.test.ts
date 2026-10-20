/**
 * #323: `guardrails.topP` must reach the model on the default VoltAgent
 * runtime. VoltAgent discards constructor `topP`, so this builds a real Agent
 * through `createAgent` and reads the call options the model receives —
 * through the bare Agent Station registers as the live chat agent (`raw`)
 * and through the wrapper.
 */
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { VoltAgentFramework } from '../voltagent-adapter.js';

const makeTempDir = trackTempDirs();

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function recordingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'Noted.' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start' as const, id: 'a' },
          { type: 'text-delta' as const, id: 'a', delta: 'Noted.' },
          { type: 'text-end' as const, id: 'a' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
          },
        ] as any,
      }),
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function build(
  guardrails: AgentSpec['guardrails'],
  logger?: { warn: (msg: string, context?: unknown) => void },
) {
  const framework = new VoltAgentFramework();
  const model = recordingModel();
  vi.spyOn(framework, 'createModel').mockResolvedValue(model);
  vi.spyOn(framework, 'loadTools').mockResolvedValue([]);
  const projectHomeDir = makeTempDir('station-volt-top-p-');
  const bundle = await framework.createAgent(
    'assistant',
    { name: 'assistant', prompt: 'Answer briefly.', guardrails } as AgentSpec,
    { appConfig: {} as any, projectHomeDir },
    {
      processedPrompt: 'Answer briefly.',
      memoryAdapter: new FileMemoryAdapter({ projectHomeDir }),
      logger,
    } as any,
  );
  return { model, bundle };
}

async function drain(result: { fullStream: AsyncIterable<unknown> }) {
  for await (const _chunk of result.fullStream) {
    // drain so the model call completes
  }
}

test('guardrails.topP reaches streamed and generated model calls on the registered agent', async () => {
  const { model, bundle } = await build({ topP: 0.37 });
  // The bare Agent is what runtime-agent-builder registers for chat.
  const raw = (bundle.agent as any).raw;
  await drain(
    await raw.streamText('Hi', { userId: 'owner', conversationId: 'c1' }),
  );
  await raw.generateText('Hi', { userId: 'owner', conversationId: 'c2' });
  expect(model.doStreamCalls[0]!.topP).toBe(0.37);
  expect(model.doGenerateCalls[0]!.topP).toBe(0.37);
});

test('guardrails.topP reaches the model through the wrapper too', async () => {
  const { model, bundle } = await build({ topP: 0.37 });
  await drain(
    await bundle.agent.streamText('Hi', {
      userId: 'owner',
      conversationId: 'c3',
    }),
  );
  expect(model.doStreamCalls[0]!.topP).toBe(0.37);
});

test('a per-call topP overrides the guardrail default', async () => {
  const { model, bundle } = await build({ topP: 0.37 });
  await (bundle.agent as any).raw.generateText('Hi', {
    userId: 'owner',
    conversationId: 'c4',
    topP: 0.9,
  });
  expect(model.doGenerateCalls[0]!.topP).toBe(0.9);
});

test('no guardrail topP leaves the model call unset', async () => {
  const { model, bundle } = await build({ temperature: 0.2 });
  await (bundle.agent as any).raw.generateText('Hi', {
    userId: 'owner',
    conversationId: 'c5',
  });
  expect(model.doGenerateCalls[0]!.topP).toBeUndefined();
  expect(model.doGenerateCalls[0]!.temperature).toBe(0.2);
});

test('temperature wins over topP when both guardrails are set', async () => {
  // Bedrock forwards both, and newer Claude models reject that combination.
  const warn = vi.fn();
  const { model, bundle } = await build(
    { temperature: 0.7, topP: 0.9 },
    { warn },
  );
  await (bundle.agent as any).raw.generateText('Hi', {
    userId: 'owner',
    conversationId: 'c6',
  });
  expect(model.doGenerateCalls[0]!.temperature).toBe(0.7);
  expect(model.doGenerateCalls[0]!.topP).toBeUndefined();
  // Station's Logger takes the message first, then the context.
  expect(warn).toHaveBeenCalledWith(
    'guardrails.topP is ignored because guardrails.temperature is also set',
    { agent: 'assistant' },
  );
});
