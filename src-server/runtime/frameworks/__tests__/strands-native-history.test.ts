import {
  Agent,
  type BaseModelConfig,
  Message,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import type { StorageAdapter } from '@voltagent/core';
import type { UIMessage } from 'ai';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { captureNativeMemoryContinuity } from '../../../services/orchestration/native-memory-continuity.js';
import { runWithAuthorizedTurnCorrelation } from '../../conversation/authorized-turn-correlation.js';
import { createNativeMemoryHistoryCompanion } from '../../conversation/native-memory-history.js';
import type { InvocationContext, IStreamResult } from '../../types.js';
import { StrandsFramework } from '../strands-adapter.js';
import {
  bindStrandsNativeHistory,
  mapStrandsContentBlocksToParts,
  nativeHistoryToStrands,
  syncStrandsMessagesToMemory,
} from '../strands-message-sync.js';

class FixtureModel extends Model {
  readonly inputs: unknown[] = [];
  readonly states: Array<{ token: string; previous: unknown }> = [];
  private started = 0;
  private release!: () => void;
  private entered!: () => void;
  readonly bothEntered = new Promise<void>((resolve) => {
    this.entered = resolve;
  });
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  constructor(
    private readonly gated = false,
    private readonly tool = false,
  ) {
    super();
  }
  open() {
    this.release();
  }
  updateConfig(_config: BaseModelConfig): void {}
  getConfig(): BaseModelConfig {
    return { modelId: 'fixture-native-history' };
  }
  async *stream(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.inputs.push(messages.map((message) => message.toJSON()));
    if (this.gated) {
      const token = JSON.stringify(messages).includes('PRIVATE-A')
        ? 'PRIVATE-A'
        : 'PRIVATE-B';
      const previous = options?.modelState?.get('native-fixture-owner');
      this.states.push({ token, previous });
      if (previous !== undefined && previous !== token)
        throw new Error('Fixture observed cross-conversation model state');
      options?.modelState?.set('native-fixture-owner', token);
    }
    if (this.inputs.length > 8)
      throw new Error('Fixture exceeded its bounded model-call contract');
    const afterTool = messages
      .at(-1)
      ?.content.some(
        (block) =>
          block.type === 'toolResultBlock' && block.toolUseId === 'same-call',
      );
    const cycle = afterTool ? 2 : 1;
    if (cycle === 1 && this.gated) {
      if (++this.started === 2) this.entered();
      await this.gate;
    }
    yield new ModelMessageStartEvent({
      type: 'modelMessageStartEvent',
      role: 'assistant',
    });
    if (this.tool && cycle === 1) {
      yield new ModelContentBlockStartEvent({
        type: 'modelContentBlockStartEvent',
        start: {
          type: 'toolUseStart',
          toolUseId: 'same-call',
          name: 'observe',
        },
      });
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{}' },
      });
      yield new ModelContentBlockStopEvent({
        type: 'modelContentBlockStopEvent',
      });
      yield new ModelMessageStopEvent({
        type: 'modelMessageStopEvent',
        stopReason: 'toolUse',
      });
    } else {
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Native response.' },
      });
      yield new ModelContentBlockStopEvent({
        type: 'modelContentBlockStopEvent',
      });
      yield new ModelMessageStopEvent({
        type: 'modelMessageStopEvent',
        stopReason: 'endTurn',
      });
    }
  }
}

