/**
 * archive#2649 — the integration proof for the per-turn context receipt.
 *
 * Nothing here is mocked between the retrieval that composes the injected
 * string and the envelope a person reads: the REAL `prepareChatRequest`
 * composes the model input from the REAL `buildKnowledgeRagContextDetailed`,
 * the REAL `streamPrimaryAgentChat` dispatches it and emits the receipt frame,
 * the REAL `StationAgentAdapter` relays that frame onto the turn's terminal
 * event, and the REAL `assembleTurnProvenanceEnvelopes` folds it into the
 * `contextInjection` slot.
 *
 * The assertions are deliberately cross-checked against the string the model
 * actually received (`agent.streamText`'s first argument) rather than against
 * the record's own inputs — a receipt that agrees only with itself is exactly
 * the fabricated claim this slice exists to prevent. Decoupling the record
 * from the injection anywhere along that chain must turn this file red.
 */
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { buildKnowledgeRagContextDetailed } from '../../../services/knowledge/knowledge-context.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';
import { prepareChatRequest } from '../chat-request-preparation.js';

/**
 * A retrieval corpus with a chunk BELOW the relevance threshold. `ignored.md`
 * is never composed into the model input, so a truthful receipt can never
 * name it — the discriminating case for "records exactly what was injected".
 */
const SEARCH_RESULTS = [
  {
    score: 0.81,
    text: 'Deploys run from main.',
    metadata: { filename: 'guide.md' },
  },
  {
    score: 0.62,
    text: 'POST /v1/deploy starts one.',
    metadata: { filename: 'api.md' },
  },
  {
    score: 0.44,
    text: 'Second guide chunk.',
    metadata: { filename: 'guide.md' },
  },
  {
    score: 0.05,
    text: 'Unrelated cafeteria menu.',
    metadata: { filename: 'ignored.md' },
  },
];

const GUIDELINES_TEXT =
  '<feedback_profile>\nreinforce: be terse\n</feedback_profile>';

function knowledgeService(options: { hit: boolean }) {
  return {
    getInjectContext: vi.fn(async () => null),
    getRAGContextDetailed: vi.fn(async () =>
      options.hit
        ? buildKnowledgeRagContextDetailed(SEARCH_RESULTS, 0.25)
        : null,
    ),
  };
}

