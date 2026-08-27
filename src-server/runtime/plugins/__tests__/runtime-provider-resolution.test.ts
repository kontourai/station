import { classifyManagedModelBinding } from '@kontourai/station-contracts/managed-model-binding';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../providers/connection-factories.js', () => ({
  createLLMProvider: vi.fn(),
  createEmbeddingProvider: vi.fn(() => null),
  createVectorDbProvider: vi.fn((connection: any) =>
    connection.type === 'lancedb' ? { id: 'lancedb' } : null,
  ),
}));

// HIGH-4 (review fix round): stub the concrete BedrockModelCatalog so a
// per-connection (non-chain) catalog construction never reaches the real
// AWS SDK clients in a unit test.
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

const { createLLMProvider } = await import(
  '../../../providers/connection-factories.js'
);
const {
  createRuntimeFrameworkModel,
  createRuntimeModelSelection,
  resolveConfiguredModelId,
  resolveDefaultManagedModelHint,
  resolveManagedAvailabilityReason,
  resolveManagedChatBinding,
  resolveManagedModelBinding,
  resolveManagedModelIdentity,
  resolveRuntimeEmbeddingProvider,
  resolveRuntimeVectorDbProvider,
  ManagedModelUnavailableError,
} = await import('../runtime-provider-resolution.js');

