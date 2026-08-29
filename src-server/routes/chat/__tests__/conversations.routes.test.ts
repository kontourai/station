import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { resolvePrincipal } from '../../../services/identity/principal-resolver.js';
import { resolveRuntimeAgent } from '../../agents/runtime-agent-resolver.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  conversationOps: { add: vi.fn() },
  conversationMessageSearches: { add: vi.fn() },
  chatTitleRegenerated: { add: vi.fn() },
}));
vi.mock('../chat-title-generation.js', () => ({
  generateConversationTitle: vi.fn().mockResolvedValue('Regenerated title'),
}));
// Mock only the generator; keep the real isSessionSummaryFailure guard the
// route imports from the same module (a bare factory left it undefined and
// every summary POST 500'd — caught by full:regression, 2026-08-17).
vi.mock('../session-summary-generation.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateSessionSummary: vi.fn().mockResolvedValue({
    text: 'The team chose the bounded path.',
    model: 'structure-model',
    summarizedFromMessageId: 'm1',
    summarizedThroughMessageId: 'm2',
    summarizedMessageCount: 2,
    sourceMessageCount: 2,
    partialMessageIncluded: false,
  }),
}));
// archive#4080 follow-up (review round 2, finding 1): spy-wrap the
// REAL implementation (not a fake) so every other test's behavior is
// unchanged — this exists only to pin that the messages route actually
// calls through the shared resolver rather than a re-derived copy.
vi.mock(
  '../../../runtime/conversation/conversation-transcript-source.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../runtime/conversation/conversation-transcript-source.js')
      >();
    return {
      ...actual,
      resolveConversationTranscriptSource: vi.fn(
        actual.resolveConversationTranscriptSource,
      ),
    };
  },
);
vi.mock('../../../runtime/conversation/conversation-manager.js', () => ({
  manageConversationContext: vi.fn().mockResolvedValue({ success: true }),
  getConversationStats: vi.fn().mockResolvedValue({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
    toolCalls: 0,
    estimatedCost: 0,
    modelId: 'test-model',
    systemPromptTokens: 0,
    mcpServerTokens: 0,
    userMessageTokens: 0,
    assistantMessageTokens: 0,
    contextFilesTokens: 0,
  }),
}));

const {
  createConversationRoutes,
  createGlobalConversationRoutes,
  readCompleteForkConversationWindow,
} = await import('../conversations.js');
const { FileMemoryAdapter } = await import(
  '../../../adapters/file/memory-adapter.js'
);
const { ensureChatConversation } = await import('../chat-persistence.js');
const { conversationOps } = await import('../../../telemetry/metrics.js');
const { getConversationStats } = await import(
  '../../../runtime/conversation/conversation-manager.js'
);
const { manageConversationContext } = await import(
  '../../../runtime/conversation/conversation-manager.js'
);
const { generateSessionSummary } = await import(
  '../session-summary-generation.js'
);
const { resolveConversationTranscriptSource } = await import(
  '../../../runtime/conversation/conversation-transcript-source.js'
);

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
});
const alphaAuthority = () =>
  sessionReadAuthorityFromRequest(
    'alpha-user',
    { tenantId: tenantId('alpha') },
    hostedRegistry,
  );

function createMockAdapter() {
  const convs = [
    {
      id: 'c1',
      userId: 'agent:default',
      title: 'Test Chat',
      metadata: { existing: 'value' },
    },
  ];
  return {
    getConversations: vi.fn().mockResolvedValue(convs),
    queryConversations: vi.fn().mockResolvedValue(convs),
    getConversation: vi.fn().mockResolvedValue(convs[0]),
    createConversation: vi.fn().mockResolvedValue(undefined),
    updateConversation: vi
      .fn()
      .mockImplementation(async (_id: string, updates: any) => ({
        ...convs[0],
        ...updates,
      })),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    addMessage: vi.fn().mockResolvedValue(undefined),
    addMessages: vi.fn().mockResolvedValue(undefined),
    getMessages: vi
      .fn()
      .mockResolvedValue([{ role: 'user', content: 'hello' }]),
  };
}

function completedForkTranscript() {
  return [
    { id: 'fork-user', role: 'user', content: 'hello' },
    {
      id: 'fork-answer',
      role: 'assistant',
      content: 'completed answer',
      metadata: { turnId: 'fork-turn', answerEligible: true },
    },
  ];
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
  setLevel: vi.fn(),
  getLevel: vi.fn(() => 'info' as const),
};

function emptyHistoryReader() {
  return {
    readSessionMessages: vi.fn().mockReturnValue([]),
    readSessionConversation: vi.fn().mockResolvedValue(null),
    listConversationHistoryPage: vi.fn().mockResolvedValue({
      items: [],
      hasMore: false,
    }),
  };
}