function buildCtx(options: {
  hit: boolean;
  guidelines: boolean;
  memoryAdapter: Record<string, unknown>;
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
    feedbackService: {
      getRatings: () => [],
      getBehaviorGuidelinesDetailed: () =>
        options.guidelines
          ? { text: GUIDELINES_TEXT, reinforce: 1, avoid: 0 }
          : null,
    },
    knowledgeService: knowledgeService({ hit: options.hit }),
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

async function* emptyStream() {
  /* the turn produces no assistant output — the receipt is the subject here */
}

/**
 * Runs one real `/chat` dispatch and returns both the raw SSE body and the
 * exact string the model received, so every receipt claim can be checked
 * against the injection itself.
 */
async function dispatchChatTurn(options: {
  hit: boolean;
  guidelines: boolean;
  /**
   * The message shape sent. `attachment-only` is the array-shaped user
   * message with a file part and NO text part — what an uncaptioned
   * attachment produces, and the shape both `/chat` composers silently drop
   * their whole block for (archive#2649 review fix HIGH-1).
   */
  shape?: 'text' | 'attachment-only';
  ambientContext?: string;
}): Promise<{ body: string; modelInput: unknown }> {
  const conversations = new Map<string, { id: string; title?: string }>();
  const memoryAdapter = {
    getConversation: vi.fn(async (id: string) => conversations.get(id) ?? null),
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
  const ctx = buildCtx({ ...options, memoryAdapter });

  let modelInput: unknown = '';
  const streamText = vi.fn(async (input: unknown) => {
    modelInput = input;
    return {
      fullStream: emptyStream(),
      text: Promise.resolve(''),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve('stop'),
    };
  });
  const agent = {
    getMemory: () => null,
    model: { modelId: 'test-model' },
    streamText,
  };

  const chatInput =
    options.shape === 'attachment-only'
      ? ([
          {
            role: 'user',
            parts: [{ type: 'file', url: 'data:image/png;base64,AAAA' }],
          },
        ] as any)
      : 'how do deploys work?';

  const app = new Hono();
  app.post('/chat', async (c) => {
    const prepared = await prepareChatRequest({
      ctx,
      slug: 'assistant',
      input: chatInput,
      options: {},
      projectSlug: 'proj-1',
    });
    return streamPrimaryAgentChat({
      c,
      ctx,
      slug: 'assistant',
      plugin: '',
      input: chatInput,
      ...(options.ambientContext
        ? { ambientContext: options.ambientContext }
        : {}),
      restOptions: prepared.options,
      injectContext: prepared.injectContext,
      ragContext: prepared.ragContext,
      contextInjection: prepared.contextInjection,
      agent,
      configurationLease: captureRuntimeConfigurationLease(ctx)!,
    } as any);
  });

  const response = await app.request('/chat', { method: 'POST' });
  const body = await response.text();
  expect(streamText).toHaveBeenCalledTimes(1);
  return { body, modelInput };
}

/**
 * Replays a real `/chat` SSE body through the REAL station-agent adapter and
 * folds its canonical events — the same two hops production uses to get a
 * receipt from the route onto the provenance card.
 */
async function foldDispatchedTurn(body: string) {
  const eventBus = new EventBus();
  const adapter = new StationAgentAdapter({
    apiBase: 'http://127.0.0.1:3141',
    hasAgent: (agentId: string) => agentId === 'assistant',
    eventBus,
    approvalRegistry: new ApprovalRegistry(
      { info: vi.fn(), warn: vi.fn() },
      { eventBus },
    ),
    fetch: vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch,
    now: () => new Date('2026-08-14T00:00:00.000Z'),
  });

  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  await adapter.startSession({
    threadId: 'thread-1',
    provider: 'station-agent',
    cwd: '/work/station',
    metadata: { agentId: 'assistant', projectSlug: 'proj-1', userId: 'user-1' },
  });
  await adapter.sendTurn({
    threadId: 'thread-1',
    input: 'how do deploys work?',
  });

  const events: CanonicalRuntimeEvent[] = [];
  while (!events.some((event) => event.method === 'turn.completed')) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Timed out waiting for turn.completed')),
          2_000,
        ),
      ),
    ]);
    if (next.done) break;
    events.push(next.value);
  }
  const [envelope] = assembleTurnProvenanceEnvelopes(events);
  return { events, envelope };
}

