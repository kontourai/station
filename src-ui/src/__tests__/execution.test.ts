import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import {
  agentConnectionLabel,
  buildProviderOptions,
  canAgentStartChat,
  connectionDisplayLabel,
  connectionEvidenceDetail,
  connectionEvidenceLabel,
  connectionTypeLabel,
  executionStatusLabel,
  formatExecutionSummary,
  guaranteeConcreteModel,
  isManagedRuntimeConnectionId,
  preferredChatRuntime,
  preferredConnectedRuntime,
  resolveAgentExecution,
  resolveBindingStatus,
  resolveEffectiveCapabilityState,
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
  test('names the built-in Bedrock runtime after its actual provider', () => {
    expect(connectionTypeLabel('bedrock')).toBe('Amazon Bedrock');
    expect(agentConnectionLabel('bedrock')).toBe('Amazon Bedrock');
  });

  /**
   * archive#3739: /connections/engines printed `muse` as an engine
   * name, and the built-in vector store as `lancedb`. Every type Station's own
   * adapter registry and connection factories ship has to have a name
   * somebody chose; anything left over falls through to the slug, and that is
   * the case this list exists to keep empty.
   */
  test('every connection type Station ships has a chosen name', () => {
    for (const type of [
      'bedrock',
      'ollama',
      'openai-compat',
      'anthropic',
      'google',
      'lancedb',
      'claude',
      'codex',
      'muse',
      'acp',
    ]) {
      expect(connectionTypeLabel(type)).not.toBe(type);
    }
  });

  // A connection is named the way its owner named it, wherever the record is
  // in hand — the server's own provider label first, then the name, and only
  // then the type.
  test('a connection record is named by its own name, never its slug', () => {
    expect(
      connectionDisplayLabel({
        name: 'Muse Code',
        type: 'muse',
        config: {},
      } as never),
    ).toBe('Muse Code');
    expect(
      connectionDisplayLabel({
        name: 'My box',
        type: 'muse',
        config: { providerLabel: 'Muse Code' },
      } as never),
    ).toBe('Muse Code');
    expect(
      connectionDisplayLabel({ name: '  ', type: 'acp', config: {} } as never),
    ).toBe('Custom engine');
  });

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
    expect(
      formatExecutionSummary({
        model: 'claude-sonnet',
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
    ).toBe('Claude Code · claude-sonnet');
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

  test('formats execution status labels for chat summary display', () => {
    expect(executionStatusLabel(undefined)).toBe('Not started');
    expect(executionStatusLabel('awaiting-approval')).toBe('Awaiting approval');
    expect(executionStatusLabel('running')).toBe('Running');
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

  test('an unbound Agent needs the Model-connection picker (#3662)', () => {
    // `isManagedRuntimeConnectionId` gates whether the editor's Engine tab
    // offers a Model connection. It answered `false` for an absent binding —
    // so the one Agent shape that ALWAYS needs a Model connection, the
    // Station-engine one, was the shape it was never offered to.
    expect(isManagedRuntimeConnectionId(undefined, [])).toBe(true);
    expect(isManagedRuntimeConnectionId('', [])).toBe(true);
    // An external binding still answers false.
    expect(
      isManagedRuntimeConnectionId('codex', [
        {
          id: 'codex',
          kind: 'agent',
          type: 'codex',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          config: { engineId: 'codex' },
        },
      ] as never),
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
        config: { executionClass: 'managed' },
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
          executionClass: 'connected',
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

  test('prefers connected runtimes when choosing a connected agent default', () => {
    const runtime = preferredConnectedRuntime([
      {
        id: 'bedrock',
        kind: 'agent',
        type: 'bedrock-runtime',
        name: 'Managed Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'managed' },
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
        config: { executionClass: 'connected' },
        status: 'ready',
        prerequisites: [],
      },
    ] as any);

    expect(runtime?.id).toBe('codex');
  });

  test('preferredConnectedRuntime and preferredChatRuntime exclude ACP connections from the "connected" bucket (station#1003 Phase B parity with the pre-rename executionClass literal)', () => {
    const acpOnly = [
      {
        id: 'kiro',
        kind: 'agent',
        type: 'acp',
        name: 'Kiro',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { engineId: 'acp' },
        status: 'ready',
        prerequisites: [],
      },
    ] as any;

    expect(preferredConnectedRuntime(acpOnly)).toBeNull();
    // preferredChatRuntime still falls back to the broader "any selectable
    // connection" pool when nothing "connected" or "managed" matches — the
    // ACP exclusion only removes it from the connected/managed buckets, not
    // from that final ready[0] fallback (unchanged from the pre-rename
    // behavior).
    expect(preferredChatRuntime(acpOnly)?.id).toBe('kiro');

    const acpPlusCodex = [
      ...acpOnly,
      {
        id: 'codex',
        kind: 'agent',
        type: 'codex',
        name: 'Codex Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { engineId: 'codex' },
        status: 'ready',
        prerequisites: [],
      },
    ] as any;

    expect(preferredConnectedRuntime(acpPlusCodex)?.id).toBe('codex');
    expect(preferredChatRuntime(acpPlusCodex)?.id).toBe('codex');
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
            config: { executionClass: 'connected' },
          } as any,
        ],
      ),
    ).toBe(false);
  });

  test('derives effective capability state from the current binding', () => {
    expect(
      resolveEffectiveCapabilityState({
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
          config: { executionClass: 'managed' },
          status: 'ready',
          prerequisites: [],
        } as any,
        hasModelCatalog: true,
      }),
    ).toEqual({
      system_prompt: true,
      mcp: true,
      tool_execution: true,
      model_catalog: true,
      model_selection: true,
    });

    expect(
      resolveEffectiveCapabilityState({
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
        hasModelCatalog: true,
      }),
    ).toEqual({
      system_prompt: true,
      mcp: false,
      tool_execution: false,
      model_catalog: true,
      model_selection: true,
    });

    expect(
      resolveEffectiveCapabilityState({
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
        hasModelCatalog: false,
      }),
    ).toEqual({
      system_prompt: true,
      mcp: false,
      tool_execution: false,
      model_catalog: false,
      model_selection: false,
    });

    expect(
      resolveEffectiveCapabilityState({
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
        hasModelCatalog: true,
      }),
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

  test('labels chat confidence no stronger than its evidence', () => {
    expect(
      connectionEvidenceLabel({
        evidenceVersion: 1,
        level: 'catalog-ready',
        observedAt: '2026-07-13T20:00:00.000Z',
        freshness: 'fresh',
        summary: 'Live catalog.',
        smoke: {
          status: 'not-tested',
          freshness: 'unknown',
          turnLimit: 1,
        },
      }),
    ).toBe('Live catalog');
    expect(
      connectionEvidenceLabel({
        evidenceVersion: 1,
        level: 'catalog-ready',
        observedAt: '2026-07-13T20:00:00.000Z',
        freshness: 'fresh',
        summary: 'Latest smoke failed.',
        action: 'Sign in again.',
        smoke: {
          status: 'failed',
          freshness: 'fresh',
          reason: 'Authentication failed.',
          turnLimit: 1,
        },
      }),
    ).toBe('Smoke failed');
    expect(
      connectionEvidenceDetail({
        evidenceVersion: 1,
        level: 'prerequisite-ready',
        observedAt: '2026-07-13T20:00:00.000Z',
        freshness: 'fresh',
        summary: 'Prerequisites are ready.',
        action: 'Run smoke.',
        smoke: {
          status: 'not-tested',
          freshness: 'unknown',
          turnLimit: 1,
        },
      }),
    ).toBe('Prerequisites are ready. Run smoke.');
  });

  test('sessionAdapterSupportsSteering only reports true for a connection that explicitly declares steering (#613)', () => {
    const connections = [
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

    // No built-in adapter declares 'steering' today — a real runtime
    // connection without it must never be treated as steering-capable.
    expect(sessionAdapterSupportsSteering('claude', connections)).toBe(false);
    // A connection that does declare it (the seam's only way to flip the
    // branch) is honored.
    expect(
      sessionAdapterSupportsSteering('steering-preview-runtime', connections),
    ).toBe(true);
    // Absent connectionId or an id with no match both resolve false rather
    // than throwing.
    expect(sessionAdapterSupportsSteering(undefined, connections)).toBe(false);
    expect(sessionAdapterSupportsSteering('unknown-runtime', connections)).toBe(
      false,
    );
    // Default (no connections supplied) never crashes and stays false.
    expect(sessionAdapterSupportsSteering('claude')).toBe(false);
  });
});
