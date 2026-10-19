/**
 * A minimal real `/chat` app for direct-route dedup tests: the production
 * `streamPrimaryAgentChat` behind a Hono route, over a caller-supplied agent,
 * conversation store and `ChatTurnDedupStore`. Shared by an in-process test
 * and a SIGKILLed child process, so both run the same route setup.
 */
import { Hono } from 'hono';
import { streamPrimaryAgentChat } from '../routes/chat/chat-primary-stream.js';
import type { ChatTurnDedupStore } from '../routes/chat/chat-turn-dedup.js';
import { captureRuntimeConfigurationLease } from '../runtime/plugins/runtime-configuration-lease.js';

export interface ChatHarnessAgent {
  getMemory(): null;
  model: { modelId: string };
  streamText(input: string, options: unknown): unknown;
}

export interface ChatHarnessConversationStore {
  getConversation(id: string): Promise<unknown>;
  createConversation(payload: { id: string }): Promise<unknown>;
  addMessage(...args: unknown[]): Promise<unknown>;
  getMessages(...args: unknown[]): Promise<unknown[]>;
  getConversations(...args: unknown[]): Promise<unknown[]>;
}

/** An in-memory conversation store whose `createConversation` may be held. */
export function createHarnessConversationStore(
  onCreate?: () => Promise<void>,
): ChatHarnessConversationStore {
  const conversations = new Map<string, { id: string; title: string }>();
  return {
    getConversation: async (id) => conversations.get(id) ?? null,
    createConversation: async (payload) => {
      await onCreate?.();
      conversations.set(payload.id, {
        id: payload.id,
        title: 'New Conversation',
      });
    },
    addMessage: async () => undefined,
    getMessages: async () => [],
    getConversations: async () => [],
  };
}

/** An agent result that streams nothing and finishes cleanly. */
export function emptyAgentResult() {
  async function* none() {}
  return {
    fullStream: none(),
    text: Promise.resolve(''),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve('stop'),
  };
}

function buildCtx(conversations: ChatHarnessConversationStore) {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return {
    agentSpecs: new Map(),
    toolNameMapping: new Map(),
    approvalRegistry: {},
    logger,
    agentHooksMap: new Map(),
    memoryAdapters: new Map([['assistant', conversations]]),
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
  };
}

/** `POST /chat?clientTurnId=…` runs one direct `/chat` turn for `assistant`. */
export function buildChatHarnessApp(options: {
  agent: ChatHarnessAgent;
  conversations: ChatHarnessConversationStore;
  dedupStore: ChatTurnDedupStore;
}): Hono {
  // The route takes the runtime context by its full type; this harness
  // supplies only the members a direct /chat turn reads.
  const ctx = buildCtx(options.conversations) as unknown as Parameters<
    typeof streamPrimaryAgentChat
  >[0]['ctx'];
  const app = new Hono();
  app.post('/chat', (c) => {
    const clientTurnId = c.req.query('clientTurnId');
    return streamPrimaryAgentChat({
      c,
      ctx,
      slug: 'assistant',
      plugin: '',
      input: 'hello',
      restOptions: clientTurnId ? { clientTurnId } : {},
      injectContext: null,
      ragContext: null,
      agent: options.agent,
      configurationLease: captureRuntimeConfigurationLease(ctx)!,
      dedupStore: options.dedupStore,
    });
  });
  return app;
}