describe('runtime-provider-resolution', () => {
  beforeEach(() => {
    vi.mocked(createLLMProvider).mockReset();
    perConnectionCatalogCtor.mockClear();
    perConnectionResolveModelId.mockClear();
    perConnectionDispose.mockClear();
  });

  test('createRuntimeFrameworkModel delegates to the active framework', async () => {
    const framework = {
      createModel: vi.fn(async () => ({ kind: 'model' })),
    };
    const spec = { slug: 'agent-1' } as any;

    const model = await createRuntimeFrameworkModel(spec, {
      framework: framework as any,
      appConfig: { defaultModel: 'foo' } as any,
      projectHomeDir: '/tmp/project',
      modelCatalog: { kind: 'catalog' } as any,
      listProviderConnections: () => [],
    });

    expect(framework.createModel).toHaveBeenCalledWith(spec, {
      appConfig: { defaultModel: 'foo' },
      projectHomeDir: '/tmp/project',
      modelCatalog: { kind: 'catalog' },
      listProviderConnections: expect.any(Function),
    });
    expect(model).toEqual({ kind: 'model' });
  });

  // station#1426 fix round (MB-2): the one-shot model-selection paths
  // (chat-model-override.ts, invoke.ts, invoke-agent.ts) route through this
  // function to reach `framework.createModel`. If it silently dropped
  // `dispatchEvidenceSource`/`logger`, every candidate on those paths would
  // grade as `unavailable` with no way to trace why — pin the forwarding at
  // its single choke point.
  test('createRuntimeFrameworkModel forwards dispatchEvidenceSource and logger to the active framework', async () => {
    const framework = {
      createModel: vi.fn(async () => ({ kind: 'model' })),
    };
    const spec = { slug: 'agent-1' } as any;
    const dispatchEvidenceSource = {
      getConnectionReadinessEvidence: vi.fn(async () => new Map()),
    };
    const logger = {
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

    await createRuntimeFrameworkModel(spec, {
      framework: framework as any,
      appConfig: { defaultModel: 'foo' } as any,
      projectHomeDir: '/tmp/project',
      dispatchEvidenceSource,
      logger,
    });

    expect(framework.createModel).toHaveBeenCalledWith(
      spec,
      expect.objectContaining({ dispatchEvidenceSource, logger }),
    );
  });

  test('prefers explicit managed model connections and provider-specific model defaults', async () => {
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [
        { id: 'gpt-4.1', name: 'GPT-4.1' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      ]),
    } as any);

    const binding = await resolveManagedModelBinding(
      {
        execution: {
          modelConnectionId: 'openai-main',
        },
      } as any,
      {
        appConfig: {
          defaultLLMProvider: 'bedrock-default',
          defaultModel: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        } as any,
        listProviderConnections: () =>
          [
            {
              id: 'bedrock-default',
              type: 'bedrock',
              enabled: true,
              capabilities: ['llm'],
              config: {
                defaultModel: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
              },
            },
            {
              id: 'openai-main',
              type: 'openai-compat',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'gpt-4.1' },
            },
          ] as any,
      },
    );

    expect(binding.providerConnection?.id).toBe('openai-main');
    expect(binding.providerType).toBe('openai-compat');
    expect(binding.modelId).toBe('gpt-4.1');
  });

  /*
   * station#3653: an OpenAI-compatible endpoint that serves chat and answers
   * `GET /models` with an empty list. `probeModelConnection` reads that as
   * "no catalogue", runs the one-token chat probe against the connection's
   * `defaultModel`, records a PASSED check and the connection reads Ready —
   * while this binding used to refuse the very same model, which is why the
   * Station engine logged "Default agent not registered because no launchable
   * model is configured" beside a Ready connection.
   */
  test('binds the configured default model when the provider enumerates nothing', async () => {
    vi.mocked(createLLMProvider).mockReturnValue({
      // What `OpenAICompatLLMProvider` derives for a self-hosted endpoint:
      // its empty list is not an enumeration. Per instance, not per class
      // (station#3653 delta review HIGH-1).
      emptyCatalogMeaning: 'no-catalog',
      listModels: vi.fn(async () => []),
    } as any);

    const binding = await resolveManagedModelBinding({} as any, {
      appConfig: {} as any,
      listProviderConnections: () =>
        [
          {
            id: 'local-openai',
            type: 'openai-compat',
            enabled: true,
            capabilities: ['llm'],
            config: { defaultModel: 'local-model' },
          },
        ] as any,
    });

    expect(binding.providerConnection?.id).toBe('local-openai');
    expect(binding.modelId).toBe('local-model');
  });

  test('an enumerating provider still refuses a default model it did not list', async () => {
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'gpt-4.1', name: 'GPT-4.1' }]),
    } as any);

    await expect(
      resolveManagedModelBinding({} as any, {
        appConfig: {} as any,
        listProviderConnections: () =>
          [
            {
              id: 'local-openai',
              type: 'openai-compat',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'local-model' },
            },
          ] as any,
      }),
    ).rejects.toThrow('is not launchable for this provider');
  });

  /*
   * Review HIGH-1: the same empty answer from an adapter that did NOT declare
   * it, which is every key-based provider. Anthropic's `[]` is an
   * authoritative "this account has no models", so the binding must refuse.
   */
  test('refuses the configured default model when an undeclared provider enumerates nothing', async () => {
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => []),
    } as any);

    await expect(
      resolveManagedModelBinding({} as any, {
        appConfig: {} as any,
        listProviderConnections: () =>
          [
            {
              id: 'anthropic-main',
              type: 'anthropic',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'claude-sonnet-4' },
            },
          ] as any,
      }),
    ).rejects.toThrow('is not launchable for this provider');
  });

  test('rejects an unsupported preferred model instead of selecting the first available model', async () => {
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'llama3.2', name: 'Llama 3.2' }]),
    } as any);

    const binding = resolveManagedModelBinding(
      {
        model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        execution: {
          modelConnectionId: 'ollama-main',
        },
      } as any,
      {
        appConfig: {
          defaultModel: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        } as any,
        listProviderConnections: () =>
          [
            {
              id: 'ollama-main',
              type: 'ollama',
              enabled: true,
              capabilities: ['llm'],
              config: {},
            },
          ] as any,
      },
    );
    await expect(binding).rejects.toThrow(
      'is not launchable for this provider',
    );
    await expect(binding).rejects.toBeInstanceOf(ManagedModelUnavailableError);
  });

  test('rejects a missing explicit provider connection instead of falling through', async () => {
    await expect(
      resolveManagedModelBinding(
        {
          model: 'model-a',
          execution: { modelConnectionId: 'missing' },
        } as any,
        {
          appConfig: {
            defaultLLMProvider: 'available',
            defaultModel: 'model-a',
          } as any,
          listProviderConnections: () =>
            [
              {
                id: 'available',
                type: 'ollama',
                enabled: true,
                capabilities: ['llm'],
                config: { defaultModel: 'model-a' },
              },
            ] as any,
        },
      ),
    ).rejects.toThrow("connection 'missing' is unavailable");
    expect(createLLMProvider).not.toHaveBeenCalled();
  });

  test('uses the only enabled provider without applying a ranking policy', async () => {
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'model-a', name: 'Model A' }]),
    } as any);

    await expect(
      resolveManagedModelBinding({ model: 'model-a' } as any, {
        appConfig: { defaultModel: 'model-a' } as any,
        listProviderConnections: () =>
          [
            {
              id: 'only-provider',
              type: 'ollama',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'model-a' },
            },
          ] as any,
      }),
    ).resolves.toMatchObject({
      providerConnection: { id: 'only-provider' },
      modelId: 'model-a',
    });
  });

  test('derives the default-agent model from a sole connection default', () => {
    expect(
      resolveDefaultManagedModelHint(
        { defaultModel: '' } as any,
        [
          {
            id: 'only-provider',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
            config: { defaultModel: 'qwen3:30b' },
          },
        ] as any,
      ),
    ).toBe('qwen3:30b');
  });

  test('does not derive a default-agent model from ambiguous connections', () => {
    expect(
      resolveDefaultManagedModelHint(
        { defaultModel: '' } as any,
        ['a', 'b'].map((id) => ({
          id,
          type: 'ollama',
          enabled: true,
          capabilities: ['llm'],
          config: { defaultModel: `${id}-model` },
        })) as any,
      ),
    ).toBeNull();
  });

  test('rejects ambiguous providers instead of selecting the first connection', async () => {
    await expect(
      resolveManagedModelBinding({ model: 'model-a' } as any, {
        appConfig: { defaultModel: 'model-a' } as any,
        listProviderConnections: () =>
          [
            {
              id: 'available',
              type: 'ollama',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'model-a' },
            },
            {
              id: 'also-available',
              type: 'openai-compat',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'model-a' },
            },
          ] as any,
      }),
    ).rejects.toThrow('require an explicit default');
    expect(createLLMProvider).not.toHaveBeenCalled();
  });

  test('rejects a model binding when no enabled provider exists', async () => {
    await expect(
      resolveManagedModelBinding({ model: 'model-a' } as any, {
        appConfig: { defaultModel: 'model-a' } as any,
        listProviderConnections: () => [],
      }),
    ).rejects.toThrow('No enabled LLM provider connection is configured');
    expect(createLLMProvider).not.toHaveBeenCalled();
  });

  test('uses the bedrock catalog when a bedrock connection is selected', async () => {
    const modelCatalog = {
      resolveModelId: vi.fn(async (modelId: string) => `resolved:${modelId}`),
    };

    const binding = await resolveManagedModelBinding(
      {
        execution: {
          modelConnectionId: 'bedrock-default',
        },
      } as any,
      {
        appConfig: {
          defaultModel: 'claude-sonnet-4-6',
        } as any,
        listProviderConnections: () =>
          [
            {
              id: 'bedrock-default',
              type: 'bedrock',
              enabled: true,
              capabilities: ['llm'],
              config: {},
            },
          ] as any,
        modelCatalog: modelCatalog as any,
      },
    );

    expect(binding.providerType).toBe('bedrock');
    expect(binding.modelId).toBe('resolved:claude-sonnet-4-6');
    expect(modelCatalog.resolveModelId).toHaveBeenCalledWith(
      'claude-sonnet-4-6',
    );
  });

  test('validates Bedrock selectors in the selected connection region', async () => {
    const regionalCatalog = {
      resolveModelId: vi.fn(async (modelId: string) => `eu:${modelId}`),
    };
    const modelCatalog = {
      resolveModelId: vi.fn(),
      forRegion: vi.fn(() => regionalCatalog),
    };

    const binding = await resolveManagedModelBinding(
      {
        model: 'anthropic.test',
        execution: { modelConnectionId: 'bedrock-eu' },
      } as any,
      {
        appConfig: { region: 'us-east-1' },
        listProviderConnections: () => [
          {
            id: 'bedrock-eu',
            type: 'bedrock',
            enabled: true,
            capabilities: ['llm'],
            config: { region: 'eu-west-1' },
          },
        ],
        modelCatalog,
      } as any,
    );

    expect(modelCatalog.forRegion).toHaveBeenCalledWith('eu-west-1');
    expect(modelCatalog.resolveModelId).not.toHaveBeenCalled();
    expect(regionalCatalog.resolveModelId).toHaveBeenCalledWith(
      'anthropic.test',
    );
    expect(binding.modelId).toBe('eu:anthropic.test');
    expect(binding.region).toBe('eu-west-1');
  });

  test('projects one effective model identity for launch and accounting', () => {
    expect(
      resolveManagedModelIdentity(
        {
          model: 'stale-model',
          region: 'eu-central-1',
          execution: {
            modelConnectionId: 'bedrock-eu',
            modelId: 'execution-model',
          },
        } as any,
        {
          appConfig: {
            defaultLLMProvider: 'bedrock-eu',
            defaultModel: 'default-model',
            region: 'us-east-1',
          },
          listProviderConnections: () => [
            {
              id: 'bedrock-eu',
              type: 'bedrock',
              enabled: true,
              capabilities: ['llm'],
              config: { region: 'eu-west-1' },
            },
          ],
        } as any,
      ),
    ).toMatchObject({
      providerConnection: { id: 'bedrock-eu' },
      providerType: 'bedrock',
      modelId: 'execution-model',
      region: 'eu-central-1',
    });
  });

  test('preserves the full agent binding in one-shot model selection', async () => {
    const createModel = vi.fn().mockResolvedValue({ id: 'model' });
    const result = await createRuntimeModelSelection(
      {
        region: 'eu-west-1',
        execution: { modelConnectionId: 'bedrock-eu' },
      } as any,
      'eu-model',
      {
        framework: { createModel } as any,
        appConfig: {
          defaultLLMProvider: 'bedrock-eu',
          region: 'us-east-1',
        } as any,
        projectHomeDir: '/tmp/home',
        modelCatalog: {} as any,
        listProviderConnections: () =>
          [
            {
              id: 'bedrock-eu',
              type: 'bedrock',
              enabled: true,
              capabilities: ['llm'],
              config: { region: 'eu-west-1' },
            },
          ] as any,
      },
    );

    expect(result.identity).toMatchObject({
      providerConnection: { id: 'bedrock-eu' },
      modelId: 'eu-model',
      region: 'eu-west-1',
    });
    expect(createModel).toHaveBeenCalledWith(
      {
        region: 'eu-west-1',
        model: 'eu-model',
        execution: {
          modelConnectionId: 'bedrock-eu',
          modelId: 'eu-model',
        },
      },
      expect.objectContaining({ projectHomeDir: '/tmp/home' }),
    );
  });

  test('resolveManagedModelIdentity throws the explicit-default error for multiple connections with no default (guards the unregistered-agent trigger) (#chat)', () => {
    const connections = ['a', 'b'].map((id) => ({
      id,
      type: 'ollama',
      enabled: true,
      capabilities: ['llm'],
      config: { defaultModel: `${id}-model` },
    }));
    expect(() =>
      resolveManagedModelIdentity({ model: 'model-a' } as any, {
        appConfig: {} as any,
        listProviderConnections: () => connections as any,
      }),
    ).toThrow(
      'Multiple enabled LLM provider connections require an explicit default.',
    );
  });

  // Delta review H2 — system status must ask WHICH connection the managed
  // engine would select, using the selection resolver itself.
  // Delta2 review H2 — and be told apart the three ways it can be
  // unanswerable, because `ambiguous`/`invalid` are states in which the agent
  // resolves to nothing, not states with no opinion.
  test('resolveManagedChatBinding honours the explicit binding, then the declared default', () => {
    const connections = [
      {
        id: 'a',
        type: 'ollama',
        enabled: true,
        capabilities: ['llm'],
        config: { defaultModel: 'a-model' },
      },
      {
        id: 'b',
        type: 'ollama',
        enabled: true,
        capabilities: ['llm'],
        config: { defaultModel: 'b-model' },
      },
    ];
    expect(
      resolveManagedChatBinding(
        { execution: { modelConnectionId: 'b' } } as any,
        {
          appConfig: { defaultLLMProvider: 'a' } as any,
          listProviderConnections: () => connections as any,
        },
      ),
    ).toEqual({ kind: 'resolved', connectionId: 'b' });
    expect(
      resolveManagedChatBinding({} as any, {
        appConfig: { defaultLLMProvider: 'a' } as any,
        listProviderConnections: () => connections as any,
      }),
    ).toEqual({ kind: 'resolved', connectionId: 'a' });
    // Ambiguous with no declared default: unanswerable, not a guess.
    expect(
      resolveManagedChatBinding({} as any, {
        appConfig: {} as any,
        listProviderConnections: () => connections as any,
      }),
    ).toEqual({ kind: 'ambiguous' });
    expect(
      resolveManagedChatBinding({} as any, {
        appConfig: {} as any,
        listProviderConnections: () => [],
      }),
    ).toEqual({ kind: 'none' });
    // A declared default that is not among the enabled connections is a
    // broken binding, not an absent one.
    expect(
      resolveManagedChatBinding({} as any, {
        appConfig: { defaultLLMProvider: 'gone' } as any,
        listProviderConnections: () => connections as any,
      }),
    ).toEqual({ kind: 'invalid', declaredConnectionId: 'gone' });
    expect(
      resolveManagedChatBinding(
        { execution: { modelConnectionId: 'gone' } } as any,
        {
          appConfig: { defaultLLMProvider: 'a' } as any,
          listProviderConnections: () => connections as any,
        },
      ),
    ).toEqual({ kind: 'invalid', declaredConnectionId: 'gone' });
    // The binding follows the app config it is handed, which is what makes a
    // live default change visible to status (delta2 review H2).
    let appConfig: { defaultLLMProvider?: string } = {
      defaultLLMProvider: 'a',
    };
    const binding = () =>
      resolveManagedChatBinding({} as any, {
        appConfig: appConfig as any,
        listProviderConnections: () => connections as any,
      });
    expect(binding()).toEqual({ kind: 'resolved', connectionId: 'a' });
    appConfig = { defaultLLMProvider: 'b' };
    expect(binding()).toEqual({ kind: 'resolved', connectionId: 'b' });
  });

  // Review H1 — Home's "this agent can run" answer must agree with the
  // Connections hub's "this connection's check failed". The refusal is named
  // rather than silently dropping the connection, which would have reported
  // "No enabled LLM provider connection is configured" for a connection that
  // plainly exists.
  test('a refused connection makes the managed agent unavailable, and names why', () => {
    const only = [
      {
        id: 'anthropic-1',
        type: 'anthropic',
        name: 'Work Anthropic',
        enabled: true,
        capabilities: ['llm'],
        config: { defaultModel: 'model-a' },
      },
    ];
    expect(
      resolveManagedAvailabilityReason({ model: 'model-a' } as any, {
        appConfig: {} as any,
        listProviderConnections: () => only as any,
      }),
    ).toBe(null);

    expect(
      resolveManagedAvailabilityReason({ model: 'model-a' } as any, {
        appConfig: {} as any,
        listProviderConnections: () => only as any,
        gatedConnectionIds: new Map([['anthropic-1', 'failed' as const]]),
      }),
    ).toBe(
      "Model connection 'Work Anthropic' was refused by its provider at its last check. Fix its settings and test it again in Connections.",
    );
  });

  // Delta2 review M1: the same gate, a different fact. A connection Station
  // could not reach must not be described as one the provider refused.
  test('an unreachable connection says it could not be reached, not that it was refused', () => {
    expect(
      resolveManagedAvailabilityReason({ model: 'model-a' } as any, {
        appConfig: {} as any,
        listProviderConnections: () =>
          [
            {
              id: 'anthropic-1',
              type: 'anthropic',
              name: 'Work Anthropic',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'model-a' },
            },
          ] as any,
        gatedConnectionIds: new Map([['anthropic-1', 'unreachable' as const]]),
      }),
    ).toBe(
      "Model connection 'Work Anthropic' could not be reached at its last check. Check that the provider is running and reachable, then test it again in Connections.",
    );
  });

  test('a refusal for a DIFFERENT connection does not make the resolved one unavailable', () => {
    expect(
      resolveManagedAvailabilityReason({ model: 'model-a' } as any, {
        appConfig: {} as any,
        listProviderConnections: () =>
          [
            {
              id: 'only',
              type: 'ollama',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'model-a' },
            },
          ] as any,
        gatedConnectionIds: new Map([
          ['some-other-connection', 'failed' as const],
        ]),
      }),
    ).toBe(null);
  });

  // The execution binding never receives `gatedConnectionIds`: a receipt is
  // a claim about the past, and the delivery attempt makes its own request.
  test('the execution identity resolver is unaffected without the option', () => {
    expect(
      resolveManagedModelIdentity({ model: 'model-a' } as any, {
        appConfig: {} as any,
        listProviderConnections: () =>
          [
            {
              id: 'anthropic-1',
              type: 'anthropic',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'model-a' },
            },
          ] as any,
      }).providerConnection.id,
    ).toBe('anthropic-1');
  });

  test('resolveManagedAvailabilityReason returns the reason when unresolvable and null when it resolves (#chat)', () => {
    const ambiguous = ['a', 'b'].map((id) => ({
      id,
      type: 'ollama',
      enabled: true,
      capabilities: ['llm'],
      config: { defaultModel: `${id}-model` },
    }));
    expect(
      resolveManagedAvailabilityReason({ model: 'model-a' } as any, {
        appConfig: {} as any,
        listProviderConnections: () => ambiguous as any,
      }),
    ).toBe(
      'Multiple enabled LLM provider connections require an explicit default.',
    );

    expect(
      resolveManagedAvailabilityReason({ model: 'model-a' } as any, {
        appConfig: {} as any,
        listProviderConnections: () =>
          [
            {
              id: 'only',
              type: 'ollama',
              enabled: true,
              capabilities: ['llm'],
              config: { defaultModel: 'model-a' },
            },
          ] as any,
      }),
    ).toBeNull();
  });

  test('resolveRuntimeVectorDbProvider returns the enabled vectordb provider', () => {
    const provider = resolveRuntimeVectorDbProvider({
      listProviderConnections: () =>
        [
          { enabled: true, capabilities: ['llm'] },
          {
            enabled: true,
            capabilities: ['vectordb'],
            type: 'lancedb',
            config: {},
          },
        ] as any,
    } as any);

    expect(provider).toBeTruthy();
  });

  test('resolveRuntimeEmbeddingProvider skips disabled or missing providers', () => {
    const provider = resolveRuntimeEmbeddingProvider({
      listProviderConnections: () =>
        [{ enabled: false, capabilities: ['embedding'] }] as any,
    } as any);

    expect(provider).toBeNull();
  });

  test('resolveConfiguredModelId rejects when no model is configured', async () => {
    const modelCatalog = {
      resolveModelId: vi.fn(async (modelId: string) => `resolved:${modelId}`),
    };

    await expect(
      resolveConfiguredModelId({ model: '' } as any, {
        appConfig: { defaultModel: '' } as any,
        modelCatalog: modelCatalog as any,
      }),
    ).rejects.toThrow('Bedrock model selector is required');

    expect(modelCatalog.resolveModelId).not.toHaveBeenCalled();
  });

  test('resolveConfiguredModelId uses the catalog when a model is configured', async () => {
    const modelCatalog = {
      resolveModelId: vi.fn(async (modelId: string) => `resolved:${modelId}`),
    };

    await expect(
      resolveConfiguredModelId({ model: '' } as any, {
        appConfig: { defaultModel: 'anthropic.test' } as any,
        modelCatalog: modelCatalog as any,
      }),
    ).resolves.toBe('resolved:anthropic.test');

    expect(modelCatalog.resolveModelId).toHaveBeenCalledWith('anthropic.test');
  });

  test('resolveConfiguredModelId fails closed without Bedrock catalog evidence', async () => {
    await expect(
      resolveConfiguredModelId({ model: 'unknown-model' } as any, {
        appConfig: { defaultModel: '' } as any,
      }),
    ).rejects.toThrow('Bedrock model catalog is required');
  });

  // HIGH-4 (review fix round): a profile/api-key Bedrock connection must
  // resolve launchability against ITS OWN auth, never the injected
  // process-global chain-authenticated catalog.
  test('a profile-mode Bedrock connection resolves against a freshly bound per-connection catalog, not the global chain catalog', async () => {
    const globalCatalog = {
      resolveModelId: vi.fn(async () => {
        throw new Error(
          'must not resolve against the global chain-auth catalog',
        );
      }),
      forRegion: vi.fn(() => globalCatalog),
    };

    const binding = await resolveManagedModelBinding(
      {
        model: 'anthropic.test',
        execution: { modelConnectionId: 'bedrock-profile' },
      } as any,
      {
        appConfig: { region: 'us-east-1' },
        listProviderConnections: () => [
          {
            id: 'bedrock-profile',
            type: 'bedrock',
            enabled: true,
            capabilities: ['llm'],
            config: {
              region: 'eu-west-1',
              authMode: 'profile',
              profile: 'work',
            },
          },
        ],
        modelCatalog: globalCatalog,
      } as any,
    );

    expect(globalCatalog.forRegion).not.toHaveBeenCalled();
    expect(globalCatalog.resolveModelId).not.toHaveBeenCalled();
    expect(perConnectionCatalogCtor).toHaveBeenCalledWith('eu-west-1', {
      authMode: 'profile',
      profile: 'work',
      apiKey: undefined,
    });
    expect(perConnectionResolveModelId).toHaveBeenCalledWith('anthropic.test');
    expect(perConnectionDispose).toHaveBeenCalled();
    expect(binding.modelId).toBe('per-connection:anthropic.test');
  });

  test('an api-key-mode Bedrock connection also resolves against its own per-connection catalog', async () => {
    const globalCatalog = {
      resolveModelId: vi.fn(),
      forRegion: vi.fn(() => globalCatalog),
    };

    await resolveManagedModelBinding(
      {
        model: 'anthropic.test',
        execution: { modelConnectionId: 'bedrock-api-key' },
      } as any,
      {
        appConfig: { region: 'us-east-1' },
        listProviderConnections: () => [
          {
            id: 'bedrock-api-key',
            type: 'bedrock',
            enabled: true,
            capabilities: ['llm'],
            config: {
              region: 'us-east-1',
              authMode: 'api-key',
              apiKey: 'bedrock-key-123',
            },
          },
        ],
        modelCatalog: globalCatalog,
      } as any,
    );

    expect(globalCatalog.forRegion).not.toHaveBeenCalled();
    expect(globalCatalog.resolveModelId).not.toHaveBeenCalled();
    expect(perConnectionCatalogCtor).toHaveBeenCalledWith('us-east-1', {
      authMode: 'api-key',
      profile: undefined,
      apiKey: 'bedrock-key-123',
    });
  });

  test('a chain-mode (default) Bedrock connection keeps using the shared global catalog', async () => {
    const globalCatalog = {
      resolveModelId: vi.fn(async (modelId: string) => `global:${modelId}`),
      forRegion: vi.fn(() => globalCatalog),
    };

    const binding = await resolveManagedModelBinding(
      {
        model: 'anthropic.test',
        execution: { modelConnectionId: 'bedrock-default' },
      } as any,
      {
        appConfig: { region: 'us-east-1' },
        listProviderConnections: () => [
          {
            id: 'bedrock-default',
            type: 'bedrock',
            enabled: true,
            capabilities: ['llm'],
            config: { region: 'us-east-1' },
          },
        ],
        modelCatalog: globalCatalog,
      } as any,
    );

    expect(perConnectionCatalogCtor).not.toHaveBeenCalled();
    expect(globalCatalog.forRegion).toHaveBeenCalledWith('us-east-1');
    expect(binding.modelId).toBe('global:anthropic.test');
  });
});

