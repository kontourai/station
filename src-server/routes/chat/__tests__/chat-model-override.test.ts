import { describe, expect, test, vi } from 'vitest';

// HIGH-4 residual (review re-review): stub the concrete BedrockModelCatalog
// so a per-connection (non-chain) catalog construction never reaches the
// real AWS SDK clients in a unit test.
const perConnectionCatalogCtor = vi.hoisted(() => vi.fn());
const perConnectionResolveModelId = vi.hoisted(() =>
  vi.fn(async (modelId: string) => `per-connection:${modelId}`),
);
const perConnectionDispose = vi.hoisted(() => vi.fn());

vi.mock('../../../providers/llm/bedrock-models.js', () => ({
  BedrockModelCatalog: class {
    constructor(region: string, options?: unknown) {
      perConnectionCatalogCtor(region, options);
    }
    resolveModelId(modelId: string) {
      return perConnectionResolveModelId(modelId);
    }
    dispose() {
      perConnectionDispose();
    }
  },
}));

import { resolveChatAgentModelOverride } from '../chat-model-override.js';

describe('chat-model-override helpers', () => {
  test('a profile-mode Bedrock model override resolves against a freshly bound per-connection catalog, not the global chain catalog', async () => {
    perConnectionCatalogCtor.mockClear();
    perConnectionResolveModelId.mockClear();
    perConnectionResolveModelId.mockRejectedValueOnce(new Error('unknown'));
    perConnectionDispose.mockClear();
    const globalResolveModelId = vi.fn(async () => {
      throw new Error('must not resolve against the global chain-auth catalog');
    });
    const globalForRegion = vi.fn();

    const result = await resolveChatAgentModelOverride({
      ctx: {
        agentSpecs: new Map(),
        agentTools: new Map(),
        appConfig: { region: 'us-east-1' },
        configLoader: { getLaunchabilityRevision: () => 0 },
        getAgentConfigurationRevision: () => 0,
        modelCatalog: {
          resolveModelId: globalResolveModelId,
          forRegion: globalForRegion,
        },
        providerService: {
          getLaunchabilityRevision: () => 1,
        },
        logger: {
          warn: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      slug: 'writer',
      modelOverride: 'anthropic.test',
      agent: { id: 'writer' },
      providerConnection: {
        id: 'bedrock-profile',
        type: 'bedrock',
        config: { region: 'eu-west-1', authMode: 'profile', profile: 'work' },
      } as any,
    });

    expect(globalForRegion).not.toHaveBeenCalled();
    expect(globalResolveModelId).not.toHaveBeenCalled();
    expect(perConnectionCatalogCtor).toHaveBeenCalledWith('eu-west-1', {
      authMode: 'profile',
      profile: 'work',
      apiKey: undefined,
    });
    expect(perConnectionResolveModelId).toHaveBeenCalledWith('anthropic.test');
    expect(perConnectionDispose).toHaveBeenCalled();
    expect(result.status).toBe(400);
  });

  test('a chain-mode Bedrock model override keeps using the global catalog, never constructing a per-connection one', async () => {
    perConnectionCatalogCtor.mockClear();
    const globalResolveModelId = vi
      .fn()
      .mockRejectedValue(new Error('unknown'));
    const globalCatalog = {
      resolveModelId: globalResolveModelId,
      forRegion: vi.fn(() => globalCatalog),
    };

    const result = await resolveChatAgentModelOverride({
      ctx: {
        agentSpecs: new Map(),
        agentTools: new Map(),
        appConfig: { region: 'us-east-1' },
        configLoader: { getLaunchabilityRevision: () => 0 },
        getAgentConfigurationRevision: () => 0,
        modelCatalog: globalCatalog,
        providerService: {
          getLaunchabilityRevision: () => 1,
        },
        logger: {
          warn: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      slug: 'writer',
      modelOverride: 'anthropic.test',
      agent: { id: 'writer' },
      providerConnection: {
        id: 'bedrock-default',
        type: 'bedrock',
        config: { region: 'us-east-1' },
      } as any,
    });

    expect(perConnectionCatalogCtor).not.toHaveBeenCalled();
    expect(globalCatalog.forRegion).toHaveBeenCalledWith('us-east-1');
    expect(globalResolveModelId).toHaveBeenCalledWith('anthropic.test');
    expect(result.status).toBe(400);
  });

  test('returns a validation error for invalid model overrides', async () => {
    const resolveModelId = vi.fn().mockRejectedValue(new Error('unknown'));
    const result = await resolveChatAgentModelOverride({
      ctx: {
        agentSpecs: new Map(),
        agentTools: new Map(),
        appConfig: {},
        configLoader: { getLaunchabilityRevision: () => 0 },
        getAgentConfigurationRevision: () => 0,
        modelCatalog: {
          resolveModelId,
        },
        providerService: {
          getLaunchabilityRevision: () => 1,
        },
        logger: {
          warn: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      slug: 'writer',
      modelOverride: 'bad-model',
      agent: { id: 'writer' },
      providerConnection: { id: 'bedrock-main', type: 'bedrock' } as any,
    });

    expect(result).toEqual({
      agent: { id: 'writer' },
      status: 400,
      error:
        'Invalid model ID: bad-model. Please select a valid model from the list.',
    });
    expect(resolveModelId).toHaveBeenCalledWith('bad-model');
  });

  test('rejects an override without an exact provider connection', async () => {
    const result = await resolveChatAgentModelOverride({
      ctx: {} as any,
      slug: 'writer',
      modelOverride: 'model-a',
      agent: { id: 'writer' },
    });

    expect(result).toEqual({
      agent: { id: 'writer' },
      status: 400,
      error:
        'A configured provider connection is required for model overrides.',
    });
  });

  test('creates and caches a temp agent for a valid model override', async () => {
    const tempAgent = { id: 'writer:alt' };
    const activeAgents = new Map<string, any>();
    const createTempAgent = vi.fn().mockResolvedValue({ raw: tempAgent });
    const overrideMemoryAdapter = { id: 'writer-store' };
    const createModel = vi.fn().mockResolvedValue({ id: 'resolved-model' });
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const result = await resolveChatAgentModelOverride({
      ctx: {
        activeAgents,
        agentSpecs: new Map([['writer', { region: 'us-west-2' }]]),
        agentTools: new Map([['writer', [{ name: 'tool-a' }]]]),
        appConfig: { region: 'us-east-1' },
        getAgentConfigurationRevision: () => 0,
        modelCatalog: {
          resolveModelId: vi.fn().mockResolvedValue('resolved-model-id'),
        },
        configLoader: {
          getProjectHomeDir: () => '/home',
          getLaunchabilityRevision: () => 0,
        },
        providerService: {
          listProviderConnections: () => [],
          getLaunchabilityRevision: () => 7,
        },
        framework: { createTempAgent, createModel },
        memoryAdapters: new Map([['writer', overrideMemoryAdapter]]),
        logger,
      } as any,
      slug: 'writer',
      modelOverride: 'sonnet',
      agent: { id: 'writer', instructions: 'Be helpful' },
      providerConnection: { id: 'bedrock-main', type: 'bedrock' } as any,
    });

    expect(result).toEqual({
      agent: tempAgent,
      resolvedModelId: 'resolved-model-id',
    });
    expect(createModel).toHaveBeenCalledWith(
      {
        region: 'us-west-2',
        model: 'resolved-model-id',
        execution: {
          modelId: 'resolved-model-id',
          modelConnectionId: 'bedrock-main',
        },
      },
      expect.objectContaining({ appConfig: { region: 'us-east-1' } }),
    );
    // archive#914: a session model override rebuilds the agent for an *existing*
    // conversation, so it has to carry the slug's conversation store or the
    // override silently costs the user their history.
    expect(createTempAgent).toHaveBeenCalledWith({
      name: 'writer:bedrock-main:resolved-model-id:7:0:0',
      instructions: 'Be helpful',
      model: { id: 'resolved-model' },
      tools: [{ name: 'tool-a' }],
      memoryAdapter: overrideMemoryAdapter,
    });
    expect(
      activeAgents.get('writer:bedrock-main:resolved-model-id:7:0:0'),
    ).toBe(tempAgent);
    expect(logger.info).toHaveBeenCalledWith(
      'Created agent with model override',
      {
        slug: 'writer',
        modelOverride: 'sonnet',
        providerConnectionId: 'bedrock-main',
        resolvedModel: 'resolved-model-id',
      },
    );
  });

  // archive#1426 fix round (MB-2): chat-model-override.ts is a one-shot
  // model-selection path that previously never reached
  // `AgentCreationConfig.dispatchEvidenceSource` — every override-created
  // Dispatch model on this path silently graded every candidate as the
  // hardcoded (then honest-unavailable) floor with no way to tell why. Pin
  // that the override path now forwards the SAME evidence source/logger the
  // registered-agent path uses.
  test('forwards ctx.dispatchEvidenceSource and ctx.logger to framework.createModel', async () => {
    const createModel = vi.fn().mockResolvedValue({ id: 'model' });
    const dispatchEvidenceSource = {
      getConnectionReadinessEvidence: vi.fn(async () => new Map()),
    };
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    await resolveChatAgentModelOverride({
      ctx: {
        activeAgents: new Map(),
        agentSpecs: new Map([['writer', {}]]),
        agentTools: new Map([['writer', []]]),
        appConfig: {},
        getAgentConfigurationRevision: () => 0,
        configLoader: {
          getProjectHomeDir: () => '/home',
          getLaunchabilityRevision: () => 0,
        },
        providerService: {
          resolveModelForProvider: vi.fn().mockResolvedValue('model-a'),
          listProviderConnections: () => [],
          getLaunchabilityRevision: () => 1,
        },
        framework: {
          createModel,
          createTempAgent: vi.fn().mockResolvedValue({ raw: { id: 'agent' } }),
        },
        dispatchEvidenceSource,
        logger,
      } as any,
      slug: 'writer',
      modelOverride: 'model-a',
      agent: { id: 'writer' },
      providerConnection: { id: 'ollama-main', type: 'ollama' } as any,
    });

    expect(createModel).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ dispatchEvidenceSource, logger }),
    );
  });

  test('validates Bedrock overrides in the effective execution region', async () => {
    const regionalCatalog = {
      resolveModelId: vi.fn().mockResolvedValue('eu.anthropic.test'),
    };
    const forRegion = vi.fn(() => regionalCatalog);
    const createTempAgent = vi
      .fn()
      .mockResolvedValue({ raw: { id: 'regional-agent' } });

    await resolveChatAgentModelOverride({
      ctx: {
        activeAgents: new Map(),
        agentSpecs: new Map([['writer', {}]]),
        agentTools: new Map([['writer', []]]),
        appConfig: { region: 'us-east-1' },
        getAgentConfigurationRevision: () => 0,
        modelCatalog: { forRegion, resolveModelId: vi.fn() },
        configLoader: {
          getProjectHomeDir: () => '/home',
          getLaunchabilityRevision: () => 0,
        },
        providerService: {
          listProviderConnections: () => [],
          getLaunchabilityRevision: () => 1,
        },
        framework: {
          createModel: vi.fn().mockResolvedValue({ id: 'model' }),
          createTempAgent,
        },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
      slug: 'writer',
      modelOverride: 'anthropic.test',
      agent: { id: 'writer' },
      providerConnection: {
        id: 'bedrock-eu',
        type: 'bedrock',
        config: { region: 'eu-west-1' },
      } as any,
    });

    expect(forRegion).toHaveBeenCalledWith('eu-west-1');
    expect(regionalCatalog.resolveModelId).toHaveBeenCalledWith(
      'anthropic.test',
    );
  });

  test('uses provider-owned exact validation for non-Bedrock overrides', async () => {
    const resolveModelForProvider = vi
      .fn()
      .mockResolvedValue('qwen2.5-coder:32b');
    const createModel = vi.fn().mockResolvedValue({ id: 'model' });
    const tempAgent = { id: 'temp' };
    const result = await resolveChatAgentModelOverride({
      ctx: {
        activeAgents: new Map(),
        agentSpecs: new Map([['writer', {}]]),
        agentTools: new Map([['writer', []]]),
        appConfig: {},
        getAgentConfigurationRevision: () => 0,
        configLoader: {
          getProjectHomeDir: () => '/home',
          getLaunchabilityRevision: () => 0,
        },
        providerService: {
          resolveModelForProvider,
          listProviderConnections: () => [],
          getLaunchabilityRevision: () => 3,
        },
        framework: {
          createModel,
          createTempAgent: vi.fn().mockResolvedValue({ raw: tempAgent }),
        },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
      slug: 'writer',
      modelOverride: 'qwen2.5-coder:32b',
      agent: { id: 'writer' },
      providerConnection: { id: 'ollama-main', type: 'ollama' } as any,
    });

    expect(result).toEqual({
      agent: tempAgent,
      resolvedModelId: 'qwen2.5-coder:32b',
    });
    expect(resolveModelForProvider).toHaveBeenCalledWith(
      'ollama-main',
      'qwen2.5-coder:32b',
    );
    expect(createModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'qwen2.5-coder:32b',
        execution: {
          modelId: 'qwen2.5-coder:32b',
          modelConnectionId: 'ollama-main',
        },
      }),
      expect.any(Object),
    );
  });

  test('does not reuse a model override agent after provider launchability changes', async () => {
    let revision = 1;
    const activeAgents = new Map<string, any>();
    const createTempAgent = vi
      .fn()
      .mockResolvedValueOnce({ raw: { id: 'revision-1' } })
      .mockResolvedValueOnce({ raw: { id: 'revision-2' } });
    const ctx = {
      activeAgents,
      agentSpecs: new Map([['writer', {}]]),
      agentTools: new Map([['writer', []]]),
      appConfig: {},
      getAgentConfigurationRevision: () => 0,
      configLoader: {
        getProjectHomeDir: () => '/home',
        getLaunchabilityRevision: () => 0,
      },
      providerService: {
        resolveModelForProvider: vi.fn().mockResolvedValue('model-a'),
        listProviderConnections: () => [],
        getLaunchabilityRevision: () => revision,
      },
      framework: {
        createModel: vi.fn().mockResolvedValue({ id: 'model' }),
        createTempAgent,
      },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any;
    const input = {
      ctx,
      slug: 'writer',
      modelOverride: 'model-a',
      agent: { id: 'writer' },
      providerConnection: { id: 'ollama-main', type: 'ollama' } as any,
    };

    const first = await resolveChatAgentModelOverride(input);
    revision = 2;
    const second = await resolveChatAgentModelOverride(input);

    expect(first.agent.id).toBe('revision-1');
    expect(second.agent.id).toBe('revision-2');
    expect(createTempAgent).toHaveBeenCalledTimes(2);
    expect(activeAgents.size).toBe(1);
    expect(activeAgents.has('writer:ollama-main:model-a:1:0:0')).toBe(false);
    expect(activeAgents.has('writer:ollama-main:model-a:2:0:0')).toBe(true);
  });

  test('does not cache an override created across a launchability revision', async () => {
    let revision = 1;
    let releaseAgent!: (value: unknown) => void;
    const activeAgents = new Map<string, any>();
    const createTempAgent = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseAgent = resolve;
        }),
    );
    const ctx = {
      activeAgents,
      agentSpecs: new Map([['writer', {}]]),
      agentTools: new Map([['writer', []]]),
      appConfig: {},
      getAgentConfigurationRevision: () => 0,
      configLoader: {
        getProjectHomeDir: () => '/home',
        getLaunchabilityRevision: () => 0,
      },
      providerService: {
        resolveModelForProvider: vi.fn().mockResolvedValue('model-a'),
        listProviderConnections: () => [],
        getLaunchabilityRevision: () => revision,
      },
      framework: {
        createModel: vi.fn().mockResolvedValue({ id: 'model' }),
        createTempAgent,
      },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any;
    const pending = resolveChatAgentModelOverride({
      ctx,
      slug: 'writer',
      modelOverride: 'model-a',
      agent: { id: 'writer' },
      providerConnection: { id: 'ollama-main', type: 'ollama' } as any,
    });
    await vi.waitFor(() => expect(createTempAgent).toHaveBeenCalledOnce());

    revision = 2;
    releaseAgent({ raw: { id: 'stale-agent' } });

    await expect(pending).resolves.toMatchObject({ status: 409 });
    expect(activeAgents).toHaveLength(0);
  });

  test('single-flights concurrent creation for the same cold override', async () => {
    let releaseModel!: (value: unknown) => void;
    const model = new Promise((resolve) => {
      releaseModel = resolve;
    });
    const activeAgents = new Map<string, any>();
    const createModel = vi.fn(() => model);
    const createTempAgent = vi
      .fn()
      .mockResolvedValue({ raw: { id: 'shared-agent' } });
    const ctx = {
      activeAgents,
      agentSpecs: new Map([['writer', {}]]),
      agentTools: new Map([['writer', []]]),
      appConfig: {},
      getAgentConfigurationRevision: () => 0,
      configLoader: {
        getProjectHomeDir: () => '/home',
        getLaunchabilityRevision: () => 0,
      },
      providerService: {
        resolveModelForProvider: vi.fn().mockResolvedValue('model-a'),
        listProviderConnections: () => [],
        getLaunchabilityRevision: () => 1,
      },
      framework: { createModel, createTempAgent },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any;
    const input = {
      ctx,
      slug: 'writer',
      modelOverride: 'model-a',
      agent: { id: 'writer' },
      providerConnection: { id: 'ollama-main', type: 'ollama' } as any,
    };

    const first = resolveChatAgentModelOverride(input);
    const second = resolveChatAgentModelOverride(input);
    await vi.waitFor(() => expect(createModel).toHaveBeenCalledTimes(1));
    releaseModel({ id: 'model' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { agent: { id: 'shared-agent' }, resolvedModelId: 'model-a' },
      { agent: { id: 'shared-agent' }, resolvedModelId: 'model-a' },
    ]);
    expect(createTempAgent).toHaveBeenCalledTimes(1);
  });

  test('retains only one override cache entry per agent across connections', async () => {
    const activeAgents = new Map<string, any>();
    const ctx = {
      activeAgents,
      agentSpecs: new Map([['writer', {}]]),
      agentTools: new Map([['writer', []]]),
      appConfig: {},
      getAgentConfigurationRevision: () => 0,
      configLoader: {
        getProjectHomeDir: () => '/home',
        getLaunchabilityRevision: () => 0,
      },
      providerService: {
        resolveModelForProvider: vi.fn(async (id: string) => `${id}-model`),
        listProviderConnections: () => [],
        getLaunchabilityRevision: () => 1,
      },
      framework: {
        createModel: vi.fn().mockResolvedValue({ id: 'model' }),
        createTempAgent: vi
          .fn()
          .mockResolvedValueOnce({ raw: { id: 'first-agent' } })
          .mockResolvedValueOnce({ raw: { id: 'second-agent' } }),
      },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any;

    await resolveChatAgentModelOverride({
      ctx,
      slug: 'writer',
      modelOverride: 'model-a',
      agent: { id: 'writer' },
      providerConnection: { id: 'ollama-a', type: 'ollama' } as any,
    });
    await resolveChatAgentModelOverride({
      ctx,
      slug: 'writer',
      modelOverride: 'model-b',
      agent: { id: 'writer' },
      providerConnection: { id: 'ollama-b', type: 'ollama' } as any,
    });

    expect(activeAgents.size).toBe(1);
    expect([...activeAgents.keys()]).toEqual([
      'writer:ollama-b:ollama-b-model:1:0:0',
    ]);
  });

  test('does not cache an override created across an agent configuration revision', async () => {
    let agentRevision = 2;
    let releaseAgent!: (value: unknown) => void;
    const activeAgents = new Map<string, any>();
    const createTempAgent = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseAgent = resolve;
        }),
    );
    const ctx = {
      activeAgents,
      agentSpecs: new Map([['writer', { prompt: 'original' }]]),
      agentTools: new Map([['writer', [{ name: 'tool-a' }]]]),
      appConfig: { region: 'us-east-1' },
      getAgentConfigurationRevision: () => agentRevision,
      configLoader: {
        getProjectHomeDir: () => '/home',
        getLaunchabilityRevision: () => 0,
      },
      providerService: {
        resolveModelForProvider: vi.fn().mockResolvedValue('model-a'),
        listProviderConnections: () => [],
        getLaunchabilityRevision: () => 1,
      },
      framework: {
        createModel: vi.fn().mockResolvedValue({ id: 'model' }),
        createTempAgent,
      },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any;
    const pending = resolveChatAgentModelOverride({
      ctx,
      slug: 'writer',
      modelOverride: 'model-a',
      agent: { id: 'writer', instructions: 'original' },
      providerConnection: { id: 'ollama-main', type: 'ollama' } as any,
    });
    await vi.waitFor(() => expect(createTempAgent).toHaveBeenCalledOnce());

    agentRevision = 4;
    releaseAgent({ raw: { id: 'stale-agent' } });

    await expect(pending).resolves.toMatchObject({ status: 409 });
    expect(activeAgents).toHaveLength(0);
  });

  test('rejects overrides while agent configuration is being reloaded', async () => {
    const agent = { id: 'writer' };
    await expect(
      resolveChatAgentModelOverride({
        ctx: {
          providerService: { getLaunchabilityRevision: () => 1 },
          getAgentConfigurationRevision: () => null,
        } as any,
        slug: 'writer',
        modelOverride: 'model-a',
        agent,
        providerConnection: { id: 'ollama-main', type: 'ollama' } as any,
      }),
    ).resolves.toMatchObject({ agent, status: 409 });
  });
});
