/**
 * A failed `/chat` turn persists a `[SYSTEM_EVENT] [CHAT_ERROR]` marker that
 * the conversation messages and export routes serve to the browser and the
 * knowledge store indexes. Its text used to be the thrown error's own
 * message, so a model provider's error body reached the chat after a reload.
 * Driven through the REAL `streamPrimaryAgentChat` and `finalizeChatRequest`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from '@ai-sdk/provider';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';
import { ChatTurnDedupStore } from '../chat-turn-dedup.js';

const SECRET = 'sk-live-SECRET-7c6b5a';

function providerError(statusCode: number | undefined) {
  return new APICallError({
    message: `upstream exploded ${SECRET}`,
    url: `https://provider.example.test/v1/chat/completions?key=${SECRET}`,
    requestBodyValues: { messages: [SECRET] },
    ...(statusCode === undefined ? {} : { statusCode }),
    responseBody: `{"error":"${SECRET}"}`,
  });
}

describe('streamPrimaryAgentChat failed-turn marker text', () => {
  let dir: string;
  let dedupStore: ChatTurnDedupStore;
  let memoryAdapter: Record<string, ReturnType<typeof vi.fn>>;
  let logged: unknown[];

  const buildCtx = () =>
    ({
      agentSpecs: new Map(),
      toolNameMapping: new Map(),
      approvalRegistry: {},
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn((...args: unknown[]) => logged.push(args)),
      },
      agentHooksMap: new Map(),
      memoryAdapters: new Map([['assistant', memoryAdapter]]),
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
    }) as any;

  const run = async (thrown: unknown) => {
    const ctx = buildCtx();
    const app = new Hono();
    app.post('/chat', (c) =>
      streamPrimaryAgentChat({
        c,
        ctx,
        slug: 'assistant',
        plugin: '',
        input: 'hello',
        restOptions: { conversationId: 'conversation-1', userId: 'user-1' },
        injectContext: null,
        ragContext: null,
        agent: {
          getMemory: () => null,
          model: { modelId: 'test-model' },
          streamText: vi.fn(async () => {
            throw thrown;
          }),
        } as any,
        configurationLease: captureRuntimeConfigurationLease(ctx)!,
        dedupStore,
      }),
    );
    const response = await app.request('/chat', { method: 'POST' });
    const body = await response.text();
    const persisted = memoryAdapter.addMessage.mock.calls.map((call) =>
      JSON.stringify(call[0]),
    );
    const marker = persisted.find((text) => text.includes('[CHAT_ERROR]'));
    return { body, persisted, marker };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-primary-stream-failure-'));
    dedupStore = new ChatTurnDedupStore(join(dir, 'chat-turn-dedup.json'));
    logged = [];
    const conversations = new Map<string, { id: string }>();
    memoryAdapter = {
      getConversation: vi.fn(
        async (id: string) => conversations.get(id) ?? null,
      ),
      createConversation: vi.fn(async (payload: { id: string }) => {
        conversations.set(payload.id, { id: payload.id });
      }),
      addMessage: vi.fn(async () => {}),
      getMessages: vi.fn(async () => []),
      getConversations: vi.fn(async () => []),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    [500, 'The model provider returned an error (HTTP 500).'],
    [429, 'The model provider rate-limited the request (HTTP 429).'],
    [404, 'The model provider could not find the model (HTTP 404).'],
  ])(
    'a provider HTTP %i persists its status sentence and no provider text',
    async (status, sentence) => {
      const { body, persisted, marker } = await run(providerError(status));

      expect(marker).toContain(`[SYSTEM_EVENT] [CHAT_ERROR] ${sentence}`);
      expect(persisted.join('\n')).not.toContain(SECRET);
      expect(persisted.join('\n')).not.toContain('provider.example.test');
      expect(body).toContain(`"statusCode":${status}`);
      expect(body).not.toContain(SECRET);
      // The route still logs the real cause for an operator.
      expect(logged.length).toBeGreaterThan(0);
    },
  );

  test('an error with no provider status persists the fixed generic', async () => {
    const { persisted, marker } = await run(providerError(undefined));

    expect(marker).toContain(
      '[SYSTEM_EVENT] [CHAT_ERROR] The response stream failed.',
    );
    expect(persisted.join('\n')).not.toContain(SECRET);
  });

  test("a plain thrown error's own message is never persisted", async () => {
    const { persisted, marker } = await run(
      new Error(`connect ECONNREFUSED /Users/operator ${SECRET}`),
    );

    expect(marker).toContain(
      '[SYSTEM_EVENT] [CHAT_ERROR] The response stream failed.',
    );
    expect(persisted.join('\n')).not.toContain(SECRET);
    expect(persisted.join('\n')).not.toContain('/Users/operator');
  });

  test('an inferred credential refusal persists the unnumbered sentence', async () => {
    const { persisted, marker } = await run(
      new Error(`invalid credential ${SECRET}`),
    );

    expect(marker).toContain(
      '[SYSTEM_EVENT] [CHAT_ERROR] The model provider rejected the credentials.',
    );
    expect(marker).not.toContain('HTTP');
    expect(persisted.join('\n')).not.toContain(SECRET);
  });

  test("Station's own abort constant is kept so a reload still reads as stopped", async () => {
    const { marker } = await run(new Error('Stream aborted by client'));

    expect(marker).toContain(
      '[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client',
    );
  });
});