async function fixture() {
  const messages = new Map<string, UIMessage[]>();
  const users = new Map<string, string>();
  const writes: Array<{ id: string; user: string; message: UIMessage }> = [];
  const adapter = {
    getConversation: async (id: string) =>
      users.has(id)
        ? { id, resourceId: 'agent-a', userId: users.get(id) }
        : null,
    getMessages: async (_user: string, id: string) => messages.get(id) ?? [],
    addMessage: async (message: UIMessage, user: string, id: string) => {
      writes.push({ id, user, message });
      messages.set(id, [...(messages.get(id) ?? []), message]);
    },
  } as unknown as StorageAdapter;
  const companion = async (id: string, user: string, token: string) => {
    const prior = `prior-${id}`;
    users.set(prior, user);
    users.set(id, user);
    messages.set(prior, [
      {
        id: `${prior}-message`,
        role: 'user',
        parts: [{ type: 'text', text: token }],
      },
    ]);
    messages.set(id, []);
    const scope = {
      provider: 'station-agent' as const,
      agentId: 'agent-a',
      userId: user,
    };
    const rows = [
      { conversationId: id, sessionId: prior, ordinal: 0, createdAt: 'first' },
      {
        conversationId: id,
        sessionId: id,
        ordinal: 1,
        predecessorSessionId: prior,
        createdAt: 'second',
      },
    ];
    let current = true;
    const binding = await captureNativeMemoryContinuity(
      { currentSessionId: id, scope },
      {
        conversationForSession: (key) =>
          rows.find((row) => row.sessionId === key),
        conversationSessions: () => rows,
        contextBoundaryForSuccessor: () => undefined,
        readSession: async (key) => ({ sessionId: key, ...scope }),
        isAuthorityCurrent: () => current,
      },
    );
    return {
      history: createNativeMemoryHistoryCompanion({
        binding,
        readCanonicalSession: async () => [],
      }),
      revoke: () => {
        current = false;
      },
    };
  };
  return { adapter, messages, users, writes, companion };
}
async function consume(result: IStreamResult) {
  for await (const _ of result.fullStream) {
    /* actual SDK stream */
  }
  return result.text;
}
function correlated<T>(
  sessionId: string,
  run: () => T,
  history: Awaited<
    ReturnType<Awaited<ReturnType<typeof fixture>>['companion']>
  >['history'],
) {
  return runWithAuthorizedTurnCorrelation(
    {
      accountId: 'account',
      sessionId,
      turnId: `turn-${sessionId}`,
      correlationId: `correlation-${sessionId}`,
    },
    run,
    history,
  );
}