/**
 * The runtime side of the shared managed-model rule.
 *
 * station#3743's fix expressed this rule a second time in the agent editor,
 * and the copy drifted on the case that decides whether an agent can run at
 * all: the editor chose "the sole READY candidate" where this side counts
 * every ENABLED one and calls two of them ambiguous (sol review, HIGH). Both
 * sides now import `classifyManagedModelBinding`, and each is held to it over
 * the SAME case table — this block for the runtime,
 * `src-ui/src/__tests__/managed-model-binding-agreement.test.ts` for the
 * editor. Neither imports the other (the two trees typecheck as separate TS
 * projects), so agreement is proven transitively through the rule they share:
 * re-introduce a local rule on either side and that side's block reddens.
 */
describe('the runtime agrees with the shared managed-model rule', () => {
  interface BindingCase {
    id: string;
    connections: Array<{
      id: string;
      enabled: boolean;
      status: string;
      capabilities: string[];
    }>;
    appDefault?: string;
    declared?: string;
  }

  const llm = (
    id: string,
    overrides: Partial<BindingCase['connections'][number]> = {},
  ) => ({
    id,
    enabled: true,
    status: 'ready',
    capabilities: ['llm'],
    ...overrides,
  });

  // Duplicated verbatim in the editor's sibling file. The last case is the one
  // the drifting mirror got wrong.
  const CASES: BindingCase[] = [
    { id: 'a single candidate', connections: [llm('only-llm')] },
    {
      id: 'a disabled sibling',
      connections: [
        llm('ready-llm'),
        llm('off-llm', { enabled: false, status: 'disabled' }),
      ],
    },
    {
      id: 'a vector store sibling',
      connections: [
        llm('ready-llm'),
        llm('vectors', { capabilities: ['vectordb'] }),
      ],
    },
    {
      id: 'an app default breaking a tie',
      connections: [llm('first-llm'), llm('second-llm')],
      appDefault: 'second-llm',
    },
    {
      id: 'an explicit binding to a non-candidate',
      connections: [
        llm('ready-llm'),
        llm('off-llm', { enabled: false, status: 'disabled' }),
      ],
      declared: 'off-llm',
    },
    {
      id: 'one ready plus one enabled-but-degraded, no default',
      connections: [
        llm('ready-llm'),
        llm('degraded-llm', { status: 'degraded' }),
      ],
    },
  ];

  for (const testCase of CASES) {
    test(`${testCase.id} resolves the same way the rule does`, () => {
      const rule = classifyManagedModelBinding({
        declaredConnectionId: testCase.declared,
        appDefaultConnectionId: testCase.appDefault,
        connections: testCase.connections,
      });
      const binding = resolveManagedChatBinding(
        {
          execution: testCase.declared
            ? { modelConnectionId: testCase.declared }
            : undefined,
        } as never,
        {
          appConfig: { defaultLLMProvider: testCase.appDefault },
          listProviderConnections: () => testCase.connections as never,
        },
      );
      expect({
        resolved: binding.kind === 'resolved',
        connectionId: binding.kind === 'resolved' ? binding.connectionId : null,
      }).toEqual({
        resolved: rule.kind === 'resolved',
        connectionId: rule.kind === 'resolved' ? rule.connectionId : null,
      });
    });
  }

  // Named explicitly, because it is the case the whole finding is about.
  test('one ready beside one enabled-but-degraded is ambiguous, not resolved', () => {
    const connections = [
      llm('ready-llm'),
      llm('degraded-llm', { status: 'degraded' }),
    ];
    expect(
      resolveManagedChatBinding({} as never, {
        appConfig: {},
        listProviderConnections: () => connections as never,
      }),
    ).toEqual({ kind: 'ambiguous' });
  });
});
