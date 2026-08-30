import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  chatDuration: { record: vi.fn() },
  chatRequests: { add: vi.fn() },
  costEstimated: { add: vi.fn() },
  tokensInput: { add: vi.fn() },
  tokensOutput: { add: vi.fn() },
}));

// archive#1566: the title-generation model call itself is covered by
// chat-title-generation.test.ts — these tests only need to control what it
// returns to exercise the hook's write/skip decisions.
const generateConversationTitle = vi.fn();
vi.mock('../chat-title-generation.js', () => ({
  generateConversationTitle: (...args: unknown[]) =>
    generateConversationTitle(...args),
}));

vi.mock('../../../utils/pricing.js', () => ({
  estimateCost: vi.fn(() => 1.25),
  findModelPricing: vi.fn(async () => ({
    inputCostPer1k: 1,
    outputCostPer1k: 2,
  })),
}));

// Only the temp-agent write is stubbed; `persistUserTurnIfMissing` stays real
// so the failed-turn assertions below exercise what actually lands in
// storage, in order.
vi.mock('../chat-persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../chat-persistence.js')>()),
}));

import { tokensInput, tokensOutput } from '../../../telemetry/metrics.js';
import { estimateCost, findModelPricing } from '../../../utils/pricing.js';
import {
  emitChatAgentStart,
  ensureChatAgentStatsInitialized,
  finalizeChatRequest,
} from '../chat-lifecycle.js';