test('actual SDK isolates concurrent native conversations, approvals, model state and current-child writes', async () => {
  const f = await fixture();
  const a = await f.companion('child-a', 'user-a', 'PRIVATE-A');
  const b = await f.companion('child-b', 'user-b', 'PRIVATE-B');
  const model = new FixtureModel(true, true);
  const seen: InvocationContext[] = [];
  const execute = vi.fn(async () => ({ ok: true }));
  const agent = await new StrandsFramework().createTempAgent({
    name: 'display-only',
    agentId: 'agent-a',
    instructions: 'Respond.',
    model,
    memoryAdapter: f.adapter,
    tools: [
      {
        name: 'observe',
        description: 'Observe.',
        parameters: z.object({}),
        execute,
      },
    ],
    hooks: {
      beforeToolCall: async (_call, invocation) => {
        seen.push(invocation);
        return invocation.conversationId === 'child-b';
      },
    },
  });
  const first = await correlated(
    'child-a',
    () =>
      agent.streamText('turn-a', {
        conversationId: 'child-a',
        userId: 'user-a',
      }),
    a.history,
  );
  const second = await correlated(
    'child-b',
    () =>
      agent.streamText('turn-b', {
        conversationId: 'child-b',
        userId: 'user-b',
      }),
    b.history,
  );
  const completed = Promise.all([consume(first), consume(second)]);
  try {
    await Promise.race([model.bothEntered, completed]);
  } finally {
    model.open();
  }
  await completed;
  expect(JSON.stringify(model.inputs[0])).toContain('PRIVATE-A');
  expect(JSON.stringify(model.inputs[0])).not.toContain('PRIVATE-B');
  expect(JSON.stringify(model.inputs[1])).toContain('PRIVATE-B');
  expect(JSON.stringify(model.inputs[1])).not.toContain('PRIVATE-A');
  expect(
    seen
      .map((entry) => [entry.agentSlug, entry.conversationId, entry.userId])
      .sort(),
  ).toEqual([
    ['display-only', 'child-a', 'user-a'],
    ['display-only', 'child-b', 'user-b'],
  ]);
  expect(
    seen
      .map((entry) => [entry.sessionId, entry.turnId, entry.principalId])
      .sort(),
  ).toEqual([
    ['child-a', 'turn-child-a', 'account'],
    ['child-b', 'turn-child-b', 'account'],
  ]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(model.states.filter((entry) => entry.previous !== undefined)).toEqual(
    expect.arrayContaining([
      { token: 'PRIVATE-A', previous: 'PRIVATE-A' },
      { token: 'PRIVATE-B', previous: 'PRIVATE-B' },
    ]),
  );
  expect(
    f.writes.every((entry) => entry.id === 'child-a' || entry.id === 'child-b'),
  ).toBe(true);
  expect(JSON.stringify(f.writes)).not.toContain('PRIVATE-A');
  expect(JSON.stringify(f.writes)).not.toContain('PRIVATE-B');
  expect(
    f.writes
      .filter((entry) => entry.id === 'child-a')
      .every((entry) => entry.user === 'user-a'),
  ).toBe(true);
  expect(f.writes.some((entry) => entry.message.role === 'assistant')).toBe(
    true,
  );
});

test('SDK constructors retain structured tool and attachment history; inherited SDK identities are never copied into child', async () => {
  const history = nativeHistoryToStrands([
    {
      id: 'u',
      role: 'user',
      parts: [
        { type: 'text', text: 'Earlier.' },
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'data:image/png;base64,AQID',
        },
        {
          type: 'file',
          mediaType: 'application/pdf',
          url: 'data:application/pdf;base64,BAUG',
          filename: 'report.pdf',
        },
      ],
    },
    {
      id: 'a',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'lookup',
          toolCallId: 'history-call',
          state: 'output-available',
          input: { key: 4 },
          output: { exact: ['result'] },
        },
      ],
    },
  ]);
  const nativeParts = mapStrandsContentBlocksToParts([
    {
      type: 'toolResultBlock',
      toolUseId: 'history-call',
      content: [{ text: 'Exact native result.' }, { json: { nested: true } }],
    },
  ]);
  const restoredResult = nativeHistoryToStrands([
    { id: 'result', role: 'user', parts: nativeParts },
  ]);
  expect(restoredResult[0].toJSON().content).toEqual([
    {
      toolResult: {
        toolUseId: 'history-call',
        status: 'success',
        content: [{ text: 'Exact native result.' }, { json: { nested: true } }],
      },
    },
  ]);
  const sdk = new Agent({ model: new FixtureModel(), messages: history });
  expect(sdk.messages[0].content.map((block) => block.type)).toEqual([
    'textBlock',
    'imageBlock',
    'documentBlock',
  ]);
  expect(JSON.stringify(sdk.messages)).toContain('history-call');
  bindStrandsNativeHistory(sdk, sdk.messages);
  const fresh = Message.fromJSON({
    role: 'assistant',
    content: [{ text: 'Only new output.' }],
  });
  // SDK context management may replace/truncate its array; retained tracking IDs still identify inherited rows.
  sdk.messages = [sdk.messages.at(-1)!, fresh];
  const addMessage = vi.fn(async () => {});
  const memory = {
    getMessages: vi.fn(async () => Array(9).fill({})),
    addMessage,
  };
  const input = {
    agent: sdk,
    agentMessages: sdk.messages,
    invocation: { agentSlug: 'a', userId: 'user', conversationId: 'child' },
    logger: { info: () => {}, error: () => {} },
    memoryAdapter: memory,
    resolvedModel: 'fixture',
  };
  await syncStrandsMessagesToMemory(input);
  await syncStrandsMessagesToMemory(input);
  expect(addMessage).toHaveBeenCalledTimes(1);
  expect(addMessage.mock.calls[0]).toMatchObject([
    { role: 'assistant', parts: [{ type: 'text', text: 'Only new output.' }] },
    'user',
    'child',
    { model: 'fixture' },
  ]);
  expect(memory.getMessages).not.toHaveBeenCalled();
});

