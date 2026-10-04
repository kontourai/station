/**
 * #3112 — what a Station-agent conversation stores, and what its conversation
 * read serves, composed from the real pieces:
 *
 * - the REAL `OrchestrationService` over a real `EventStore`, so a failed
 *   turn's successor Session is reserved by the real lineage code;
 * - the REAL `StationAgentAdapter`, whose `/chat` relay is answered by the
 *   REAL `prepareChatRequest` + `streamPrimaryAgentChat` with a REAL
 *   VoltAgent agent writing to a REAL `FileMemoryAdapter`;
 * - the REAL conversation routes reading that same store.
 *
 * Only the language model is a fixture.
 */
import { join } from 'node:path';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { VoltAgentFramework } from '../../../runtime/frameworks/voltagent-adapter.js';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import type { IAgent } from '../../../runtime/types.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';
import { prepareChatRequest } from '../chat-request-preparation.js';
import { createConversationRoutes } from '../conversations.js';

// Created before the suite's hooks so the store closes before its directory goes.
const makeTempDir = trackTempDirs();

const SLUG = 'assistant';
const OWNER = 'owner-user';
const TIMEZONE = '[Timezone: Europe/Berlin]';
const PROJECT_RULES = 'Project rule: answer in one sentence.';

type StoredMessage = {
  role: string;
  parts?: Array<{ type: string; text?: string }>;
};

function textOf(message: StoredMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that answers, or fails every call the way an HTTP 500 does. */
function model(mode: { fail: boolean }) {
  return new MockLanguageModelV3({
    doStream: async () => {
      if (mode.fail) throw new Error('Internal Server Error');
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 'a' },
            { type: 'text-delta' as const, id: 'a', delta: 'An answer.' },
            { type: 'text-end' as const, id: 'a' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage,
            },
          ] as any,
        }),
      };
    },
  });
}

function chatCtx(memoryAdapter: FileMemoryAdapter) {
  return {
    agentSpecs: new Map(),
    toolNameMapping: new Map(),
    approvalRegistry: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agentHooksMap: new Map(),
    memoryAdapters: new Map([[SLUG, memoryAdapter]]),
    feedbackService: {
      getRatings: () => [],
      getBehaviorGuidelinesDetailed: () => null,
    },
    knowledgeService: {
      getInjectContext: vi.fn(async () => PROJECT_RULES),
      getRAGContextDetailed: vi.fn(async () => null),
    },
    storageAdapter: { getProject: () => undefined },
    activeAgents: new Map(),
    providerService: {
      resolveProvider: vi.fn(),
      listProviderConnections: () => [],
      getLaunchabilityRevision: () => 0,
    },
    agentStatus: new Map(),
    agentStats: new Map(),
    agentTools: new Map(),
    monitoringEvents: undefined,
    monitoringEmitter: undefined,
    modelCatalog: undefined,
    metricsLog: [] as unknown[],
    getAgentConfigurationRevision: () => 0,
    configLoader: { getLaunchabilityRevision: () => 0 },
    commitAgentConfigurationRead: async (
      _expectedRevision: number,
      operation: () => Promise<unknown>,
    ) => operation(),
  } as any;
}

