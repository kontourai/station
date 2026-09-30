import { describe, expect, test, vi } from 'vitest';
import { CHAT_INPUT_MAX_CHARS } from '../../../../src-shared/chat-input-limits.js';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { getInternalApiToken } from '../../../utils/internal-api-token.js';

vi.mock('../chat-request-preparation.js', () => ({
  prepareChatRequest: vi.fn(async () => ({
    options: { model: 'gpt-5.4' },
    resolvedProviderConn: null,
    injectContext: null,
    ragContext: null,
  })),
}));

const streamPrimaryAgentChat = vi.fn<(...args: any[]) => Response>(
  () => ({}) as Response,
);
vi.mock('../chat-primary-stream.js', () => ({
  logDebugChatImages: vi.fn(),
  streamPrimaryAgentChat: (...args: any[]) => streamPrimaryAgentChat(...args),
}));

vi.mock('../chat-model-override.js', () => ({
  resolveChatAgentModelOverride: vi.fn(async ({ agent }: any) => ({ agent })),
}));

const { createChatRoutes, externalEngineChatRedirectMessage } = await import(
  '../chat.js'
);
const { prepareChatRequest } = await import('../chat-request-preparation.js');

describe('Chat Routes', () => {
  // archive#1426 fix round 3 (M-1): launchPersistedAgentWithOverride is the
  // rescue path for a persisted agent that failed to register at boot (its
  // default model didn't resolve) but the chat picker sent a model override.
  // It spreads the loaded spec (any configured Dispatch policy included)
  // into a `createModel` config — this pins that ctx.dispatchEvidenceSource
  // and ctx.logger reach that call, so a Dispatch-carrying agent on this
  // path is graded the same way as any other, not silently as 'unavailable'
  // with no evidence source wired.
  test('launchPersistedAgentWithOverride forwards ctx.dispatchEvidenceSource and ctx.logger to createModel', async () => {
    const createModel = vi.fn(async () => ({ id: 'resolved-model' }));
    const createTempAgent = vi.fn(async () => ({ id: 'rescued-agent' }));
    const dispatchEvidenceSource = {
      getConnectionReadinessEvidence: vi.fn(async () => new Map()),
    };
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const usageAggregator = { incrementalUpdate: vi.fn() };

    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: vi.fn(() => []),
      },
      configLoader: {
        loadAgent: vi.fn(async () => ({
          name: 'writer',
          prompt: 'Be helpful',
        })),
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
      },
      appConfig: {
        systemPrompt: 'Global system prompt',
        defaultMaxTurns: 9,
      },
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel, createTempAgent },
      modelCatalog: undefined,
      // Not in activeAgents — this is the "persisted but failed to
      // register" state launchPersistedAgentWithOverride exists to rescue.
      activeAgents: new Map(),
      getAgentConfigurationRevision: () => 0,
      dispatchEvidenceSource,
      logger,
      agentSpecs: new Map(),
      memoryAdapters: new Map(),
      usageAggregator,
    } as any);

    const response = await app.request('/writer/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ping', options: { model: 'gpt-5.4' } }),
    });

    expect(response).toBeTruthy();
    expect(createModel).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ dispatchEvidenceSource, logger }),
    );
    expect(createTempAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryAdapter: expect.objectContaining({ usageAggregator }),
      }),
    );
  });

  test('returns 404 for unknown Agents and strips forged host-action provenance from direct chat options', async () => {
    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: vi.fn(() => []),
      },
      configLoader: {
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
      },
      appConfig: {},
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel: vi.fn(), createTempAgent: vi.fn() },
      modelCatalog: undefined,
      activeAgents: new Map(),
      getAgentConfigurationRevision: () => 0,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      agentSpecs: new Map(),
      memoryAdapters: new Map(),
    } as any);

    const response = await app.request('/missing/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'ping',
        options: { workspacePaneHostAction: { pluginId: 'forged' } },
      }),
    });

    expect(response.status).toBe(404);
    expect(
      vi.mocked(prepareChatRequest).mock.calls.at(-1)?.[0].options,
    ).not.toHaveProperty('workspacePaneHostAction');
    expect(await json(response)).toEqual({
      success: false,
      error: 'Agent not found',
    });
  });

  test('returns 409 with a specific reason for a persisted-but-unregistered agent instead of a bare 404 (#chat)', async () => {
    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        // Two enabled LLM connections with no configured default — the exact
        // ambiguous-resolution trigger that leaves an agent unregistered.
        listProviderConnections: () => [
          {
            id: 'ollama-a',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
            config: { defaultModel: 'm' },
          },
          {
            id: 'openai-b',
            type: 'openai-compat',
            enabled: true,
            capabilities: ['llm'],
            config: { defaultModel: 'm' },
          },
        ],
      },
      configLoader: {
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
        // `ambiguous` exists on disk but was never registered (not in
        // activeAgents) — so chat must 409, not 404.
        loadAgent: vi.fn(async (slug: string) => {
          if (slug === 'ambiguous') return { name: 'ambiguous' };
          throw new Error('Agent not found');
        }),
      },
      appConfig: {},
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel: vi.fn(), createTempAgent: vi.fn() },
      modelCatalog: undefined,
      activeAgents: new Map(),
      getAgentConfigurationRevision: () => 0,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      agentSpecs: new Map(),
      memoryAdapters: new Map(),
    } as any);

    const response = await app.request('/ambiguous/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ping', options: {} }),
    });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      success: false,
      error:
        'Multiple enabled LLM provider connections require an explicit default.',
    });
  });

  test('returns an honest redirect-style 409 for a persisted agent bound to a ready external engine connection instead of "not currently launchable" (station#977)', async () => {
    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: vi.fn(() => []),
      },
      // archive#977: the reload lifecycle (runtime-agent-lifecycle.ts) never
      // builds a Station-engine agent for an external-engine-bound record —
      // this agent is deliberately never in `activeAgents`, exactly mirroring
      // production for a real 'engine-lab' agent bound to claude.
      configLoader: {
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
        loadAgent: vi.fn(async (slug: string) => {
          if (slug === 'engine-lab') {
            return {
              name: 'Engine Lab',
              execution: { agentConnectionId: 'claude' },
            };
          }
          throw new Error('Agent not found');
        }),
      },
      connectionService: {
        listRuntimeConnections: vi.fn(async () => [
          {
            id: 'claude',
            kind: 'agent',
            type: 'claude',
            name: 'Claude Code',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: { provider: 'claude', engineId: 'claude' },
            status: 'ready',
            prerequisites: [],
          },
        ]),
      },
      appConfig: {},
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel: vi.fn(), createTempAgent: vi.fn() },
      modelCatalog: undefined,
      activeAgents: new Map(),
      getAgentConfigurationRevision: () => 0,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      agentSpecs: new Map(),
      memoryAdapters: new Map(),
    } as any);

    const response = await app.request('/engine-lab/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ping', options: {} }),
    });

    expect(response.status).toBe(409);
    const payload = await json(response);
    expect(payload).toEqual({
      success: false,
      error: externalEngineChatRedirectMessage('engine-lab'),
    });
    // Never the false "not currently launchable" Station-engine reading.
    expect(payload.error).not.toContain('not currently launchable');
  });

  test('a registry-backed external default resolves by its clean id and redirects to orchestration', async () => {
    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: vi.fn(() => []),
      },
      configLoader: {
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
        // Registry defaults deliberately have no authored Agent file.
        loadAgent: vi.fn(async () => {
          throw new Error('Agent not found');
        }),
      },
      connectionService: {
        listRuntimeConnections: vi.fn(async () => [
          {
            id: 'codex',
            kind: 'agent',
            type: 'codex',
            name: 'Codex',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: { engineId: 'codex' },
            status: 'ready',
            prerequisites: [],
          },
        ]),
      },
      listAgents: vi.fn(async () => [
        {
          slug: 'codex',
          name: 'codex',
          execution: { agentConnectionId: 'codex' },
        },
      ]),
      getDefaultAgentIds: vi.fn(async () => new Set(['station', 'codex'])),
      appConfig: {},
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel: vi.fn(), createTempAgent: vi.fn() },
      modelCatalog: undefined,
      activeAgents: new Map(),
      getAgentConfigurationRevision: () => 0,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      agentSpecs: new Map(),
      memoryAdapters: new Map(),
    } as any);

    const response = await app.request('/codex/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ping', options: {} }),
    });

    expect(response.status).toBe(409);
    const payload = await json(response);
    expect(payload).toEqual({
      success: false,
      error: externalEngineChatRedirectMessage('codex'),
    });
    expect(payload.error).not.toContain('not currently launchable');
  });

  test('the public station id dispatches through its explicit internal runtime binding', async () => {
    const stationAgent = { id: 'managed-station' };
    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: vi.fn(() => []),
      },
      configLoader: {
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
        loadAgent: vi.fn(),
      },
      appConfig: {},
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel: vi.fn(), createTempAgent: vi.fn() },
      modelCatalog: undefined,
      activeAgents: new Map([['default', stationAgent]]),
      getAgentConfigurationRevision: () => 0,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      agentSpecs: new Map(),
      memoryAdapters: new Map(),
    } as any);

    const response = await app.request('/station/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ping', options: {} }),
    });

    expect(response).toBeTruthy();
    expect(streamPrimaryAgentChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ slug: 'station', agent: stationAgent }),
    );
  });

  test('falls through to the Station-engine lens when connectionService is absent (older wiring/tests) — no fabricated redirect', async () => {
    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: vi.fn(() => []),
      },
      configLoader: {
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
        loadAgent: vi.fn(async (slug: string) => {
          if (slug === 'engine-lab') {
            return {
              name: 'Engine Lab',
              execution: { agentConnectionId: 'claude' },
            };
          }
          throw new Error('Agent not found');
        }),
      },
      appConfig: {},
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel: vi.fn(), createTempAgent: vi.fn() },
      modelCatalog: undefined,
      activeAgents: new Map(),
      getAgentConfigurationRevision: () => 0,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      agentSpecs: new Map(),
      memoryAdapters: new Map(),
    } as any);

    const response = await app.request('/engine-lab/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ping', options: {} }),
    });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      success: false,
      error: 'No enabled LLM provider connection is configured.',
    });
  });

  test('rejects provider resolution from an obsolete runtime configuration', async () => {
    streamPrimaryAgentChat.mockClear();
    let agentRevision = 0;
    vi.mocked(prepareChatRequest).mockImplementationOnce(async () => {
      agentRevision = 2;
      return {
        options: { model: 'model-a' },
        resolvedProviderConn: {
          id: 'ollama-main',
          type: 'ollama',
          enabled: true,
          capabilities: ['llm'],
          config: {},
        },
        injectContext: null,
        ragContext: null,
      } as any;
    });
    const app = createChatRoutes({
      configLoader: { getLaunchabilityRevision: () => 0 },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: () => [],
      },
      getAgentConfigurationRevision: () => agentRevision,
      activeAgents: new Map([['default', { id: 'agent' }]]),
      agentSpecs: new Map([['default', {}]]),
      agentTools: new Map([['default', []]]),
      memoryAdapters: new Map(),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as any);

    const response = await app.request('/default/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ping', options: { model: 'model-a' } }),
    });

    expect(response.status).toBe(409);
    expect(streamPrimaryAgentChat).not.toHaveBeenCalled();
  });

  describe('an error thrown while preparing the turn is returned as outward text', () => {
    const secret = 'sk-live-SECRET-6d5c4b';
    async function providerError(
      statusCode?: number,
      message = `model gone ${secret}`,
    ) {
      const { APICallError } = await import('@ai-sdk/provider');
      return new APICallError({
        message,
        url: `https://provider.example.test/v1/models?key=${secret}`,
        requestBodyValues: { secret },
        ...(statusCode === undefined ? {} : { statusCode }),
        responseBody: secret,
      });
    }
    const cases: Array<[string, () => Promise<unknown>, number, string]> = [
      [
        'a model provider error',
        () => providerError(404),
        500,
        'The model provider could not find the model (HTTP 404).',
      ],
      [
        'a RetryError whose last attempt was a provider error',
        async () => {
          const { RetryError } = await import('ai');
          return new RetryError({
            message: `Failed after 3 attempts. Last error: model gone ${secret}`,
            reason: 'maxRetriesExceeded',
            errors: [await providerError(429), await providerError(429)],
          });
        },
        500,
        'The model provider rate-limited the request (HTTP 429).',
      ],
      [
        'an error whose cause is a provider error',
        async () =>
          new Error(`launch failed: model gone ${secret}`, {
            cause: new Error('inner', { cause: await providerError(503) }),
          }),
        500,
        'The model provider returned an error (HTTP 503).',
      ],
      [
        'a statusless provider error naming credentials',
        () => providerError(undefined, `invalid credential ${secret}`),
        401,
        'The model provider rejected the credentials.',
      ],
      [
        'an AggregateError holding a provider error',
        async () =>
          new AggregateError(
            [new Error('other'), await providerError(429)],
            `all attempts failed: ${secret}`,
          ),
        500,
        'The model provider rate-limited the request (HTTP 429).',
      ],
      [
        'a wrapper chain deeper than the search bound',
        async () => {
          let wrapped: unknown = await providerError(404);
          for (let level = 0; level < 5; level++) {
            wrapped = new Error(`level ${level}: ${secret}`, {
              cause: wrapped,
            });
          }
          return wrapped;
        },
        500,
        'The request could not be completed.',
      ],
      [
        'a cyclic cause chain',
        async () => {
          const outer = new Error(`outer ${secret}`);
          const inner = new Error(`inner ${secret}`, { cause: outer });
          (outer as { cause?: unknown }).cause = inner;
          return outer;
        },
        500,
        'The request could not be completed.',
      ],
      [
        'a Station-authored error',
        async () => new Error('Prompt template is missing'),
        500,
        'Prompt template is missing',
      ],
      [
        'a Station-authored credential error',
        async () => new Error('No credential configured for this connection'),
        401,
        'No credential configured for this connection',
      ],
    ];

    test.each(cases)('%s', async (_label, makeError, status, expected) => {
      const thrown = await makeError();
      vi.mocked(prepareChatRequest).mockImplementationOnce(async () => {
        throw thrown;
      });
      const app = createChatRoutes({
        configLoader: { getLaunchabilityRevision: () => 0 },
        providerService: {
          getLaunchabilityRevision: () => 0,
          listProviderConnections: () => [],
        },
        getAgentConfigurationRevision: () => 0,
        activeAgents: new Map([['default', { id: 'agent' }]]),
        agentSpecs: new Map([['default', {}]]),
        agentTools: new Map([['default', []]]),
        memoryAdapters: new Map(),
        logger: {
          error: vi.fn(),
          warn: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
        },
      } as any);

      const response = await app.request('/default/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'ping' }),
      });
      const text = await response.text();

      expect(response.status).toBe(status);
      expect(JSON.parse(text).error).toBe(expected);
      expect(text).not.toContain(secret);
    });
  });

  test('launches a persisted-but-unregistered agent when a valid model override is provided', async () => {
    const createModel = vi.fn(async () => ({ id: 'resolved-model' }));
    const createTempAgent = vi.fn(async () => ({ id: 'override-agent' }));
    const memoryAdapters = new Map();

    vi.mocked(prepareChatRequest).mockImplementationOnce(
      async () =>
        ({
          options: { model: 'qwen3.5:35b' },
          resolvedProviderConn: {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
            config: {},
          },
          injectContext: null,
          ragContext: null,
        }) as any,
    );

    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: vi.fn(() => []),
      },
      configLoader: {
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
        loadAgent: vi.fn(async () => ({
          name: 'assistant',
          prompt: 'You are a helpful assistant.',
          execution: { agentConnectionId: 'ollama-local' },
        })),
      },
      appConfig: { defaultMaxTurns: 9 },
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel, createTempAgent },
      modelCatalog: undefined,
      activeAgents: new Map(),
      getAgentConfigurationRevision: () => 0,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      agentSpecs: new Map(),
      memoryAdapters,
    } as any);

    await app.request('/demo-layout:assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'ping',
        options: { model: 'qwen3.5:35b' },
      }),
    });

    expect(createModel).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          modelId: 'qwen3.5:35b',
          modelConnectionId: 'ollama-local',
        }),
      }),
      expect.any(Object),
    );
    expect(createTempAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'demo-layout:assistant',
        instructions: expect.any(Function),
      }),
    );
    expect(streamPrimaryAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'demo-layout:assistant',
        agent: { id: 'override-agent' },
      }),
    );
  });

  test('falls through to the 409 when the model override also fails', async () => {
    const { ManagedModelUnavailableError } = await import(
      '../../../runtime/plugins/runtime-provider-resolution.js'
    );
    const createModel = vi.fn(async () => {
      throw new ManagedModelUnavailableError(
        "Model selector 'bad-model' is not launchable for this provider.",
      );
    });

    vi.mocked(prepareChatRequest).mockImplementationOnce(
      async () =>
        ({
          options: { model: 'bad-model' },
          resolvedProviderConn: {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
            config: {},
          },
          injectContext: null,
          ragContext: null,
        }) as any,
    );

    const app = createChatRoutes({
      acpBridge: { hasAgent: () => false },
      storageAdapter: { getProject: vi.fn() },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: vi.fn(() => [
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
            config: {},
          },
        ]),
      },
      configLoader: {
        getProjectHomeDir: () => '/tmp/station-test-home',
        getLaunchabilityRevision: () => 0,
        loadAgent: vi.fn(async () => ({
          name: 'assistant',
          prompt: 'You are a helpful assistant.',
          model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        })),
      },
      appConfig: {},
      replaceTemplateVariables: (text: string) => text,
      framework: { createModel, createTempAgent: vi.fn() },
      modelCatalog: undefined,
      activeAgents: new Map(),
      getAgentConfigurationRevision: () => 0,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      agentSpecs: new Map(),
      memoryAdapters: new Map(),
    } as any);

    const response = await app.request('/demo-layout:assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'ping',
        options: { model: 'bad-model' },
      }),
    });

    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not currently launchable/i);
  });
});