test('title/subagent/no-conversation calls do not borrow the enclosing native history', async () => {
  const f = await fixture();
  const owned = await f.companion('child', 'user', 'PRIVATE-PARENT');
  for (const agentId of [undefined, 'other-agent']) {
    const model = new FixtureModel();
    const agent = await new StrandsFramework().createTempAgent({
      name: 'agent-a',
      agentId,
      instructions: 'Respond.',
      model,
      memoryAdapter: f.adapter,
    });
    await expect(
      correlated(
        'child',
        () =>
          agent.streamText('helper', {
            conversationId: 'child',
            userId: 'user',
          }),
        owned.history,
      ),
    ).rejects.toThrow(agentId ? 'does not belong' : 'canonical Agent identity');
    expect(JSON.stringify(model.inputs)).not.toContain('PRIVATE-PARENT');
  }
  const model = new FixtureModel();
  const agent = await new StrandsFramework().createTempAgent({
    name: 'display',
    agentId: 'agent-a',
    instructions: 'Respond.',
    model,
    memoryAdapter: f.adapter,
  });
  await correlated(
    'child',
    async () => consume(await agent.streamText('direct')),
    owned.history,
  );
  expect(JSON.stringify(model.inputs)).not.toContain('PRIVATE-PARENT');
});

test('revocation before lazy stream consumption prevents SDK execution and settles result promises', async () => {
  const f = await fixture();
  const owned = await f.companion('child', 'user', 'PRIVATE-PARENT');
  const model = new FixtureModel();
  const agent = await new StrandsFramework().createTempAgent({
    name: 'display',
    agentId: 'agent-a',
    instructions: 'Respond.',
    model,
    memoryAdapter: f.adapter,
  });
  const result = await correlated(
    'child',
    () => agent.streamText('late', { conversationId: 'child', userId: 'user' }),
    owned.history,
  );
  owned.revoke();
  await expect(consume(result)).rejects.toThrow('history changed');
  expect(model.inputs).toEqual([]);
  await expect(result.finishReason).resolves.toBe('error');
  await expect(result.usage).resolves.toBeUndefined();
});

test('direct explicit conversations use isolated current-only SDK history and persist only their own new messages', async () => {
  const f = await fixture();
  f.users.set('direct-a', 'user');
  f.users.set('direct-b', 'user');
  f.messages.set('direct-a', [
    { id: 'old-a', role: 'user', parts: [{ type: 'text', text: 'DIRECT-A' }] },
  ]);
  f.messages.set('direct-b', [
    { id: 'old-b', role: 'user', parts: [{ type: 'text', text: 'DIRECT-B' }] },
  ]);
  const model = new FixtureModel();
  const agent = await new StrandsFramework().createTempAgent({
    name: 'display',
    agentId: 'agent-a',
    instructions: 'Respond.',
    model,
    memoryAdapter: f.adapter,
  });
  await consume(
    await agent.streamText('new-a', {
      conversationId: 'direct-a',
      userId: 'user',
    }),
  );
  await consume(
    await agent.streamText('new-b', {
      conversationId: 'direct-b',
      userId: 'user',
    }),
  );
  expect(JSON.stringify(model.inputs[0])).toContain('DIRECT-A');
  expect(JSON.stringify(model.inputs[1])).toContain('DIRECT-B');
  expect(JSON.stringify(model.inputs[1])).not.toContain('DIRECT-A');
  expect(JSON.stringify(model.inputs[1])).not.toContain('new-a');
  expect(f.writes.map((entry) => entry.id)).toEqual([
    'direct-a',
    'direct-a',
    'direct-b',
    'direct-b',
  ]);
  expect(JSON.stringify(f.writes)).not.toContain('DIRECT-A');
  await expect(
    agent.streamText('foreign', {
      conversationId: 'direct-a',
      userId: 'other-user',
    }),
  ).rejects.toThrow('ownership is unavailable');
  const unowned = await new StrandsFramework().createTempAgent({
    name: 'agent-a',
    instructions: 'Respond.',
    model,
    memoryAdapter: f.adapter,
  });
  await expect(
    unowned.streamText('unowned', {
      conversationId: 'direct-a',
      userId: 'user',
    }),
  ).rejects.toThrow('canonical Agent identity');
});
