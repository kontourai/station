/**
 * #5390: which VoltAgent turns the built-in Station agent's stats count, and
 * with what usage, through the real adapter hooks
 * (`createVoltAgentLifecycleHooks`), the real Station hooks
 * (`createAgentHooks`) and a real VoltAgent `Agent` streaming a scripted
 * model.
 *
 * VoltAgent ends a stream whose provider sent an error part with an output
 * whose `finishReason` is `error` and no `error` field, so the adapter must
 * pass that failure on. Its abort listener can call `onEnd` again with no
 * output after a turn completed, so an abort must never count. And a turn
 * that called tools has one usage per model step: the output's `usage` is the
 * last step's, `totalUsage` the turn's.
 */
import { Agent, createTool, Memory } from '@voltagent/core';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { createAgentHooks } from '../../agents/agent-hooks.js';
import { createVoltAgentLifecycleHooks } from '../voltagent-adapter.js';

const temp = trackTempDirs();

const partialText = [
  { type: 'text-start' as const, id: 't' },
  { type: 'text-delta' as const, id: 't', delta: 'Partial' },
];
const answer = [...partialText, { type: 'text-end' as const, id: 't' }];
const usage = (input?: number, output?: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const finish = (reason: 'stop' | 'error' | 'tool-calls', reported: object) => ({
  type: 'finish' as const,
  finishReason: { unified: reason, raw: reason },
  usage: reported,
});
const toolCall = {
  type: 'tool-call' as const,
  toolCallId: 'call',
  toolName: 'lookup',
  input: '{}',
};

/** One stream per model step; the last repeats for any further step. */
function scripted(steps: unknown[][], chunkDelayInMs?: number) {
  let step = 0;
  return new MockLanguageModelV3({
    modelId: 'scripted',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: (steps[step++] ?? steps.at(-1)) as never[],
        ...(chunkDelayInMs ? { chunkDelayInMs } : {}),
      }),
    }),
  });
}

async function runTurn(
  model: MockLanguageModelV3,
  options: {
    stopAfterChunks?: number;
    abortAfterDone?: boolean;
    toolThrows?: boolean;
  } = {},
) {
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
    spec: {
      name: 'Station Assistant',
      prompt: 'Help.',
      tools: { autoApprove: ['lookup'] },
    },
    appConfig: { defaultModel: 'scripted' },
    configLoader: { loadAgent: vi.fn().mockRejectedValue(new Error('none')) },
    agentFixedTokens: new Map(),
    memoryAdapters: new Map([['default', store]]),
    toolNameMapping: new Map(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any);
  const afterInvocation = vi.fn(shared.afterInvocation!);
  const agent = new Agent({
    name: 'default',
    instructions: 'Answer.',
    model,
    tools: [
      createTool({
        name: 'lookup',
        description: 'Looks something up.',
        parameters: z.object({}),
        execute: async () => {
          if (options.toolThrows) throw new Error('lookup failed');
          return 'found';
        },
      }),
    ],
    memory: new Memory({
      storage: new FileMemoryAdapter({ projectHomeDir: temp('volt-stats-') }),
    }),
    hooks: createVoltAgentLifecycleHooks('default', {
      ...shared,
      afterInvocation,
    }),
  });
  const stop = new AbortController();
  try {
    const result = await agent.streamText('Question', {
      conversationId: 'conv-1',
      userId: 'owner',
      abortSignal: stop.signal,
      maxSteps: 3,
    });
    let seen = 0;
    for await (const _chunk of result.fullStream)
      if (++seen === options.stopAfterChunks) stop.abort();
    if (options.abortAfterDone) {
      // A client that disconnects after the turn completed.
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop.abort('Client disconnected');
    }
  } catch {
    // A stream that fails before content rejects; its hook still ran.
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { store, afterInvocation, stats: () => metadata.stats as any };
}

describe('VoltAgent turn counting (#5390)', () => {
  test('a stream that failed with nothing reported is not counted', async () => {
    const turn = await runTurn(
      scripted([
        [...partialText, { type: 'error', error: new Error('scripted_error') }],
      ]),
    );
    expect(turn.store.updateConversation).not.toHaveBeenCalled();
    expect(turn.stats()).toBeUndefined();
  });

  test('a stream that failed after reporting usage counts, with its tokens', async () => {
    const turn = await runTurn(
      scripted([[...answer, finish('error', usage(7, 3))]]),
    );
    expect(turn.stats()).toMatchObject({
      turns: 1,
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  test('an answered turn with no usage counts once, with no token counts', async () => {
    const turn = await runTurn(
      scripted([[...answer, finish('stop', usage())]]),
    );
    expect(turn.stats()).toMatchObject({ turns: 1, toolCalls: 0 });
    expect(turn.stats()).not.toHaveProperty('inputTokens');
  });

  test('an abort that arrives after the turn completed changes nothing', async () => {
    const turn = await runTurn(
      scripted([[...answer, finish('stop', usage(5, 2))]]),
      { abortAfterDone: true },
    );
    expect(turn.afterInvocation).toHaveBeenCalledTimes(1);
    expect(turn.stats()).toMatchObject({
      turns: 1,
      inputTokens: 5,
      outputTokens: 2,
    });
  });

  test("a person's Stop mid-stream records nothing", async () => {
    const turn = await runTurn(
      scripted(
        [
          [
            ...partialText,
            { type: 'text-delta', id: 't', delta: ' more' },
            { type: 'text-end', id: 't' },
            finish('stop', usage(5, 2)),
          ],
        ],
        100,
      ),
      { stopAfterChunks: 3 },
    );
    expect(turn.store.updateConversation).not.toHaveBeenCalled();
    expect(turn.stats()).toBeUndefined();
  });
});

describe('VoltAgent turn usage across model steps (#5390)', () => {
  test('a turn of three tool steps records every step, not only the last', async () => {
    const turn = await runTurn(
      scripted([[toolCall, finish('tool-calls', usage(3, 1))]]),
    );
    expect(turn.stats()).toMatchObject({
      turns: 1,
      toolCalls: 3,
      inputTokens: 9,
      outputTokens: 3,
    });
  });

  test('a single-step turn records that step, as before', async () => {
    const turn = await runTurn(
      scripted([[...answer, finish('stop', usage(5, 2))]]),
    );
    expect(turn.stats()).toMatchObject({
      turns: 1,
      inputTokens: 5,
      outputTokens: 2,
    });
  });

  test('a turn that failed after a successful tool step keeps that step', async () => {
    const turn = await runTurn(
      scripted([
        [toolCall, finish('tool-calls', usage(3, 1))],
        [...partialText, { type: 'error', error: new Error('scripted_error') }],
      ]),
    );
    expect(turn.stats()).toMatchObject({
      turns: 1,
      toolCalls: 1,
      inputTokens: 3,
      outputTokens: 1,
    });
  });

  test('a tool that fails and then an answer is one turn', async () => {
    const turn = await runTurn(
      scripted([
        [toolCall, finish('tool-calls', usage())],
        [...answer, finish('stop', usage())],
      ]),
      { toolThrows: true },
    );
    expect(turn.afterInvocation).toHaveBeenCalledTimes(1);
    expect(turn.stats()).toMatchObject({ turns: 1, toolCalls: 1 });
  });
});