describe('Chat Routes: prompt size guard (station#2807)', () => {
  // Minimal ctx that gets an active 'default' agent all the way to the
  // (mocked) stream call — the same shape the obsolete-configuration test
  // above uses. The refusal tests never reach any of it: validate() runs
  // before the handler.
  function chatAppForSizeGuard() {
    return createChatRoutes({
      configLoader: { getLaunchabilityRevision: () => 0 },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: () => [],
      },
      getAgentConfigurationRevision: () => 0,
      activeAgents: new Map([['default', { id: 'agent' }]]),
      agentSpecs: new Map([['default', {}]]),
      agentTools: new Map([['default', []]]),
      memoryAdapters: new Map(),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as any);
  }

  function postChat(
    app: ReturnType<typeof chatAppForSizeGuard>,
    input: unknown,
  ) {
    return app.request('/station/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, options: {} }),
    });
  }

  test('refuses a prompt one character over the limit before any provider/engine work', async () => {
    streamPrimaryAgentChat.mockClear();
    vi.mocked(prepareChatRequest).mockClear();
    const app = chatAppForSizeGuard();

    const response = await postChat(app, 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1));

    // A validation refusal in the shape this route's other validation
    // errors take: 400 + 'Validation failed' + flattened field errors.
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toBe('Validation failed');
    expect(body.details.fieldErrors.input[0]).toBe(
      `Message is ${CHAT_INPUT_MAX_CHARS + 1} characters, which is 1 over the ${CHAT_INPUT_MAX_CHARS}-character limit.`,
    );
    // The "before" proof: neither the request preparation (provider
    // resolution, RAG) nor the streaming dispatch (agent.streamText) ever
    // ran — the refusal happened inside validate(), ahead of the handler.
    expect(prepareChatRequest).not.toHaveBeenCalled();
    expect(streamPrimaryAgentChat).not.toHaveBeenCalled();
  });

  test('refuses an oversized ChatMessage[] prompt (combined text) before any provider/engine work', async () => {
    streamPrimaryAgentChat.mockClear();
    vi.mocked(prepareChatRequest).mockClear();
    const app = chatAppForSizeGuard();

    const messages = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'a'.repeat(CHAT_INPUT_MAX_CHARS - 5) },
          // A file part must not bloat the text budget…
          {
            type: 'file',
            url: 'data:image/png;base64,Z',
            mediaType: 'image/png',
          },
        ],
      },
      // …but a second text part's characters do count toward the total.
      { id: 'msg-2', role: 'user', parts: [{ type: 'text', text: '123456' }] },
    ];
    const response = await postChat(app, messages);

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.details.fieldErrors.input[0]).toBe(
      `Message is ${CHAT_INPUT_MAX_CHARS + 1} characters, which is 1 over the ${CHAT_INPUT_MAX_CHARS}-character limit.`,
    );
    expect(prepareChatRequest).not.toHaveBeenCalled();
    expect(streamPrimaryAgentChat).not.toHaveBeenCalled();
  });

  test('accepts a prompt exactly at the limit and dispatches it to the stream', async () => {
    streamPrimaryAgentChat.mockClear();
    vi.mocked(prepareChatRequest).mockClear();
    const app = chatAppForSizeGuard();

    const response = await postChat(app, 'x'.repeat(CHAT_INPUT_MAX_CHARS));

    expect(response).toBeTruthy();
    expect(streamPrimaryAgentChat).toHaveBeenCalledTimes(1);
  });

  // archive#2807 H1 reproduction: text in the AI SDK ModelMessage shape
  // (`content`) was measured as ZERO by the parts-only sizer this replaces —
  // a 500k-character prompt was accepted unmeasured. The route accepts the
  // shape (Agent.streamText takes string | UIMessage[] | ModelMessage[]), so
  // the guard must bound it.
  test('bounds ModelMessage-shaped input (text in content) before any provider/engine work', async () => {
    streamPrimaryAgentChat.mockClear();
    vi.mocked(prepareChatRequest).mockClear();
    const app = chatAppForSizeGuard();

    const response = await postChat(app, [
      { role: 'user', content: 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1) },
    ]);

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.details.fieldErrors.input[0]).toBe(
      `Message is ${CHAT_INPUT_MAX_CHARS + 1} characters, which is 1 over the ${CHAT_INPUT_MAX_CHARS}-character limit.`,
    );
    expect(prepareChatRequest).not.toHaveBeenCalled();
    expect(streamPrimaryAgentChat).not.toHaveBeenCalled();
  });

  // The fail-closed half of H1: a shape the sizer cannot recognize must be
  // refused, not measured as zero.
  test('refuses an input shape it cannot size, before any provider/engine work', async () => {
    streamPrimaryAgentChat.mockClear();
    vi.mocked(prepareChatRequest).mockClear();
    const app = chatAppForSizeGuard();

    const response = await postChat(app, [
      {
        role: 'user',
        parts: { 0: { type: 'text', text: 'x'.repeat(500_000) } },
      },
    ]);

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toBe('Validation failed');
    expect(body.details.fieldErrors.input[0]).toContain(
      'Message shape is not recognized',
    );
    expect(prepareChatRequest).not.toHaveBeenCalled();
    expect(streamPrimaryAgentChat).not.toHaveBeenCalled();
  });
});