describe('Conversation Routes', () => {
  test('session summaries are only generated on the explicit POST, persist outside messages, and derive staleness from the live seam', async () => {
    const adapter = createMockAdapter();
    adapter.getMessages.mockResolvedValue([
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'Choose a path' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Use the bounded path' }],
      },
    ]);
    const summaries = new Map<string, any>();
    const store = {
      read: vi.fn(
        async (coordinate: any) =>
          summaries.get(coordinate.conversationId) ?? null,
      ),
      write: vi.fn(async (coordinate: any, value: any) => {
        summaries.set(coordinate.conversationId, value);
      }),
      dismiss: vi.fn(async (coordinate: any) => {
        summaries.delete(coordinate.conversationId);
      }),
    };
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'agent:default',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
      store,
    );

    // Opening/reading must not invoke the model: the POST is the only trigger.
    const before = await app.request('/station/conversations/c1/summary');
    expect(before.status).toBe(200);
    expect(await json(before)).toMatchObject({ success: true, data: null });
    expect(generateSessionSummary).not.toHaveBeenCalled();

    const generated = await app.request('/station/conversations/c1/summary', {
      method: 'POST',
    });
    const generatedBody = await json(generated);
    expect(generated.status).toBe(200);
    expect(generateSessionSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ id: 'm2' }),
        ]),
      }),
    );
    expect(generatedBody.data).toMatchObject({
      model: 'structure-model',
      summarizedThroughMessageId: 'm2',
      sourceMessageCount: 2,
      partialMessageIncluded: false,
      stale: false,
    });
    expect(generatedBody.data.generatedAt).toEqual(expect.any(String));
    expect(store.write).toHaveBeenCalledOnce();

    // A derived summary remains absent from transcript persistence, export,
    // and runtime-event facts. Any regression that writes it as a turn fails
    // these observations rather than merely checking a private store call.
    expect(adapter.addMessage).not.toHaveBeenCalled();
    expect(adapter.addMessages).not.toHaveBeenCalled();
    const exported = await app.request(
      '/station/conversations/c1/export?format=markdown',
    );
    expect(exported.status).toBe(200);
    expect(await exported.text()).not.toContain(
      'The team chose the bounded path.',
    );

    // A newer real transcript message changes the derived projection without
    // mutating a summary flag in the persisted record.
    adapter.getMessages.mockResolvedValueOnce([
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'Choose a path' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Use the bounded path' }],
      },
      { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'What next?' }] },
    ]);
    const stale = await json(
      await app.request('/station/conversations/c1/summary'),
    );
    expect(stale.data.stale).toBe(true);
    expect(summaries.get('c1')).not.toHaveProperty('stale');

    const dismissed = await app.request('/station/conversations/c1/summary', {
      method: 'DELETE',
    });
    expect(dismissed.status).toBe(200);
    const afterDismiss = await json(
      await app.request('/station/conversations/c1/summary'),
    );
    expect(afterDismiss.data).toBeNull();

    const regenerated = await app.request('/station/conversations/c1/summary', {
      method: 'POST',
    });
    expect(regenerated.status).toBe(200);
    expect(store.write).toHaveBeenCalledTimes(2);
  });

  test('session summary routes deny another hosted tenant before derived storage', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.station.test' },
        { id: 'bravo', authority: 'bravo.station.test' },
      ],
    });
    const authorityFor = (request: Request) => {
      const tenant = request.headers.get('x-test-tenant');
      return sessionReadAuthorityFromRequest(
        'shared-user',
        tenant === 'alpha' || tenant === 'bravo'
          ? { tenantId: tenantId(tenant) }
          : undefined,
        registry,
      );
    };
    const store = {
      read: vi.fn(),
      write: vi.fn(),
      dismiss: vi.fn(),
    };
    const generationCallsBefore = vi.mocked(generateSessionSummary).mock.calls
      .length;
    const reader = {
      readSessionConversation: vi.fn(
        (_id: string, authority: ReturnType<typeof authorityFor>) =>
          authority.tenantExecutionContext?.tenantId === 'alpha'
            ? Promise.resolve({ id: 'alpha-thread' })
            : Promise.resolve(null),
      ),
      readSessionMessages: vi.fn(() => [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'alpha-only transcript' }],
        },
      ]),
    };
    const app = createConversationRoutes(
      new Map() as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader as any,
      () => 'shared-user',
      undefined,
      authorityFor,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
      store,
    );

    const request = (method: 'GET' | 'POST' | 'DELETE', tenant: string) =>
      app.request('/station/conversations/alpha-thread/summary', {
        method,
        headers: { 'x-test-tenant': tenant },
      });

    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const response = await request(method, 'bravo');
      expect(response.status).toBe(404);
      expect(await json(response)).toEqual({
        success: false,
        error: 'Conversation not found',
      });
    }
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
    expect(store.dismiss).not.toHaveBeenCalled();
    expect(vi.mocked(generateSessionSummary).mock.calls).toHaveLength(
      generationCallsBefore,
    );
  });

  test('persists cataloged Task/turn refs as related evidence, never verification, and rechecks source watermark', async () => {
    const adapter = createMockAdapter();
    adapter.getMessages.mockResolvedValue([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'ship it' }] },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'reported done' }],
      },
    ]);
    const summaries = new Map<string, any>();
    const catalog = {
      observe: vi.fn().mockResolvedValue([
        {
          kind: 'task-turn',
          taskId: 'task-1',
          turnId: 'turn-1',
          eventId: 'event-1',
          authorized: true,
        },
      ]),
    };
    const reader = {
      readConversationEventWindow: vi.fn().mockResolvedValue({
        watermark: 10,
        events: [
          {
            event: {
              eventId: 'event-1',
              threadId: 'session-1',
              turnId: 'turn-1',
              method: 'turn.completed',
            },
          },
        ],
      }),
    };
    vi.mocked(generateSessionSummary).mockResolvedValueOnce({
      version: 2,
      text: 'The task is reported complete.',
      overview: 'The task is reported complete.',
      goals: [],
      constraints: [],
      progress: [],
      nextSteps: [],
      reportedCompletion: ['The assistant reported completion.'],
      model: 'structure-model',
      summarizedFromMessageId: 'm1',
      summarizedThroughMessageId: 'm2',
      summarizedMessageCount: 2,
      sourceRange: {
        fromMessageId: 'm1',
        throughMessageId: 'm2',
        messageCount: 2,
      },
      sourceRanges: [
        { fromMessageId: 'm1', throughMessageId: 'm2', messageCount: 2 },
      ],
      sourceRevision: 'generator-does-not-authorize-revision',
      sourceMessageCount: 2,
      partialMessageIncluded: false,
      contextBoundaryCount: 0,
      generationUsage: { state: 'unknown' },
    } as any);
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader as any,
      () => 'summary-user',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
      {
        read: vi.fn(async (coordinate: any) =>
          summaries.get(coordinate.conversationId),
        ),
        write: vi.fn(async (coordinate: any, value: any) => {
          summaries.set(coordinate.conversationId, value);
        }),
        dismiss: vi.fn(),
      },
      undefined,
      catalog,
    );
    const generated = await json(
      await app.request('/station/conversations/c1/summary', {
        method: 'POST',
      }),
    );
    expect(generated.data.relatedEvidenceRefs).toEqual([
      {
        kind: 'task-turn',
        taskId: 'task-1',
        turnId: 'turn-1',
        eventId: 'event-1',
      },
    ]);
    expect(generated.data.verificationRefs).toEqual([
      {
        kind: 'task-turn',
        state: 'unavailable',
        unavailableReason: 'not-captured-by-station',
      },
    ]);
    expect(catalog.observe).toHaveBeenCalled();
    reader.readConversationEventWindow.mockResolvedValueOnce({
      watermark: 11,
      events: [],
    });
    expect(
      (await json(await app.request('/station/conversations/c1/summary'))).data
        .stale,
    ).toBe(true);
  });

  test('uses the event window current successor Session for the quiescence gate', async () => {
    const adapter = createMockAdapter();
    adapter.getMessages.mockResolvedValue([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'wait' }] },
    ]);
    const reader = {
      readConversationEventWindow: vi.fn().mockResolvedValue({
        watermark: 2,
        currentSessionId: 'successor-session',
        contextBoundaries: [],
      }),
      hasActiveTurn: vi.fn(
        (sessionId: string) => sessionId === 'successor-session',
      ),
    };
    const store = { read: vi.fn(), write: vi.fn(), dismiss: vi.fn() };
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader as any,
      () => 'summary-user',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
      store,
    );
    const generationCalls = vi.mocked(generateSessionSummary).mock.calls.length;
    const response = await app.request('/station/conversations/c1/summary', {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    expect(reader.hasActiveTurn).toHaveBeenCalledWith('successor-session');
    expect(reader.hasActiveTurn).not.toHaveBeenCalledWith('c1');
    expect(vi.mocked(generateSessionSummary).mock.calls).toHaveLength(
      generationCalls,
    );
  });

  test('summary staleness rejects a broken captured extent and rechecks after generation', async () => {
    const adapter = createMockAdapter();
    const messages = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'two' }] },
      { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'three' }] },
    ];
    adapter.getMessages.mockImplementation(async () => messages);
    const summaries = new Map<string, any>([
      [
        'c1',
        {
          text: 'Prior summary',
          model: 'structure-model',
          generatedAt: '2026-08-16T12:00:00.000Z',
          summarizedFromMessageId: 'm1',
          summarizedThroughMessageId: 'm3',
          summarizedMessageCount: 3,
          sourceMessageCount: 3,
          partialMessageIncluded: false,
        },
      ],
    ]);
    const store = {
      read: vi.fn(async (coordinate: any) =>
        summaries.get(coordinate.conversationId),
      ),
      write: vi.fn(async (coordinate: any, value: any) => {
        summaries.set(coordinate.conversationId, value);
      }),
      dismiss: vi.fn(),
    };
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'summary-user',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
      store,
    );

    messages.splice(0, 2);
    const broken = await json(
      await app.request('/station/conversations/c1/summary'),
    );
    expect(broken.data.stale).toBe(true);

    messages.splice(
      0,
      0,
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'two' }] },
    );
    vi.mocked(generateSessionSummary).mockImplementationOnce(async () => {
      messages.push({
        id: 'm4',
        role: 'assistant',
        parts: [{ type: 'text', text: 'arrived during generation' }],
      });
      return {
        version: 2 as const,
        text: 'New summary',
        overview: 'New summary',
        model: 'structure-model',
        goals: [],
        constraints: [],
        progress: [],
        nextSteps: [],
        reportedCompletion: [],
        relatedEvidenceRefs: [],
        verificationRefs: [],
        summarizedFromMessageId: 'm1',
        summarizedThroughMessageId: 'm3',
        summarizedMessageCount: 3,
        sourceRange: {
          fromMessageId: 'm1',
          throughMessageId: 'm3',
          messageCount: 3,
        },
        sourceRanges: [
          { fromMessageId: 'm1', throughMessageId: 'm3', messageCount: 3 },
        ],
        sourceRevision: 'mock-revision',
        sourceMessageCount: 3,
        partialMessageIncluded: false,
        contextBoundaryCount: 0,
        contextBoundaries: [],
        generationUsage: { state: 'unknown' as const },
      };
    });
    const regenerated = await json(
      await app.request('/station/conversations/c1/summary', {
        method: 'POST',
      }),
    );
    expect(regenerated).toMatchObject({
      success: false,
      code: 'summary_source_changed',
    });
  });

  test('a failed summary generation preserves an existing summary', async () => {
    const adapter = createMockAdapter();
    const summary = {
      text: 'Existing summary',
      model: 'structure-model',
      generatedAt: '2026-08-16T12:00:00.000Z',
      summarizedFromMessageId: 'm1',
      summarizedThroughMessageId: 'm1',
      summarizedMessageCount: 1,
      sourceMessageCount: 1,
      partialMessageIncluded: false,
    };
    const store = {
      read: vi.fn(async () => summary),
      write: vi.fn(),
      dismiss: vi.fn(),
    };
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'summary-user',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
      store,
    );
    // A typed failure, not null: the generator no longer has a null return
    // at all, because four different causes collapsing to one value is what
    // forced the route into an ambiguous message (archive#3148).
    vi.mocked(generateSessionSummary).mockReset();
    vi.mocked(generateSessionSummary).mockResolvedValue({
      failed: true,
      kind: 'no-structure-model',
      message: 'No structure model is configured.',
    });

    const response = await app.request('/station/conversations/c1/summary', {
      method: 'POST',
    });
    expect(response.status).toBe(500);
    expect(store.write).not.toHaveBeenCalled();
    expect(
      (await json(await app.request('/station/conversations/c1/summary'))).data,
    ).toMatchObject({ text: 'Existing summary' });
  });

  test('session summaries never enter export, FTS projection input, or runtime events', async () => {
    const adapter = createMockAdapter();
    adapter.getMessages.mockResolvedValue([
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'Original transcript text' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Original answer text' }],
      },
    ]);
    const appendedEvents: Array<{ text?: string }> = [];
    const eventStore = {
      appendConversationFork: vi.fn(),
      appendEvent: vi.fn((event: { text?: string }) =>
        appendedEvents.push(event),
      ),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
    };
    const reader = {
      readSessionMessages: vi.fn(() => []),
      readSessionConversation: vi.fn().mockResolvedValue(null),
      searchSessionMessages: vi.fn((query: string) =>
        appendedEvents.filter((event) => event.text?.includes(query)),
      ),
      listConversationHistoryPage: vi.fn(),
    };
    const store = { read: vi.fn(), write: vi.fn(), dismiss: vi.fn() };
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader as any,
      () => 'summary-user',
      undefined,
      undefined,
      eventStore as any,
      undefined,
      undefined,
      undefined,
      {} as any,
      store,
    );

    vi.mocked(generateSessionSummary).mockReset();
    vi.mocked(generateSessionSummary).mockResolvedValue({
      text: 'The team chose the bounded path.',
      model: 'structure-model',
      summarizedFromMessageId: 'm1',
      summarizedThroughMessageId: 'm1',
      summarizedMessageCount: 1,
      sourceMessageCount: 1,
      partialMessageIncluded: false,
    } as any);
    const generated = await app.request('/station/conversations/c1/summary', {
      method: 'POST',
    });
    expect(generated.status).toBe(200);
    const exported = await app.request(
      '/station/conversations/c1/export?format=markdown',
    );
    expect(await exported.text()).not.toContain(
      'The team chose the bounded path.',
    );
    expect(adapter.addMessage).not.toHaveBeenCalled();
    expect(adapter.addMessages).not.toHaveBeenCalled();
    expect(eventStore.appendEvent).not.toHaveBeenCalled();

    const global = createGlobalConversationRoutes(
      new Map(),
      { getConversation: vi.fn(() => null) },
      mockLogger,
      undefined,
      reader as any,
      () => 'summary-user',
      undefined,
      undefined,
      eventStore,
    );
    const search = await json(await global.request('/search?query=bounded'));
    expect(search.data).toEqual([]);
    expect(reader.searchSessionMessages).toHaveBeenCalledWith(
      'bounded',
      expect.anything(),
      20,
    );
  });

  test('POST regenerate-title uses the current transcript and marks the generated source', async () => {
    const adapter = createMockAdapter();
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'agent:default',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
    );
    const response = await app.request(
      '/station/conversations/c1/regenerate-title',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(adapter.getMessages).toHaveBeenCalledWith('agent:default', 'c1');
    expect(body.data.metadata.titleSource).toBe('generated');
  });

  test('POST regenerate-title requires explicit confirmation before replacing a manual title', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue({
      id: 'c1',
      title: 'My hand-picked title',
      metadata: { titleSource: 'user' },
    });
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'agent:default',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    const response = await app.request(
      '/station/conversations/c1/regenerate-title',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );

    expect(response.status).toBe(409);
    expect(adapter.getMessages).not.toHaveBeenCalled();
    expect(adapter.updateConversation).not.toHaveBeenCalled();

    const confirmed = await app.request(
      '/station/conversations/c1/regenerate-title',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replaceManualTitle: true }),
      },
    );
    expect(confirmed.status).toBe(200);
    expect(adapter.updateConversation).toHaveBeenCalledWith('c1', {
      title: 'Regenerated title',
      metadata: { titleSource: 'generated' },
    });
  });

  test('POST regenerate-title refuses to overwrite a rename that landed mid-generation', async () => {
    // The CAS-less read-modify-write class: a manual rename while the model
    // is generating must win, and its provenance must never be falsified to
    // 'generated'. The route re-reads before writing; this pins that the
    // re-read has power.
    const adapter = createMockAdapter();
    // First read (snapshot) sees the original title; the re-read sees the
    // user's rename that landed while the model was thinking.
    adapter.getConversation
      .mockResolvedValueOnce({ id: 'c1', title: 'Original' })
      .mockResolvedValueOnce({
        id: 'c1',
        title: 'My hand-picked title',
        metadata: { titleSource: 'user' },
      });
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'agent:default',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
    );
    const response = await app.request(
      '/station/conversations/c1/regenerate-title',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(409);
    expect(adapter.updateConversation).not.toHaveBeenCalled();
  });

  test('POST regenerate-title refuses an empty conversation instead of titling nothing', async () => {
    const adapter = createMockAdapter();
    adapter.getMessages.mockResolvedValue([]);
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'agent:default',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {} as any,
    );
    const response = await app.request(
      '/station/conversations/c1/regenerate-title',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(409);
    expect(adapter.updateConversation).not.toHaveBeenCalled();
  });

  test('POST regenerate-title returns 404 for a missing conversation', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue(null);
    adapter.getMessages.mockResolvedValue([]);
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
    );
    const response = await app.request(
      '/station/conversations/missing/regenerate-title',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(404);
  });
  test('GET /:slug/conversations returns list', async () => {
    const adapters = new Map([['default', createMockAdapter()]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(await app.request('/station/conversations'));
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].agentSlug).toBe('station');
  });

  test('GET /:slug/conversations rejects a personal cursor before reading either conversation source', async () => {
    const adapter = createMockAdapter();
    const reader = emptyHistoryReader();
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
    );

    const response = await app.request(
      '/station/conversations?cursor=opaque-next-page',
    );
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'Personal history uses one compatibility page',
    });
    expect(adapter.queryConversations).not.toHaveBeenCalled();
    expect(reader.listConversationHistoryPage).not.toHaveBeenCalled();
  });

  test('rejects the retired default Agent identity at the conversation boundary', async () => {
    const adapters = new Map([['default', createMockAdapter()]]);
    const app = createConversationRoutes(adapters as any, mockLogger);

    const response = await app.request('/default/conversations');
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      code: 'AGENT_ID_RESERVED',
    });
    expect(body.error).toContain("Use the 'station' Agent instead");
  });

  test('GET /:slug/conversations returns empty for unknown agent', async () => {
    const app = createConversationRoutes(new Map() as any, mockLogger);
    const body = await json(await app.request('/unknown/conversations'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ items: [], hasMore: false });
  });

  test('GET /:slug/conversations includes orchestration-owned history', async () => {
    const reader = {
      readSessionMessages: vi.fn().mockReturnValue([]),
      readSessionConversation: vi.fn().mockResolvedValue(null),
      listSessionConversations: vi.fn().mockResolvedValue([
        {
          id: 'thread-1',
          title: 'Persisted runtime chat',
          createdAt: '2026-07-23T00:00:00Z',
          updatedAt: '2026-07-23T00:01:00Z',
          messageCount: 2,
          mutable: false,
        },
      ]),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'thread-1',
            source: 'runtime',
            agentSlug: 'claude',
            title: 'Persisted runtime chat',
            createdAt: '2026-07-23T00:00:00Z',
            updatedAt: '2026-07-23T00:01:00Z',
            messageCount: 2,
            mutable: false,
            answerability: { answerable: true },
          },
        ],
        hasMore: false,
      }),
    };
    const app = createConversationRoutes(
      new Map() as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
      () => 'bound-user',
    );
    const body = await json(await app.request('/claude/conversations'));
    expect(reader.listConversationHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'bound-user', mode: 'personal' }),
      { agentSlug: 'claude', cursor: undefined, limit: 100 },
    );
    expect(reader.listSessionConversations).not.toHaveBeenCalled();
    expect(body.data.items).toEqual([
      expect.objectContaining({
        id: 'thread-1',
        title: 'Persisted runtime chat',
      }),
    ]);
    expect(conversationOps.add).toHaveBeenCalledWith(1, {
      operation: 'history_list',
      source: 'orchestration',
      outcome: 'available',
    });
  });

  test('hosted conversation reads suppress unbound file inventory and use request authority for session history', async () => {
    const adapter = createMockAdapter();
    const reader = {
      readSessionMessages: vi
        .fn()
        .mockReturnValue([
          { role: 'assistant', parts: [{ type: 'text', text: 'alpha only' }] },
        ]),
      readSessionConversation: vi.fn().mockResolvedValue(null),
      listSessionConversations: vi.fn().mockResolvedValue([
        {
          id: 'alpha-thread',
          title: 'Alpha session',
          createdAt: '2026-07-23T00:00:00Z',
          updatedAt: '2026-07-23T00:01:00Z',
          messageCount: 1,
          mutable: false,
        },
      ]),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'alpha-thread',
            source: 'runtime',
            agentSlug: 'station',
            title: 'Alpha session',
            createdAt: '2026-07-23T00:00:00Z',
            updatedAt: '2026-07-23T00:01:00Z',
            messageCount: 1,
            mutable: false,
            answerability: { answerable: true },
          },
        ],
        hasMore: false,
      }),
    };
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
      () => 'alpha-user',
      undefined,
      alphaAuthority,
    );

    const list = await json(await app.request('/station/conversations'));
    const messages = await json(
      await app.request('/station/conversations/alpha-thread/messages'),
    );

    expect(list.data.items).toEqual([
      expect.objectContaining({ id: 'alpha-thread', title: 'Alpha session' }),
    ]);
    expect(messages.data).toEqual([
      expect.objectContaining({ role: 'assistant' }),
    ]);
    expect(adapter.getConversations).not.toHaveBeenCalled();
    expect(adapter.getMessages).not.toHaveBeenCalled();
    expect(reader.listConversationHistoryPage).toHaveBeenCalledWith(
      alphaAuthority(),
      { agentSlug: 'station', cursor: undefined, limit: 100 },
    );
    expect(reader.readSessionMessages).toHaveBeenCalledWith(
      'alpha-thread',
      alphaAuthority(),
    );
  });

  test('hosted file-memory mutations deny before adapters or context management run', async () => {
    const adapter = createMockAdapter();
    const app = createConversationRoutes(
      new Map([['station', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { readSessionConversation: vi.fn().mockResolvedValue(null) } as any,
      () => 'shared-user',
      undefined,
      () => alphaAuthority(),
    );

    const patch = await app.request('/station/conversations/c1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Probe' }),
    });
    const deletion = await app.request('/station/conversations/c1', {
      method: 'DELETE',
    });
    const context = await app.request('/station/conversations/c1/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'trim' }),
    });

    for (const response of [patch, deletion, context]) {
      expect(response.status).toBe(404);
      expect(await json(response)).toEqual({
        success: false,
        error: 'Conversation not found',
      });
    }
    expect(adapter.getConversation).not.toHaveBeenCalled();
    expect(adapter.updateConversation).not.toHaveBeenCalled();
    expect(adapter.deleteConversation).not.toHaveBeenCalled();
    expect(manageConversationContext).not.toHaveBeenCalled();
  });

  // S1 of archive#1302: the session projection already emits `projectSlug`
  // (`orchestration-service.ts`'s `readSessionConversation`) — this pins
  // that the list route's declared type no longer erases it on the wire.
  test('GET /:slug/conversations carries projectSlug through for session-projection items', async () => {
    const reader = {
      readSessionMessages: vi.fn().mockReturnValue([]),
      readSessionConversation: vi.fn().mockResolvedValue(null),
      listSessionConversations: vi.fn().mockResolvedValue([
        {
          id: 'thread-1',
          projectSlug: 'station',
          title: 'Persisted runtime chat',
          createdAt: '2026-07-23T00:00:00Z',
          updatedAt: '2026-07-23T00:01:00Z',
          messageCount: 2,
          mutable: false,
        },
      ]),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'thread-1',
            source: 'runtime',
            agentSlug: 'claude',
            projectSlug: 'station',
            title: 'Persisted runtime chat',
            createdAt: '2026-07-23T00:00:00Z',
            updatedAt: '2026-07-23T00:01:00Z',
            messageCount: 2,
            mutable: false,
            answerability: { answerable: true },
          },
        ],
        hasMore: false,
      }),
    };
    const app = createConversationRoutes(
      new Map() as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
      () => 'bound-user',
    );
    const body = await json(await app.request('/claude/conversations'));
    expect(body.data.items).toEqual([
      expect.objectContaining({ id: 'thread-1', projectSlug: 'station' }),
    ]);
  });

  // S1 of archive#1302: `ensureChatConversation` stamps `projectSlug` into a
  // newly-created file-backed conversation's metadata; the list route
  // must project it back out to the top level.
  test('a chat-created conversation persists projectSlug and re-lists it', async () => {
    const store = new Map<string, any>();
    const statefulAdapter = {
      getConversations: vi.fn(async () => Array.from(store.values())),
      queryConversations: vi.fn(async () => Array.from(store.values())),
      getConversation: vi.fn(async (id: string) => store.get(id) ?? null),
      createConversation: vi.fn(async (payload: any) => {
        const record = { ...payload };
        store.set(payload.id, record);
        return record;
      }),
      updateConversation: vi.fn(),
      deleteConversation: vi.fn(),
      getMessages: vi.fn(async () => []),
    };

    await ensureChatConversation({
      conversationStorage: statefulAdapter,
      conversationId: 'chat-1',
      userId: 'agent:default',
      slug: 'default',
      input: 'hello there',
      projectSlug: 'my-project',
    });

    const adapters = new Map([['default', statefulAdapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(await app.request('/station/conversations'));

    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([
      expect.objectContaining({ id: 'chat-1', projectSlug: 'my-project' }),
    ]);
  });

  test('fork rejects an unknown source conversation without creating a target or appending a fact', async () => {
    const source = createMockAdapter();
    source.getConversation.mockResolvedValue(null);
    const target = createMockAdapter();
    const eventStore = {
      appendConversationFork: vi.fn(),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
    };
    const app = createConversationRoutes(
      new Map([
        ['default', source],
        ['codex', target],
      ]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'fork-user',
      undefined,
      undefined,
      eventStore,
      () => true,
    );

    const response = await app.request('/station/conversations/missing/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'codex' }),
    });

    expect(response.status).toBe(404);
    expect(target.createConversation).not.toHaveBeenCalled();
    expect(eventStore.appendConversationFork).not.toHaveBeenCalled();
  });

  test('fork rejects an unresolvable target agent without creating a target or appending a fact', async () => {
    const source = createMockAdapter();
    source.getMessages.mockResolvedValue(completedForkTranscript());
    const eventStore = {
      appendConversationFork: vi.fn(),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
    };
    const app = createConversationRoutes(
      new Map([['default', source]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'fork-user',
      undefined,
      undefined,
      eventStore,
      () => true,
    );

    const response = await app.request('/station/conversations/c1/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'codex' }),
    });

    expect(response.status).toBe(404);
    expect(eventStore.appendConversationFork).not.toHaveBeenCalled();
  });

  test('fork does not append a fact when target creation fails', async () => {
    const source = createMockAdapter();
    source.getMessages.mockResolvedValue(completedForkTranscript());
    const target = createMockAdapter();
    const eventStore = {
      appendConversationFork: vi.fn(),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
    };
    const createTargetConversation = vi
      .fn()
      .mockRejectedValue(new Error('disk full'));
    const actionOperations = {
      create: vi
        .fn()
        .mockRejectedValue(new Error('tracking store unavailable')),
      update: vi.fn(),
    };
    const app = createConversationRoutes(
      new Map([
        ['default', source],
        ['codex', target],
      ]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'fork-user',
      undefined,
      undefined,
      eventStore,
      () => true,
      createTargetConversation,
      undefined,
      undefined,
      undefined,
      actionOperations as any,
    );

    const response = await app.request('/station/conversations/c1/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'codex' }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(createTargetConversation).toHaveBeenCalledOnce();
    expect(eventStore.appendConversationFork).not.toHaveBeenCalled();
    expect(actionOperations.create).toHaveBeenCalledOnce();
  });

  test('fork rejects a direct API target outside the source project without creating a conversation or fact', async () => {
    const source = createMockAdapter();
    source.getMessages.mockResolvedValue(completedForkTranscript());
    source.getConversation.mockResolvedValue({
      id: 'c1',
      title: 'Scoped',
      metadata: { projectSlug: 'private-project' },
    });
    const target = createMockAdapter();
    const eventStore = {
      appendConversationFork: vi.fn(),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
    };
    const configLoader = {
      loadAgent: vi.fn().mockResolvedValue({ slug: 'codex' }),
    };
    const app = createConversationRoutes(
      new Map([
        ['default', source],
        ['codex', target],
      ]) as any,
      mockLogger,
      undefined,
      undefined,
      configLoader as any,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'fork-user',
      undefined,
      undefined,
      eventStore,
      () => true,
      undefined,
      { getProject: () => ({ agents: [agentId('station')] }) },
    );

    const response = await app.request('/station/conversations/c1/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'codex' }),
    });

    expect(response.status).toBe(404);
    expect(target.createConversation).not.toHaveBeenCalled();
    expect(eventStore.appendConversationFork).not.toHaveBeenCalled();
  });

  test('fork preserves a source project scope for an eligible target agent', async () => {
    const source = createMockAdapter();
    source.getMessages.mockResolvedValue(completedForkTranscript());
    source.getConversation.mockResolvedValue({
      id: 'c1',
      title: 'Scoped',
      metadata: { projectSlug: 'private-project' },
    });
    const target = createMockAdapter();
    const eventStore = {
      appendConversationFork: vi.fn(),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
    };
    const configLoader = {
      loadAgent: vi.fn().mockResolvedValue({ slug: 'codex' }),
    };
    const createTargetConversation = vi.fn().mockResolvedValue(undefined);
    const actionOperations = {
      create: vi.fn().mockResolvedValue({ id: 'fork-operation', revision: 1 }),
      update: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'updated',
          operation: { id: 'fork-operation', revision: 2 },
        })
        .mockRejectedValueOnce(new Error('terminal observation failed')),
    };
    const app = createConversationRoutes(
      new Map([
        ['default', source],
        ['codex', target],
      ]) as any,
      mockLogger,
      undefined,
      undefined,
      configLoader as any,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'fork-user',
      undefined,
      undefined,
      eventStore,
      () => true,
      createTargetConversation,
      { getProject: () => ({ agents: [agentId('codex')] }) },
      undefined,
      undefined,
      actionOperations as any,
    );

    const response = await app.request('/station/conversations/c1/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'codex' }),
    });

    expect(response.status).toBe(200);
    expect(createTargetConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSlug: 'private-project',
      }),
    );
    expect(eventStore.appendConversationFork).toHaveBeenCalledOnce();
    expect(actionOperations.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'fork-user' }),
      expect.objectContaining({
        title: 'Fork conversation',
        domain: expect.objectContaining({
          kind: 'conversation-fork',
          sourceConversationId: 'c1',
        }),
      }),
    );
    expect(actionOperations.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId: 'fork-user' }),
      'fork-operation',
      { expectedRevision: 2, status: 'succeeded' },
    );
  });

  test('fork clones the selected completed slice once and returns the same child on retry', async () => {
    const source = createMockAdapter();
    source.getMessages.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'first' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'first answer',
        metadata: {
          turnId: 'turn-1',
          sessionId: 'session-1',
          answerEligible: true,
        },
      },
      { id: 'u2', role: 'user', content: 'later prompt' },
      {
        id: 'a2',
        role: 'assistant',
        content: 'later answer',
        metadata: { turnId: 'turn-2', answerEligible: true },
      },
    ]);
    const target = createMockAdapter();
    target.getConversation.mockResolvedValue(null);
    const forks: any[] = [];
    const eventStore = {
      appendConversationFork: vi.fn((event) => forks.push(event)),
      appendConversationForkIfAbsent: vi.fn((event) => {
        if (forks.some((fork) => fork.eventId === event.eventId)) return false;
        forks.push(event);
        return true;
      }),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: forks })),
    };
    const app = createConversationRoutes(
      new Map([
        ['default', source],
        ['codex', target],
      ]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'fork-user',
      undefined,
      undefined,
      eventStore,
      () => true,
    );
    const request = () =>
      app.request('/station/conversations/c1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetAgent: 'codex',
          branchPointTurnId: 'turn-1',
          idempotencyKey: 'retry-1',
        }),
      });

    const [firstResponse, secondResponse] = await Promise.all([
      request(),
      request(),
    ]);
    const first = await json(firstResponse);
    const second = await json(secondResponse);

    expect(first.data).toMatchObject({
      branchPointTurnId: 'turn-1',
      sourceSessionId: 'session-1',
      continuation: 'replay-seed',
      idempotent: false,
    });
    expect(first.data.disclosure).toContain('cursor');
    expect(second.data).toMatchObject({
      conversationId: first.data.conversationId,
      idempotent: true,
    });
    expect(target.createConversation).toHaveBeenCalledOnce();
    expect(target.addMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          metadata: expect.objectContaining({ forkSourceMessageId: 'u1' }),
        }),
        expect.objectContaining({
          role: 'assistant',
          metadata: expect.objectContaining({ forkSourceMessageId: 'a1' }),
        }),
      ]),
      'fork-user',
      first.data.conversationId,
    );
    expect(target.addMessages.mock.calls[0][0]).toHaveLength(2);
    expect(eventStore.appendConversationForkIfAbsent).toHaveBeenCalledOnce();
  });

  test('DELETE /:slug/conversations/:id deletes its owner-scoped derived summary', async () => {
    const adapter = createMockAdapter();
    const adapters = new Map([['default', adapter]]);
    const summaries = {
      read: vi.fn(),
      write: vi.fn(),
      dismiss: vi.fn(),
    };
    const app = createConversationRoutes(
      adapters as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'delete-user',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      summaries,
    );
    const body = await json(
      await app.request('/station/conversations/c1', { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
    expect(adapter.deleteConversation).toHaveBeenCalledWith('c1');
    expect(summaries.dismiss).toHaveBeenCalledWith({
      ownerScope: 'user:delete-user',
      agentSlug: 'default',
      conversationId: 'c1',
    });
  });

  // archive#1566: a rename always stamps `titleSource: 'user'` into
  // metadata (merged with whatever metadata already existed on the
  // conversation), even though this PATCH body carries no `metadata` field
  // of its own — see `sanitizePublicConversationUpdate`.
  test('PATCH /:slug/conversations/:id updates title and stamps titleSource user', async () => {
    const adapter = createMockAdapter();
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Title' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(adapter.updateConversation).toHaveBeenCalledWith('c1', {
      title: 'New Title',
      metadata: { existing: 'value', titleSource: 'user' },
    });
  });

  // archive#1566: a rename's titleSource:'user' stamp must survive
  // alongside a caller-supplied metadata patch too, not just the
  // no-metadata-in-body case above.
  test('PATCH /:slug/conversations/:id stamps titleSource user alongside an explicit metadata update', async () => {
    const adapter = createMockAdapter();
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New Title',
          metadata: { color: 'blue' },
        }),
      }),
    );
    expect(body.success).toBe(true);
    expect(adapter.updateConversation).toHaveBeenCalledWith('c1', {
      title: 'New Title',
      metadata: { existing: 'value', color: 'blue', titleSource: 'user' },
    });
  });

  // archive#1566: a metadata-only PATCH (no title in the body) must NOT
  // stamp titleSource:'user' — only a real rename should mark the title as
  // human-owned.
  test('PATCH /:slug/conversations/:id does not stamp titleSource when only metadata changes (no rename)', async () => {
    const adapter = createMockAdapter();
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { color: 'blue' } }),
      }),
    );
    expect(body.success).toBe(true);
    expect(adapter.updateConversation).toHaveBeenCalledWith('c1', {
      metadata: { existing: 'value', color: 'blue' },
    });
  });

  test('rejects rename and delete for runtime-owned conversation history', async () => {
    const adapter = createMockAdapter();
    const reader = {
      readSessionMessages: vi.fn().mockReturnValue([]),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
      }),
      readSessionConversation: vi.fn().mockResolvedValue({
        id: 'thread-runtime',
        agentSlug: 'default',
        title: 'Runtime title',
        createdAt: '2026-07-23T00:00:00Z',
        updatedAt: '2026-07-23T00:01:00Z',
        messageCount: 2,
        mutable: false as const,
      }),
    };
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
      () => 'bound-user',
    );

    const rename = await app.request('/station/conversations/thread-runtime', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cannot rename' }),
    });
    const remove = await app.request('/station/conversations/thread-runtime', {
      method: 'DELETE',
    });

    expect(rename.status).toBe(409);
    expect(remove.status).toBe(409);
    expect(adapter.updateConversation).not.toHaveBeenCalled();
    expect(adapter.deleteConversation).not.toHaveBeenCalled();
    expect(reader.readSessionConversation).toHaveBeenCalledWith(
      'thread-runtime',
      expect.objectContaining({ userId: 'bound-user', mode: 'personal' }),
    );
  });

  test('PATCH /:slug/conversations/:id preserves existing ACP session metadata when public metadata omits it', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue({
      id: 'c1',
      userId: 'agent:default',
      title: 'Test Chat',
      metadata: {
        acpSessionId: 'acp-session-original',
        existing: 'value',
      },
    });
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: {
            color: 'blue',
          },
        }),
      }),
    );
    expect(body.success).toBe(true);
    expect(adapter.updateConversation).toHaveBeenCalledWith('c1', {
      metadata: {
        acpSessionId: 'acp-session-original',
        color: 'blue',
        existing: 'value',
      },
    });
  });

  test('PATCH /:slug/conversations/:id strips spoofed ACP session metadata while preserving title updates', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue({
      id: 'c1',
      userId: 'agent:default',
      title: 'Test Chat',
      metadata: {
        acpSessionId: 'acp-session-original',
        existing: 'value',
      },
    });
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New Title',
          metadata: {
            acpSessionId: 'attacker-session',
            color: 'blue',
          },
        }),
      }),
    );
    expect(body.success).toBe(true);
    expect(adapter.updateConversation).toHaveBeenCalledWith('c1', {
      title: 'New Title',
      metadata: {
        acpSessionId: 'acp-session-original',
        color: 'blue',
        existing: 'value',
        titleSource: 'user',
      },
    });
  });

  // S1 of archive#1302: the metadata merge in `sanitizePublicConversationUpdate`
  // preserves arbitrary existing fields the client's PATCH body doesn't
  // mention — pinning this for `projectSlug` specifically (not just the
  // `acpSessionId` case already covered above) so a title/color rename
  // never silently drops the conversation's project attribution.
  test('PATCH /:slug/conversations/:id preserves existing projectSlug metadata when public metadata omits it', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue({
      id: 'c1',
      userId: 'agent:default',
      title: 'Test Chat',
      metadata: {
        projectSlug: 'my-project',
        existing: 'value',
      },
    });
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New Title',
          metadata: {
            color: 'blue',
          },
        }),
      }),
    );
    expect(body.success).toBe(true);
    expect(adapter.updateConversation).toHaveBeenCalledWith('c1', {
      title: 'New Title',
      metadata: {
        projectSlug: 'my-project',
        color: 'blue',
        existing: 'value',
        titleSource: 'user',
      },
    });
  });

  test.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
  ])(
    'PATCH /:slug/conversations/:id ignores %s metadata so ACP session metadata is not erased',
    async (_label, metadata) => {
      const adapter = createMockAdapter();
      adapter.getConversation.mockResolvedValue({
        id: 'c1',
        userId: 'agent:default',
        title: 'Test Chat',
        metadata: {
          acpSessionId: 'acp-session-original',
          existing: 'value',
        },
      });
      const adapters = new Map([['default', adapter]]);
      const app = createConversationRoutes(adapters as any, mockLogger);
      const body = await json(
        await app.request('/station/conversations/c1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'New Title',
            metadata,
          }),
        }),
      );
      expect(body.success).toBe(true);
      // archive#1566: a rename still stamps titleSource:'user' even when the
      // metadata payload itself was invalid and stripped — existing valid
      // metadata (here, the real acpSessionId) survives alongside it.
      expect(adapter.updateConversation).toHaveBeenCalledWith('c1', {
        title: 'New Title',
        metadata: {
          acpSessionId: 'acp-session-original',
          existing: 'value',
          titleSource: 'user',
        },
      });
    },
  );

  test('bounded conversation pager fails closed on a stalled cursor and reauthorizes every page', async () => {
    const authority = alphaAuthority();
    const readConversationEventWindow = vi.fn(
      async (_conversationId: string, _options: { authority: unknown }) => ({
        watermark: 1,
        events: [],
        hasMore: true,
        nextCursor: 'same-cursor',
      }),
    );
    const result = await readCompleteForkConversationWindow(
      { readConversationEventWindow } as any,
      'conversation',
      authority,
    );
    expect(result).toEqual({
      status: 'incomplete',
      reason: 'conversation cursor stalled',
    });
    expect(readConversationEventWindow).toHaveBeenCalledTimes(2);
    expect(
      readConversationEventWindow.mock.calls.every(
        ([, options]) => options.authority === authority,
      ),
    ).toBe(true);
  });

  test.each([
    [
      'thrown read',
      async () => {
        throw new Error('cursor decode failed');
      },
      'conversation page read failed',
    ],
    [
      'numeric cursor',
      async () => ({ watermark: 1, events: [], hasMore: true, nextCursor: 42 }),
      'conversation cursor stalled',
    ],
    [
      'overlong cursor',
      async () => ({
        watermark: 1,
        events: [],
        hasMore: true,
        nextCursor: 'x'.repeat(513),
      }),
      'conversation cursor stalled',
    ],
  ])(
    'bounded conversation pager classifies %s as incomplete',
    async (_name, implementation, reason) => {
      const result = await readCompleteForkConversationWindow(
        { readConversationEventWindow: vi.fn(implementation) } as any,
        'conversation',
        alphaAuthority(),
      );
      expect(result).toEqual({ status: 'incomplete', reason });
    },
  );

  test('bounded conversation pager times out a hung page read', async () => {
    const result = await readCompleteForkConversationWindow(
      {
        readConversationEventWindow: vi.fn(() => new Promise(() => {})),
      } as any,
      'conversation',
      alphaAuthority(),
    );
    expect(result).toEqual({
      status: 'incomplete',
      reason: 'conversation history read timed out',
    });
  }, 5_000);

  test.each(['events', 'bytes', 'pages'])(
    'bounded conversation pager enforces the %s limit',
    async (limit) => {
      let call = 0;
      const event = {
        eventId: 'e',
        provider: 'codex',
        threadId: 'session',
        method: 'turn.completed',
        createdAt: '2026-01-01T00:00:00Z',
        ...(limit === 'bytes'
          ? { outputText: 'x'.repeat(2 * 1024 * 1024) }
          : {}),
      };
      const readConversationEventWindow = vi.fn(async () => {
        call += 1;
        return {
          watermark: call,
          events:
            limit === 'events'
              ? Array.from({ length: 3_201 }, (_, sequence) => ({
                  sequence,
                  event: { ...event, eventId: `e-${sequence}` },
                }))
              : [{ sequence: call, event }],
          hasMore: limit === 'pages',
          ...(limit === 'pages' ? { nextCursor: `page-${call}` } : {}),
        };
      });
      const result = await readCompleteForkConversationWindow(
        { readConversationEventWindow } as any,
        'conversation',
        alphaAuthority(),
      );
      expect(result.status).toBe('incomplete');
      expect((result as { reason: string }).reason).toMatch(
        limit === 'pages' ? /page limit/ : /exceeds fork limits/,
      );
    },
  );

  test.each([
    ['missing', undefined, 'conversation event sequence is malformed'],
    ['NaN', Number.NaN, 'conversation event sequence is malformed'],
  ])(
    'bounded conversation pager rejects %s global sequence',
    async (_name, sequence, reason) => {
      const result = await readCompleteForkConversationWindow(
        {
          readConversationEventWindow: vi.fn(async () => ({
            watermark: 1,
            events: [
              {
                sequence,
                event: {
                  eventId: 'e1',
                  provider: 'codex',
                  threadId: 's',
                  method: 'turn.completed',
                  createdAt: '2026-01-01T00:00:00Z',
                },
              },
            ],
            hasMore: false,
          })),
        } as any,
        'conversation',
        alphaAuthority(),
      );
      expect(result).toEqual({ status: 'incomplete', reason });
    },
  );

  test('bounded conversation pager dedupes overlap but rejects distinct IDs sharing a sequence', async () => {
    let page = 0;
    const event = (eventId: string) => ({
      sequence: 1,
      event: {
        eventId,
        provider: 'codex',
        threadId: 's',
        method: 'turn.completed',
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    const reader = {
      readConversationEventWindow: vi.fn(async () => {
        page += 1;
        return page === 1
          ? {
              watermark: 2,
              events: [event('same')],
              hasMore: true,
              nextCursor: 'next',
            }
          : {
              watermark: 2,
              events: [event('same'), event('conflict')],
              hasMore: false,
            };
      }),
    };
    const result = await readCompleteForkConversationWindow(
      reader as any,
      'conversation',
      alphaAuthority(),
    );
    expect(result).toEqual({
      status: 'incomplete',
      reason: 'conversation event sequence conflicts',
    });
  });

  test.each([
    '550e8400-e29b-41d4-a716-446655440000',
    'user:fork:abcdef',
    'conversation:session:2',
    'plugin+opaque==',
    'abc..def',
    'codex:1787679248936',
  ])('accepts opaque safe conversation id %s', async (conversationId) => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue({
      id: conversationId,
      resourceId: 'codex',
      title: 'Opaque source',
    });
    adapter.getMessages.mockResolvedValue(completedForkTranscript());
    const forks: any[] = [];
    const app = createConversationRoutes(
      new Map([['codex', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => adapter as any,
      undefined,
      () => 'user',
      undefined,
      undefined,
      {
        appendConversationFork: vi.fn((event) => forks.push(event)),
        appendConversationForkIfAbsent: vi.fn((event) => {
          forks.push(event);
          return true;
        }),
        readConversationForkProvenance: vi.fn(() => ({ forkedTo: forks })),
      },
      () => true,
    );
    const response = await app.request(
      `/codex/conversations/${encodeURIComponent(conversationId)}/fork`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetAgent: 'codex' }),
      },
    );
    expect(response.status).toBe(200);
  });

  test('binds orchestration source ownership to the selected historical Session after handoff', async () => {
    const principal = resolvePrincipal(
      null,
      'personal',
      {
        locality: 'home-possession',
      },
      undefined,
    );
    const principalAuthority = sessionReadAuthorityFromRequest(
      principal.id,
      undefined,
      undefined,
    );
    let forkAuthority = sessionReadAuthorityFromRequest(
      'os-account-alias',
      undefined,
      undefined,
    );
    let unresolvedCaller = false;
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue(null);
    adapter.getMessages.mockResolvedValue([]);
    const reader = {
      ...emptyHistoryReader(),
      readSessionConversation: vi.fn(async (id: string, authority) =>
        authority.userId !== principal.id || id === 'handoff-conversation'
          ? null
          : {
              id,
              title: 'Handoff conversation',
              agentSlug: id === 'session-codex' ? 'codex' : 'claude',
            },
      ),
      readSessionMessages: vi.fn(() => []),
      readConversationEventWindow: vi.fn(async (_id, options) =>
        options.authority.userId !== principal.id
          ? null
          : {
              watermark: 6,
              currentSessionId: 'session-claude',
              session: { displayTitle: 'Handoff conversation' },
              sessionLineage: [
                { sessionId: 'session-codex', agentSlug: 'codex' },
                { sessionId: 'session-claude', agentSlug: 'claude' },
              ],
              events: [
                {
                  event: {
                    eventId: 'e1',
                    provider: 'codex',
                    threadId: 'session-codex',
                    turnId: 'turn-codex',
                    method: 'turn.started',
                    createdAt: '2026-01-01T00:00:00Z',
                    prompt: 'before',
                  },
                },
                {
                  event: {
                    eventId: 'e2',
                    provider: 'codex',
                    threadId: 'session-codex',
                    turnId: 'turn-codex',
                    method: 'content.text-delta',
                    createdAt: '2026-01-01T00:00:01Z',
                    itemId: 'a1',
                    delta: 'codex answer',
                  },
                },
                {
                  event: {
                    eventId: 'e3',
                    provider: 'codex',
                    threadId: 'session-codex',
                    turnId: 'turn-codex',
                    method: 'turn.completed',
                    createdAt: '2026-01-01T00:00:02Z',
                    outputText: 'codex answer',
                  },
                },
                {
                  event: {
                    eventId: 'e4',
                    provider: 'claude',
                    threadId: 'session-claude',
                    turnId: 'turn-claude',
                    method: 'turn.started',
                    createdAt: '2026-01-01T00:00:03Z',
                    prompt: 'after',
                  },
                },
                {
                  event: {
                    eventId: 'e5',
                    provider: 'claude',
                    threadId: 'session-claude',
                    turnId: 'turn-claude',
                    method: 'content.text-delta',
                    createdAt: '2026-01-01T00:00:04Z',
                    itemId: 'a2',
                    delta: 'claude answer',
                  },
                },
                {
                  event: {
                    eventId: 'e6',
                    provider: 'claude',
                    threadId: 'session-claude',
                    turnId: 'turn-claude',
                    method: 'turn.completed',
                    createdAt: '2026-01-01T00:00:05Z',
                    outputText: 'claude answer',
                  },
                },
              ]
                .map((item, index) => ({ ...item, sequence: index + 1 }))
                .slice(options.cursor ? 0 : 2, options.cursor ? 3 : 6),
              hasMore: !options.cursor,
              ...(options.cursor ? {} : { nextCursor: 'page-2' }),
            },
      ),
    };
    const forks: any[] = [];
    const app = createConversationRoutes(
      new Map([
        ['codex', adapter],
        ['claude', adapter],
      ]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => adapter as any,
      reader as any,
      () => 'user',
      undefined,
      undefined,
      {
        appendConversationFork: vi.fn((event) => forks.push(event)),
        appendConversationForkIfAbsent: vi.fn((event) => {
          forks.push(event);
          return true;
        }),
        readConversationForkProvenance: vi.fn(() => ({ forkedTo: forks })),
      },
      () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        if (unresolvedCaller) throw new Error('unverified ingress');
        return forkAuthority;
      },
    );
    const request = (source: string, turn: string) =>
      app.request(`/${source}/conversations/handoff-conversation/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetAgent: source,
          branchPointTurnId: turn,
          idempotencyKey: `${source}-${turn}`,
        }),
      });
    const claude = await request('claude', 'turn-claude');
    expect(claude.status).toBe(404);
    expect(forks).toHaveLength(0);
    forkAuthority = principalAuthority;
    reader.readConversationEventWindow.mockClear();
    const authorizedClaude = await request('claude', 'turn-claude');
    expect(
      authorizedClaude.status,
      JSON.stringify(await json(authorizedClaude.clone())),
    ).toBe(200);
    expect((await request('codex', 'turn-claude')).status).toBe(409);
    expect((await request('codex', 'turn-codex')).status).toBe(200);
    expect(
      reader.readConversationEventWindow.mock.calls.length,
    ).toBeGreaterThan(3);
    expect(
      reader.readConversationEventWindow.mock.calls.every(
        ([, options]) => options.authority.userId === principal.id,
      ),
    ).toBe(true);
    forkAuthority = sessionReadAuthorityFromRequest(
      'human:oidc:other-owner',
      undefined,
      undefined,
    );
    const factsBeforeOtherOwner = forks.length;
    expect((await request('codex', 'turn-codex')).status).toBe(404);
    expect(forks).toHaveLength(factsBeforeOtherOwner);
    unresolvedCaller = true;
    const factCount = forks.length;
    reader.readConversationEventWindow.mockClear();
    expect((await request('codex', 'turn-codex')).status).toBe(403);
    expect(reader.readConversationEventWindow).not.toHaveBeenCalled();
    expect(forks).toHaveLength(factCount);
  });

  test.each([
    ['missing sourceSessionId', undefined, true],
    ['pruned exact source Session', 'session-pruned', false],
  ])(
    'orchestration fork rejects %s before every target/fact/action effect',
    async (_caseName, sourceSessionId, exactSessionExists) => {
      const source = createMockAdapter();
      source.getConversation.mockResolvedValue(null);
      source.getMessages.mockResolvedValue([]);
      const target = createMockAdapter();
      target.getConversation.mockResolvedValue(null);
      const transcript = [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'prompt' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'answer' }],
          metadata: {
            turnId: 'turn-1',
            ...(sourceSessionId ? { sessionId: sourceSessionId } : {}),
            answerEligible: true,
          },
        },
      ];
      const reader = {
        ...emptyHistoryReader(),
        readSessionConversation: vi.fn(async (id: string) => {
          if (id === 'conversation')
            return { id, title: 'Conversation', agentSlug: 'claude' };
          return exactSessionExists
            ? { id, title: 'Session', agentSlug: 'claude' }
            : null;
        }),
        readSessionMessages: vi.fn(() => transcript),
      };
      const eventStore = {
        appendConversationFork: vi.fn(),
        appendConversationForkIfAbsent: vi.fn(),
        readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
      };
      const actionOperations = { create: vi.fn(), update: vi.fn() };
      const app = createConversationRoutes(
        new Map([['claude', source]]) as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => target as any,
        reader as any,
        () => 'user',
        undefined,
        undefined,
        eventStore,
        () => true,
        undefined,
        undefined,
        undefined,
        undefined,
        actionOperations as any,
      );
      const before = {
        create: target.createConversation.mock.calls.length,
        messages: target.addMessages.mock.calls.length,
        facts: eventStore.appendConversationFork.mock.calls.length,
        conditionalFacts:
          eventStore.appendConversationForkIfAbsent.mock.calls.length,
        actions: actionOperations.create.mock.calls.length,
      };
      const response = await app.request(
        '/claude/conversations/conversation/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetAgent: 'target',
            branchPointTurnId: 'turn-1',
          }),
        },
      );
      expect(response.status).toBe(409);
      expect({
        create: target.createConversation.mock.calls.length,
        messages: target.addMessages.mock.calls.length,
        facts: eventStore.appendConversationFork.mock.calls.length,
        conditionalFacts:
          eventStore.appendConversationForkIfAbsent.mock.calls.length,
        actions: actionOperations.create.mock.calls.length,
      }).toEqual(before);
    },
  );

  test('GET /:slug/conversations/:id/messages returns messages', async () => {
    const adapters = new Map([['default', createMockAdapter()]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1/messages'),
    );
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  test('GET /:slug/conversations/:id/messages resolves its store via the shared conversation-transcript-source resolver (station#4080 slice 1 follow-up)', async () => {
    // Pins the H2 core-reshape doctrine: `readConversationMessages` and
    // `OrchestrationService.InterruptedTurnRecovery.consume` must consume
    // the SAME resolver, not two independently maintained copies of the
    // same lookup. This spies on the real implementation (wired at the top
    // of this file) rather than faking it, so a regression that bypasses
    // the shared helper — reintroducing an inline mirror — reds here even
    // though the route's own response stays correct either way.
    (resolveConversationTranscriptSource as any).mockClear();
    const adapters = new Map([['default', createMockAdapter()]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    await app.request('/station/conversations/c1/messages');
    expect(resolveConversationTranscriptSource).toHaveBeenCalledWith(
      expect.anything(),
      'agent:default',
      'c1',
    );
  });

  // archive#1399 fix round 2, B2 (independent review) — the FileMemory
  // bypass reproduction: `memory-adapter-messages.ts` serializes and reads
  // back a message's `parts` VERBATIM, with no equivalent write-time seam
  // to `publishCanonicalEvent`'s. A well-shaped forged tuple (real
  // derivedFrom + fake digest + attestationState already 'attested', all
  // mutually consistent) stored there must not survive the `/messages`
  // route serving it — this is the SERVE-boundary control the ruling
  // requires, independent of any write-time fix.
  test('GET /:slug/conversations/:id/messages sanitizes a forged uiBlock read back from the FileMemory store', async () => {
    const adapter = createMockAdapter();
    adapter.getMessages.mockResolvedValue([
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-render_summary',
            toolCallId: 'call-1',
            output: {
              uiBlocks: [
                {
                  type: 'table',
                  columns: ['Metric', 'Value'],
                  rows: [['Coverage', 98]],
                  derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call-1' }],
                  provenanceDigest: 'b'.repeat(64),
                  attestationState: 'attested',
                },
              ],
            },
          },
        ],
      },
    ]);
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1/messages'),
    );

    expect(body.success).toBe(true);
    const output = body.data[0].parts[0].output as {
      uiBlocks: Array<Record<string, unknown>>;
    };
    // The block IS genuinely data-bearing with a real source, so it is
    // correctly served as 'attested' — but with the HOST'S digest, never
    // the forged one the store happened to contain.
    expect(output.uiBlocks[0]!.attestationState).toBe('attested');
    expect(output.uiBlocks[0]!.provenanceDigest).not.toBe('b'.repeat(64));
  });

  test('GET /:slug/conversations/:id/messages downgrades a forged attested claim with no real sources', async () => {
    const adapter = createMockAdapter();
    adapter.getMessages.mockResolvedValue([
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-render_summary',
            toolCallId: 'call-1',
            output: {
              uiBlock: {
                type: 'card',
                body: 'All checks passed',
                fields: [{ label: 'Coverage', value: '98%' }],
                // No real derivedFrom — a bare forged claim.
                attestationState: 'attested',
                provenanceDigest: 'a'.repeat(64),
              },
            },
          },
        ],
      },
    ]);
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const body = await json(
      await app.request('/station/conversations/c1/messages'),
    );

    expect(body.success).toBe(true);
    const output = body.data[0].parts[0].output as {
      uiBlock: Record<string, unknown>;
    };
    expect(output.uiBlock.attestationState).toBe('unattested');
    expect(output.uiBlock.provenanceDigest).toBeUndefined();
  });

  test('GET messages falls back to projected session events when the store is empty', async () => {
    const emptyAdapter = {
      getMessages: vi.fn().mockResolvedValue([]),
      getConversation: vi.fn().mockResolvedValue(null),
    };
    const adapters = new Map([['claude-rt', emptyAdapter]]);
    const reader = {
      readSessionMessages: vi.fn().mockReturnValue([
        {
          id: 'm0',
          role: 'assistant',
          parts: [{ type: 'text', text: 'from events' }],
        },
      ]),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
      }),
      readSessionConversation: vi.fn().mockResolvedValue(null),
    };
    const app = createConversationRoutes(
      adapters as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
      () => 'bound-user',
    );
    const body = await json(
      await app.request('/claude-rt/conversations/conv-1/messages'),
    );
    expect(reader.readSessionMessages).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ userId: 'bound-user', mode: 'personal' }),
    );
    expect(body.success).toBe(true);
    expect(body.data).toEqual([
      {
        id: 'm0',
        role: 'assistant',
        parts: [{ type: 'text', text: 'from events' }],
      },
    ]);
    expect(conversationOps.add).toHaveBeenCalledWith(1, {
      operation: 'history_restore',
      source: 'orchestration',
      outcome: 'restored',
    });
  });

  test('GET /:slug/conversations/:id/stats threads the session-usage reader through to getConversationStats (station#1299 slice 1)', async () => {
    (getConversationStats as any).mockClear();
    // Pre-existing/unrelated fix-forward (typecheck:server-tests, unrelated
    // to station#settings-revamp): `SessionMessageReader` only makes
    // `readSessionUsage` optional (see its doc comment) — the remaining
    // methods are required, mirroring the full-reader literals used
    // elsewhere in this file.
    const reader = {
      // The full SessionMessageReader surface: archive#1324's original fixture
      // predated the S1/S2 interface convergence and carried only
      // readSessionUsage, which no longer satisfies the type.
      readSessionMessages: vi.fn().mockReturnValue([]),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
      }),
      readSessionConversation: vi.fn().mockResolvedValue(null),
      readSessionUsage: vi.fn().mockReturnValue({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        turns: 1,
        toolCalls: 0,
      }),
    };
    const app = createConversationRoutes(
      new Map() as any,
      mockLogger,
      new Map(),
      new Map(),
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
      () => 'bound-user',
    );

    await app.request('/claude-rt/conversations/conv-1/stats');

    expect(getConversationStats).toHaveBeenCalled();
    const args = (getConversationStats as any).mock.calls[0];
    const readSessionUsageArg = args[9] as (threadId: string) => unknown;
    expect(typeof readSessionUsageArg).toBe('function');

    const result = readSessionUsageArg('conv-1');
    expect(reader.readSessionUsage).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ userId: 'bound-user', mode: 'personal' }),
    );
    expect(result).toMatchObject({ totalTokens: 15 });
  });

  test('GET /:slug/conversations/:id/stats omits an unresolved context-window percentage from the wire response', async () => {
    (getConversationStats as any).mockResolvedValueOnce({
      inputTokens: 50_000,
      outputTokens: 0,
      totalTokens: 50_000,
      turns: 1,
      toolCalls: 0,
      estimatedCost: 0,
      modelId: 'test-model',
      systemPromptTokens: 0,
      mcpServerTokens: 0,
      userMessageTokens: 50_000,
      assistantMessageTokens: 0,
      contextFilesTokens: 0,
      contextWindowPercentage: undefined,
    });
    const app = createConversationRoutes(new Map() as any, mockLogger);

    const body = await json(
      await app.request('/claude-rt/conversations/conv-unresolved/stats'),
    );

    expect(body.data).toMatchObject({ inputTokens: 50_000 });
    expect(body.data).not.toHaveProperty('contextWindowPercentage');
  });

  test('GET stats rejects a malformed shared response instead of serializing false telemetry', async () => {
    (getConversationStats as any).mockResolvedValueOnce({ totalTokens: -1 });
    const app = createConversationRoutes(new Map() as any, mockLogger);
    const response = await app.request('/claude-rt/conversations/bad/stats');
    expect(response.status).toBe(500);
    expect((await json(response)).success).toBe(false);
  });
});

describe('Global Conversation Routes', () => {
  test('GET /search preserves local results and projects the remote instance outcome', async () => {
    const reader = {
      searchSessionMessages: vi.fn(() => [
        {
          conversationId: 'local-thread',
          messageId: 'local-message',
          role: 'assistant' as const,
          excerpt: 'local cobalt',
          agentSlug: 'claude-rt',
        },
      ]),
      readSessionConversation: vi.fn(),
      listConversationHistoryPage: vi.fn(),
    };
    const searchRemoteMessages = vi.fn(async () => ({
      matches: [
        {
          conversationId: 'remote-thread',
          messageId: 'remote-message',
          sourceInstanceId: 'remote-1',
          sourceInstanceName: 'Second Station',
          role: 'assistant' as const,
          excerpt: 'remote cobalt',
          agentSlug: 'claude-rt',
        },
      ],
      instances: [
        {
          instanceId: 'remote-1',
          instanceName: 'Second Station',
          status: 'available' as const,
        },
      ],
      deferredInstanceCount: 0,
    }));
    const app = createGlobalConversationRoutes(
      new Map(),
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      reader as any,
      () => 'owner-alpha',
      undefined,
      undefined,
      undefined,
      searchRemoteMessages,
    );

    const body = await json(await app.request('/search?query=cobalt'));

    expect(body).toEqual({
      success: true,
      data: [
        expect.objectContaining({ conversationId: 'local-thread' }),
        expect.objectContaining({
          conversationId: 'remote-thread',
          sourceInstanceId: 'remote-1',
          sourceInstanceName: 'Second Station',
        }),
      ],
      deferredInstanceCount: 0,
      instances: [
        {
          instanceId: 'local',
          instanceName: 'This Station',
          status: 'available',
        },
        {
          instanceId: 'remote-1',
          instanceName: 'Second Station',
          status: 'available',
        },
      ],
    });
    expect(searchRemoteMessages).toHaveBeenCalledWith(
      'cobalt',
      expect.any(AbortSignal),
    );
  });

  test('GET /search reports an empty local Station without a remote fan-out', async () => {
    const reader = {
      searchSessionMessages: vi.fn(() => []),
      readSessionConversation: vi.fn(),
      listConversationHistoryPage: vi.fn(),
    };
    const app = createGlobalConversationRoutes(
      new Map(),
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      reader as any,
    );

    expect(await json(await app.request('/search?query=cobalt'))).toEqual({
      success: true,
      data: [],
      instances: [
        { instanceId: 'local', instanceName: 'This Station', status: 'empty' },
      ],
      deferredInstanceCount: 0,
    });
  });

  test('GET / enforces the history page limit and forwards an opaque cursor to the indexed runtime reader', async () => {
    const reader = {
      readSessionConversation: vi.fn(),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'thread-1',
            source: 'runtime',
            agentSlug: 'claude',
            title: 'Indexed history',
            createdAt: '2026-08-08T12:00:00.000Z',
            updatedAt: '2026-08-08T12:01:00.000Z',
            messageCount: 2,
            mutable: false,
            answerability: { answerable: true },
          },
        ],
        hasMore: true,
        nextCursor: 'opaque-next-cursor',
      }),
    };
    const app = createGlobalConversationRoutes(
      new Map(),
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      reader,
      () => 'owner-alpha',
      undefined,
      alphaAuthority,
    );

    const invalid = await json(await app.request('/?limit=101'));
    expect(invalid).toMatchObject({ success: false });

    const response = await json(
      await app.request('/?limit=2&cursor=opaque-current-cursor'),
    );
    expect(response).toEqual({
      success: true,
      data: {
        items: [expect.objectContaining({ id: 'thread-1' })],
        hasMore: true,
        nextCursor: 'opaque-next-cursor',
      },
    });
    expect(reader.listConversationHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'alpha-user', mode: 'hosted' }),
      { limit: 2, cursor: 'opaque-current-cursor' },
    );
  });

  test('hosted inventory and lookup skip unbound file records without adapter scans', async () => {
    const adapter = createMockAdapter();
    const storage = { getConversation: vi.fn().mockReturnValue(adapter) };
    const reader = {
      readSessionConversation: vi.fn().mockResolvedValue({
        id: 'alpha-thread',
        agentSlug: 'station',
        title: 'Alpha session',
        createdAt: '2026-07-23T00:00:00Z',
        updatedAt: '2026-07-23T00:01:00Z',
        messageCount: 1,
        mutable: false,
      }),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
      }),
    };
    const app = createGlobalConversationRoutes(
      new Map([['default', adapter]]) as any,
      storage as any,
      mockLogger,
      undefined,
      reader,
      () => 'alpha-user',
      undefined,
      alphaAuthority,
    );

    const inventory = await json(await app.request('/'));
    const detail = await json(await app.request('/alpha-thread'));

    expect(inventory.data).toEqual({ items: [], hasMore: false });
    expect(detail.data).toMatchObject({ id: 'alpha-thread' });
    expect(storage.getConversation).not.toHaveBeenCalled();
    expect(adapter.getConversations).not.toHaveBeenCalled();
    expect(adapter.getConversation).not.toHaveBeenCalled();
    expect(reader.listConversationHistoryPage).toHaveBeenCalledWith(
      alphaAuthority(),
      { limit: 100, cursor: undefined },
    );
    expect(reader.readSessionConversation).toHaveBeenCalledWith(
      'alpha-thread',
      alphaAuthority(),
    );
  });

  // S2 of archive#1302: the global conversation-inventory endpoint. Folds the
  // orchestration session leg (across every agent) and every registered
  // adapter's file-store conversations, tags each item's `source`, and
  // pins that `projectSlug` survives on both legs.
  test('GET / folds file-store and session conversations, tagging source and carrying projectSlug on both legs', async () => {
    const adapter = createMockAdapter();
    adapter.queryConversations.mockResolvedValue([
      {
        id: 'store-1',
        userId: 'agent:default',
        resourceId: 'default',
        title: 'Store Chat',
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:01:00Z',
        metadata: { projectSlug: 'proj-store' },
      },
    ]);
    const reader = {
      readSessionConversation: vi.fn(),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        hasMore: false,
        items: [
          {
            id: 'thread-1',
            source: 'runtime',
            agentSlug: 'claude',
            projectSlug: 'proj-runtime',
            title: 'Runtime Chat',
            createdAt: '2026-07-23T00:00:00Z',
            updatedAt: '2026-07-23T00:01:00Z',
            messageCount: 2,
            mutable: false,
            controlMode: 'station-owned',
            provider: 'claude',
          },
        ],
      }),
    };
    const app = createGlobalConversationRoutes(
      new Map([['default', adapter]]) as any,
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      reader,
      () => 'bound-user',
    );

    const body = await json(await app.request('/'));

    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([
      expect.objectContaining({
        id: 'thread-1',
        source: 'runtime',
        projectSlug: 'proj-runtime',
        mutable: false,
      }),
      expect.objectContaining({
        id: 'store-1',
        source: 'store',
        agentSlug: 'station',
        projectSlug: 'proj-store',
        mutable: true,
      }),
    ]);
    // Per-user ACL: the route hands the resolved caller identity to the
    // session leg, which is where the ACL check (`canReadSession`) lives.
    expect(reader.listConversationHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'bound-user', mode: 'personal' }),
      { limit: 100, cursor: undefined },
    );
    expect(adapter.queryConversations).toHaveBeenCalledWith({
      userId: 'bound-user',
      resourceId: 'default',
      orderBy: 'updated_at',
      orderDirection: 'DESC',
      limit: 101,
    });
    expect(conversationOps.add).toHaveBeenCalledWith(1, {
      operation: 'inventory_list',
      outcome: 'available',
    });
  });

  test('GET / excludes another user file-store conversations at the adapter boundary', async () => {
    const adapter = createMockAdapter();
    const ownerConversation = {
      id: 'owner-private',
      userId: 'owner-user',
      resourceId: 'default',
      title: 'Private owner chat',
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:01:00.000Z',
      metadata: {},
    };
    adapter.queryConversations.mockImplementation(async (options: any) => {
      // Production FileMemoryAdapter treats an absent userId as an unscoped
      // query. Model that fail-open shape so this test turns red if the route
      // ever stops passing request authority into the store boundary.
      if (options.userId === undefined) return [ownerConversation];
      return options.userId === ownerConversation.userId
        ? [ownerConversation]
        : [];
    });
    const app = createGlobalConversationRoutes(
      new Map([['default', adapter]]) as any,
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      emptyHistoryReader(),
      () => 'viewer-user',
    );

    const body = await json(await app.request('/'));

    expect(body).toEqual({
      success: true,
      data: { items: [], hasMore: false },
    });
    expect(adapter.queryConversations).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'viewer-user' }),
    );
    expect(adapter.getMessages).not.toHaveBeenCalled();
  });

  test('GET / enforces caller identity through the real file-store adapter', async () => {
    const projectHomeDir = mkdtempSync(
      join(tmpdir(), 'station-conversation-inventory-acl-'),
    );
    try {
      const adapter = new FileMemoryAdapter({ projectHomeDir });
      await adapter.createConversation({
        id: 'owner-private',
        userId: 'owner-user',
        resourceId: 'default',
        title: 'Private owner chat',
        metadata: {},
      });
      await adapter.createConversation({
        id: 'viewer-visible',
        userId: 'viewer-user',
        resourceId: 'default',
        title: 'Visible viewer chat',
        metadata: {},
      });
      const app = createGlobalConversationRoutes(
        new Map([['default', adapter]]),
        { getConversation: vi.fn().mockReturnValue(null) } as any,
        mockLogger,
        undefined,
        emptyHistoryReader(),
        () => 'viewer-user',
      );

      const body = await json(await app.request('/'));

      expect(body.data.items).toEqual([
        expect.objectContaining({
          id: 'viewer-visible',
          source: 'store',
        }),
      ]);
      expect(body.data.items).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'owner-private' }),
        ]),
      );
    } finally {
      rmSync(projectHomeDir, { recursive: true, force: true });
    }
  });

  test('GET / reports personal file-store truncation from a bounded overfetch', async () => {
    const adapter = createMockAdapter();
    const conversations = ['newest', 'middle', 'oldest'].map((id, index) => ({
      id: `store-${id}`,
      userId: 'bound-user',
      resourceId: 'default',
      title: id,
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: `2026-08-08T12:0${3 - index}:00.000Z`,
      metadata: {},
    }));
    adapter.queryConversations.mockImplementation(async (options: any) =>
      conversations.slice(0, options.limit),
    );
    const app = createGlobalConversationRoutes(
      new Map([['default', adapter]]) as any,
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      emptyHistoryReader(),
      () => 'bound-user',
    );

    const body = await json(await app.request('/?limit=2'));

    expect(body.data).toEqual({
      items: [
        expect.objectContaining({ id: 'store-newest' }),
        expect.objectContaining({ id: 'store-middle' }),
      ],
      hasMore: true,
    });
    expect(adapter.queryConversations).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'bound-user', limit: 3 }),
    );
  });

  test('GET / dedups by id with the session projection winning over the file-store leg', async () => {
    const adapter = createMockAdapter();
    adapter.queryConversations.mockResolvedValue([
      {
        id: 'shared-1',
        userId: 'agent:default',
        title: 'Stale store title',
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:01:00Z',
        metadata: {},
      },
    ]);
    const reader = {
      readSessionConversation: vi.fn(),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        hasMore: false,
        items: [
          {
            id: 'shared-1',
            source: 'runtime',
            agentSlug: 'claude',
            title: 'Live runtime title',
            createdAt: '2026-07-23T00:00:00Z',
            updatedAt: '2026-07-23T00:01:00Z',
            messageCount: 2,
            mutable: false,
          },
        ],
      }),
    };
    const app = createGlobalConversationRoutes(
      new Map([['default', adapter]]) as any,
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      reader,
      () => 'bound-user',
    );

    const body = await json(await app.request('/'));

    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      id: 'shared-1',
      source: 'runtime',
      title: 'Live runtime title',
    });
  });

  test('GET / returns one bounded personal compatibility page without a repeated local-store page', async () => {
    const adapter = createMockAdapter();
    adapter.queryConversations.mockResolvedValue([
      {
        id: 'store-newest',
        userId: 'agent:default',
        resourceId: 'default',
        title: 'Newest store chat',
        createdAt: '2026-08-08T12:00:00.000Z',
        updatedAt: '2026-08-08T12:03:00.000Z',
        metadata: {},
      },
      {
        id: 'store-oldest',
        userId: 'agent:default',
        resourceId: 'default',
        title: 'Oldest store chat',
        createdAt: '2026-08-08T12:00:00.000Z',
        updatedAt: '2026-08-08T12:00:00.000Z',
        metadata: {},
      },
    ]);
    const reader = {
      readSessionConversation: vi.fn(),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        hasMore: true,
        nextCursor: 'runtime-next',
        items: [
          {
            id: 'runtime-middle',
            source: 'runtime',
            agentSlug: 'claude',
            title: 'Runtime chat',
            createdAt: '2026-08-08T12:00:00.000Z',
            updatedAt: '2026-08-08T12:02:00.000Z',
            messageCount: 2,
            mutable: false,
            answerability: { answerable: true },
          },
        ],
      }),
    };
    const app = createGlobalConversationRoutes(
      new Map([['default', adapter]]) as any,
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      reader,
      () => 'bound-user',
    );

    const first = await json(await app.request('/?limit=2'));
    const second = await app.request('/?limit=2&cursor=runtime-next');

    expect(first.data).toEqual({
      items: [
        expect.objectContaining({ id: 'store-newest' }),
        expect.objectContaining({ id: 'runtime-middle' }),
      ],
      hasMore: true,
    });
    expect(
      new Set(first.data.items.map((item: { id: string }) => item.id)).size,
    ).toBe(2);
    expect(adapter.getMessages).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(400);
  });

  test('GET / returns the current user acknowledgement and POST records the rendered version', async () => {
    const acknowledgements = {
      get: vi.fn().mockReturnValue('2026-07-20T00:01:00.000Z'),
      acknowledge: vi.fn(),
    };
    const app = createGlobalConversationRoutes(
      new Map([['default', createMockAdapter()]]) as any,
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      {
        readSessionConversation: vi.fn(),
        listConversationHistoryPage: vi.fn().mockResolvedValue({
          items: [],
          hasMore: false,
        }),
      },
      () => 'bound-user',
      acknowledgements,
    );

    const inventory = await json(await app.request('/'));
    expect(inventory.data.items[0]).toMatchObject({
      id: 'c1',
      acknowledgedAt: '2026-07-20T00:01:00.000Z',
    });
    expect(acknowledgements.get).toHaveBeenCalledWith('bound-user', 'c1');

    const response = await app.request('/thread-1/acknowledgement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt: '2026-08-02T20:00:00Z' }),
    });
    expect(response.status).toBe(200);
    expect(acknowledgements.acknowledge).toHaveBeenCalledWith({
      userId: 'bound-user',
      conversationId: 'thread-1',
      updatedAt: '2026-08-02T20:00:00.000Z',
    });
  });

  test('POST /:id/acknowledgement rejects malformed rendered versions', async () => {
    const app = createGlobalConversationRoutes(
      new Map() as any,
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      emptyHistoryReader(),
      undefined,
      { get: vi.fn(), acknowledge: vi.fn() },
    );

    const response = await app.request('/thread-1/acknowledgement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt: 'not-a-date' }),
    });
    expect(response.status).toBe(400);
  });

  test('hosted acknowledgements require a centrally authorized session before writing', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.station.test' },
        { id: 'bravo', authority: 'bravo.station.test' },
      ],
    });
    const authorityFor = (request: Request) => {
      const tenant = request.headers.get('x-test-tenant');
      return sessionReadAuthorityFromRequest(
        'shared-user',
        tenant === 'alpha' || tenant === 'bravo'
          ? { tenantId: tenantId(tenant) }
          : undefined,
        registry,
      );
    };
    const readSessionConversation = vi.fn(
      (_id: string, authority: ReturnType<typeof authorityFor>) =>
        authority.tenantExecutionContext?.tenantId === 'alpha'
          ? Promise.resolve({ id: 'alpha-thread' })
          : Promise.resolve(null),
    );
    const acknowledgements = { get: vi.fn(), acknowledge: vi.fn() };
    const app = createGlobalConversationRoutes(
      new Map() as any,
      { getConversation: vi.fn() } as any,
      mockLogger,
      undefined,
      { readSessionConversation } as any,
      () => 'shared-user',
      acknowledgements,
      authorityFor,
    );
    const request = (tenant?: string) =>
      app.request('/alpha-thread/acknowledgement', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(tenant ? { 'x-test-tenant': tenant } : {}),
        },
        body: JSON.stringify({ updatedAt: '2026-08-02T20:00:00Z' }),
      });

    const alpha = await request('alpha');
    const bravo = await request('bravo');
    const missing = await request();

    expect(alpha.status).toBe(200);
    for (const response of [bravo, missing]) {
      expect(response.status).toBe(404);
      expect(await json(response)).toEqual({
        success: false,
        error: 'Conversation not found',
      });
    }
    expect(readSessionConversation).toHaveBeenCalledTimes(2);
    expect(acknowledgements.acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledgements.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'alpha-thread' }),
    );
  });

  test('GET /:id finds conversation in adapters', async () => {
    const adapters = new Map([['default', createMockAdapter()]]);
    const storage = { getConversation: vi.fn().mockReturnValue(null) };
    const app = createGlobalConversationRoutes(
      adapters as any,
      storage as any,
      mockLogger,
      undefined,
      emptyHistoryReader(),
    );
    const body = await json(await app.request('/c1'));
    expect(body.success).toBe(true);
    expect(body.data.agentSlug).toBe('station');
  });

  // archive#801: the map key names the adapter that answered, not the owner. An
  // adapter resolves conversations stored under any agent, so the first
  // adapter iterated used to be reported as the agent — relabelling the
  // transcript under an agent that never produced it and routing the next
  // turn to that agent's model.
  test('GET /:id attributes the conversation to its owning agent, not the adapter that answered', async () => {
    const answeringAdapter = createMockAdapter();
    answeringAdapter.getConversation.mockResolvedValue({
      id: 'c1',
      resourceId: 'ollama',
      title: 'Test Chat',
    });
    const adapters = new Map([['probe-station-agent', answeringAdapter]]);
    const storage = { getConversation: vi.fn().mockReturnValue(null) };
    const app = createGlobalConversationRoutes(
      adapters as any,
      storage as any,
      mockLogger,
      undefined,
      emptyHistoryReader(),
    );

    const body = await json(await app.request('/c1'));

    expect(body.success).toBe(true);
    expect(body.data.agentSlug).toBe('ollama');
  });

  test('GET /:id uses the answering adapter when the record names no owner', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue({ id: 'c1', title: 'Test Chat' });
    const adapters = new Map([['default', adapter]]);
    const storage = { getConversation: vi.fn().mockReturnValue(null) };
    const app = createGlobalConversationRoutes(
      adapters as any,
      storage as any,
      mockLogger,
      undefined,
      emptyHistoryReader(),
    );

    const body = await json(await app.request('/c1'));

    expect(body.data.agentSlug).toBe('station');
  });

  test('GET /:id returns 404 when not found', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue(null);
    const adapters = new Map([['default', adapter]]);
    const storage = { getConversation: vi.fn().mockReturnValue(null) };
    const app = createGlobalConversationRoutes(
      adapters as any,
      storage as any,
      mockLogger,
      undefined,
      emptyHistoryReader(),
    );
    const res = await app.request('/missing');
    expect(res.status).toBe(404);
  });

  test('GET /:id/open gives a guessed or denied identity the same empty 404 envelope', async () => {
    const reader = {
      ...emptyHistoryReader(),
      resolveConversationOpen: vi.fn().mockResolvedValue(null),
    };
    const app = createGlobalConversationRoutes(
      new Map(),
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      reader,
    );

    const response = await app.request('/guessed-owner-session/open');
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Conversation not found',
    });
    expect(reader.resolveConversationOpen).toHaveBeenCalledOnce();
  });

  test('GET /:id resolves an orchestration-owned conversation', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue(null);
    const reader = {
      readSessionConversation: vi.fn().mockResolvedValue({
        id: 'thread-1',
        agentSlug: 'claude',
        projectSlug: 'station',
        title: 'Continue the history fix',
        createdAt: '2026-07-23T00:00:00Z',
        updatedAt: '2026-07-23T00:01:00Z',
        messageCount: 2,
      }),
      listConversationHistoryPage: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
      }),
    };
    const app = createGlobalConversationRoutes(
      new Map([['default', adapter]]) as any,
      { getConversation: vi.fn().mockReturnValue(null) } as any,
      mockLogger,
      undefined,
      reader,
      () => 'bound-user',
    );
    const body = await json(await app.request('/thread-1'));
    expect(reader.readSessionConversation).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ userId: 'bound-user', mode: 'personal' }),
    );
    expect(body.data).toMatchObject({
      id: 'thread-1',
      agentSlug: 'claude',
      projectSlug: 'station',
    });
  });
});

describe('Conversation export route (station#1999 S2)', () => {
  const conversationMessages = [
    {
      id: 'u1',
      role: 'user' as const,
      parts: [{ type: 'text', text: 'list files' }],
      metadata: { timestamp: 1750982400000 },
    },
    {
      id: 'a1',
      role: 'assistant' as const,
      parts: [
        { type: 'text', text: 'Listing.' },
        {
          type: 'tool-invocation',
          toolCallId: 'c1',
          toolName: 'ls',
          args: { path: '.' },
          state: 'result',
          result: 'a.txt',
        },
      ],
      metadata: { timestamp: 1750982401000, reportedModel: 'claude-sonnet-5' },
    },
  ];

  function exportAdapter() {
    return {
      getConversations: vi.fn().mockResolvedValue([]),
      getConversation: vi.fn().mockResolvedValue({
        id: 'c1',
        userId: 'agent:default',
        title: 'Files',
      }),
      getMessages: vi.fn().mockResolvedValue(conversationMessages),
      updateConversation: vi.fn(),
      deleteConversation: vi.fn(),
    };
  }

  test('exports a schema-valid canonical thread with tool pairing and title', async () => {
    const { Thread } = await import('@kontourai/thread');
    const adapters = new Map([['default', exportAdapter()]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const res = await app.request('/station/conversations/conv-1/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const thread = Thread.parse(JSON.parse(await res.text()));
    expect(thread.id).toBe('conv-1');
    expect(thread.metadata?.source).toBe('station');
    expect(thread.metadata?.title).toBe('Files');
    expect(thread.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    const assistant = thread.messages[1];
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    expect(assistant.model).toBe('claude-sonnet-5');
    const tool = thread.messages[2];
    if (tool?.role !== 'tool') throw new Error('expected tool');
    expect(tool.toolResults[0]?.toolCallId).toBe('c1');
  });

  test('exports provider formats through ferry (anthropic-messages alternates)', async () => {
    const adapters = new Map([['default', exportAdapter()]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const res = await app.request(
      '/station/conversations/conv-1/export?format=anthropic-messages',
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    const roles = body.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']); // tool_result rides in user
    expect(JSON.stringify(body)).toContain('tool_result');
  });

  test('markdown export sets a markdown content type', async () => {
    const adapters = new Map([['default', exportAdapter()]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const res = await app.request(
      '/station/conversations/conv-1/export?format=markdown',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toContain('## Assistant');
  });

  test('rejects unknown formats with 400 naming the expected set', async () => {
    const adapters = new Map([['default', exportAdapter()]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const res = await app.request(
      '/station/conversations/conv-1/export?format=docx',
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('docx');
    expect(body.error).toContain('thread');
  });

  test('404s on an empty/unknown conversation without leaking shape', async () => {
    const adapter = exportAdapter();
    adapter.getMessages = vi.fn().mockResolvedValue([]);
    adapter.getConversation = vi.fn().mockResolvedValue(null);
    const adapters = new Map([['default', adapter]]);
    const app = createConversationRoutes(adapters as any, mockLogger);
    const res = await app.request('/station/conversations/missing/export');
    expect(res.status).toBe(404);
  });

  /**
   * archive#3158: one string answered three different situations, and the
   * read already knew which one it was looking at.
   */
  describe('names which empty it found', () => {
    test('a native-SDK conversation absent from the memory store is not called missing', async () => {
      // Claude Code and Codex turns persist as runtime events, NOT in the
      // memory store — so getConversation returns null for every one of them.
      // Deriving 'not-found' from that store alone and then continuing to the
      // projection meant a conversation that exists (and that GET /messages
      // serves as 200 []) was reported as "Conversation not found" by export.
      // A positive claim of non-existence about something that exists is the
      // label-vs-derivation defect relocated, not removed (archive#3158
      // review).
      const adapter = exportAdapter();
      adapter.getMessages = vi.fn().mockResolvedValue([]);
      adapter.getConversation = vi.fn().mockResolvedValue(null);
      const app = createConversationRoutes(
        new Map([['default', adapter]]) as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // The projection ran and found nothing. It has no existence channel
        // — [] means both "no such session" and "authority denied" — so
        // which absence occurred is genuinely undetermined.
        { readSessionMessages: () => [] } as never,
      );

      const res = await app.request('/station/conversations/native-1/export');

      expect(res.status).toBe(404);
      expect((await json(res)).error).toBe('Conversation not found or empty');
    });

    test('no conversation by that id', async () => {
      const adapter = exportAdapter();
      adapter.getMessages = vi.fn().mockResolvedValue([]);
      adapter.getConversation = vi.fn().mockResolvedValue(null);
      const app = createConversationRoutes(
        new Map([['default', adapter]]) as any,
        mockLogger,
      );

      const res = await app.request('/station/conversations/missing/export');

      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({
        success: false,
        error: 'Conversation not found',
      });
    });

    test('a conversation that exists and holds no messages', async () => {
      const adapter = exportAdapter();
      adapter.getMessages = vi.fn().mockResolvedValue([]);
      adapter.getConversation = vi
        .fn()
        .mockResolvedValue({ id: 'c1', userId: 'agent:alias', title: 'Files' });
      const app = createConversationRoutes(
        new Map([['default', adapter]]) as any,
        mockLogger,
      );

      const res = await app.request('/station/conversations/c1/export');

      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({
        success: false,
        error: 'Conversation has no messages to export',
      });
    });

    test('messages that project to nothing exportable', async () => {
      const adapter = exportAdapter();
      adapter.getMessages = vi
        .fn()
        .mockResolvedValue([
          { id: 'empty-text', role: 'assistant', parts: [{ type: 'text' }] },
        ]);
      const app = createConversationRoutes(
        new Map([['default', adapter]]) as any,
        mockLogger,
      );

      const res = await app.request('/station/conversations/conv-1/export');

      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({
        success: false,
        error: 'Conversation has no exportable messages',
      });
    });

    test('a hosted read keeps the either/or answer it did not determine', async () => {
      // The hosted branch deliberately never looks the conversation up, so
      // naming either cause here would disclose the very thing that branch
      // exists to withhold.
      const adapter = exportAdapter();
      const app = createConversationRoutes(
        new Map([['default', adapter]]) as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        emptyHistoryReader(),
        () => 'alpha-user',
        undefined,
        alphaAuthority,
      );

      const res = await app.request('/station/conversations/c1/export');

      expect(res.status).toBe(404);
      expect(adapter.getConversation).not.toHaveBeenCalled();
      expect(await json(res)).toEqual({
        success: false,
        error: 'Conversation not found or empty',
      });
    });
  });

  test('does not attach an unbound store title to an orchestration export', async () => {
    const { Thread } = await import('@kontourai/thread');
    const adapter = exportAdapter();
    const reader = {
      ...emptyHistoryReader(),
      readSessionMessages: vi.fn().mockReturnValue([
        {
          id: 'runtime-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'tenant-owned message' }],
        },
      ]),
    };
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
      () => 'alpha-user',
      undefined,
      alphaAuthority,
    );

    const res = await app.request('/station/conversations/c1/export');

    expect(res.status).toBe(200);
    expect(adapter.getConversation).not.toHaveBeenCalled();
    expect(
      Thread.parse(JSON.parse(await res.text())).metadata?.title,
    ).toBeUndefined();
  });

  test('404s when messages project to no exportable thread messages', async () => {
    const adapter = exportAdapter();
    adapter.getMessages = vi
      .fn()
      .mockResolvedValue([
        { id: 'empty-text', role: 'assistant', parts: [{ type: 'text' }] },
      ]);
    const app = createConversationRoutes(
      new Map([['default', adapter]]) as any,
      mockLogger,
    );

    const res = await app.request('/station/conversations/conv-1/export');

    expect(res.status).toBe(404);
  });

  test.each(['codex', 'claude', 'muse'])(
    'production registry-aware fork admits clean default %s Agent absent from activeAgents',
    async (targetAgent) => {
      const source = createMockAdapter();
      source.getConversation.mockResolvedValue({
        id: 'codex:1787679248936',
        resourceId: 'codex',
        title: 'Physical source',
      });
      source.getMessages.mockResolvedValue(completedForkTranscript());
      const target = createMockAdapter();
      target.getConversation.mockResolvedValue(null);
      const forks: any[] = [];
      const eventStore = {
        readConversationForkProvenance: vi.fn(() => ({ forkedTo: forks })),
        appendConversationFork: vi.fn((event) => forks.push(event)),
        appendConversationForkIfAbsent: vi.fn((event) => {
          forks.push(event);
          return true;
        }),
      };
      const defaults = new Set(['codex', 'claude', 'muse']);
      const isKnownAgent = (slug: string) =>
        resolveRuntimeAgent(slug, {
          listAgents: async () =>
            [...defaults].map((id) => ({
              slug: id,
              name: id,
              execution: { agentConnectionId: id },
            })),
          getDefaultAgentIds: async () => defaults,
        });
      const app = createConversationRoutes(
        new Map([
          ['codex', source],
          ['claude', target],
          ['muse', target],
        ]) as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => target as any,
        undefined,
        () => 'physical-user',
        undefined,
        undefined,
        eventStore,
        isKnownAgent,
      );
      const response = await app.request(
        '/codex/conversations/codex%3A1787679248936/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetAgent,
            branchPointTurnId: 'fork-turn',
            idempotencyKey: `physical-${targetAgent}`,
          }),
        },
      );
      expect(response.status).toBe(200);
      expect((await json(response)).data).toMatchObject({
        continuation: 'replay-seed',
      });
    },
  );

  test('production registry-aware fork rejects a deleted/unknown target absent from active and persisted registries', async () => {
    const source = createMockAdapter();
    source.getMessages.mockResolvedValue(completedForkTranscript());
    const app = createConversationRoutes(
      new Map([['codex', source]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'physical-user',
      undefined,
      undefined,
      undefined,
      (slug) =>
        resolveRuntimeAgent(slug, {
          listAgents: async () => [],
          getDefaultAgentIds: async () => new Set(),
        }),
    );
    const response = await app.request(
      '/codex/conversations/codex%3A1787679248936/fork',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetAgent: 'deleted-agent' }),
      },
    );
    expect(response.status).toBe(404);
  });

  test.each([
    '../agents/codex',
    '.',
    '',
    'Codex',
    'codex/control',
    `codex${String.fromCharCode(0)}`,
    `a${'b'.repeat(64)}`,
  ])(
    'rejects poisoned target Agent id %j before adapter or fact access',
    async (targetAgent) => {
      const adapter = createMockAdapter();
      const eventStore = {
        appendConversationFork: vi.fn(),
        readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
      };
      const app = createConversationRoutes(
        new Map([['codex', adapter]]) as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => 'user',
        undefined,
        undefined,
        eventStore,
        vi.fn(() => true),
      );
      const response = await app.request('/codex/conversations/source/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetAgent }),
      });
      expect(response.status).toBe(400);
      expect(adapter.getConversation).not.toHaveBeenCalled();
      expect(eventStore.readConversationForkProvenance).not.toHaveBeenCalled();
    },
  );

  test('rejects encoded source traversal before adapter or fact access', async () => {
    const adapter = createMockAdapter();
    const eventStore = {
      appendConversationFork: vi.fn(),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
    };
    const app = createConversationRoutes(
      new Map([['codex', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'user',
      undefined,
      undefined,
      eventStore,
      vi.fn(() => true),
    );
    const response = await app.request(
      '/%2E%2E%2Fcodex/conversations/source/fork',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetAgent: 'codex' }),
      },
    );
    expect([400, 404]).toContain(response.status);
    expect(adapter.getConversation).not.toHaveBeenCalled();
    expect(eventStore.readConversationForkProvenance).not.toHaveBeenCalled();
  });

  test('rejects a clean unknown source even when the conversation id exists under another Agent', async () => {
    const adapter = createMockAdapter();
    const createAdapter = vi.fn(() => adapter as any);
    const app = createConversationRoutes(
      new Map([['codex', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createAdapter,
      undefined,
      () => 'user',
      undefined,
      undefined,
      {
        appendConversationFork: vi.fn(),
        readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
      },
      (slug) => slug === 'codex',
    );
    const response = await app.request('/ghost/conversations/c1/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'codex' }),
    });
    expect(response.status).toBe(404);
    expect(createAdapter).not.toHaveBeenCalled();
    expect(adapter.getConversation).not.toHaveBeenCalled();
  });

  test('rejects route source Agent that mismatches recorded conversation ownership', async () => {
    const adapter = createMockAdapter();
    adapter.getConversation.mockResolvedValue({
      id: 'c1',
      resourceId: 'claude',
      title: 'Owned by Claude',
    });
    const eventStore = {
      appendConversationFork: vi.fn(),
      readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
    };
    const app = createConversationRoutes(
      new Map([['codex', adapter]]) as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'user',
      undefined,
      undefined,
      eventStore,
      () => true,
    );
    const response = await app.request('/codex/conversations/c1/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'codex' }),
    });
    expect(response.status).toBe(409);
    expect(eventStore.readConversationForkProvenance).not.toHaveBeenCalled();
  });

  test.each([
    '%2E%2E%2Fsecret',
    'safe%2Fsecret',
    'safe%5Csecret',
    'safe%00secret',
    '.',
    '..',
    `a${'b'.repeat(256)}`,
  ])(
    'rejects poisoned decoded conversation segment %s before adapter access',
    async (conversationId) => {
      const adapter = createMockAdapter();
      const eventStore = {
        appendConversationFork: vi.fn(),
        readConversationForkProvenance: vi.fn(() => ({ forkedTo: [] })),
      };
      const app = createConversationRoutes(
        new Map([['codex', adapter]]) as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => 'user',
        undefined,
        undefined,
        eventStore,
        () => true,
      );
      const response = await app.request(
        `/codex/conversations/${conversationId}/fork`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetAgent: 'codex' }),
        },
      );
      expect([400, 404]).toContain(response.status);
      expect(adapter.getConversation).not.toHaveBeenCalled();
      expect(eventStore.readConversationForkProvenance).not.toHaveBeenCalled();
    },
  );

  test.each([
    [undefined, 404],
    ['different-project', 404],
    ['owned-project', 200],
  ])(
    'project-owned target requires exact eligible owned scope %s',
    async (targetProjectSlug, expected) => {
      const source = createMockAdapter();
      source.getConversation.mockResolvedValue({
        id: 'c1',
        resourceId: 'codex',
        title: 'Source',
      });
      source.getMessages.mockResolvedValue(completedForkTranscript());
      const target = createMockAdapter();
      target.getConversation.mockResolvedValue(null);
      const forks: any[] = [];
      const app = createConversationRoutes(
        new Map([
          ['codex', source],
          ['owned', target],
        ]) as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => target as any,
        undefined,
        () => 'user',
        undefined,
        undefined,
        {
          appendConversationFork: vi.fn((event) => forks.push(event)),
          appendConversationForkIfAbsent: vi.fn((event) => {
            forks.push(event);
            return true;
          }),
          readConversationForkProvenance: vi.fn(() => ({ forkedTo: forks })),
        },
        (slug) => (slug === 'owned' ? { project: 'owned-project' } : true),
        undefined,
        {
          getProject: (slug) =>
            slug === 'owned-project'
              ? { agents: [agentId('owned')] }
              : (undefined as never),
        },
      );
      const response = await app.request('/codex/conversations/c1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetAgent: 'owned',
          ...(targetProjectSlug ? { targetProjectSlug } : {}),
        }),
      });
      expect(response.status).toBe(expected);
      if (expected !== 200)
        expect(target.createConversation).not.toHaveBeenCalled();
    },
  );
});