describe('Station-agent conversation storage (#3112)', () => {
  let tmp: string;
  let memoryAdapter: FileMemoryAdapter;
  let eventStore: EventStore;
  let adapter: StationAgentAdapter;
  let service: OrchestrationService;
  let modelMode: { fail: boolean };
  let languageModel: MockLanguageModelV3;
  let agent: IAgent;

  /** The relay's `/chat`, answered by the real chat pipeline. */
  async function relayChat(init: RequestInit | undefined): Promise<Response> {
    const body = JSON.parse(String(init?.body));
    const ctx = chatCtx(memoryAdapter);
    const app = new Hono();
    app.post('/chat', async (c) => {
      const prepared = await prepareChatRequest({
        ctx,
        slug: SLUG,
        input: body.input,
        options: body.options ?? {},
        projectSlug: body.projectSlug ?? 'proj-1',
      });
      return streamPrimaryAgentChat({
        c,
        ctx,
        slug: SLUG,
        plugin: '',
        input: body.input,
        ...(body.ambientContext ? { ambientContext: body.ambientContext } : {}),
        restOptions: prepared.options,
        injectContext: prepared.injectContext,
        ragContext: prepared.ragContext,
        contextInjection: prepared.contextInjection,
        agent,
        configurationLease: captureRuntimeConfigurationLease(ctx)!,
      } as any);
    });
    return app.request('/chat', { method: 'POST' });
  }

  async function waitForTurnEnd(threadId: string, turns: number) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const detail = await service.readSession(
        threadId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      const ended = (detail?.events ?? []).filter(
        (event) =>
          event.method === 'turn.completed' || event.method === 'runtime.error',
      ).length;
      // The terminal event lands before the adapter's settled status does.
      if (
        ended >= turns &&
        detail?.session.hasActiveTurn !== true &&
        detail?.session.status !== 'running'
      )
        return detail!;
      if (Date.now() > deadline)
        throw new Error(`turn on ${threadId} never ended`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function startSession(threadId: string, conversationId: string) {
    const started = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId,
          provider: 'station-agent',
          metadata: { agentId: SLUG, userId: OWNER, conversationId },
        },
      },
      { userId: OWNER },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
  }

  async function send(threadId: string, text: string, turns: number) {
    await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId, input: text, ambientContext: TIMEZONE },
      },
      { userId: OWNER },
    );
    return waitForTurnEnd(threadId, turns);
  }

  async function readMessages(conversationId: string) {
    const routes = createConversationRoutes(
      new Map([[SLUG, memoryAdapter]]) as any,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service as any,
      () => OWNER,
    );
    const response = await routes.request(
      `/${SLUG}/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: StoredMessage[] };
    return body.data;
  }

  beforeEach(async () => {
    tmp = makeTempDir('station-agent-storage-');
    memoryAdapter = new FileMemoryAdapter({ projectHomeDir: tmp });
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    const eventBus = new EventBus();
    modelMode = { fail: false };
    languageModel = model(modelMode);
    agent = await new VoltAgentFramework().createTempAgent({
      agentId: SLUG,
      name: SLUG,
      instructions: 'Answer briefly.',
      model: languageModel,
      memoryAdapter: memoryAdapter as any,
    });
    adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:1',
      hasAgent: (id: string) => id === SLUG,
      fetch: vi.fn(async (_url: unknown, init?: RequestInit) =>
        relayChat(init),
      ) as unknown as typeof fetch,
      approvalRegistry: new ApprovalRegistry(
        { info: vi.fn(), warn: vi.fn() },
        { eventBus },
      ),
      eventBus,
    });
    service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'station-agent' ? adapter : undefined),
        list: () => [adapter],
      },
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
  });

  afterEach(async () => {
    await adapter.stopAll().catch(() => undefined);
    eventStore.close();
  });

  test('the stored user turn is the typed text while the model still receives its context', async () => {
    await startSession('conv-typed', 'conv-typed');
    await send('conv-typed', 'What is the plan?', 1);

    const stored = (await memoryAdapter.getMessages(
      OWNER,
      'conv-typed',
    )) as StoredMessage[];
    expect(stored.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(textOf(stored[0]!)).toBe('What is the plan?');

    // The context is not lost: the model-facing prompt still carries the
    // ambient line and the project rules ahead of the typed text.
    const prompt = JSON.stringify(languageModel.doStreamCalls[0]?.prompt);
    expect(prompt).toContain(TIMEZONE);
    expect(prompt).toContain(PROJECT_RULES);
    expect(prompt).toContain('What is the plan?');

    // The conversation title is drawn from the typed text, too.
    const conversation = await memoryAdapter.getConversation('conv-typed');
    expect(conversation?.title ?? '').not.toContain('[Timezone:');
  });

  test('a turn sent after a failed turn is in the conversation read, with its failure marker, in order', async () => {
    modelMode.fail = true;
    await startSession('conv-failed', 'conv-failed');
    const failed = await send('conv-failed', 'First try', 1);
    expect(failed.session.status).toBe('error');

    // The follow-up resolves the way every conversation send does: the
    // failed binding cannot take another turn, so the real lineage code
    // reserves a successor Session beneath the same conversation.
    const continuation = await service.resolveConversationContinuation(
      'conv-failed',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'station-agent' },
    );
    expect(continuation.startRequired).toBe(true);
    expect(continuation.sessionId).not.toBe('conv-failed');
    expect(eventStore.conversationSessions('conv-failed')).toHaveLength(2);
    await startSession(continuation.sessionId, 'conv-failed');
    await send(continuation.sessionId, 'Second try', 1);

    const messages = await readMessages('conv-failed');
    const texts = messages.map(textOf);
    // Each failed turn reads as its prompt followed by its failure marker,
    // the successor's after the root's.
    const isMarker = (text: string) =>
      text.startsWith('[SYSTEM_EVENT] [CHAT_ERROR] ');
    const markers = texts.flatMap((text, index) =>
      isMarker(text) ? [index] : [],
    );
    expect(markers).toHaveLength(2);
    const firstPrompt = texts.indexOf('First try');
    const secondPrompt = texts.indexOf('Second try');
    expect(firstPrompt).toBeGreaterThanOrEqual(0);
    expect(firstPrompt).toBeLessThan(markers[0]!);
    expect(markers[0]!).toBeLessThan(secondPrompt);
    expect(secondPrompt).toBeLessThan(markers[1]!);
    expect(texts.lastIndexOf('First try')).toBeLessThan(markers[0]!);
    for (const text of texts) expect(text).not.toContain('[Timezone:');
  });
});