describe('Chat Routes: the Station-agent relay thread (#2589)', () => {
  function relayApp() {
    return createChatRoutes({
      configLoader: { getLaunchabilityRevision: () => 0 },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: () => [],
      },
      getAgentConfigurationRevision: () => 0,
      activeAgents: new Map([['default', { id: 'agent' }]]),
      agentSpecs: new Map([['default', {}]]),
      agentTools: new Map([['default', []]]),
      memoryAdapters: new Map(),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as any);
  }

  // The adapter's relay headers exactly (station-agent-adapter.ts), then
  // each way a request can fall short of them.
  test.each([
    ['the adapter relay for its own conversation', {}, 'thread-7'],
    [
      'a UI-proxied request (token set, caller forced remote)',
      { 'x-station-proxy-caller': 'remote' },
      undefined,
    ],
    [
      'a request without the internal token',
      { 'x-station-internal-token': 'not-the-token' },
      undefined,
    ],
    [
      'a relay naming another conversation',
      { 'x-station-orchestration-thread': 'thread-other' },
      undefined,
    ],
    [
      'a request with the internal token but no caller header',
      { 'x-station-proxy-caller': undefined },
      undefined,
    ],
  ])('%s', async (_label, override, expected) => {
    streamPrimaryAgentChat.mockClear();
    vi.mocked(prepareChatRequest).mockImplementationOnce(
      async () =>
        ({
          options: { conversationId: 'thread-7' },
          resolvedProviderConn: null,
          injectContext: null,
          ragContext: null,
        }) as any,
    );
    const response = await relayApp().request('/station/chat', {
      method: 'POST',
      // An `undefined` override drops the header entirely.
      headers: Object.fromEntries(
        Object.entries({
          'Content-Type': 'application/json',
          'x-station-internal-token': getInternalApiToken(),
          'x-station-proxy-caller': 'local',
          'x-station-orchestration-thread': 'thread-7',
          ...override,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      body: JSON.stringify({
        input: 'ping',
        options: { conversationId: 'thread-7' },
      }),
    });

    expect(response).toBeTruthy();
    expect(streamPrimaryAgentChat).toHaveBeenCalledTimes(1);
    expect(
      streamPrimaryAgentChat.mock.calls[0]?.[0].orchestrationThreadId,
    ).toBe(expected);
  });
});
