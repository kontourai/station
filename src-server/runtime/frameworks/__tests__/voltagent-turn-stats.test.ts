/**
 * #5390: which VoltAgent turns the built-in Station agent's stats count,
 * through the real adapter hooks (`createVoltAgentLifecycleHooks`), the real
 * Station hooks (`createAgentHooks`) and a real VoltAgent `Agent` streaming a
 * scripted model. VoltAgent ends a stream whose provider sent an error part
 * with an output whose `finishReason` is `error` and no `error` field, so the
 * adapter must pass that failure on.
 */
import { Agent, Memory } from '@voltagent/core';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { createAgentHooks } from '../../agents/agent-hooks.js';
import { createVoltAgentLifecycleHooks } from '../voltagent-adapter.js';

const temp = trackTempDirs();

const partialText = [
  { type: 'text-start' as const, id: 't' },
  { type: 'text-delta' as const, id: 't', delta: 'Partial' },
];
const reportedUsage = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};
/** What a provider that reports no usage leaves in the finish part. */
const noUsage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};
const finish = (reason: 'stop' | 'error', usage: object) => ({
  type: 'finish' as const,
  finishReason: { unified: reason, raw: reason },
  usage,
});

function scripted(chunks: unknown[], chunkDelayInMs?: number) {
  return new MockLanguageModelV3({
    modelId: 'scripted',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: chunks as never[],
        ...(chunkDelayInMs ? { chunkDelayInMs } : {}),
      }),
    }),
  });
}

async function runTurn(model: MockLanguageModelV3, stopAfterChunks?: number) {
  let metadata: Record<string, unknown> = {};
  const store = {
    getConversation: vi.fn(async () => ({ resourceId: 'default', metadata })),
    getMessages: vi.fn().mockResolvedValue([]),
    updateConversation: vi.fn(
      async (_id: string, update: { metadata: Record<string, unknown> }) => {
        metadata = update.metadata;
      },
    ),
    removeLastMessage: vi.fn().mockResolvedValue(undefined),
    addMessage: vi.fn().mockResolvedValue(undefined),
  };
  const shared = createAgentHooks({
    spec: { name: 'Station Assistant', prompt: 'Help.' },
    appConfig: { defaultModel: 'scripted' },
    configLoader: { loadAgent: vi.fn().mockRejectedValue(new Error('none')) },
    agentFixedTokens: new Map(),
    memoryAdapters: new Map([['default', store]]),
    toolNameMapping: new Map(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any);
  const agent = new Agent({
    name: 'default',
    instructions: 'Answer.',
    model,
    memory: new Memory({
      storage: new FileMemoryAdapter({ projectHomeDir: temp('volt-stats-') }),
    }),
    hooks: createVoltAgentLifecycleHooks('default', shared),
  });
  const stop = new AbortController();
  try {
    const result = await agent.streamText('Question', {
      conversationId: 'conv-1',
      userId: 'owner',
      abortSignal: stop.signal,
    });
    let seen = 0;
    for await (const _chunk of result.fullStream)
      if (++seen === stopAfterChunks) stop.abort();
  } catch {
    // A stream that fails before content rejects; its hook still ran.
  }
  return { store, stats: () => metadata.stats as any };
}

describe('VoltAgent turn counting (#5390)', () => {
  test('a stream that failed with nothing reported is not counted', async () => {
    const turn = await runTurn(
      scripted([
        ...partialText,
        { type: 'error', error: new Error('scripted_error') },
      ]),
    );
    expect(turn.store.updateConversation).not.toHaveBeenCalled();
    expect(turn.stats()).toBeUndefined();
  });

  test('a stream that failed after reporting usage counts, with its tokens', async () => {
    const turn = await runTurn(
      scripted([
        ...partialText,
        { type: 'text-end', id: 't' },
        finish('error', reportedUsage),
      ]),
    );
    expect(turn.stats()).toMatchObject({
      turns: 1,
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  test('an answered turn with no usage counts once, with no token counts', async () => {
    const turn = await runTurn(
      scripted([
        ...partialText,
        { type: 'text-end', id: 't' },
        finish('stop', noUsage),
      ]),
    );
    expect(turn.stats()).toMatchObject({ turns: 1, toolCalls: 0 });
    expect(turn.stats()).not.toHaveProperty('inputTokens');
  });

  test("a person's Stop after the turn started counts the turn, with nothing reported", async () => {
    const turn = await runTurn(
      scripted(
        [
          ...partialText,
          { type: 'text-delta', id: 't', delta: ' more' },
          { type: 'text-end', id: 't' },
          finish('stop', reportedUsage),
        ],
        100,
      ),
      3,
    );
    await vi.waitFor(() => expect(turn.stats()).toBeDefined());
    expect(turn.stats()).toMatchObject({ turns: 1 });
    expect(turn.stats()).not.toHaveProperty('inputTokens');
  });
});
