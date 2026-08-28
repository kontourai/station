/**
 * archive#1224 (offline): end-to-end proof that the direct `/chat`
 * route's dedup short-circuit (`chat-primary-stream.ts`) actually prevents a
 * second agent execution for a replayed `clientTurnId` — exercised through
 * the REAL `streamPrimaryAgentChat` (not mocked, unlike `chat.routes.test.ts`)
 * against a minimal-but-real Hono app and a real, temp-file-backed
 * `ChatTurnDedupStore`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';
import { ChatTurnDedupStore } from '../chat-turn-dedup.js';

function readSSEEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

function buildAgent(streamText: ReturnType<typeof vi.fn>) {
  return {
    getMemory: () => null,
    model: { modelId: 'test-model' },
    streamText,
  };
}

async function* emptyStream() {
  /* no chunks — the turn produces no assistant output for this test */
}

function buildCtx(options: {
  memoryAdapter: Record<string, unknown>;
  dedupStore: ChatTurnDedupStore;
}) {
  return {
    agentSpecs: new Map(),
    toolNameMapping: new Map(),
    approvalRegistry: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    agentHooksMap: new Map(),
    memoryAdapters: new Map([['assistant', options.memoryAdapter]]),
    feedbackService: { getRatings: () => [] },
    agentStatus: new Map(),
    agentStats: new Map(),
    agentTools: new Map(),
    monitoringEvents: undefined,
    monitoringEmitter: undefined,
    modelCatalog: undefined,
    metricsLog: [] as unknown[],
    providerService: {
      listProviderConnections: () => [],
      getLaunchabilityRevision: () => 0,
    },
    getAgentConfigurationRevision: () => 0,
    configLoader: { getLaunchabilityRevision: () => 0 },
    commitAgentConfigurationRead: async (
      _expectedRevision: number,
      operation: () => Promise<unknown>,
    ) => operation(),
  } as any;
}

function buildApp(ctx: any, agent: any, dedupStore: ChatTurnDedupStore) {
  const app = new Hono();
  app.post('/chat', (c) =>
    streamPrimaryAgentChat({
      c,
      ctx,
      slug: 'assistant',
      plugin: '',
      input: 'hello',
      restOptions: c.req.query('clientTurnId')
        ? { clientTurnId: c.req.query('clientTurnId') }
        : {},
      injectContext: null,
      ragContext: null,
      agent,
      configurationLease: captureRuntimeConfigurationLease(ctx)!,
      dedupStore,
    }),
  );
  return app;
}

