import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import {
  buildContextOptions,
  buildLastChosenModelBindingKey,
  buildNewChatModalViewModel,
  buildNewChatModelOverrideKey,
  filterContextOptions,
  findAuthoredAgentForEngineConnection,
  GLOBAL_CONTEXT,
  getRecentAgentSlugsForContext,
  NEW_CHAT_AGENT_NOT_SET_UP_LABEL,
  NEW_CHAT_AGENT_UNAVAILABLE_FALLBACK,
  resolveNewChatAgentEnable,
  resolveNewChatAgentUnavailability,
  resolveNewChatDefaultSelection,
  resolveNewChatInitialContext,
  resolveNewChatWorkspaceHint,
  scheduleSelectedAgentVisibility,
  splitCwdBreadcrumb,
} from '../components/modals/new-chat-modal-utils';

describe('new-chat-modal-utils', () => {
  test('scopes pre-session model overrides to context and provider binding', () => {
    const agent = {
      slug: agentId('station'),
      execution: {
        agentConnectionId: engineConnectionId('bedrock-runtime'),
        runtimeOptions: { providerId: 'ollama-local' },
      },
    };

    const globalOllama = buildNewChatModelOverrideKey(agent, GLOBAL_CONTEXT);
    expect(globalOllama).not.toBe(
      buildNewChatModelOverrideKey(agent, 'project-a'),
    );
    expect(globalOllama).not.toBe(
      buildNewChatModelOverrideKey(
        {
          ...agent,
          execution: {
            ...agent.execution,
            runtimeOptions: { providerId: 'bedrock-prod' },
          },
        },
        GLOBAL_CONTEXT,
      ),
    );
  });

  test('buildLastChosenModelBindingKey identifies the agent app connection, not the project', () => {
    const agent = {
      slug: agentId('station'),
      execution: {
        agentConnectionId: engineConnectionId('bedrock-runtime'),
        runtimeOptions: { providerId: 'ollama-local' },
      },
    };

    expect(buildLastChosenModelBindingKey(agent)).toBe(
      buildNewChatModelOverrideKey(agent, GLOBAL_CONTEXT)
        .split('\u001f')
        .slice(1)
        .join('\u001f'),
    );
    // Same agent app connection, different project contexts: identical binding key.
    expect(buildLastChosenModelBindingKey(agent)).toBe(
      buildLastChosenModelBindingKey(agent),
    );
    // Different provider binding: different key.
    expect(buildLastChosenModelBindingKey(agent)).not.toBe(
      buildLastChosenModelBindingKey({
        ...agent,
        execution: {
          ...agent.execution,
          runtimeOptions: { providerId: 'bedrock-prod' },
        },
      }),
    );
    // Different agent slug on the same connection: different key.
    expect(buildLastChosenModelBindingKey(agent)).not.toBe(
      buildLastChosenModelBindingKey({
        ...agent,
        slug: agentId('other-agent'),
      }),
    );
  });

  test('defers selected-agent visibility until layout and uses nearest scrolling', () => {
    const scrollIntoView = vi.fn();
    let scheduled: FrameRequestCallback | undefined;

    const frame = scheduleSelectedAgentVisibility(
      { scrollIntoView } as unknown as HTMLButtonElement,
      (callback) => {
        scheduled = callback;
        return 7;
      },
    );

    expect(frame).toBe(7);
    expect(scrollIntoView).not.toHaveBeenCalled();
    scheduled?.(0);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  test('splitCwdBreadcrumb preserves explicit separators for home and absolute paths', () => {
    expect(splitCwdBreadcrumb('~/dev/github/kontourai')).toEqual({
      parent: '~/dev/github',
      separator: '/',
      leaf: 'kontourai',
    });
    expect(splitCwdBreadcrumb('/Users/brian/dev/github/kontourai/')).toEqual({
      parent: '/Users/brian/dev/github',
      separator: '/',
      leaf: 'kontourai',
    });
  });

  test('buildContextOptions prepends global and preserves project metadata', () => {
    expect(
      buildContextOptions([
        {
          slug: 'project-a',
          name: 'Project A',
          icon: '🧪',
          workingDirectory: '/work/a',
        } as any,
      ]),
    ).toEqual([
      { value: GLOBAL_CONTEXT, label: 'No workspace', glyph: 'globe' },
      {
        value: 'project-a',
        label: 'Project A',
        icon: '🧪',
        workingDirectory: '/work/a',
      },
    ]);
  });

  test('buildContextOptions skips null project entries defensively', () => {
    expect(
      buildContextOptions([
        null,
        { slug: 'project-a', name: 'Project A' } as any,
      ] as any),
    ).toEqual([
      { value: GLOBAL_CONTEXT, label: 'No workspace', glyph: 'globe' },
      {
        value: 'project-a',
        label: 'Project A',
        glyph: 'folder',
        workingDirectory: undefined,
      },
    ]);
  });

  test('prefers only an active project with a working directory', () => {
    const projects = [
      { slug: 'project-a', name: 'Project A' },
      {
        slug: 'project-b',
        name: 'Project B',
        workingDirectory: '/workspace/project-b',
      },
    ] as any;

    expect(resolveNewChatInitialContext('project-b', projects)).toBe(
      'project-b',
    );
    expect(resolveNewChatInitialContext('project-a', projects)).toBe(
      GLOBAL_CONTEXT,
    );
    expect(resolveNewChatInitialContext('deleted-project', projects)).toBe(
      GLOBAL_CONTEXT,
    );
    expect(resolveNewChatInitialContext(null, projects)).toBe(GLOBAL_CONTEXT);
    expect(resolveNewChatInitialContext(null, [])).toBe(GLOBAL_CONTEXT);
  });

  test('filterContextOptions matches labels case-insensitively', () => {
    const options = buildContextOptions([
      { slug: 'project-a', name: 'Alpha Project' } as any,
      { slug: 'project-b', name: 'Beta Project' } as any,
    ]);

    expect(filterContextOptions(options, '')).toBe(options);
    expect(filterContextOptions(options, 'beta').map((o) => o.value)).toEqual([
      'project-b',
    ]);
  });

  test('getRecentAgentSlugsForContext prefers active chats before stored history', () => {
    expect(
      getRecentAgentSlugsForContext(
        {
          s1: {
            agentSlug: 'alpha',
            messages: [{}],
            projectSlug: undefined,
            lastActivity: 3000,
          },
          s2: {
            agentSlug: 'beta',
            messages: [{}],
            projectSlug: 'project-a',
            lastActivity: 2000,
          },
          s3: {
            agentSlug: 'gamma',
            messages: [{}],
            projectSlug: 'project-a',
            lastActivity: 1000,
          },
        },
        'project-a',
        ['delta', 'beta', 'epsilon', 'zeta'],
      ),
    ).toEqual(['beta', 'gamma', 'delta', 'epsilon', 'zeta']);

    expect(
      getRecentAgentSlugsForContext(
        {
          s1: {
            agentSlug: 'alpha',
            messages: [{}],
            projectSlug: undefined,
            lastActivity: 3000,
          },
          s2: {
            agentSlug: 'beta',
            messages: [{}],
            projectSlug: 'project-a',
            lastActivity: 2000,
          },
        },
        GLOBAL_CONTEXT,
        ['stored-a'],
      ),
    ).toEqual(['alpha', 'stored-a']);
  });

  test('default selection uses chooser order and the ACP live model and mode', () => {
    const selection = resolveNewChatDefaultSelection({
      flatList: [
        {
          slug: 'recent',
          name: 'Recent Agent',
          model: 'stale-model',
          execution: { agentConnectionId: 'acp-runtime' },
        } as any,
      ],
      agentConnections: [
        {
          id: 'acp-runtime',
          config: {},
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
        } as any,
      ],
      modelConnections: [],
      acpConnections: [
        {
          id: 'acp-runtime',
          currentModel: 'live-model',
          configOptions: [{ category: 'mode', currentValue: 'plan' }],
        },
      ],
      projectDefaultModel: 'project-model',
    });
    expect(selection.agent?.slug).toBe('recent');
    expect(selection.effectiveModel).toMatchObject({
      id: 'live-model',
      // station#3391 made `modelDisplayLabel` the ONE derivation of what a
      // model id is called, and prettifies an id with no catalog entry rather
      // than showing the user an internal id. This expectation predates that
      // unification; asserting the raw id here pins the behaviour #3391
      // deliberately removed.
      label: 'Live Model',
      mode: 'plan',
      source: 'runtime',
    });
  });

  test('default selection keeps the provider-validated model over a stale project model', () => {
    const selection = resolveNewChatDefaultSelection({
      flatList: [
        {
          slug: 'station',
          name: 'Station',
          model: 'llama3.2',
          execution: {
            agentConnectionId: 'bedrock-runtime',
            runtimeOptions: {
              executionMode: 'station',
              providerId: 'ollama-local',
            },
          },
        } as any,
      ],
      agentConnections: [],
      modelConnections: [
        {
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
      ],
      acpConnections: [],
      projectDefaultModel: 'claude-sonnet-4-6',
    });

    expect(selection.effectiveModel).toMatchObject({
      id: 'llama3.2',
      label: 'Llama 3.2',
      source: 'agent default',
    });
  });

  test('default selection never lets remembered-model memory shadow a PROVIDER_MANAGED agent default', () => {
    const flatList = [
      {
        slug: 'station',
        name: 'Station',
        model: 'llama3.2',
        execution: {
          agentConnectionId: 'bedrock-runtime',
          runtimeOptions: {
            executionMode: 'station',
            providerId: 'ollama-local',
          },
        },
      } as any,
    ];
    const modelConnections: ConnectionConfig[] = [
      {
        id: 'ollama-local',
        kind: 'model',
        type: 'ollama',
        name: 'Local Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: {
          modelOptions: [
            { id: 'llama3.2', name: 'Llama 3.2', originalId: 'llama3.2' },
            { id: 'mistral', name: 'Mistral', originalId: 'mistral' },
          ],
        },
        status: 'ready',
        prerequisites: [],
      },
    ];

    // A stored "last chosen" entry for this same agent app binding — valid
    // against the catalog, so nothing about the memory itself is stale.
    // It must still never win: an admin's project/agent default model for
    // a Station (PROVIDER_MANAGED) agent must not be shadowed by
    // remembered-model memory, which is an External-agent (agent app)
    // concept only.
    const selection = resolveNewChatDefaultSelection({
      flatList,
      agentConnections: [],
      modelConnections,
      acpConnections: [],
      projectDefaultModel: 'claude-sonnet-4-6',
      lastChosenModelByBinding: { 'ollama-local\u001fdefault': 'mistral' },
    });

    expect(selection.effectiveModel).toMatchObject({
      id: 'llama3.2',
      label: 'Llama 3.2',
      source: 'agent default',
    });
  });

  test('default selection prefers a valid remembered model over the live ACP model', () => {
    const flatList = [
      {
        slug: 'recent',
        name: 'Recent Agent',
        model: 'stale-model',
        execution: { agentConnectionId: 'acp-runtime' },
      } as any,
    ];
    const agentConnections = [
      {
        id: 'acp-runtime',
        config: {},
        runtimeCatalog: {
          source: 'live',
          models: [
            { id: 'live-model', name: 'live-model', originalId: 'live-model' },
            {
              id: 'remembered-model',
              name: 'remembered-model',
              originalId: 'remembered-model',
            },
          ],
          builtInModels: [],
        },
      } as any,
    ];
    const acpConnections = [
      {
        id: 'acp-runtime',
        currentModel: 'live-model',
        configOptions: [{ category: 'mode', currentValue: 'plan' }],
      },
    ];

    const remembered = resolveNewChatDefaultSelection({
      flatList,
      agentConnections,
      modelConnections: [],
      acpConnections,
      lastChosenModelByBinding: {
        'acp-runtime\u001frecent': 'remembered-model',
      },
    });
    expect(remembered.effectiveModel).toMatchObject({
      id: 'remembered-model',
      source: 'last chosen',
    });

    const ignoredStale = resolveNewChatDefaultSelection({
      flatList,
      agentConnections,
      modelConnections: [],
      acpConnections,
      lastChosenModelByBinding: {
        'acp-runtime\u001facp:recent': 'retired-model',
      },
    });
    expect(ignoredStale.effectiveModel).toMatchObject({
      id: 'live-model',
      source: 'runtime',
    });

    const noMemory = resolveNewChatDefaultSelection({
      flatList,
      agentConnections,
      modelConnections: [],
      acpConnections,
    });
    expect(noMemory.effectiveModel).toMatchObject({
      id: 'live-model',
      source: 'runtime',
    });
  });

  test('buildNewChatModalViewModel groups runtime, layout, ACP, and global agents', () => {
    const viewModel = buildNewChatModalViewModel({
      agents: [
        {
          slug: 'alpha',
          name: 'Alpha',
          source: 'local',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
        {
          slug: 'beta',
          name: 'Beta',
          source: 'local',
          plugin: 'layout',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
        {
          slug: 'gamma',
          name: 'Gamma',
          source: 'acp',
          engineConnectionType: 'acp',
          connectionName: 'ACP One',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
      ],
      projects: [
        { slug: 'project-a', name: 'Project A', layoutCount: 1 } as any,
      ],
      agentConnections: [
        {
          id: 'bedrock-runtime',
          kind: 'agent',
          type: 'bedrock-runtime',
          name: 'Managed Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
      ],
      selectedContext: GLOBAL_CONTEXT,
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: undefined,
      layoutAvailableAgents: ['layout:beta'],
      layoutName: 'Workspace Layout',
      layoutIcon: '🧩',
      providerManagedAgentSlugs: [],
      recentSlugs: ['alpha'],
    });

    expect(viewModel.isGlobal).toBe(true);
    expect(viewModel.currentContextOption?.value).toBe(GLOBAL_CONTEXT);
    expect(viewModel.contextOptions[0]).toEqual({
      value: GLOBAL_CONTEXT,
      label: 'No workspace',
      glyph: 'globe',
    });
    expect(viewModel.filteredContextOptions).toHaveLength(2);
    // DESIGN.md §5: two bands, the same two the Agents list uses. `Recent`
    // and a layout's own group are CONTEXT groupings and survive above them.
    expect(viewModel.groups.map((group) => group.label)).toEqual([
      'Recent',
      'Workspace Layout',
      'Engines on this machine',
    ]);
    expect(viewModel.flatList.map((agent) => agent.slug)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(viewModel.compatibilityMessage).toBeUndefined();
  });

  test('dedupes runtime chat agents when agents already include matching runtime entries', () => {
    const viewModel = buildNewChatModalViewModel({
      agents: [
        {
          slug: 'claude',
          name: 'Claude Runtime',
          description: 'server-backed claude runtime row',
          source: 'local',
          engineDefault: true,
          engineId: 'claude',
          engineDisplayName: 'Claude Runtime',
          execution: { agentConnectionId: 'claude-runtime' },
        } as any,
        {
          slug: 'codex',
          name: 'Codex Runtime',
          description: 'server-backed codex runtime row',
          source: 'local',
          engineDefault: true,
          engineId: 'codex',
          engineDisplayName: 'Codex Runtime',
          execution: { agentConnectionId: 'codex-runtime' },
        } as any,
        {
          slug: 'station',
          name: 'Station',
          source: 'local',
          engineDefault: true,
          engineId: 'station',
          engineDisplayName: 'Station',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
      ],
      projects: [],
      agentConnections: [
        {
          id: 'claude-runtime',
          kind: 'agent',
          type: 'claude-runtime',
          name: 'Claude Runtime',
          description: 'connection-backed claude runtime row',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
        {
          id: 'codex-runtime',
          kind: 'agent',
          type: 'codex-runtime',
          name: 'Codex Runtime',
          description: 'connection-backed codex runtime row',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: {
            source: 'built-in',
            models: [],
            builtInModels: [],
          },
          prerequisites: [],
        } as any,
        {
          id: 'bedrock-runtime',
          kind: 'agent',
          type: 'bedrock-runtime',
          name: 'Managed Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
      ],
      selectedContext: GLOBAL_CONTEXT,
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: undefined,
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [],
      recentSlugs: [],
    });

    // DESIGN.md §5: the engine rows share ONE band. What this test is
    // actually about is DEDUPE — each engine appears once, carrying the
    // server-backed row's own description — and that is unchanged.
    const engineBand = viewModel.groups.find(
      (group) => group.label === 'Engines on this machine',
    );

    expect(engineBand?.agents.map((agent) => agent.slug).sort()).toEqual([
      'claude',
      'codex',
      'station',
    ]);
    expect(
      viewModel.flatList.filter((agent) => agent.slug === 'claude'),
    ).toHaveLength(1);
    expect(
      viewModel.flatList.filter((agent) => agent.slug === 'codex'),
    ).toHaveLength(1);
    expect(
      engineBand?.agents.find((agent) => agent.slug === 'claude')?.description,
    ).toBe('server-backed claude runtime row');
    expect(
      engineBand?.agents.find((agent) => agent.slug === 'codex')?.description,
    ).toBe('server-backed codex runtime row');
    expect(
      viewModel.groups.find((group) => group.label === 'Your agents'),
    ).toBeUndefined();
  });

  test('excludes managed runtime rows before grouping and stale recency', () => {
    const viewModel = buildNewChatModalViewModel({
      agents: [
        {
          slug: 'station',
          name: 'Managed Runtime',
          source: 'local',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
        {
          slug: 'station',
          name: 'Station',
          source: 'local',
          execution: {
            agentConnectionId: 'bedrock-runtime',
            runtimeOptions: { executionMode: 'station' },
          },
        } as any,
      ],
      projects: [],
      agentConnections: [
        {
          id: 'bedrock-runtime',
          kind: 'agent',
          type: 'bedrock-runtime',
          name: 'Managed Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: { executionClass: 'managed', provider: 'bedrock' },
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
        {
          id: 'codex-runtime',
          kind: 'agent',
          type: 'codex-runtime',
          name: 'Codex Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: { executionClass: 'external' },
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
      ],
      selectedContext: GLOBAL_CONTEXT,
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: undefined,
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [agentId('station')],
      recentSlugs: ['station', 'station'],
    });

    expect(viewModel.groups.map((group) => group.label)).toEqual(['Recent']);
    expect(viewModel.flatList.map((agent) => agent.slug)).toEqual(['station']);
    expect(
      viewModel.groups.flatMap((group) =>
        group.agents.map((agent) => agent.slug),
      ),
    ).not.toContain('codex');
  });

  test('shows provider-managed default agent in project context without runtime readiness', () => {
    const viewModel = buildNewChatModalViewModel({
      agents: [
        {
          slug: 'station',
          name: 'Station',
          source: 'local',
          model: 'llama3.2',
          execution: {
            agentConnectionId: 'bedrock-runtime',
            runtimeOptions: {
              executionMode: 'station',
              executionScope: 'project',
              providerId: 'ollama-local',
              providerKind: 'ollama',
              displayModel: 'llama3.2',
            },
          },
        } as any,
      ],
      projects: [
        { slug: 'project-a', name: 'Project A', layoutCount: 0 } as any,
      ],
      agentConnections: [],
      selectedContext: 'project-a',
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: undefined,
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [agentId('station')],
      recentSlugs: [],
    });

    expect(viewModel.groups.map((group) => group.label)).toEqual([
      'Your agents',
    ]);
    expect(viewModel.flatList.map((agent) => agent.slug)).toEqual(['station']);
    expect(viewModel.groups[0]?.agents[0]).toEqual(
      expect.objectContaining({ slug: 'station', name: 'Station' }),
    );
  });

  test('treats undefined project agent scope as all agents and empty scope as no agents', () => {
    const base = {
      agents: [
        {
          slug: 'alpha',
          name: 'Alpha',
          source: 'local',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
      ],
      projects: [],
      agentConnections: [
        {
          id: 'bedrock-runtime',
          kind: 'agent',
          type: 'bedrock-runtime',
          name: 'Managed Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
      ],
      selectedContext: 'project-a',
      contextSearch: '',
      agentSearch: '',
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [],
      recentSlugs: [],
    };

    expect(
      buildNewChatModalViewModel({
        ...base,
        selectedProjectAgentFilter: undefined,
      }).flatList.map((agent) => agent.slug),
    ).toEqual(['alpha']);
    expect(
      buildNewChatModalViewModel({
        ...base,
        selectedProjectAgentFilter: [],
      }).flatList.map((agent) => agent.slug),
    ).toEqual([]);
  });

  test('keeps unavailable custom Agents visible only in their permitted project scope', () => {
    const base = {
      agents: [
        {
          slug: 'unavailable-global',
          name: 'Unavailable global',
          available: false,
          unavailableReason: 'A model connection is required.',
          execution: { agentConnectionId: 'removed-connection' },
        },
        {
          slug: 'unavailable-owned',
          name: 'Unavailable owned',
          project: 'project-a',
          available: false,
          unavailableReason: 'The engine connection was removed.',
          execution: { agentConnectionId: 'removed-connection' },
        },
        {
          slug: 'unavailable-other-project',
          name: 'Unavailable elsewhere',
          project: 'project-b',
          available: false,
          unavailableReason: 'The engine connection was removed.',
          execution: { agentConnectionId: 'removed-connection' },
        },
      ] as any[],
      projects: [
        { slug: 'project-a', name: 'Project A', layoutCount: 0 },
        { slug: 'project-b', name: 'Project B', layoutCount: 0 },
      ] as any[],
      agentConnections: [] as any[],
      selectedContext: 'project-a',
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: undefined,
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [],
      recentSlugs: [],
    };

    expect(
      buildNewChatModalViewModel(base).flatList.map((agent) => agent.slug),
    ).toEqual(['unavailable-global', 'unavailable-owned']);
  });

  describe('project-owned agents (station#1004, unification slice 7)', () => {
    test('an agent owned by the selected project appears in its engine group even when ProjectConfig.agents excludes it', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [
          {
            slug: 'owned-agent',
            name: 'Owned Agent',
            source: 'local',
            project: 'project-a',
            execution: { agentConnectionId: 'bedrock-runtime' },
          } as any,
        ],
        projects: [
          { slug: 'project-a', name: 'Project A', layoutCount: 0 } as any,
        ],
        agentConnections: [
          {
            id: 'bedrock-runtime',
            kind: 'agent',
            type: 'bedrock-runtime',
            name: 'Managed Runtime',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: {},
            status: 'ready',
            runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
            prerequisites: [],
          } as any,
        ],
        selectedContext: 'project-a',
        contextSearch: '',
        agentSearch: '',
        // Empty filter would normally exclude every global agent — an owned
        // agent ignores it entirely (§3.3 two-input rule).
        selectedProjectAgentFilter: [],
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });

      expect(viewModel.flatList.map((agent) => agent.slug)).toEqual([
        'owned-agent',
      ]);
    });

    test('an agent owned by another project never appears', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [
          {
            slug: 'owned-elsewhere',
            name: 'Owned Elsewhere',
            source: 'local',
            project: 'project-b',
            execution: { agentConnectionId: 'bedrock-runtime' },
          } as any,
        ],
        projects: [
          { slug: 'project-a', name: 'Project A', layoutCount: 0 } as any,
          { slug: 'project-b', name: 'Project B', layoutCount: 0 } as any,
        ],
        agentConnections: [
          {
            id: 'bedrock-runtime',
            kind: 'agent',
            type: 'bedrock-runtime',
            name: 'Managed Runtime',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: {},
            status: 'ready',
            runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
            prerequisites: [],
          } as any,
        ],
        selectedContext: 'project-a',
        contextSearch: '',
        agentSearch: '',
        selectedProjectAgentFilter: undefined,
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });

      expect(viewModel.flatList.map((agent) => agent.slug)).toEqual([]);
    });

    test('owned agents do not appear in the global (no workspace) context', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [
          {
            slug: 'owned-agent',
            name: 'Owned Agent',
            source: 'local',
            project: 'project-a',
            execution: { agentConnectionId: 'bedrock-runtime' },
          } as any,
        ],
        projects: [
          { slug: 'project-a', name: 'Project A', layoutCount: 0 } as any,
        ],
        agentConnections: [
          {
            id: 'bedrock-runtime',
            kind: 'agent',
            type: 'bedrock-runtime',
            name: 'Managed Runtime',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: {},
            status: 'ready',
            runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
            prerequisites: [],
          } as any,
        ],
        selectedContext: GLOBAL_CONTEXT,
        contextSearch: '',
        agentSearch: '',
        selectedProjectAgentFilter: undefined,
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });

      expect(viewModel.flatList.map((agent) => agent.slug)).toEqual([]);
    });

    test('the ProjectConfig.agents filter applies exact global Agent ids alongside an owned agent', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [
          {
            slug: 'owned-agent',
            name: 'Owned Agent',
            source: 'local',
            project: 'project-a',
            execution: { agentConnectionId: 'bedrock-runtime' },
          } as any,
          {
            slug: 'global-excluded',
            name: 'Global Excluded',
            source: 'local',
            execution: { agentConnectionId: 'bedrock-runtime' },
          } as any,
          {
            slug: 'global-aliased',
            name: 'Global Aliased',
            source: 'local',
            execution: { agentConnectionId: 'bedrock-runtime' },
          } as any,
        ],
        projects: [
          { slug: 'project-a', name: 'Project A', layoutCount: 0 } as any,
        ],
        agentConnections: [
          {
            id: 'bedrock-runtime',
            kind: 'agent',
            type: 'bedrock-runtime',
            name: 'Managed Runtime',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: {},
            status: 'ready',
            runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
            prerequisites: [],
          } as any,
        ],
        selectedContext: 'project-a',
        contextSearch: '',
        agentSearch: '',
        // 'owned-agent' is not named here — its ownership admits it.
        selectedProjectAgentFilter: [agentId('global-aliased')],
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });

      expect(viewModel.flatList.map((agent) => agent.slug).sort()).toEqual([
        'global-aliased',
        'owned-agent',
      ]);
    });
  });

  test('project agent scope exposes only selected agents and selected runtime chat rows', () => {
    const viewModel = buildNewChatModalViewModel({
      agents: [
        {
          slug: 'alpha',
          name: 'Alpha',
          source: 'local',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
        {
          slug: 'beta',
          name: 'Beta',
          source: 'local',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
      ],
      projects: [
        { slug: 'project-a', name: 'Project A', layoutCount: 0 } as any,
      ],
      agentConnections: [
        {
          id: 'bedrock-runtime',
          kind: 'agent',
          type: 'bedrock-runtime',
          name: 'Managed Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
        {
          id: 'codex-runtime',
          kind: 'agent',
          type: 'codex-runtime',
          name: 'Codex Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
      ],
      selectedContext: 'project-a',
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: [agentId('alpha'), agentId('codex')],
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [],
      recentSlugs: [],
    });

    expect(viewModel.groups.map((group) => group.label)).toEqual([
      'Your agents',
    ]);
    expect(viewModel.flatList.map((agent) => agent.slug)).toEqual(['alpha']);
  });

  test('hides recent runtime agents from the runtime section and keeps runtime chat last', () => {
    const viewModel = buildNewChatModalViewModel({
      agents: [
        {
          slug: 'codex',
          name: 'Codex Runtime',
          source: 'local',
          execution: { agentConnectionId: 'codex-runtime' },
        } as any,
        {
          slug: 'station',
          name: 'Station',
          source: 'local',
          execution: { agentConnectionId: 'bedrock-runtime' },
        } as any,
      ],
      projects: [],
      agentConnections: [
        {
          id: 'codex-runtime',
          kind: 'agent',
          type: 'codex-runtime',
          name: 'Codex Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
        {
          id: 'claude-runtime',
          kind: 'agent',
          type: 'claude-runtime',
          name: 'Claude Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'cached', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
      ],
      selectedContext: GLOBAL_CONTEXT,
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: undefined,
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [],
      recentSlugs: ['codex'],
    });

    expect(viewModel.groups.map((group) => group.label)).toEqual(['Recent']);
    expect(viewModel.groups[0]?.agents.map((agent) => agent.slug)).toEqual([
      'codex',
    ]);
    expect(viewModel.groups[1]).toBeUndefined();
  });

  test('surfaces degraded runtime compatibility messaging', () => {
    const viewModel = buildNewChatModalViewModel({
      agents: [],
      projects: [],
      agentConnections: [
        {
          id: 'codex-runtime',
          kind: 'agent',
          type: 'codex-runtime',
          name: 'Codex Runtime',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'degraded',
          runtimeCatalog: {
            source: 'built-in',
            reason: 'Live catalog unavailable.',
            models: [],
            builtInModels: [],
          },
          prerequisites: [],
        } as any,
      ],
      selectedContext: GLOBAL_CONTEXT,
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: undefined,
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [],
      recentSlugs: [],
    });

    expect(viewModel.compatibilityMessage).toContain(
      'Codex Runtime: Degraded · Catalog Built-in',
    );
  });

  describe('registry-owned default Agents', () => {
    function connectedConnection(overrides: Record<string, any> = {}) {
      return {
        id: 'claude-runtime',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Code',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'connected' },
        status: 'ready',
        runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
        prerequisites: [],
        ...overrides,
      } as any;
    }

    function defaultClaudeCode(overrides: Record<string, any> = {}) {
      return {
        slug: 'claude-code',
        name: 'Claude Code',
        source: 'local',
        execution: { agentConnectionId: 'claude-runtime' },
        engineDefault: true,
        engineId: 'claude',
        engineDisplayName: 'Claude Code',
        ...overrides,
      } as any;
    }

    test('uses the persisted default Agent without manufacturing another row', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [defaultClaudeCode()],
        projects: [],
        agentConnections: [connectedConnection()],
        selectedContext: GLOBAL_CONTEXT,
        contextSearch: '',
        agentSearch: '',
        selectedProjectAgentFilter: undefined,
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });

      expect(viewModel.flatList.map((agent) => agent.slug)).toEqual([
        'claude-code',
      ]);
      expect(viewModel.flatList.some((agent) => agent.slug === 'claude')).toBe(
        false,
      );
    });

    test('does not manufacture a row when the persisted default is absent', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [],
        projects: [],
        agentConnections: [connectedConnection()],
        selectedContext: GLOBAL_CONTEXT,
        contextSearch: '',
        agentSearch: '',
        selectedProjectAgentFilter: undefined,
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });

      expect(viewModel.flatList.map((agent) => agent.slug)).toEqual([]);
    });

    test('groups a persisted default Agent inside its engine group, not Global', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [defaultClaudeCode()],
        projects: [],
        agentConnections: [connectedConnection()],
        selectedContext: GLOBAL_CONTEXT,
        contextSearch: '',
        agentSearch: '',
        selectedProjectAgentFilter: undefined,
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });

      expect(viewModel.groups.map((group) => group.label)).toEqual([
        'Engines on this machine',
      ]);
      expect(
        viewModel.groups.find((group) => group.label === 'Your agents'),
      ).toBeUndefined();
    });

    test('matches a recent Agent by its exact clean id', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [defaultClaudeCode()],
        projects: [],
        agentConnections: [connectedConnection()],
        selectedContext: GLOBAL_CONTEXT,
        contextSearch: '',
        agentSearch: '',
        selectedProjectAgentFilter: undefined,
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: ['claude-code'],
      });

      expect(viewModel.groups.map((group) => group.label)).toEqual(['Recent']);
      expect(viewModel.groups[0]?.agents.map((agent) => agent.slug)).toEqual([
        'claude-code',
      ]);
    });

    test('project agent filter naming the exact Agent id admits the default', () => {
      const viewModel = buildNewChatModalViewModel({
        agents: [
          defaultClaudeCode({
            slug: 'codex',
            name: 'Codex',
            execution: { agentConnectionId: 'codex-runtime' },
            engineId: 'codex',
            engineDisplayName: 'Codex',
          }),
        ],
        projects: [
          { slug: 'project-a', name: 'Project A', layoutCount: 0 } as any,
        ],
        agentConnections: [
          connectedConnection({
            id: 'codex-runtime',
            type: 'codex',
            name: 'Codex',
          }),
        ],
        selectedContext: 'project-a',
        contextSearch: '',
        agentSearch: '',
        selectedProjectAgentFilter: [agentId('codex')],
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });

      expect(viewModel.flatList.map((agent) => agent.slug)).toEqual(['codex']);
    });
  });

  test('converges a native connection and an ACP connection with the same engine name into one group', () => {
    const viewModel = buildNewChatModalViewModel({
      agents: [
        {
          slug: 'opencode',
          name: 'OpenCode',
          source: 'local',
          engineDefault: true,
          engineId: 'opencode',
          engineDisplayName: 'OpenCode',
          execution: { agentConnectionId: 'opencode-native' },
        } as any,
        {
          slug: 'opencode-mode',
          name: 'OpenCode Mode',
          source: 'acp',
          engineConnectionType: 'acp',
          connectionName: 'OpenCode',
          execution: { agentConnectionId: 'opencode-acp' },
        } as any,
      ],
      projects: [],
      agentConnections: [
        {
          id: 'opencode-native',
          kind: 'agent',
          type: 'opencode-native',
          name: 'OpenCode',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
        {
          id: 'opencode-acp',
          kind: 'agent',
          type: 'acp',
          name: 'OpenCode',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: {},
          status: 'ready',
          runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
          prerequisites: [],
        } as any,
      ],
      selectedContext: GLOBAL_CONTEXT,
      contextSearch: '',
      agentSearch: '',
      selectedProjectAgentFilter: undefined,
      layoutAvailableAgents: [],
      layoutName: undefined,
      layoutIcon: undefined,
      providerManagedAgentSlugs: [],
      recentSlugs: [],
    });

    // Convergence is now structural: a native engine row and an ACP engine
    // row share ONE band, so two connections for one engine cannot open two
    // headings whatever they are called.
    const engineGroups = viewModel.groups.filter(
      (group) => group.label === 'Engines on this machine',
    );
    expect(engineGroups).toHaveLength(1);
    expect(engineGroups[0]?.agents.map((agent) => agent.slug).sort()).toEqual(
      ['opencode', 'opencode-mode'].sort(),
    );
  });

  describe('engine enable (#3027)', () => {
    const codexConnection = {
      id: 'codex',
      kind: 'agent',
      type: 'codex-runtime',
      name: 'Codex',
      enabled: true,
      capabilities: ['agent-runtime'],
      config: {},
      status: 'ready',
      prerequisites: [],
    } as any;

    const codexAlias = {
      slug: 'codex',
      name: 'codex',
      engineDefault: true,
      engineId: 'codex',
      engineDisplayName: 'Codex',
      execution: { agentConnectionId: 'codex' },
      available: false,
      unavailableReason:
        "Agent 'codex' has no authored Agent definition, so Station cannot start new sessions with it.",
      enable: { engineConnectionId: 'codex' },
    } as any;

    const authoredCodexAgent = {
      slug: 'codex-agent',
      name: 'Codex Agent',
      execution: { agentConnectionId: 'codex' },
    } as any;

    function viewModelFor(agents: any[], agentSearch = '') {
      return buildNewChatModalViewModel({
        agents,
        projects: [],
        agentConnections: [codexConnection],
        selectedContext: GLOBAL_CONTEXT,
        contextSearch: '',
        agentSearch,
        selectedProjectAgentFilter: undefined,
        layoutAvailableAgents: [],
        layoutName: undefined,
        layoutIcon: undefined,
        providerManagedAgentSlugs: [],
        recentSlugs: [],
      });
    }

    test('offers Enable only for an unavailable row carrying the machine-readable signal', () => {
      expect(resolveNewChatAgentEnable(codexAlias)).toEqual({
        engineConnectionId: 'codex',
      });
      // Explanatory reason text alone is not an authorization to enable.
      expect(
        resolveNewChatAgentEnable({
          available: false,
          unavailableReason: codexAlias.unavailableReason,
        } as any),
      ).toBeUndefined();
      // An available row never offers Enable even if a stale signal rides it.
      expect(
        resolveNewChatAgentEnable({
          available: true,
          enable: { engineConnectionId: 'codex' },
        } as any),
      ).toBeUndefined();
    });

    test('FIND matches only authored agents bound to the connection, never the alias itself', () => {
      expect(
        findAuthoredAgentForEngineConnection(
          [codexAlias, authoredCodexAgent],
          'codex',
        ),
      ).toBe(authoredCodexAgent);
      expect(
        findAuthoredAgentForEngineConnection([codexAlias], 'codex'),
      ).toBeUndefined();
      expect(
        findAuthoredAgentForEngineConnection([authoredCodexAgent], 'claude'),
      ).toBeUndefined();
    });

    // station#3027(c): what the ROW renders. The server sentence stays as
    // written (API clients, the 400 body on a refused turn, and delegation all
    // consume it) — the picker just stops shouting it.
    describe('unavailable presentation', () => {
      test('an available row has no unavailability presentation at all', () => {
        expect(
          resolveNewChatAgentUnavailability({ available: true } as any),
        ).toBeUndefined();
        expect(resolveNewChatAgentUnavailability({} as any)).toBeUndefined();
        // A stale enable signal on an available row changes nothing.
        expect(
          resolveNewChatAgentUnavailability({
            available: true,
            enable: { engineConnectionId: 'codex' },
          } as any),
        ).toBeUndefined();
      });

      test('the enable signal turns the sentence into a two-word state, description intact', () => {
        const presentation = resolveNewChatAgentUnavailability(codexAlias);
        expect(presentation).toEqual({
          kind: 'state',
          stateLabel: NEW_CHAT_AGENT_NOT_SET_UP_LABEL,
          description: codexAlias.unavailableReason,
        });
        // A state, not an instruction — the row's Enable button owns the verb.
        expect(NEW_CHAT_AGENT_NOT_SET_UP_LABEL).toBe('Not set up');
        expect(NEW_CHAT_AGENT_NOT_SET_UP_LABEL.split(' ')).toHaveLength(3);
        // Nothing is dropped: the accessible description is byte-identical to
        // the server's text.
        expect((presentation as any).description).toBe(
          codexAlias.unavailableReason,
        );
      });

      test('without the enable signal the reason is the presentation — reason text is never parsed', () => {
        expect(
          resolveNewChatAgentUnavailability({
            available: false,
            // Same wording as the enableable row, but no machine-readable
            // signal: explanatory text is not an authorization to claim the
            // row is merely un-set-up.
            unavailableReason: codexAlias.unavailableReason,
          } as any),
        ).toEqual({
          kind: 'reason',
          description: codexAlias.unavailableReason,
        });
      });

      test('a refusal with no reason still describes itself', () => {
        expect(
          resolveNewChatAgentUnavailability({ available: false } as any),
        ).toEqual({
          kind: 'reason',
          description: NEW_CHAT_AGENT_UNAVAILABLE_FALLBACK,
        });
        expect(
          resolveNewChatAgentUnavailability({
            available: false,
            enable: { engineConnectionId: 'codex' },
          } as any),
        ).toEqual({
          kind: 'state',
          stateLabel: NEW_CHAT_AGENT_NOT_SET_UP_LABEL,
          description: NEW_CHAT_AGENT_UNAVAILABLE_FALLBACK,
        });
      });
    });

    test('hides the alias row while an authored agent bound to the same connection exists', () => {
      const viewModel = viewModelFor([codexAlias, authoredCodexAgent]);
      expect(viewModel.flatList.map((agent) => agent.slug)).toEqual([
        'codex-agent',
      ]);
      // Searching for the alias by name must not resurrect the dead row.
      const searched = viewModelFor([codexAlias, authoredCodexAgent], 'codex');
      expect(searched.flatList.map((agent) => agent.slug)).toEqual([
        'codex-agent',
      ]);
    });

    test('deleting the authored agent naturally un-hides the alias — derived state, no persistence', () => {
      const viewModel = viewModelFor([codexAlias]);
      expect(viewModel.flatList.map((agent) => agent.slug)).toEqual(['codex']);
    });

    test('scopedAgents is the scope-filtered pre-search set, so Enable FIND cannot reach out-of-scope agents (#3027 M2)', () => {
      const otherProjectCodex = {
        slug: 'other-codex-agent',
        name: 'Other Codex Agent',
        project: 'other-project',
        execution: { agentConnectionId: 'codex' },
      } as any;
      // Global context: the project-OWNED agent is out of scope and must be
      // absent from scopedAgents (it would otherwise be silently selectable
      // through Enable's FIND) — while the in-scope alias remains.
      const viewModel = viewModelFor([codexAlias, otherProjectCodex]);
      expect(viewModel.scopedAgents.map((agent) => agent.slug)).toEqual([
        'codex',
      ]);
      // And an in-scope authored agent IS present, even while a search query
      // filters it out of the rendered list.
      const searched = viewModelFor([codexAlias, authoredCodexAgent], 'zzz');
      expect(searched.flatList).toEqual([]);
      expect(searched.scopedAgents.map((agent) => agent.slug)).toContain(
        'codex-agent',
      );
    });

    test('an authored agent bound to a DIFFERENT connection does not hide the alias', () => {
      const claudeBound = {
        slug: 'claude-agent',
        name: 'Claude Agent',
        execution: { agentConnectionId: 'claude' },
        // Unavailable (its own connection is gone) so it stays listed with
        // its reason — which must not demote a DIFFERENT engine's alias.
        available: false,
        unavailableReason: "Engine connection 'claude' is not configured.",
      } as any;
      const viewModel = viewModelFor([codexAlias, claudeBound]);
      expect(viewModel.flatList.map((agent) => agent.slug).sort()).toEqual([
        'claude-agent',
        'codex',
      ]);
    });
  });

  /**
   * station#1089. Measured on origin/main (1e5b45d2) against a live instance:
   * project `scope-only` (created with no `workingDirectory`) + connection
   * `oc-elsewhere` (`cwd: /tmp/s1089-elsewhere`) produced
   * `session.cwd = /tmp/s1089-elsewhere`, and the engine CLI's own `getcwd`
   * read back `/private/tmp/s1089-elsewhere` — while this control said
   * "~ (defaults to home)".
   */
  describe('resolveNewChatWorkspaceHint (#1089)', () => {
    const acpConnections = [
      { id: 'oc-elsewhere', cwd: '/tmp/s1089-elsewhere', currentModel: null },
      { id: 'oc-blank', cwd: '   ', currentModel: null },
      { id: 'oc-none', currentModel: null },
    ];
    const agentOn = (connectionId: string) =>
      ({
        slug: connectionId,
        execution: { agentConnectionId: connectionId },
      }) as any;

    test("names the connection's directory instead of claiming home for a directoryless project", () => {
      expect(
        resolveNewChatWorkspaceHint({
          agent: agentOn('oc-elsewhere'),
          project: { slug: 'scope-only', name: 'Scope Only' } as any,
          acpConnections,
        }),
      ).toEqual({ kind: 'connection', path: '/tmp/s1089-elsewhere' });
    });

    test('names it for an unbound chat too — connection-default-wins is the server behavior there as well', () => {
      expect(
        resolveNewChatWorkspaceHint({
          agent: agentOn('oc-elsewhere'),
          project: undefined,
          acpConnections,
        }),
      ).toEqual({ kind: 'connection', path: '/tmp/s1089-elsewhere' });
    });

    test("a project's own working directory still outranks the connection default", () => {
      // Verified live, not assumed: project `bound` (/tmp/s1089-project) on
      // connection `oc-elsewhere` started with cwd /tmp/s1089-project and the
      // CLI's getcwd agreed. The orchestration resolver turns the project
      // directory into `input.cwd`, which the adapter takes first.
      expect(
        resolveNewChatWorkspaceHint({
          agent: agentOn('oc-elsewhere'),
          project: {
            slug: 'bound',
            name: 'Bound',
            workingDirectory: '/tmp/s1089-project',
          } as any,
          acpConnections,
        }),
      ).toEqual({ kind: 'project', path: '/tmp/s1089-project' });
    });

    test('falls back to home when no directory is stated anywhere', () => {
      expect(
        resolveNewChatWorkspaceHint({
          agent: agentOn('oc-none'),
          project: { slug: 'scope-only', name: 'Scope Only' } as any,
          acpConnections,
        }),
      ).toEqual({ kind: 'home' });
      // A blank/whitespace `cwd` is what the connection form persists for an
      // untouched Working Directory field — it states nothing.
      expect(
        resolveNewChatWorkspaceHint({
          agent: agentOn('oc-blank'),
          project: undefined,
          acpConnections,
        }),
      ).toEqual({ kind: 'home' });
      // A Station-engine agent has no connection directory at all.
      expect(
        resolveNewChatWorkspaceHint({
          agent: { slug: 'station' } as any,
          project: undefined,
          acpConnections,
        }),
      ).toEqual({ kind: 'home' });
    });
  });
});