function createRuntimeContext() {
  return {
    monitoringEmitter: {
      emitAgentStart: vi.fn(),
      emitAgentComplete: vi.fn(),
    },
    memoryAdapters: new Map(),
    agentStats: new Map(),
    agentStatus: new Map(),
    agentSpecs: new Map([
      [
        'agent-a',
        {
          model: 'model-a',
          guardrails: { maxSteps: 7 },
        },
      ],
    ]),
    modelCatalog: {},
    appConfig: { invokeModel: 'fallback-model', region: 'us-east-1' },
    metricsLog: [],
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

describe('chat-lifecycle helpers', () => {
  test('emits agent start payload', () => {
    const ctx = createRuntimeContext();

    emitChatAgentStart({
      ctx,
      slug: 'agent-a',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      input: 'hello',
    });

    // The Station-engine start span now names its engine (archive#3074): before,
    // it carried neither provider nor model, which is why a tool event could
    // not be joined back to an engine at all.
    expect(ctx.monitoringEmitter.emitAgentStart).toHaveBeenCalledWith({
      slug: 'agent-a',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      input: 'hello',
      provider: 'station',
      model: undefined,
    });
  });

  test('carries the resolved model onto the start span (#3074)', () => {
    // The other half of the wiring had no assertion anywhere: the only
    // exercised call site never supplied a model, so a regression that
    // dropped it would have gone unnoticed.
    const ctx = createRuntimeContext();

    emitChatAgentStart({
      ctx,
      slug: 'agent-a',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      input: 'hello',
      model: 'claude-sonnet-5',
    });

    expect(ctx.monitoringEmitter.emitAgentStart).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'station',
        model: 'claude-sonnet-5',
      }),
    );
  });

  test('initializes agent stats from memory adapter conversation history', async () => {
    const ctx = createRuntimeContext();
    ctx.memoryAdapters.set('agent-a', {
      getConversations: vi.fn(async () => [
        { id: 'c1', userId: 'u1' },
        { id: 'c2', userId: 'u2' },
      ]),
      getMessages: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }])
        .mockResolvedValueOnce([{ id: 'm3' }]),
    });

    await ensureChatAgentStatsInitialized({ ctx, slug: 'agent-a' });

    expect(ctx.agentStats.get('agent-a')).toEqual({
      conversationCount: 2,
      messageCount: 3,
      lastUpdated: expect.any(Number),
    });
  });

  test('finalizes chat completion, stats, monitoring, and metrics', async () => {
    const ctx = createRuntimeContext();
    ctx.agentStatus.set('agent-a', 'running');
    ctx.agentStats.set('agent-a', {
      conversationCount: 1,
      messageCount: 10,
      lastUpdated: 0,
    });

    const artifacts: Array<{ type: string; content?: unknown }> = [];
    const chatSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };

    await finalizeChatRequest({
      ctx,
      slug: 'agent-a',
      plugin: 'plugin-a',
      input: 'hello',
      operationContext: {
        userId: 'user-1',
        conversationId: 'conversation-1',
        traceId: 'trace-1',
      },
      completionReason: 'completed',
      accumulatedText: 'Answer',
      reasoningText: '',
      artifacts,
      result: {
        usage: Promise.resolve({
          promptTokens: 11,
          completionTokens: 22,
          cacheReadTokens: 33,
          cacheWriteTokens: 44,
        }),
      },
      modelOverride: 'override-model',
      memoryAdapter: null,
      conversationId: 'conversation-1',
      isNewConversation: true,
      chatStartMs: Date.now() - 50,
      chatSpan,
    });

    expect(ctx.agentStatus.get('agent-a')).toBe('idle');
    expect(artifacts).toEqual([{ type: 'text', content: 'Answer' }]);
    expect(ctx.monitoringEmitter.emitAgentComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'agent-a',
        conversationId: 'conversation-1',
        reason: 'completed',
        outputChars: 6,
      }),
    );
    expect(ctx.agentStats.get('agent-a')).toEqual({
      conversationCount: 2,
      messageCount: 12,
      lastUpdated: expect.any(Number),
    });
    expect(ctx.metricsLog).toEqual([
      expect.objectContaining({
        agentSlug: 'agent-a',
        event: 'completion',
        conversationId: 'conversation-1',
        messageCount: 2,
        cost: 1.25,
      }),
    ]);
    expect(estimateCost).toHaveBeenLastCalledWith(expect.anything(), {
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
    });
    expect(chatSpan.end).toHaveBeenCalled();
  });

  test('omits metrics cost when pricing lookup fails', async () => {
    vi.mocked(findModelPricing).mockRejectedValueOnce(
      new Error('pricing unavailable'),
    );
    const ctx = createRuntimeContext();
    const chatSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };

    await finalizeChatRequest({
      ctx,
      slug: 'agent-a',
      plugin: 'plugin-a',
      input: 'hello',
      operationContext: {
        userId: 'user-1',
        conversationId: 'conversation-1',
        traceId: 'trace-1',
      },
      completionReason: 'completed',
      accumulatedText: 'Answer',
      reasoningText: '',
      artifacts: [],
      result: {
        usage: Promise.resolve({ promptTokens: 11, completionTokens: 22 }),
      },
      memoryAdapter: null,
      conversationId: 'conversation-1',
      isNewConversation: false,
      chatStartMs: Date.now(),
      chatSpan,
    });

    expect(ctx.metricsLog).toHaveLength(1);
    expect(ctx.metricsLog[0]).not.toHaveProperty('cost');
  });

  test('does not manufacture input usage when only output tokens were reported', async () => {
    vi.mocked(tokensInput.add).mockClear();
    vi.mocked(tokensOutput.add).mockClear();
    const ctx = createRuntimeContext();
    const chatSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };

    await finalizeChatRequest({
      ctx,
      slug: 'agent-a',
      plugin: 'plugin-a',
      input: 'hello',
      operationContext: {
        userId: 'user-1',
        conversationId: 'conversation-1',
        traceId: 'trace-1',
      },
      completionReason: 'completed',
      accumulatedText: 'Answer',
      reasoningText: '',
      artifacts: [],
      result: { usage: Promise.resolve({ completionTokens: 7 }) },
      memoryAdapter: null,
      conversationId: 'conversation-1',
      isNewConversation: false,
      chatStartMs: Date.now(),
      chatSpan,
    });

    expect(ctx.monitoringEmitter.emitAgentComplete).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { outputTokens: 7 } }),
    );
    expect(tokensInput.add).not.toHaveBeenCalled();
    expect(tokensOutput.add).toHaveBeenCalledWith(7, {
      agent: 'agent-a',
      plugin: 'plugin-a',
    });
    expect(chatSpan.setAttribute).not.toHaveBeenCalledWith(
      'station.tokens.input',
      expect.anything(),
    );
    expect(chatSpan.setAttribute).toHaveBeenCalledWith(
      'station.tokens.output',
      7,
    );
  });

  // archive#191 R2 persistence-gap fix: a failed turn that produced zero output
  // otherwise persisted nothing at all, so a translated error a user saw
  // live silently vanished on reload.
  describe('failed-turn marker persistence (#191 R2)', () => {
    function chatSpanStub() {
      return { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    }

    test('a zero-output failure persists the user turn, then the [SYSTEM_EVENT][CHAT_ERROR] marker (#797)', async () => {
      const ctx = createRuntimeContext();
      const addMessage = vi.fn(
        async (
          _msg: any,
          _userId: string,
          _conversationId: string,
          _metadata?: any,
        ) => undefined,
      );

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'completed',
        accumulatedText: '',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: { addMessage },
        conversationId: 'conversation-1',
        isNewConversation: false,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
        turnFailureText: 'AccessDeniedException: boom',
      });

      expect(addMessage).toHaveBeenCalledTimes(2);

      // archive#797: the user's own message has to land first, or the transcript
      // shows a failure with nothing the user actually sent.
      const [userTurn, userTurnUserId, userTurnConversationId] =
        addMessage.mock.calls[0];
      expect(userTurnUserId).toBe('user-1');
      expect(userTurnConversationId).toBe('conversation-1');
      expect(userTurn.role).toBe('user');
      expect(userTurn.parts[0].text).toBe('hello');

      const [message, userId, conversationId] = addMessage.mock.calls[1];
      expect(userId).toBe('user-1');
      expect(conversationId).toBe('conversation-1');
      expect(message.role).toBe('user');
      expect(message.parts[0].text).toBe(
        '[SYSTEM_EVENT] [CHAT_ERROR] AccessDeniedException: boom',
      );
    });

    test('an aborted turn whose user message already persisted is not duplicated (#797)', async () => {
      const ctx = createRuntimeContext();
      const addMessage = vi.fn(
        async (
          _msg: any,
          _userId: string,
          _conversationId: string,
          _metadata?: any,
        ) => undefined,
      );
      const getMessages = vi.fn(
        async (_userId: string, _conversationId: string) => [
          { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        ],
      );

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'aborted',
        accumulatedText: '',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: { addMessage, getMessages },
        conversationId: 'conversation-1',
        isNewConversation: false,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
        turnFailureText: 'Stream aborted by client',
      });

      // Assert the dedup check actually ran, not merely that one write
      // happened — a deleted recovery call would also leave exactly the
      // marker (archive#797 review).
      expect(getMessages).toHaveBeenCalledWith('user-1', 'conversation-1');
      expect(addMessage).toHaveBeenCalledTimes(1);
      expect(addMessage.mock.calls[0][0].parts[0].text).toBe(
        '[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client',
      );
    });

    test('a cancelled turn with no failure text still recovers the user turn (#797 review)', async () => {
      const ctx = createRuntimeContext();
      const addMessage = vi.fn(
        async (
          _msg: any,
          _userId: string,
          _conversationId: string,
          _metadata?: any,
        ) => undefined,
      );
      const getMessages = vi.fn(
        async (_userId: string, _conversationId: string) => [],
      );

      // `chat-primary-stream.ts`'s graceful-cancellation branch persists an
      // assistant "cancelled" message and never reaches the outer catch, so
      // no `turnFailureText` is produced — the user's own message would
      // otherwise still be lost.
      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'aborted',
        accumulatedText: '',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: { addMessage, getMessages },
        conversationId: 'conversation-1',
        isNewConversation: false,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
      });

      expect(addMessage).toHaveBeenCalledTimes(1);
      expect(addMessage.mock.calls[0][0].role).toBe('user');
      expect(addMessage.mock.calls[0][0].parts[0].text).toBe('hello');
    });

    test('a successful turn (non-empty accumulatedText) persists no marker', async () => {
      const ctx = createRuntimeContext();
      const addMessage = vi.fn(
        async (
          _msg: any,
          _userId: string,
          _conversationId: string,
          _metadata?: any,
        ) => undefined,
      );

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'completed',
        accumulatedText: 'A real answer',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: { addMessage },
        conversationId: 'conversation-1',
        isNewConversation: false,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
        turnFailureText: undefined,
      });

      expect(addMessage).not.toHaveBeenCalled();
    });

    test('a zero-output turn with no turnFailureText (e.g. a user-cancelled turn) persists no marker', async () => {
      const ctx = createRuntimeContext();
      const addMessage = vi.fn(
        async (
          _msg: any,
          _userId: string,
          _conversationId: string,
          _metadata?: any,
        ) => undefined,
      );

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'aborted',
        accumulatedText: '',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: { addMessage },
        conversationId: 'conversation-1',
        isNewConversation: false,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
      });

      // No marker — but the user's own message is still recovered, because
      // this graceful-cancellation path loses it too (archive#797 review).
      expect(
        addMessage.mock.calls.filter((call) =>
          String(call[0]?.parts?.[0]?.text ?? '').includes('[CHAT_ERROR]'),
        ),
      ).toHaveLength(0);
      expect(addMessage).toHaveBeenCalledTimes(1);
      expect(addMessage.mock.calls[0][0].parts[0].text).toBe('hello');
    });

    test('a zero-output failure without a resolved userId persists no marker (defensive no-op, not a throw)', async () => {
      const ctx = createRuntimeContext();
      const addMessage = vi.fn(
        async (
          _msg: any,
          _userId: string,
          _conversationId: string,
          _metadata?: any,
        ) => undefined,
      );

      await expect(
        finalizeChatRequest({
          ctx,
          slug: 'agent-a',
          plugin: 'plugin-a',
          input: 'hello',
          operationContext: {
            conversationId: 'conversation-1',
            traceId: 'trace-1',
          },
          completionReason: 'completed',
          accumulatedText: '',
          reasoningText: '',
          artifacts: [],
          result: { usage: Promise.resolve({}) },
          memoryAdapter: { addMessage },
          conversationId: 'conversation-1',
          isNewConversation: false,
          chatStartMs: Date.now(),
          chatSpan: chatSpanStub(),
          turnFailureText: 'boom',
        }),
      ).resolves.toBeUndefined();

      expect(addMessage).not.toHaveBeenCalled();
    });

    // archive#1293 review (HIGH-1), verifier-reproduced: chat-lifecycle
    // persists the user text via persistUserTurnIfMissing, then
    // unconditionally appends the [CHAT_ERROR] marker, on EVERY zero-output
    // failed turn. Two back-to-back failed turns with identical text used
    // to have turn 2's recovery scan walk past turn 1's marker row (stored
    // with role 'user'), find turn 1's identical text, and conclude
    // "already persisted" — silently dropping turn 2's own message. This
    // exercises the real call sequence (finalizeChatRequest, twice, against
    // one shared stateful memoryAdapter) and asserts BOTH user messages
    // land in the durable transcript.
    test('two consecutive identical-text failed turns both persist their own user message (station#1293 HIGH-1)', async () => {
      const stored: Array<{ role: string; parts: Array<{ text: string }> }> =
        [];
      const addMessage = vi.fn(async (msg: any) => {
        stored.push(msg);
      });
      const getMessages = vi.fn(async () => [...stored]);

      const runFailedTurn = () =>
        finalizeChatRequest({
          ctx: createRuntimeContext(),
          slug: 'agent-a',
          plugin: 'plugin-a',
          input: 'retry this',
          operationContext: {
            userId: 'user-1',
            conversationId: 'conversation-1',
            traceId: 'trace-1',
          },
          completionReason: 'errored',
          accumulatedText: '',
          reasoningText: '',
          artifacts: [],
          result: { usage: Promise.resolve({}) },
          memoryAdapter: { addMessage, getMessages },
          conversationId: 'conversation-1',
          isNewConversation: false,
          chatStartMs: Date.now(),
          chatSpan: chatSpanStub(),
          turnFailureText: 'transient failure',
        });

      await runFailedTurn();
      await runFailedTurn();

      const userTextRows = stored.filter(
        (message) =>
          message.role === 'user' &&
          !message.parts[0].text.startsWith('[SYSTEM_EVENT]'),
      );
      expect(userTextRows).toHaveLength(2);
      expect(userTextRows[0].parts[0].text).toBe('retry this');
      expect(userTextRows[1].parts[0].text).toBe('retry this');

      const markerRows = stored.filter((message) =>
        message.parts[0].text.startsWith('[SYSTEM_EVENT] [CHAT_ERROR]'),
      );
      expect(markerRows).toHaveLength(2);
    });

    test('a memoryAdapter.addMessage failure is logged, not thrown', async () => {
      const ctx = createRuntimeContext();
      const addMessage = vi.fn(async () => {
        throw new Error('disk full');
      });

      await expect(
        finalizeChatRequest({
          ctx,
          slug: 'agent-a',
          plugin: 'plugin-a',
          input: 'hello',
          operationContext: {
            userId: 'user-1',
            conversationId: 'conversation-1',
            traceId: 'trace-1',
          },
          completionReason: 'completed',
          accumulatedText: '',
          reasoningText: '',
          artifacts: [],
          result: { usage: Promise.resolve({}) },
          memoryAdapter: { addMessage },
          conversationId: 'conversation-1',
          isNewConversation: false,
          chatStartMs: Date.now(),
          chatSpan: chatSpanStub(),
          turnFailureText: 'boom',
        }),
      ).resolves.toBeUndefined();

      expect(ctx.logger.error).toHaveBeenCalledWith(
        'Failed to persist failed-turn marker message',
        expect.objectContaining({ error: expect.any(Error) }),
      );
    });
  });

  // archive#1566: fire-and-forget auto-title generation, hooked off the
  // first turn of a brand-new conversation.
  describe('auto title generation (station#1566)', () => {
    function chatSpanStub() {
      return { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    }

    /**
     * A minimal stand-in for `FileMemoryAdapter`'s real (queue-serialized)
     * `updateConversation`: reads the current record from an in-memory
     * store, runs the updater against it, and only writes if the updater
     * returns a non-null patch. Good enough to exercise
     * `generateAndPersistAutoTitle`'s decision logic without needing the
     * real adapter's disk I/O — the queue-serialization guarantee itself is
     * covered at the adapter level
     * (`memory-adapter-conversation-update.test.ts`).
     */
    function createFakeConversationStorage(initial: Record<string, any>) {
      const store = new Map(Object.entries(initial));
      const updateConversation = vi.fn(
        async (id: string, updater: (current: any) => any) => {
          const current = store.get(id);
          if (!current) {
            throw new Error(`Conversation ${id} not found`);
          }
          const patch = updater(current);
          if (!patch) {
            return current;
          }
          const updated = { ...current, ...patch };
          store.set(id, updated);
          return updated;
        },
      );
      return { store, updateConversation };
    }

    test('writes the generated title with titleSource "auto" for a new conversation with output', async () => {
      generateConversationTitle.mockReset();
      generateConversationTitle.mockResolvedValue('A generated title');
      const ctx = createRuntimeContext();
      const { store, updateConversation } = createFakeConversationStorage({
        'conversation-1': {
          id: 'conversation-1',
          title: 'the first fifty characters of the prompt',
          metadata: { projectSlug: 'proj' },
        },
      });

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello there',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'completed',
        accumulatedText: 'A real answer',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: null,
        conversationStorage: { updateConversation },
        conversationId: 'conversation-1',
        isNewConversation: true,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
      });

      await vi.waitFor(() => expect(updateConversation).toHaveBeenCalled());

      expect(generateConversationTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx,
          firstUserText: 'hello there',
          assistantText: 'A real answer',
        }),
      );
      expect(store.get('conversation-1')).toMatchObject({
        title: 'A generated title',
        metadata: { projectSlug: 'proj', titleSource: 'auto' },
      });
    });

    test('does not write when the conversation already has titleSource "user" (a human rename wins)', async () => {
      generateConversationTitle.mockReset();
      generateConversationTitle.mockResolvedValue('A generated title');
      const ctx = createRuntimeContext();
      const { store, updateConversation } = createFakeConversationStorage({
        'conversation-1': {
          id: 'conversation-1',
          title: 'My Renamed Chat',
          metadata: { titleSource: 'user' },
        },
      });

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello there',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'completed',
        accumulatedText: 'A real answer',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: null,
        conversationStorage: { updateConversation },
        conversationId: 'conversation-1',
        isNewConversation: true,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
      });

      await vi.waitFor(() => expect(updateConversation).toHaveBeenCalled());

      // The updater ran (it's how the decision itself is made) but must have
      // returned null — the stored record is untouched.
      expect(store.get('conversation-1')).toEqual({
        id: 'conversation-1',
        title: 'My Renamed Chat',
        metadata: { titleSource: 'user' },
      });
    });

    test('does not overwrite a provider-reported title with an asynchronous generated title', async () => {
      generateConversationTitle.mockReset();
      generateConversationTitle.mockResolvedValue('A generated title');
      const ctx = createRuntimeContext();
      const { store, updateConversation } = createFakeConversationStorage({
        'conversation-1': {
          id: 'conversation-1',
          title: 'Provider reported title',
          metadata: { titleSource: 'provider' },
        },
      });

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello there',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'completed',
        accumulatedText: 'A real answer',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: null,
        conversationStorage: { updateConversation },
        conversationId: 'conversation-1',
        isNewConversation: true,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
      });

      await vi.waitFor(() => expect(updateConversation).toHaveBeenCalled());
      expect(store.get('conversation-1')).toEqual({
        id: 'conversation-1',
        title: 'Provider reported title',
        metadata: { titleSource: 'provider' },
      });
    });

    // archive#1566 review (HIGH, TOCTOU): the original shape read the
    // conversation, decided, and only THEN wrote a static object — a rename
    // landing in that gap got silently clobbered. The fix moves the decision
    // inside the updater callback, which the (real, adapter-level) queue
    // guarantees always runs against the LATEST committed state. This test
    // reproduces the reviewer's exact scenario at this layer: the rename
    // lands WHILE the title-generation model call is still in flight (the
    // only real async gap in this function), immediately before
    // `updateConversation` is even invoked — proving the user's rename
    // survives regardless of how that race lands.
    test('a user rename that lands while title generation is in flight always wins (station#1566 review HIGH — TOCTOU regression)', async () => {
      const { store, updateConversation } = createFakeConversationStorage({
        'conversation-1': {
          id: 'conversation-1',
          title: 'the first fifty characters of the prompt',
          metadata: {},
        },
      });

      generateConversationTitle.mockReset();
      generateConversationTitle.mockImplementation(async () => {
        // Simulates the PATCH route's own (separately queued) rename
        // committing WHILE this call's model round trip is still pending —
        // the exact interleaving the review flagged. Nothing in
        // `generateAndPersistAutoTitle` reads the conversation before this
        // resolves, so there is no stale snapshot to be caught out by.
        store.set('conversation-1', {
          id: 'conversation-1',
          title: 'User Renamed Chat',
          metadata: { titleSource: 'user' },
        });
        return 'A generated title';
      });

      const ctx = createRuntimeContext();

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello there',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'completed',
        accumulatedText: 'A real answer',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: null,
        conversationStorage: { updateConversation },
        conversationId: 'conversation-1',
        isNewConversation: true,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
      });

      await vi.waitFor(() => expect(updateConversation).toHaveBeenCalled());

      expect(store.get('conversation-1')).toEqual({
        id: 'conversation-1',
        title: 'User Renamed Chat',
        metadata: { titleSource: 'user' },
      });
    });

    test('does not write when generation returns null (initial truncated title stands)', async () => {
      generateConversationTitle.mockReset();
      generateConversationTitle.mockResolvedValue(null);
      const ctx = createRuntimeContext();
      const { store, updateConversation } = createFakeConversationStorage({
        'conversation-1': {
          id: 'conversation-1',
          title: 'the first fifty characters of the prompt',
        },
      });

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello there',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'completed',
        accumulatedText: 'A real answer',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: null,
        conversationStorage: { updateConversation },
        conversationId: 'conversation-1',
        isNewConversation: true,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
      });

      await vi.waitFor(() =>
        expect(generateConversationTitle).toHaveBeenCalled(),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(updateConversation).not.toHaveBeenCalled();
      expect(store.get('conversation-1')).toEqual({
        id: 'conversation-1',
        title: 'the first fifty characters of the prompt',
      });
    });

    test('does not fire for an existing (non-new) conversation', async () => {
      generateConversationTitle.mockReset();
      generateConversationTitle.mockResolvedValue('A generated title');
      const ctx = createRuntimeContext();
      const { updateConversation } = createFakeConversationStorage({
        'conversation-1': { id: 'conversation-1' },
      });

      await finalizeChatRequest({
        ctx,
        slug: 'agent-a',
        plugin: 'plugin-a',
        input: 'hello there',
        operationContext: {
          userId: 'user-1',
          conversationId: 'conversation-1',
          traceId: 'trace-1',
        },
        completionReason: 'completed',
        accumulatedText: 'A real answer',
        reasoningText: '',
        artifacts: [],
        result: { usage: Promise.resolve({}) },
        memoryAdapter: null,
        conversationStorage: { updateConversation },
        conversationId: 'conversation-1',
        isNewConversation: false,
        chatStartMs: Date.now(),
        chatSpan: chatSpanStub(),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(generateConversationTitle).not.toHaveBeenCalled();
      expect(updateConversation).not.toHaveBeenCalled();
    });
  });
});
