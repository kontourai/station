import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import {
  buildProviderOptions,
  canAgentStartChat,
  chatSessionIsLive,
  guaranteeConcreteModel,
  preferredChatRuntime,
  resolveAgentExecution,
  resolveBindingStatus,
  resolveEffectiveModel,
  resolveGlobalProviderManagedExecution,
  resolveModelProviderLabel,
  resolveProjectProviderManagedExecution,
  resolveSessionExecutionSummary,
  runtimeCatalogSourceSentence,
  sessionAdapterSupportsSteering,
  supportsProviderManagedBinding,
} from '../utils/execution';

describe('execution utils', () => {
  // "None catalog" was the enum read out loud.
  test('the catalogue fact reads as a phrase, not as an enum', () => {
    expect(runtimeCatalogSourceSentence('none')).toBe('No model catalog');
    expect(runtimeCatalogSourceSentence('live')).toBe('Live model catalog');
    expect(runtimeCatalogSourceSentence('cached')).toBe('Cached model catalog');
    expect(runtimeCatalogSourceSentence('built-in')).toBe(
      'Built-in model catalog',
    );
  });

  test('builds provider options for runtime-specific settings', () => {
    expect(
      buildProviderOptions('claude', {
        thinking: false,
        effort: 'high',
      }),
    ).toEqual({
      thinking: false,
      effort: 'high',
    });
    expect(
      buildProviderOptions('codex', {
        reasoningEffort: 'xhigh',
        fastMode: true,
      }),
    ).toEqual({
      reasoningEffort: 'xhigh',
      fastMode: true,
    });
  });

  test('resolves agent execution defaults and summaries', () => {
    const resolved = resolveAgentExecution({
      model: 'claude-sonnet',
      execution: {
        agentConnectionId: engineConnectionId('claude'),
        modelId: 'claude-sonnet',
        runtimeOptions: { effort: 'medium', thinking: true },
      },
    });

    expect(resolved).toMatchObject({
      agentConnectionId: engineConnectionId('claude'),
      provider: 'claude',
      model: 'claude-sonnet',
      providerOptions: { effort: 'medium', thinking: true },
    });
  });

  test('resolveAgentExecution returns provider acp for an agent bound to an ACP engine connection (station#954)', () => {
    const resolved = resolveAgentExecution({
      execution: { agentConnectionId: engineConnectionId('kiro') },
      engineConnectionType: 'acp',
    } as any);

    expect(resolved).toMatchObject({
      agentConnectionId: engineConnectionId('kiro'),
      provider: 'acp',
    });
  });

  test('uses model connection options for provider-managed selection', () => {
    expect(
      resolveEffectiveModel({
        agent: { model: 'llama3.2' },
        runtimeConnection: {
          id: 'ollama-local',
          kind: 'model',
          type: 'ollama',
          name: 'Local Ollama',
          enabled: true,
          capabilities: ['llm'],
          config: {
            modelOptions: [
              {
                id: 'llama3.2',
                name: 'Llama 3.2',
                originalId: 'llama3.2',
              },
            ],
          },
          status: 'ready',
          prerequisites: [],
        },
      }),
    ).toMatchObject({
      id: 'llama3.2',
      label: 'Llama 3.2',
      selectableModels: [
        {
          id: 'llama3.2',
          name: 'Llama 3.2',
          originalId: 'llama3.2',
        },
      ],
    });
  });

  test('last-chosen model wins over runtime and project default, but loses to a session override', () => {
    const runtimeConnection: AgentConnectionView = {
      id: engineConnectionId('claude'),
      kind: 'agent',
      type: 'claude',
      name: 'Claude Runtime',
      enabled: true,
      capabilities: ['agent-runtime'],
      config: {},
      status: 'ready',
      setup: { state: 'ready', detected: true, configured: true },
      runtimeCatalog: {
        source: 'live' as const,
        models: [
          {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            originalId: 'claude-sonnet-4-6',
          },
          {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            originalId: 'claude-opus-4-6',
          },
        ],
        builtInModels: [],
      },
      prerequisites: [],
    };

    expect(
      resolveEffectiveModel({
        runtimeConnection,
        runtimeCurrentModel: 'claude-sonnet-4-6',
        projectDefaultModel: 'claude-sonnet-4-6',
        lastChosenModel: 'claude-opus-4-6',
      }),
    ).toMatchObject({
      id: 'claude-opus-4-6',
      source: 'last chosen',
    });

    expect(
      resolveEffectiveModel({
        runtimeConnection,
        runtimeCurrentModel: 'claude-sonnet-4-6',
        sessionOverride: 'claude-sonnet-4-6',
        lastChosenModel: 'claude-opus-4-6',
      }),
    ).toMatchObject({
      id: 'claude-sonnet-4-6',
      source: 'session override',
    });
  });

  test('ignores a last-chosen model that is no longer in the connection catalog', () => {
    const runtimeConnection: AgentConnectionView = {
      id: engineConnectionId('claude'),
      kind: 'agent',
      type: 'claude',
      name: 'Claude Runtime',
      enabled: true,
      capabilities: ['agent-runtime'],
      config: {},
      status: 'ready',
      setup: { state: 'ready', detected: true, configured: true },
      runtimeCatalog: {
        source: 'live' as const,
        models: [
          {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            originalId: 'claude-sonnet-4-6',
          },
        ],
        builtInModels: [],
      },
      prerequisites: [],
    };

    expect(
      resolveEffectiveModel({
        runtimeConnection,
        runtimeCurrentModel: 'claude-sonnet-4-6',
        lastChosenModel: 'retired-model',
      }),
    ).toMatchObject({
      id: 'claude-sonnet-4-6',
      source: 'runtime',
    });
  });

  test('trusts a last-chosen model when the connection reports no catalog to validate against', () => {
    expect(
      resolveEffectiveModel({
        runtimeConnection: {
          id: 'claude',
          kind: 'agent',
          type: 'claude',
          name: 'Claude Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          prerequisites: [],
        },
        lastChosenModel: 'claude-opus-4-6',
      }),
    ).toMatchObject({
      id: 'claude-opus-4-6',
      source: 'last chosen',
    });
  });

  test('guaranteeConcreteModel falls back to the first catalog model so New Chat is never unset', () => {
    const unset = resolveEffectiveModel({
      runtimeConnection: {
        id: 'claude',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {},
        status: 'ready',
        runtimeCatalog: {
          source: 'live',
          models: [
            {
              id: 'claude-sonnet-4-6',
              name: 'Claude Sonnet 4.6',
              originalId: 'claude-sonnet-4-6',
            },
            {
              id: 'claude-opus-4-6',
              name: 'Claude Opus 4.6',
              originalId: 'claude-opus-4-6',
            },
          ],
          builtInModels: [],
        },
        prerequisites: [],
      },
    });
    expect(unset).toMatchObject({ id: null, source: 'unknown' });

    expect(guaranteeConcreteModel(unset)).toMatchObject({
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      source: 'first available',
    });

    // Leaves an already-resolved model untouched.
    const resolved = resolveEffectiveModel({
      agent: { model: 'agent-model' },
    });
    expect(guaranteeConcreteModel(resolved)).toBe(resolved);

    // No catalog to fall back to: reports unknown, same as resolveEffectiveModel.
    const noCatalog = resolveEffectiveModel({});
    expect(guaranteeConcreteModel(noCatalog)).toBe(noCatalog);
  });

  test('prefers persisted provider identity over a managed runtime on cold restore', () => {
    expect(
      resolveModelProviderLabel({
        executionMode: 'station',
        runtimeConnectionName: 'Amazon Bedrock',
        provider: 'ollama',
        agentName: 'Station',
      }),
    ).toBe('Ollama');
    expect(
      resolveModelProviderLabel({
        executionMode: 'station',
        providerConnectionName: 'Local Ollama',
        runtimeConnectionName: 'Amazon Bedrock',
        provider: 'ollama',
      }),
    ).toBe('Local Ollama');
  });

  test('prefers orchestration-backed session execution details', () => {
    expect(
      resolveSessionExecutionSummary({
        provider: 'bedrock',
        model: 'claude-should-not-win',
        status: 'sending',
        orchestrationProvider: 'claude',
        orchestrationModel: 'claude-sonnet-4-6',
        orchestrationStatus: 'awaiting-approval',
      }),
    ).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      status: 'awaiting-approval',
    });
  });

  test('only allows chat for agents whose runtime is ready', () => {
    const runtimes = [
      {
        id: 'claude',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {},
        status: 'ready',
        prerequisites: [],
      },
      {
        id: 'bedrock',
        kind: 'agent',
        type: 'bedrock-runtime',
        name: 'Managed Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {},
        status: 'missing_prerequisites',
        prerequisites: [],
      },
    ] as any;

    expect(
      canAgentStartChat(
        {
          execution: {
            agentConnectionId: engineConnectionId('claude'),
          },
        },
        runtimes,
      ),
    ).toBe(true);
    // A binding to a connection that is not ready, and one to a connection
    // that is not in the inventory at all, both refuse.
    expect(
      canAgentStartChat(
        { execution: { agentConnectionId: engineConnectionId('bedrock') } },
        runtimes,
      ),
    ).toBe(false);
    expect(
      canAgentStartChat(
        { execution: { agentConnectionId: engineConnectionId('nowhere') } },
        runtimes,
      ),
    ).toBe(false);
  });

  test('an Agent with no engine binding runs on Station and can start a chat (#3662)', () => {
    // This assertion used to read `false`, and that is the whole defect: the
    // seeded Station Agent has no resolvable engine connection (the registry
    // refuses `station` as one), so a fresh home whose model connection was
    // tested Ready — `/api/system/status` reporting configuredChatReady —
    // still rendered "Nothing to chat with yet". Absent binding = Station's
    // own engine, which is what the server dispatches on.
    expect(canAgentStartChat({ slug: 'station' }, [])).toBe(true);
    expect(canAgentStartChat({ slug: 'station', execution: {} }, [])).toBe(
      true,
    );
  });

  test('canAgentStartChat resolves ACP agents by exact per-connection match', () => {
    const acpConnections = [
      {
        id: 'kiro',
        kind: 'agent',
        type: 'acp',
        name: 'Kiro',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {},
        status: 'ready',
        prerequisites: [],
      },
      {
        id: 'other-acp',
        kind: 'agent',
        type: 'acp',
        name: 'Other ACP',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {},
        status: 'degraded',
        prerequisites: [],
      },
    ] as any;

    // (b) exact match found and ready -> true
    expect(
      canAgentStartChat(
        {
          slug: 'kiro-coder',
          execution: { agentConnectionId: engineConnectionId('kiro') },
        },
        acpConnections,
      ),
    ).toBe(true);

    // (c) this connection's own row is degraded even though a *different*
    // ACP connection row is ready -- must not fall back to any-connection.
    expect(
      canAgentStartChat(
        {
          slug: 'other-acp-coder',
          execution: { agentConnectionId: engineConnectionId('other-acp') },
        },
        acpConnections,
      ),
    ).toBe(false);

    // (d) no matching row at all for this ACP connection id -> false
    expect(
      canAgentStartChat(
        {
          slug: 'missing-coder',
          execution: { agentConnectionId: engineConnectionId('missing-acp') },
        },
        acpConnections,
      ),
    ).toBe(false);

    // (e) non-ACP slug with no exact match -> false, unchanged prior behavior
    expect(
      canAgentStartChat(
        {
          slug: 'station',
          execution: {
            agentConnectionId: engineConnectionId('claude'),
          },
        },
        acpConnections,
      ),
    ).toBe(false);
  });

  test('prefers a ready connected runtime before a Station runtime', () => {
    const runtime = preferredChatRuntime([
      {
        id: 'bedrock',
        kind: 'agent',
        type: 'bedrock-runtime',
        name: 'Managed Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { engineId: 'station' },
        status: 'ready',
        prerequisites: [],
      },
      {
        id: 'codex',
        kind: 'agent',
        type: 'codex',
        name: 'Codex Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'codex',
          defaultModel: 'gpt-5-codex',
        },
        status: 'ready',
        runtimeCatalog: {
          source: 'live',
          models: [
            {
              id: 'gpt-5-codex',
              name: 'GPT-5 Codex',
              originalId: 'gpt-5-codex',
            },
          ],
          builtInModels: [],
        },
        prerequisites: [],
      },
    ] as any);

    expect(runtime?.id).toBe('codex');
    expect(runtime?.config.defaultModel).toBe('gpt-5-codex');
  });

  test('preferredChatRuntime keeps ACP connections out of the "connected" bucket (station#1003 Phase B parity with the pre-rename executionClass literal)', () => {
    const kiro = {
      id: 'kiro',
      kind: 'agent',
      type: 'acp',
      name: 'Kiro',
      enabled: true,
      capabilities: ['agent-runtime'],
      config: { engineId: 'acp' },
      status: 'ready',
      prerequisites: [],
    };
    const managed = {
      id: 'bedrock',
      kind: 'agent',
      type: 'bedrock-runtime',
      name: 'Managed Runtime',
      enabled: true,
      capabilities: ['agent-runtime'],
      config: { engineId: 'station' },
      status: 'ready',
      prerequisites: [],
    };

    // An ACP connection listed first is not a "connected" runtime, so the
    // Station-managed one wins over it.
    expect(preferredChatRuntime([kiro, managed] as any)?.id).toBe('bedrock');
    // It still stays in the final "any selectable connection" fallback when
    // nothing connected or managed exists.
    expect(preferredChatRuntime([kiro] as any)?.id).toBe('kiro');
  });

  test('resolves provider-managed execution for project-scoped chat', () => {
    const resolved = resolveProjectProviderManagedExecution(
      {
        defaultProviderId: 'ollama-local',
        defaultModel: 'llama3.2',
      },
      [
        {
          id: 'ollama-local',
          kind: 'model',
          type: 'ollama',
          name: 'Local Ollama',
          enabled: true,
          capabilities: ['llm'],
          config: {},
          status: 'ready',
          prerequisites: [],
        },
      ] as any,
    );

    expect(resolved).toEqual({
      executionMode: 'station',
      executionScope: 'project',
      provider: 'ollama',
      providerId: 'ollama-local',
      defaultProviderId: 'ollama-local',
      model: 'llama3.2',
      providerOptions: {},
    });
  });

  test('resolves provider-managed execution for bedrock-backed project defaults', () => {
    expect(
      resolveProjectProviderManagedExecution(
        {
          defaultProviderId: 'bedrock-default',
          defaultModel: 'claude-sonnet',
        },
        [
          {
            id: 'bedrock-default',
            kind: 'model',
            type: 'bedrock',
            name: 'Bedrock',
            enabled: true,
            capabilities: ['llm'],
            config: {},
            status: 'ready',
            prerequisites: [],
          },
        ] as any,
      ),
    ).toEqual({
      executionMode: 'station',
      executionScope: 'project',
      provider: 'bedrock',
      providerId: 'bedrock-default',
      defaultProviderId: 'bedrock-default',
      model: 'claude-sonnet',
      providerOptions: {},
    });
    expect(resolveProjectProviderManagedExecution(null, [] as any)).toBeNull();
  });

  // The defect the project AI-model section had: `ProjectSettingsView` wrote
  // `defaultModel` and nothing wrote `defaultProviderId`, and this leg passes
  // `allowSingleProviderDefault: false` — so the saved model resolved to
  // nothing however many connections existed. The pair is what applies.
  test('a project model without a model connection resolves to nothing', () => {
    const connections = [
      {
        id: 'ollama-local',
        kind: 'model',
        type: 'ollama',
        name: 'Local Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: {},
        status: 'ready',
        prerequisites: [],
      },
    ] as any;

    expect(
      resolveProjectProviderManagedExecution(
        { defaultModel: 'llama3.2' },
        connections,
      ),
    ).toBeNull();
    expect(
      resolveProjectProviderManagedExecution(
        { defaultProviderId: 'ollama-local', defaultModel: 'llama3.2' },
        connections,
      ),
    ).not.toBeNull();
  });

  test('resolves a global provider-managed fallback when there is exactly one llm provider', () => {
    const resolved = resolveGlobalProviderManagedExecution(
      {
        defaultModel: 'llama3.2',
      },
      [
        {
          id: 'ollama-local',
          kind: 'model',
          type: 'ollama',
          name: 'Local Ollama',
          enabled: true,
          capabilities: ['llm'],
          config: {},
          status: 'ready',
          prerequisites: [],
        },
      ] as any,
    );

    expect(resolved).toEqual({
      executionMode: 'station',
      executionScope: 'global',
      provider: 'ollama',
      providerId: 'ollama-local',
      defaultProviderId: 'ollama-local',
      model: 'llama3.2',
      providerOptions: {},
    });
  });

  test('falls back to a provider-supported model when the requested model is invalid for that provider', () => {
    const resolved = resolveProjectProviderManagedExecution(
      {
        defaultProviderId: 'ollama-local',
        defaultModel: 'claude-sonnet-4-6',
      },
      [
        {
          id: 'ollama-local',
          kind: 'model',
          type: 'ollama',
          name: 'Local Ollama',
          enabled: true,
          capabilities: ['llm'],
          config: {
            defaultModel: 'llama3.2',
            modelOptions: [{ id: 'llama3.2', name: 'Llama 3.2' }],
          },
          status: 'ready',
          prerequisites: [],
        },
      ] as any,
    );

    expect(resolved).toEqual({
      executionMode: 'station',
      executionScope: 'project',
      provider: 'ollama',
      providerId: 'ollama-local',
      defaultProviderId: 'ollama-local',
      model: 'llama3.2',
      providerOptions: {},
    });
  });

  test('provider-managed binding covers managed agents (tools allowed), excludes connected/ACP', () => {
    // Managed agents with MCP tools ARE provider-managed-eligible: the managed
    // path runs their tools on the bound Model connection (proven live).
    expect(
      supportsProviderManagedBinding({
        slug: 'station',
        toolsConfig: { mcpServers: ['station-control'] },
      } as any),
    ).toBe(true);
    expect(
      supportsProviderManagedBinding({
        slug: 'chat-helper',
        toolsConfig: { mcpServers: [] },
      } as any),
    ).toBe(true);
    expect(
      supportsProviderManagedBinding(
        {
          slug: 'codex-agent',
          execution: { agentConnectionId: engineConnectionId('codex') },
        } as any,
        [
          {
            id: 'codex',
            config: { engineId: 'codex' },
          } as any,
        ],
      ),
    ).toBe(false);
  });

  test('derives effective capability state from the current binding', () => {
    // The global catalog stands in for "the model catalog has entries".
    const CATALOG = [{ id: 'catalog', name: 'Catalog', originalId: 'catalog' }];
    expect(
      resolveBindingStatus({
        agent: {
          slug: 'station',
          toolsConfig: { mcpServers: ['station-control'] },
          execution: {
            agentConnectionId: engineConnectionId('bedrock'),
          },
        } as any,
        runtimeConnection: {
          id: 'bedrock',
          kind: 'agent',
          type: 'bedrock-runtime',
          name: 'Managed Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: { engineId: 'station' },
          status: 'ready',
          prerequisites: [],
        } as any,
        globalModels: CATALOG,
      }).capabilityState,
    ).toEqual({
      system_prompt: true,
      mcp: true,
      tool_execution: true,
      model_catalog: true,
      model_selection: true,
    });

    expect(
      resolveBindingStatus({
        agent: {
          slug: 'station',
          toolsConfig: { mcpServers: ['station-control'] },
        } as any,
        chatState: {
          executionMode: 'station',
        } as any,
        runtimeConnection: {
          id: 'ollama-local',
          kind: 'model',
          type: 'ollama',
          config: {
            modelOptions: [{ id: 'llama3.2', name: 'Llama 3.2' }],
          },
        } as any,
        globalModels: CATALOG,
      }).capabilityState,
    ).toEqual({
      system_prompt: true,
      mcp: false,
      tool_execution: false,
      model_catalog: true,
      model_selection: true,
    });

    expect(
      resolveBindingStatus({
        agent: {
          slug: 'claude',
          execution: {
            agentConnectionId: engineConnectionId('claude'),
          },
        } as any,
        chatState: {
          executionMode: 'external',
          agentConnectionId: engineConnectionId('claude'),
        } as any,
      }).capabilityState,
    ).toEqual({
      system_prompt: true,
      mcp: false,
      tool_execution: false,
      model_catalog: false,
      model_selection: false,
    });

    expect(
      resolveBindingStatus({
        agent: {
          slug: 'claude',
          execution: {
            agentConnectionId: engineConnectionId('claude'),
          },
          modelOptions: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }],
        } as any,
        chatState: {
          executionMode: 'external',
          agentConnectionId: engineConnectionId('claude'),
        } as any,
        globalModels: CATALOG,
      }).capabilityState,
    ).toEqual({
      system_prompt: true,
      mcp: false,
      tool_execution: false,
      model_catalog: true,
      model_selection: true,
    });
  });

  test('resolves binding status from runtime catalog metadata', () => {
    expect(
      resolveBindingStatus({
        agent: {
          slug: 'codex',
          execution: { agentConnectionId: engineConnectionId('codex') },
        } as any,
        chatState: {
          executionMode: 'external',
          agentConnectionId: engineConnectionId('codex'),
        } as any,
        runtimeConnection: {
          id: 'codex',
          kind: 'agent',
          type: 'codex',
          name: 'Codex Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'degraded',
          prerequisites: [],
          runtimeCatalog: {
            source: 'built-in',
            reason: 'Live catalog unavailable.',
            models: [],
            builtInModels: [
              {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                originalId: 'gpt-5.5',
              },
            ],
          },
        } as any,
      }),
    ).toEqual({
      catalogSource: 'built-in',
      catalogReason: 'Live catalog unavailable.',
      bindingReadiness: 'degraded',
      capabilityState: {
        system_prompt: true,
        mcp: false,
        tool_execution: false,
        model_catalog: true,
        model_selection: true,
      },
      visibleModels: [
        {
          id: 'gpt-5.5',
          name: 'GPT-5.5',
          originalId: 'gpt-5.5',
        },
      ],
    });
  });

  test('preserves provider-reported model capabilities through agent binding status', () => {
    const capabilities = {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    };

    expect(
      resolveBindingStatus({
        agent: {
          slug: 'claude',
          execution: {
            agentConnectionId: engineConnectionId('claude'),
          },
          modelOptions: [
            {
              id: 'claude-sonnet',
              name: 'Claude Sonnet',
              originalId: 'claude-sonnet',
              capabilities,
            },
          ],
        },
        chatState: {
          executionMode: 'external',
          agentConnectionId: engineConnectionId('claude'),
        },
        runtimeConnection: {
          id: 'claude',
          kind: 'agent',
          type: 'claude',
          name: 'Claude Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          prerequisites: [],
        },
      }),
    ).toMatchObject({
      capabilityState: {
        model_catalog: true,
        model_selection: true,
      },
      visibleModels: [
        {
          id: 'claude-sonnet',
          capabilities,
        },
      ],
    });
  });

  test('prefers a runtime-reported model without guessing from its catalog', () => {
    const runtimeConnection = {
      id: 'opencode',
      kind: 'agent',
      type: 'acp',
      config: {},
      runtimeCatalog: {
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A', originalId: 'model-a' }],
        builtInModels: [],
      },
    } as any;
    expect(
      resolveEffectiveModel({
        runtimeConnection,
        runtimeCurrentModel: 'opencode/big-pickle',
        runtimeCurrentMode: 'plan',
        projectDefaultModel: 'unrelated/project-default',
      }),
    ).toMatchObject({
      id: 'opencode/big-pickle',
      label: 'opencode/big-pickle',
      source: 'runtime',
      catalogSource: 'live',
      mode: 'plan',
    });
  });

  test('reports unknown instead of treating a catalog entry as active', () => {
    expect(
      resolveEffectiveModel({
        runtimeConnection: {
          id: 'runtime',
          kind: 'agent',
          type: 'runtime',
          config: {},
          runtimeCatalog: {
            source: 'cached',
            models: [{ id: 'maybe', name: 'Maybe', originalId: 'maybe' }],
            builtInModels: [],
          },
        } as any,
      }),
    ).toMatchObject({
      id: null,
      label: 'Model not reported',
      source: 'unknown',
      catalogSource: 'cached',
    });
  });

  test('session override wins without mutating persisted defaults', () => {
    expect(
      resolveEffectiveModel({
        agent: { model: 'agent-model' },
        projectDefaultModel: 'project-model',
        sessionOverride: 'session-model',
      }),
    ).toMatchObject({ id: 'session-model', source: 'session override' });
  });

  test('sessionAdapterSupportsSteering reads midTurnSteer, not a connection capabilities flag', () => {
    const connections = [
      {
        id: 'claude-runtime',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { engineId: 'claude' },
        status: 'ready',
        prerequisites: [],
      },
      {
        id: 'muse-runtime',
        kind: 'agent',
        type: 'muse',
        name: 'Muse Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { engineId: 'muse' },
        status: 'ready',
        prerequisites: [],
      },
      {
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex',
        name: 'Codex Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { engineId: 'codex' },
        status: 'ready',
        prerequisites: [],
      },
      {
        id: 'steering-preview-runtime',
        kind: 'agent',
        type: 'steering-preview-runtime',
        name: 'Steering Preview Runtime',
        enabled: true,
        capabilities: ['agent-runtime', 'steering'],
        config: {},
        status: 'ready',
        prerequisites: [],
      },
    ] as any;

    expect(sessionAdapterSupportsSteering('claude-runtime', connections)).toBe(
      true,
    );
    expect(sessionAdapterSupportsSteering('codex-runtime', connections)).toBe(
      true,
    );
    expect(sessionAdapterSupportsSteering('muse-runtime', connections)).toBe(
      false,
    );
    // The live session's provider wins over the bound connection.
    expect(
      sessionAdapterSupportsSteering('muse-runtime', connections, 'claude'),
    ).toBe(true);
    expect(
      sessionAdapterSupportsSteering('claude-runtime', connections, 'muse'),
    ).toBe(false);
    // A stale `capabilities: ['steering']` string is not authority.
    expect(
      sessionAdapterSupportsSteering('steering-preview-runtime', connections),
    ).toBe(false);
    expect(sessionAdapterSupportsSteering(undefined, connections)).toBe(false);
    expect(sessionAdapterSupportsSteering('unknown-runtime', connections)).toBe(
      false,
    );
    expect(sessionAdapterSupportsSteering('claude-runtime')).toBe(false);
  });
});