describe('streamPrimaryAgentChat client-turn dedup (station#1224 offline slice 2)', () => {
  let dir: string;
  let dedupStore: ChatTurnDedupStore;
  let memoryAdapter: {
    getConversation: ReturnType<typeof vi.fn>;
    createConversation: ReturnType<typeof vi.fn>;
    addMessage: ReturnType<typeof vi.fn>;
    getMessages: ReturnType<typeof vi.fn>;
    getConversations: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-primary-stream-dedup-'));
    dedupStore = new ChatTurnDedupStore(join(dir, 'chat-turn-dedup.json'));
    const conversations = new Map<string, { id: string; title?: string }>();
    memoryAdapter = {
      getConversation: vi.fn(
        async (id: string) => conversations.get(id) ?? null,
      ),
      createConversation: vi.fn(async (payload: { id: string }) => {
        conversations.set(payload.id, {
          id: payload.id,
          title: 'New Conversation',
        });
      }),
      addMessage: vi.fn(async () => {}),
      getMessages: vi.fn(async () => []),
      getConversations: vi.fn(async () => []),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('two /chat requests with the SAME clientTurnId execute the agent only once', async () => {
    const streamText = vi.fn(async () => ({
      fullStream: emptyStream(),
      text: Promise.resolve(''),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve('stop'),
    }));
    const agent = buildAgent(streamText);
    const ctx = buildCtx({ memoryAdapter, dedupStore });
    const app = buildApp(ctx, agent, dedupStore);

    const first = await app.request('/chat?clientTurnId=client-turn-1', {
      method: 'POST',
    });
    const firstBody = await first.text();
    const firstEvents = readSSEEvents(firstBody);
    const firstConversationId = firstEvents.find(
      (e) => e.type === 'conversation-started',
    )?.conversationId;

    expect(streamText).toHaveBeenCalledTimes(1);
    expect(typeof firstConversationId).toBe('string');

    const second = await app.request('/chat?clientTurnId=client-turn-1', {
      method: 'POST',
    });
    const secondBody = await second.text();
    const secondEvents = readSSEEvents(secondBody);

    // The crux: no second agent execution.
    expect(streamText).toHaveBeenCalledTimes(1);
    // The deduped response hands the client back the SAME conversationId as
    // the original, already-processed turn — not a fresh/second one.
    expect(secondEvents).toEqual([
      expect.objectContaining({
        type: 'conversation-started',
        conversationId: firstConversationId,
      }),
      expect.objectContaining({ type: 'finish', finishReason: 'completed' }),
    ]);
    // No duplicate user-turn persistence from the dedup short-circuit path.
    // Exactly the ONE persist from the original (first) turn — the
    // dedup short-circuit on the second request must not add a SECOND
    // copy of the user's message.
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
  });

  test('station#1224 CRITICAL fix — the missing test: a still-running turn resolves AFTER a concurrent replay has already started polling, and the agent executes EXACTLY ONCE', async () => {
    let releaseStreamText!: (value: unknown) => void;
    const streamTextGate = new Promise((resolve) => {
      releaseStreamText = resolve;
    });
    const streamText = vi.fn(() => streamTextGate);
    const agent = buildAgent(streamText);
    const ctx = buildCtx({ memoryAdapter, dedupStore });
    const app = buildApp(ctx, agent, dedupStore);

    // Kick off the first request's body read — this is what actually
    // triggers streamPrimaryAgentChat's callback to run (Hono's stream()
    // body is lazy). It will hang on `streamTextGate` until released below,
    // simulating a turn that is still genuinely executing.
    // `app.request()` returns a plain (non-Promise) Response when its
    // handler resolves synchronously — as `streamPrimaryAgentChat` does
    // (only its background stream-writing callback is async) — so it must
    // be wrapped in `Promise.resolve()` before `.then` is safe to chain.
    const firstTextPromise = Promise.resolve(
      app.request('/chat?clientTurnId=turn-concurrent', { method: 'POST' }),
    ).then((response) => response.text());

    // Let the first request's claim land (everything up to `await
    // agent.streamText(...)` is synchronous/microtask work).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streamText).toHaveBeenCalledTimes(1);

    // A concurrent replay with the SAME clientTurnId while the first is
    // still genuinely unresolved — it must poll, never re-execute.
    const secondTextPromise = Promise.resolve(
      app.request('/chat?clientTurnId=turn-concurrent', { method: 'POST' }),
    ).then((response) => response.text());

    // Give the second request's poll loop several iterations before the
    // first genuinely resolves — proves it's actively waiting, not racing.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(streamText).toHaveBeenCalledTimes(1);

    // NOW the original, still-running turn resolves.
    releaseStreamText({
      fullStream: emptyStream(),
      text: Promise.resolve(''),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve('stop'),
    });

    const [firstBody, secondBody] = await Promise.all([
      firstTextPromise,
      secondTextPromise,
    ]);
    const firstConversationId = readSSEEvents(firstBody).find(
      (e) => e.type === 'conversation-started',
    )?.conversationId;
    const secondConversationId = readSSEEvents(secondBody).find(
      (e) => e.type === 'conversation-started',
    )?.conversationId;

    // The crux: the concurrent replay never triggered a second execution,
    // even though it started polling well before the original resolved.
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(typeof firstConversationId).toBe('string');
    expect(secondConversationId).toBe(firstConversationId);
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
  });

  test('a DIFFERENT clientTurnId is never deduped — each executes independently', async () => {
    const streamText = vi.fn(async () => ({
      fullStream: emptyStream(),
      text: Promise.resolve(''),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve('stop'),
    }));
    const agent = buildAgent(streamText);
    const ctx = buildCtx({ memoryAdapter, dedupStore });
    const app = buildApp(ctx, agent, dedupStore);

    const r1 = await app.request('/chat?clientTurnId=turn-a', {
      method: 'POST',
    });
    await r1.text();
    const r2 = await app.request('/chat?clientTurnId=turn-b', {
      method: 'POST',
    });
    await r2.text();

    expect(streamText).toHaveBeenCalledTimes(2);
  });

  test('a failed turn releases its claim so a retry with the same clientTurnId genuinely re-executes', async () => {
    const streamText = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(async () => ({
        fullStream: emptyStream(),
        text: Promise.resolve(''),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve('stop'),
      }));
    const agent = buildAgent(streamText);
    const ctx = buildCtx({ memoryAdapter, dedupStore });
    const app = buildApp(ctx, agent, dedupStore);

    const r1 = await app.request('/chat?clientTurnId=turn-retry', {
      method: 'POST',
    });
    await r1.text();
    const r2 = await app.request('/chat?clientTurnId=turn-retry', {
      method: 'POST',
    });
    await r2.text();

    expect(streamText).toHaveBeenCalledTimes(2);
  });

  test('omitting clientTurnId never dedups (back-compat)', async () => {
    const streamText = vi.fn(async () => ({
      fullStream: emptyStream(),
      text: Promise.resolve(''),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve('stop'),
    }));
    const agent = buildAgent(streamText);
    const ctx = buildCtx({ memoryAdapter, dedupStore });
    const app = buildApp(ctx, agent, dedupStore);

    const r1 = await app.request('/chat', { method: 'POST' });
    await r1.text();
    const r2 = await app.request('/chat', { method: 'POST' });
    await r2.text();

    expect(streamText).toHaveBeenCalledTimes(2);
  });
});
