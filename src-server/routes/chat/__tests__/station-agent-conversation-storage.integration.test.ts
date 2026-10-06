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
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createAgentHooks } from '../../../runtime/agents/agent-hooks.js';
import { VoltAgentFramework } from '../../../runtime/frameworks/voltagent-adapter.js';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import type { IAgent } from '../../../runtime/types.js';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import {
  type StationControlCaller,
  stationControlCallerPrincipal,
} from '../../../tools/station-control-shared.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';
import { prepareChatRequest } from '../chat-request-preparation.js';
import {
  conversationReferenceReadDeps,
  createConversationReferenceReadRoutes,
} from '../conversation-reference-read.js';
import {
  CONVERSATION_READ_MAX_SESSIONS,
  createConversationRoutes,
  createGlobalConversationRoutes,
} from '../conversations.js';

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

  async function startSession(
    threadId: string,
    conversationId: string,
    owner = OWNER,
  ) {
    const started = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId,
          provider: 'station-agent',
          // The start metadata a foreground chat send records.
          metadata: {
            agentId: SLUG,
            agentSlug: SLUG,
            userId: owner,
            conversationId,
          },
        },
      },
      { userId: owner },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
  }

  async function send(
    threadId: string,
    text: string,
    turns: number,
    owner = OWNER,
  ) {
    await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId, input: text, ambientContext: TIMEZONE },
      },
      { userId: owner },
    );
    return waitForTurnEnd(threadId, turns);
  }

  const quietLogger = () =>
    ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as any;

  function agentRoutes() {
    return createConversationRoutes(
      new Map([[SLUG, memoryAdapter]]) as any,
      quietLogger(),
      new Map(),
      new Map(),
      { loadAgent: async () => ({ model: 'mock-model-id' }) } as any,
      { defaultModel: 'mock-model-id' } as any,
      undefined,
      undefined,
      service as any,
      () => OWNER,
    );
  }

  function globalRoutes() {
    return createGlobalConversationRoutes(
      new Map([[SLUG, memoryAdapter]]) as any,
      { getConversation: () => null },
      quietLogger(),
      undefined,
      service as any,
      () => OWNER,
    );
  }

  /**
   * The production composition of the referenced-conversation read. With a
   * `caller`, each request carries the station-control authority the guard
   * binds for a tool call, so its reads are scoped to that principal.
   */
  function referenceReadRoutes(caller?: StationControlCaller) {
    const routes = createConversationReferenceReadRoutes(
      conversationReferenceReadDeps({
        memoryAdapters: new Map([[SLUG, memoryAdapter]]) as any,
        sessions: service,
        eventStore,
        deviceKind: () => undefined,
        authorityFor: () =>
          sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
        logger: quietLogger(),
      }),
    );
    if (!caller) return routes;
    const host = new Hono();
    host.use('*', async (c, next) => {
      bindStationControlRequestAuthority(c.req.raw, {
        kind: 'caller',
        caller,
        boundOperator: caller.assurance === 'bound',
      });
      await next();
    });
    host.route('/', routes);
    return host;
  }

  async function readJson<T>(app: Hono, path: string): Promise<T> {
    const response = await app.request(path);
    expect(response.status, path).toBe(200);
    return ((await response.json()) as { data: T }).data;
  }

  /** A conversation whose second turn ran in a successor Session. */
  async function failTwice(conversationId: string) {
    modelMode.fail = true;
    await startSession(conversationId, conversationId);
    const failed = await send(conversationId, 'First try', 1);
    expect(failed.session.status).toBe('error');
    // The follow-up resolves the way every conversation send does: the
    // failed binding cannot take another turn, so the real lineage code
    // reserves a successor Session beneath the same conversation.
    const continuation = await service.resolveConversationContinuation(
      conversationId,
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'station-agent' },
    );
    expect(continuation.startRequired).toBe(true);
    expect(continuation.sessionId).not.toBe(conversationId);
    expect(eventStore.conversationSessions(conversationId)).toHaveLength(2);
    await startSession(continuation.sessionId, conversationId);
    await send(continuation.sessionId, 'Second try', 1);
    return continuation.sessionId;
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
      // The real lifecycle hooks: they record each turn's usage on the
      // conversation record the turn ran under.
      hooks: createAgentHooks({
        spec: { name: SLUG, prompt: 'Answer briefly.' },
        appConfig: { defaultModel: 'mock-model-id' },
        configLoader: { loadAgent: async () => ({ model: 'mock-model-id' }) },
        agentFixedTokens: new Map(),
        memoryAdapters: new Map([[SLUG, memoryAdapter]]),
        toolNameMapping: new Map(),
        logger: quietLogger(),
      } as any),
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
    await failTwice('conv-failed');

    const messages = await readMessages('conv-failed');
    // Each failed turn reads as exactly its prompt and its failure marker,
    // the successor's after the root's: no second copy of the prompt, no
    // empty assistant reply, no context.
    const marker = expect.stringMatching(/^\[SYSTEM_EVENT\] \[CHAT_ERROR\] /);
    expect(
      messages.map((message) => ({
        role: message.role,
        text: textOf(message),
      })),
    ).toEqual([
      { role: 'user', text: 'First try' },
      { role: 'user', text: marker },
      { role: 'user', text: 'Second try' },
      { role: 'user', text: marker },
    ]);
  });

  test('the referenced-conversation read covers the lineage, addressed by either Session', async () => {
    const successor = await failTwice('conv-referenced');
    for (const id of ['conv-referenced', successor]) {
      const read = await readJson<{
        conversationId: string;
        messages: Array<{ text: string }>;
      }>(referenceReadRoutes(), `/${encodeURIComponent(id)}/read`);
      expect(read.conversationId, id).toBe('conv-referenced');
      expect(
        read.messages.map((message) => message.text),
        id,
      ).toEqual([
        'First try',
        expect.stringMatching(/^\[SYSTEM_EVENT\] \[CHAT_ERROR\] /),
        'Second try',
        expect.stringMatching(/^\[SYSTEM_EVENT\] \[CHAT_ERROR\] /),
      ]);
    }
  });

  test('a successor Session is not listed or found as a conversation of its own', async () => {
    const successor = await failTwice('conv-listed');
    // The successor's turn really is stored under its own id.
    expect(
      (await memoryAdapter.getMessages(OWNER, successor)).length,
    ).toBeGreaterThan(0);

    const agentList = await readJson<{ items: Array<{ id: string }> }>(
      agentRoutes(),
      `/${SLUG}/conversations`,
    );
    expect(agentList.items.map((item) => item.id)).toEqual(['conv-listed']);

    const inventory = await readJson<{ items: Array<{ id: string }> }>(
      globalRoutes(),
      '/',
    );
    expect(inventory.items.map((item) => item.id)).toEqual(['conv-listed']);

    const hits = await readJson<Array<{ conversationId: string }>>(
      globalRoutes(),
      '/search?query=Second%20try',
    );
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.conversationId).toBe('conv-listed');
  });

  test('a conversation with a successor Session is read-only to the file-store delete, root and successor alike', async () => {
    const successor = await failTwice('conv-deleted');
    for (const id of ['conv-deleted', successor]) {
      const response = await agentRoutes().request(
        `/${SLUG}/conversations/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      expect(response.status, id).toBe(409);
    }
    // Nothing was removed, so the conversation still reads whole.
    expect(await memoryAdapter.getConversation('conv-deleted')).not.toBeNull();
    expect(await memoryAdapter.getConversation(successor)).not.toBeNull();
    expect(await readMessages('conv-deleted')).toHaveLength(4);
  });

  test('the conversation stats count every Session in its lineage', async () => {
    await startSession('conv-stats', 'conv-stats');
    await send('conv-stats', 'Answered first', 1);
    modelMode.fail = true;
    const failed = await send('conv-stats', 'Fails', 2);
    expect(failed.session.status).toBe('error');
    modelMode.fail = false;
    const continuation = await service.resolveConversationContinuation(
      'conv-stats',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'station-agent' },
    );
    expect(continuation.startRequired).toBe(true);
    await startSession(continuation.sessionId, 'conv-stats');
    await send(continuation.sessionId, 'Answered after', 1);

    // Each answered turn's usage is on the record its Session ran under.
    const recordTurns = async (id: string) =>
      (
        (await memoryAdapter.getConversation(id))?.metadata as
          | { stats?: { turns?: number } }
          | undefined
      )?.stats?.turns;
    expect(await recordTurns('conv-stats')).toBe(1);
    expect(await recordTurns(continuation.sessionId)).toBe(1);

    const stats = await readJson<{
      turns: number;
      inputTokens?: number;
      outputTokens?: number;
    }>(agentRoutes(), `/${SLUG}/conversations/conv-stats/stats`);
    expect(stats).toMatchObject({ turns: 2, inputTokens: 2, outputTokens: 2 });

    // An engine with no store record has its stats folded from runtime
    // events; that fold covers the lineage the same way.
    const perSession = [
      service.readSessionUsage('conv-stats', INTERNAL_SESSION_READ_SCOPE),
      service.readSessionUsage(
        continuation.sessionId,
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ];
    expect(perSession[1]!.turns).toBeGreaterThan(0);
    expect(
      service.readConversationUsage('conv-stats', INTERNAL_SESSION_READ_SCOPE)
        .turns,
    ).toBe(perSession[0]!.turns + perSession[1]!.turns);
  });

  test('a conversation read refuses a lineage longer than its bound instead of truncating it', async () => {
    // Pinned beside the constant it bounds: a change to either is deliberate.
    expect(CONVERSATION_READ_MAX_SESSIONS).toBe(64);
    await startSession('conv-long', 'conv-long');
    let predecessor = 'conv-long';
    const reserveTo = (count: number) => {
      while (eventStore.conversationSessions('conv-long').length < count) {
        predecessor = eventStore.reserveNextConversationSession({
          conversationId: 'conv-long',
          predecessorSessionId: predecessor,
          proposedSessionId: `conv-long:session:${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
        }).lineage.sessionId;
      }
    };
    const get = (path: string) =>
      agentRoutes().request(`/${SLUG}/conversations/conv-long/${path}`);

    reserveTo(CONVERSATION_READ_MAX_SESSIONS);
    expect((await get('messages')).status).toBe(200);
    // Within the bound the read proceeds; an empty conversation then reads
    // as not found to a person's request.
    expect(
      (await referenceReadRoutes().request('/conv-long/read')).status,
    ).toBe(404);
    expect((await get('stats')).status).toBe(200);

    reserveTo(CONVERSATION_READ_MAX_SESSIONS + 1);
    const referenced = await referenceReadRoutes().request('/conv-long/read');
    expect(referenced.status).toBe(422);
    expect(await referenced.json()).toMatchObject({
      code: 'conversation_lineage_too_long',
    });
    for (const path of ['messages', 'stats', 'export']) {
      const response = await get(path);
      expect(response.status, path).toBe(422);
      expect(await response.json(), path).toMatchObject({
        success: false,
        code: 'conversation_lineage_too_long',
      });
    }
  });

  test('a page of conversations is not shortened by successor records it skips', async () => {
    // An older direct chat: a file-store conversation with no Session.
    modelMode.fail = false;
    const direct = await relayChat({
      body: JSON.stringify({
        input: 'A direct chat',
        options: { conversationId: 'conv-direct', userId: OWNER },
      }),
    });
    await direct.text();
    expect(await memoryAdapter.getConversation('conv-direct')).not.toBeNull();
    await failTwice('conv-paged');

    const page = await readJson<{
      items: Array<{ id: string }>;
      hasMore: boolean;
    }>(agentRoutes(), `/${SLUG}/conversations?limit=1`);
    expect(page.items.map((item) => item.id)).toEqual(['conv-paged']);
    // The direct chat is beyond this page, not lost from it.
    expect(page.hasMore).toBe(true);
    const all = await readJson<{ items: Array<{ id: string }> }>(
      agentRoutes(),
      `/${SLUG}/conversations?limit=2`,
    );
    expect(all.items.map((item) => item.id)).toEqual([
      'conv-paged',
      'conv-direct',
    ]);
  });

  test("a principal-scoped read serves only the Sessions its principal owns, a successor's included", async () => {
    // The root is the owner's; the successor ran for someone else, so both
    // its store record and its runtime events are another principal's.
    modelMode.fail = true;
    await startSession('conv-owned', 'conv-owned');
    await send('conv-owned', 'Owner turn', 1);
    const continuation = await service.resolveConversationContinuation(
      'conv-owned',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'station-agent' },
    );
    await startSession(continuation.sessionId, 'conv-owned', 'other-user');
    await send(continuation.sessionId, 'Other turn', 1, 'other-user');
    expect(
      (await memoryAdapter.getConversation(continuation.sessionId))?.userId,
    ).toBe('other-user');
    expect(
      service.readSessionMessages(
        continuation.sessionId,
        INTERNAL_SESSION_READ_SCOPE,
      ).length,
    ).toBeGreaterThan(0);

    // A station-control agent on the owner's own conversation, not a bound
    // operator: its reads are scoped to the owner.
    const caller: StationControlCaller = {
      sessionId: 'conv-owned',
      assurance: 'delegated-custody',
      principal: stationControlCallerPrincipal(OWNER, 'session-owner'),
      conversationId: 'conv-owned',
    };
    const read = await readJson<{
      access: string;
      messages: Array<{ text: string }>;
    }>(referenceReadRoutes(caller), '/conv-owned/read');
    expect(read.access).toBe('own');
    const texts = read.messages.map((message) => message.text);
    expect(texts).toEqual([
      'Owner turn',
      expect.stringMatching(/^\[SYSTEM_EVENT\] \[CHAT_ERROR\] /),
    ]);
    expect(texts.join('\n')).not.toContain('Other turn');
  });
});