describe('per-turn context injection, route → adapter → provenance envelope (station#2649)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a knowledge hit is recorded as exactly the sources composed into the model input — and nothing else', async () => {
    const { body, modelInput: rawInput } = await dispatchChatTurn({
      hit: true,
      guidelines: true,
    });
    const modelInput = rawInput as string;

    // The injection actually happened, and the sub-threshold chunk did not.
    expect(modelInput).toContain('<project_knowledge>');
    expect(modelInput).toContain('Deploys run from main.');
    expect(modelInput).not.toContain('Unrelated cafeteria menu.');
    expect(modelInput).toContain(GUIDELINES_TEXT);

    // The route emitted the receipt on the wire for the dispatched turn.
    expect(body).toContain('"type":"context-injection"');

    const { envelope } = await foldDispatchedTurn(body);
    expect(envelope.contextInjection?.state).toBe('observed');
    const record =
      envelope.contextInjection?.state === 'observed'
        ? envelope.contextInjection.value
        : undefined;

    expect(record?.knowledge).toEqual({
      // Three chunks cleared the threshold; `guide.md` supplied two of them
      // and is therefore ONE distinct source.
      chunkCount: 3,
      sources: ['guide.md', 'api.md'],
      omittedSources: 0,
      approxTokens: expect.any(Number),
    });
    expect(record?.guidelines).toEqual({
      reinforce: 1,
      avoid: 0,
      approxTokens: expect.any(Number),
    });
    // Nothing Station did not inject: no project-rules block was composed.
    expect(record).not.toHaveProperty('projectRules');
    expect(record).not.toHaveProperty('conversationFeedback');
    expect(record).not.toHaveProperty('workflowSteering');

    // Every named source is genuinely present in what the model received,
    // and the omitted one is named nowhere in the receipt.
    for (const source of record?.knowledge?.sources ?? []) {
      expect(modelInput).toContain(source);
    }
    expect(JSON.stringify(record)).not.toContain('ignored.md');

    // The cost figure is derived from the string the MODEL received, not
    // from the record's own bookkeeping: re-measure the injected block out
    // of `modelInput` and compare.
    const injectedKnowledgeBlock = modelInput.slice(
      modelInput.indexOf('<project_knowledge>'),
      modelInput.indexOf('</project_knowledge>') +
        '</project_knowledge>'.length,
    );
    expect(record?.knowledge?.approxTokens).toBe(
      Math.ceil(Buffer.byteLength(injectedKnowledgeBlock, 'utf8') / 4),
    );
    expect(record?.guidelines?.approxTokens).toBe(
      Math.ceil(Buffer.byteLength(GUIDELINES_TEXT, 'utf8') / 4),
    );
  });

  test('a turn with no retrieval and no guidelines records an EMPTY receipt — an earned "Station injected nothing", never a fabricated block', async () => {
    const { body, modelInput: rawInput } = await dispatchChatTurn({
      hit: false,
      guidelines: false,
    });
    const modelInput = rawInput as string;

    expect(modelInput).not.toContain('<project_knowledge>');
    expect(modelInput).not.toContain('<feedback_profile>');

    const { envelope } = await foldDispatchedTurn(body);
    expect(envelope.contextInjection).toMatchObject({
      state: 'observed',
      value: {},
    });
    // Observed-empty is a claim about THIS turn, so it must carry the
    // observation that earned it.
    const slot = envelope.contextInjection;
    expect(
      slot?.state === 'observed' && slot.observedFrom.length,
    ).toBeGreaterThan(0);
  });

  // archive#2649 review fix (HIGH-1). The defect this test exists for:
  // knowledge/project-rules/guidelines were recorded from composition
  // INTENT, but `applyCombinedContextToInput` drops the whole block for an
  // array-shaped message with no text part. A user sending an uncaptioned
  // screenshot in a project with inject docs and guidelines got a card
  // reading "Project rules (~N tokens) - Guidelines: 2 reinforce / 1 avoid"
  // for a model that received neither.
  test('an uncaptioned attachment records NOTHING, because the composers dropped everything they built', async () => {
    const { body, modelInput } = await dispatchChatTurn({
      hit: true,
      guidelines: true,
      shape: 'attachment-only',
    });

    // Ground truth first: the model genuinely received none of it.
    const serializedInput = JSON.stringify(modelInput);
    expect(serializedInput).not.toContain('<project_knowledge>');
    expect(serializedInput).not.toContain(GUIDELINES_TEXT);
    expect(serializedInput).not.toContain('Deploys run from main.');

    const { envelope } = await foldDispatchedTurn(body);
    // An empty record - "no Station-composed context reached the model" -
    // and specifically NOT the blocks that were composed and thrown away.
    expect(envelope.contextInjection).toMatchObject({
      state: 'observed',
      value: {},
    });
    const record =
      envelope.contextInjection?.state === 'observed'
        ? envelope.contextInjection.value
        : undefined;
    for (const block of ['knowledge', 'projectRules', 'guidelines'] as const) {
      expect(record).not.toHaveProperty(block);
    }
  });

  // archive#2649 review fix (MEDIUM-1): ambient context is Station-composed
  // at the same choke point, so an empty record would otherwise assert
  // "nothing" over a turn that carried a timezone.
  test('records ambient context as its own block when it reached the model', async () => {
    const { body, modelInput } = await dispatchChatTurn({
      hit: false,
      guidelines: false,
      ambientContext: '[Timezone: Atlantic/Reykjavik]',
    });

    expect(String(modelInput)).toContain('[Timezone: Atlantic/Reykjavik]');

    const { envelope } = await foldDispatchedTurn(body);
    const record =
      envelope.contextInjection?.state === 'observed'
        ? envelope.contextInjection.value
        : undefined;
    // Measured as the byte delta the composition actually added.
    expect(record?.ambient?.approxTokens).toBe(
      Math.ceil(
        Buffer.byteLength('[Timezone: Atlantic/Reykjavik]\n', 'utf8') / 4,
      ),
    );
  });
});