/**
 * Round 3 F1. The send path withholds a session-start-only payload on a LIVE
 * session; every "unsure" answer here must be `false`, because false means
 * the posture is sent and a re-sent identical posture is a no-op while a
 * withheld one leaves a new session running something nobody chose.
 */
describe('chatSessionIsLive', () => {
  test('a running session is live', () => {
    expect(
      chatSessionIsLive({
        orchestrationSessionStarted: true,
        orchestrationStatus: 'running',
      }),
    ).toBe(true);
  });

  test('an open turn is live even before a status lands', () => {
    expect(
      chatSessionIsLive({
        orchestrationSessionStarted: true,
        orchestrationTurnOpen: true,
      }),
    ).toBe(true);
  });

  /**
   * Round 4 N1/N6. A TURN ending is not a session ending: `turn.aborted`
   * (Stop) and `runtime.error` write a status and leave the process — and
   * `orchestrationSessionStarted` — alone, and 'idle' is the ordinary
   * between-turns status. Classing any of them as settled re-requests the
   * posture into a session the server merely continues.
   */
  test.each([
    ['aborted', 'the user pressed Stop'],
    ['errored', 'a runtime error ended the turn'],
    ['idle', 'the session is between turns'],
    ['running', 'a turn is running'],
    ['awaiting-approval', 'an approval is pending'],
    ['queued', 'the session is queued'],
    ['needs_input', 'the session is waiting on input'],
    ['review_pending', 'a review is pending'],
    ['blocked', 'the session is blocked'],
  ])('%s is live (%s)', (status) => {
    expect(
      chatSessionIsLive({
        orchestrationSessionStarted: true,
        orchestrationStatus: status,
      }),
    ).toBe(true);
  });

  test('every session-terminal status is not live', () => {
    // The lifecycle half is derived from `isSessionLifecycleStateStopped`,
    // so this list is the assertion, not the source.
    for (const status of ['completed', 'failed', 'canceled', 'exited']) {
      expect(
        chatSessionIsLive({
          orchestrationSessionStarted: true,
          orchestrationStatus: status,
        }),
      ).toBe(false);
    }
  });

  test('an exited session is not live even though its id remains', () => {
    // `session.exited` clears the flag and leaves `currentSessionId`; the id
    // is deliberately not an input here.
    expect(
      chatSessionIsLive({
        orchestrationSessionStarted: false,
        orchestrationStatus: 'exited',
      }),
    ).toBe(false);
  });

  test('a reopened conversation with no status is not live', () => {
    // `commitConversationOpen` marks a resolved (continuable) open started
    // and supplies no status. Unsure answers not-live.
    expect(chatSessionIsLive({ orchestrationSessionStarted: true })).toBe(
      false,
    );
  });

  test('a chat that never started anything is not live', () => {
    expect(chatSessionIsLive({})).toBe(false);
    expect(chatSessionIsLive(undefined)).toBe(false);
  });
});
