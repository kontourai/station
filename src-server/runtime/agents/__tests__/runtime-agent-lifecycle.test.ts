import { describe, expect, test, vi } from 'vitest';
import { ManagedModelUnavailableError } from '../../plugins/runtime-provider-resolution.js';
import {
  reloadRuntimeAgents,
  reloadRuntimeSkillsAndAgents,
  switchRuntimeAgent,
} from '../runtime-agent-lifecycle.js';

function createAgent(name: string) {
  return { id: name, name } as any;
}

function stagedAgentCallbacks(
  createVoltAgentInstance: (slug: string) => Promise<any>,
) {
  return {
    prepareVoltAgentInstance: async (slug: string) => {
      const agent = await createVoltAgentInstance(slug);
      return {
        agent,
        bundle: {
          agent,
          tools: [],
          memoryAdapter: {},
          fixedTokens: { systemPromptTokens: 0, mcpServerTokens: 0 },
        },
        hooks: {} as any,
        slug,
        spec: { name: slug, prompt: '' },
      };
    },
    activateVoltAgentInstance: (prepared: { agent: any }) => prepared.agent,
    commitPreparedResources: vi.fn(),
    cleanupPreparedResources: vi.fn(async () => {}),
  };
}

describe('reloadRuntimeAgents', () => {
  test('reloads config, removes deleted agents, adds new agents, and preserves default metadata', async () => {
    const removedConfig = { disconnect: vi.fn().mockResolvedValue(undefined) };
    const activeAgents = new Map<string, any>([
      ['default', createAgent('default')],
      ['removed', createAgent('removed')],
    ]);
    const agentMetadataMap = new Map<string, any>([
      ['default', { slug: 'default', name: 'Default' }],
      ['removed', { slug: 'removed', name: 'Removed' }],
    ]);
    const agentSpecs = new Map<string, any>([['removed', { slug: 'removed' }]]);
    const agentTools = new Map<string, any[]>([['removed', []]]);
    const memoryAdapters = new Map<string, any>([['removed', {}]]);
    const mcpConfigs = new Map<string, any>([['server', removedConfig]]);
    const mcpConnectionStatus = new Map<string, any>([
      ['server', { connected: true }],
    ]);
    const integrationMetadata = new Map<string, any>([
      ['server', { type: 'mcp' }],
    ]);
    const registerAgent = vi.fn();
    const removeAgent = vi.fn(() => true);
    const logger = { info: vi.fn(), error: vi.fn() };
    const emit = vi.fn();
    const createVoltAgentInstance = vi.fn(async (slug: string) =>
      createAgent(slug),
    );

    const appConfig = await reloadRuntimeAgents({
      configLoader: {
        listAgents: vi.fn(async () => [
          { slug: 'new-agent', name: 'New Agent' },
        ]),
      } as any,
      activeAgents,
      agentMetadataMap,
      agentSpecs,
      agentTools,
      memoryAdapters,
      mcpConfigs,
      mcpConnectionStatus,
      integrationMetadata,
      voltAgent: { registerAgent, removeAgent },
      logger,
      eventBus: { emit },
      ...stagedAgentCallbacks(createVoltAgentInstance),
      loadAppConfig: async () => ({ logLevel: 'debug' }) as any,
      applyAppConfig: vi.fn(),
      applyLogLevel: vi.fn(),
    });

    expect(appConfig).toEqual({ logLevel: 'debug' });
    expect(removedConfig.disconnect).toHaveBeenCalledTimes(1);
    expect(activeAgents.has('removed')).toBe(false);
    expect(activeAgents.has('new-agent')).toBe(true);
    expect(agentMetadataMap.get('default')).toEqual({
      slug: 'default',
      name: 'Default',
    });
    expect(agentMetadataMap.get('new-agent')).toEqual({
      slug: 'new-agent',
      name: 'New Agent',
    });
    expect(registerAgent).toHaveBeenCalledWith(activeAgents.get('new-agent'));
    expect(removeAgent).toHaveBeenCalledWith('removed');
    expect(emit).toHaveBeenCalledWith('agents:changed', { count: 1 });
  });

  test('rebuilds an EXISTING agent so edits (tools/autoApprove/prompt) take effect', async () => {
    // Regression: editing an existing agent then reloading used to be a no-op
    // for that agent — it was skipped because it was already active. It must be
    // torn down and recreated so the new spec is picked up.
    const existingConfig = { disconnect: vi.fn().mockResolvedValue(undefined) };
    const activeAgents = new Map<string, any>([
      ['default', createAgent('default')],
      ['editme', createAgent('editme')],
    ]);
    const agentSpecs = new Map<string, any>([
      ['editme', { slug: 'editme', tools: { autoApprove: [] } }],
    ]);
    const mcpConfigs = new Map<string, any>([['server', existingConfig]]);
    const createVoltAgentInstance = vi.fn(async (slug: string) =>
      createAgent(slug),
    );

    await reloadRuntimeAgents({
      configLoader: {
        listAgents: vi.fn(async () => [{ slug: 'editme', name: 'Edit Me' }]),
      } as any,
      activeAgents,
      agentMetadataMap: new Map(),
      agentSpecs,
      agentTools: new Map([['editme', []]]),
      memoryAdapters: new Map([['editme', {}]]),
      mcpConfigs,
      mcpConnectionStatus: new Map([['server', { connected: true }]]),
      integrationMetadata: new Map([['server', { type: 'mcp' }]]),
      voltAgent: { registerAgent: vi.fn(), removeAgent: vi.fn() },
      logger: { info: vi.fn(), error: vi.fn() },
      eventBus: { emit: vi.fn() },
      ...stagedAgentCallbacks(createVoltAgentInstance),
      loadAppConfig: async () => ({}) as any,
      applyAppConfig: vi.fn(),
      applyLogLevel: vi.fn(),
    });

    // The existing agent was torn down (old MCP disconnected) and recreated.
    expect(existingConfig.disconnect).toHaveBeenCalledTimes(1);
    expect(createVoltAgentInstance).toHaveBeenCalledWith('editme');
    expect(activeAgents.has('editme')).toBe(true);
  });

  test('retires a shared integration connection when its prepared replacement publishes', async () => {
    const previous = { disconnect: vi.fn().mockResolvedValue(undefined) };
    const replacement = { disconnect: vi.fn().mockResolvedValue(undefined) };
    const mcpConfigs = new Map<string, any>([['review', previous]]);
    const preparedMcpConfigs = new Map<string, any>([['review', replacement]]);

    await reloadRuntimeAgents({
      configLoader: {
        listAgents: vi.fn(async () => [{ slug: 'editme', name: 'Edit Me' }]),
      } as any,
      activeAgents: new Map([['editme', createAgent('editme')]]),
      agentMetadataMap: new Map(),
      agentSpecs: new Map([
        [
          'editme',
          { slug: 'editme', name: 'Edit Me', prompt: 'Review changes.' },
        ],
      ]),
      agentTools: new Map([['editme', []]]),
      memoryAdapters: new Map([['editme', {}]]),
      mcpConfigs,
      preparedMcpConfigs,
      mcpConnectionStatus: new Map([['review', { connected: true }]]),
      integrationMetadata: new Map([['review', { type: 'mcp' }]]),
      voltAgent: { registerAgent: vi.fn(), removeAgent: vi.fn() },
      logger: { info: vi.fn(), error: vi.fn() },
      eventBus: { emit: vi.fn() },
      ...stagedAgentCallbacks(async (slug) => createAgent(slug)),
      commitPreparedResources: () => {
        for (const [key, connection] of preparedMcpConfigs) {
          mcpConfigs.set(key, connection);
        }
      },
      loadAppConfig: async () => ({}) as any,
    });

    expect(previous.disconnect).toHaveBeenCalledOnce();
    expect(replacement.disconnect).not.toHaveBeenCalled();
    expect(mcpConfigs.get('review')).toBe(replacement);
  });

  test('keeps model-unavailable agents configurable without blocking other activation', async () => {
    const activeAgents = new Map<string, any>();
    const agentMetadataMap = new Map<string, any>();
    const logger = { info: vi.fn(), error: vi.fn() };
    const emit = vi.fn();
    const callbacks = stagedAgentCallbacks(async (slug) => createAgent(slug));
    const prepareVoltAgentInstance = vi.fn(async (slug: string) => {
      if (slug === 'needs-model') {
        throw new ManagedModelUnavailableError(
          'No enabled LLM provider connection is configured.',
        );
      }
      return callbacks.prepareVoltAgentInstance(slug);
    });

    await reloadRuntimeAgents({
      configLoader: {
        listAgents: vi.fn(async () => [
          { slug: 'needs-model', name: 'Needs Model' },
          { slug: 'ready', name: 'Ready' },
        ]),
      } as any,
      activeAgents,
      agentMetadataMap,
      agentSpecs: new Map(),
      agentTools: new Map(),
      memoryAdapters: new Map(),
      mcpConfigs: new Map(),
      mcpConnectionStatus: new Map(),
      integrationMetadata: new Map(),
      voltAgent: { registerAgent: vi.fn(), removeAgent: vi.fn() },
      logger,
      eventBus: { emit },
      ...callbacks,
      prepareVoltAgentInstance,
      loadAppConfig: async () => ({}) as any,
    });

    expect(activeAgents.has('needs-model')).toBe(false);
    expect(activeAgents.has('ready')).toBe(true);
    expect(agentMetadataMap.get('needs-model')).toEqual({
      slug: 'needs-model',
      name: 'Needs Model',
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Agent is unavailable until a model is configured',
      {
        agent: 'needs-model',
        reason: 'No enabled LLM provider connection is configured.',
      },
    );
    expect(emit).toHaveBeenCalledWith('agents:changed', { count: 2 });
  });

  // archive#977: mirrors the cold-boot skip proven by
  // runtime-cold-start-custom-agent.test.ts's "external-engine-bound agent
  // records ... do not build managed runtime instances" (archive#954) — the
  // reload path previously lacked this skip, so a managed external-engine
  // agent (e.g. a user-created agent bound to the claude-runtime connection)
  // was unconditionally sent through `prepareVoltAgentInstance`, threw
  // `ManagedModelUnavailableError`, and was logged/tracked as
  // "unavailable until a model is configured" even though it is fully
  // launchable through orchestration via its bound engine.
  test('skips external-engine-bound agents on reload without attempting prepareVoltAgentInstance (station#977)', async () => {
    const activeAgents = new Map<string, any>();
    const agentMetadataMap = new Map<string, any>();
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const emit = vi.fn();
    const callbacks = stagedAgentCallbacks(async (slug) => createAgent(slug));
    const prepareVoltAgentInstance = vi.fn(callbacks.prepareVoltAgentInstance);

    await reloadRuntimeAgents({
      configLoader: {
        listAgents: vi.fn(async () => [
          {
            slug: 'engine-lab',
            name: 'Engine Lab',
            execution: { agentConnectionId: 'claude-runtime' },
          },
          { slug: 'ready', name: 'Ready' },
        ]),
      } as any,
      activeAgents,
      agentMetadataMap,
      agentSpecs: new Map(),
      agentTools: new Map(),
      memoryAdapters: new Map(),
      mcpConfigs: new Map(),
      mcpConnectionStatus: new Map(),
      integrationMetadata: new Map(),
      voltAgent: { registerAgent: vi.fn(), removeAgent: vi.fn() },
      logger,
      eventBus: { emit },
      ...callbacks,
      prepareVoltAgentInstance,
      loadAppConfig: async () => ({}) as any,
    });

    // Never attempted for the external-engine-bound agent.
    expect(prepareVoltAgentInstance).not.toHaveBeenCalledWith(
      'engine-lab',
      expect.anything(),
    );
    expect(prepareVoltAgentInstance).toHaveBeenCalledWith(
      'ready',
      expect.anything(),
    );
    expect(activeAgents.has('engine-lab')).toBe(false);
    expect(activeAgents.has('ready')).toBe(true);
    // Cleanly skipped, not logged as a ManagedModelUnavailableError case —
    // that log line names a different, unrelated reason class.
    expect(logger.info).not.toHaveBeenCalledWith(
      'Agent is unavailable until a model is configured',
      expect.objectContaining({ agent: 'engine-lab' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Skipping agent record with no instance to build',
      expect.objectContaining({
        agent: 'engine-lab',
        agentConnectionId: 'claude-runtime',
      }),
    );
  });

  test('publishes the new generation when retired MCP cleanup does not settle', async () => {
    vi.useFakeTimers();
    try {
      const existing = createAgent('existing');
      const stalledConfig = {
        disconnect: vi.fn(() => new Promise<void>(() => undefined)),
      };
      const activeAgents = new Map([['existing', existing]]);
      const mcpConfigs = new Map([['server', stalledConfig]]);
      const retainRetiredResource = vi.fn();
      const commitPreparedResources = vi.fn();

      const reload = reloadRuntimeAgents({
        configLoader: {
          listAgents: vi.fn(async () => [{ slug: 'replacement' }]),
        } as any,
        activeAgents,
        agentMetadataMap: new Map(),
        agentSpecs: new Map(),
        agentTools: new Map(),
        memoryAdapters: new Map(),
        mcpConfigs,
        mcpConnectionStatus: new Map([['server', { connected: true }]]),
        integrationMetadata: new Map([['server', { type: 'mcp' }]]),
        voltAgent: {
          registerAgent: vi.fn(),
          removeAgent: vi.fn(() => true),
        },
        logger: { info: vi.fn(), error: vi.fn() },
        eventBus: { emit: vi.fn() },
        ...stagedAgentCallbacks(async (slug) => createAgent(slug)),
        commitPreparedResources,
        retainRetiredResource,
        retiredResourceCleanupTimeoutMs: 10,
        loadAppConfig: async () => ({}) as any,
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(reload).resolves.toEqual({});
      expect(activeAgents.has('replacement')).toBe(true);
      expect(mcpConfigs.has('server')).toBe(false);
      expect(commitPreparedResources).toHaveBeenCalledOnce();
      expect(retainRetiredResource).toHaveBeenCalledWith(
        'server',
        stalledConfig,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('preserves active agents and resources when staging a replacement fails', async () => {
    const existingAgent = createAgent('existing');
    const existingConfig = { disconnect: vi.fn().mockResolvedValue(undefined) };
    const activeAgents = new Map<string, any>([['existing', existingAgent]]);
    const agentMetadataMap = new Map<string, any>([
      ['existing', { slug: 'existing', name: 'Existing' }],
    ]);
    const agentSpecs = new Map<string, any>([
      ['existing', { name: 'Existing', prompt: 'old' }],
    ]);
    const agentTools = new Map<string, any[]>([['existing', []]]);
    const memoryAdapters = new Map<string, any>([['existing', {}]]);
    const mcpConfigs = new Map<string, any>([['server', existingConfig]]);
    const cleanupPreparedResources = vi.fn(async () => undefined);
    const applyAppConfig = vi.fn();
    const registerAgent = vi.fn();

    await expect(
      reloadRuntimeAgents({
        configLoader: {
          listAgents: vi.fn(async () => [
            { slug: 'existing', name: 'Existing' },
            { slug: 'broken', name: 'Broken' },
          ]),
        } as any,
        activeAgents,
        agentMetadataMap,
        agentSpecs,
        agentTools,
        memoryAdapters,
        mcpConfigs,
        mcpConnectionStatus: new Map([['server', { connected: true }]]),
        integrationMetadata: new Map([['server', { type: 'mcp' }]]),
        voltAgent: { registerAgent, removeAgent: vi.fn() },
        logger: { info: vi.fn(), error: vi.fn() },
        eventBus: { emit: vi.fn() },
        prepareVoltAgentInstance: vi.fn(async (slug: string) => {
          if (slug === 'broken') throw new Error('agent build failed');
          return {
            agent: createAgent(slug),
            bundle: {
              agent: createAgent(slug),
              tools: [],
              memoryAdapter: {},
              fixedTokens: { systemPromptTokens: 0, mcpServerTokens: 0 },
            },
            hooks: {} as any,
            slug,
            spec: { name: slug, prompt: '' },
          };
        }),
        activateVoltAgentInstance: vi.fn(),
        commitPreparedResources: vi.fn(),
        cleanupPreparedResources,
        loadAppConfig: async () => ({ logLevel: 'debug' }) as any,
        applyAppConfig,
        applyLogLevel: vi.fn(),
      }),
    ).rejects.toThrow('agent build failed');

    expect(cleanupPreparedResources).toHaveBeenCalledOnce();
    expect(existingConfig.disconnect).not.toHaveBeenCalled();
    expect(activeAgents.get('existing')).toBe(existingAgent);
    expect(agentMetadataMap.get('existing')).toEqual({
      slug: 'existing',
      name: 'Existing',
    });
    expect(agentSpecs.get('existing')).toEqual({
      name: 'Existing',
      prompt: 'old',
    });
    expect(applyAppConfig).not.toHaveBeenCalled();
    expect(registerAgent).not.toHaveBeenCalled();
  });

  test('preserves the live generation when detached activation fails', async () => {
    const existing = createAgent('existing');
    const activeAgents = new Map([['existing', existing]]);
    const commitPreparedResources = vi.fn();
    const cleanupPreparedResources = vi.fn(async () => undefined);

    await expect(
      reloadRuntimeAgents({
        configLoader: {
          listAgents: vi.fn(async () => [
            { slug: 'existing' },
            { slug: 'broken' },
          ]),
        } as any,
        activeAgents,
        agentMetadataMap: new Map(),
        agentSpecs: new Map(),
        agentTools: new Map(),
        memoryAdapters: new Map(),
        mcpConfigs: new Map(),
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        voltAgent: { registerAgent: vi.fn(), removeAgent: vi.fn() },
        logger: { info: vi.fn(), error: vi.fn() },
        eventBus: { emit: vi.fn() },
        ...stagedAgentCallbacks(async (slug) => createAgent(slug)),
        activateVoltAgentInstance: vi.fn((prepared) => {
          if (prepared.slug === 'broken') throw new Error('activation failed');
          return prepared.agent;
        }),
        commitPreparedResources,
        cleanupPreparedResources,
        loadAppConfig: async () => ({}) as any,
        applyAppConfig: vi.fn(),
        applyLogLevel: vi.fn(),
      }),
    ).rejects.toThrow('activation failed');

    expect(activeAgents).toEqual(new Map([['existing', existing]]));
    expect(commitPreparedResources).not.toHaveBeenCalled();
    expect(cleanupPreparedResources).toHaveBeenCalledOnce();
  });

  test('rolls registry publication back when the source revision changes', async () => {
    const existing = createAgent('existing');
    const retired = createAgent('retired');
    const activeAgents = new Map([
      ['existing', existing],
      ['retired', retired],
    ]);
    const registerAgent = vi.fn();
    const removeAgent = vi.fn(() => true);
    const commitPreparedResources = vi.fn();
    // The revision moves DURING publication: the pre-publication gate
    // (archive#3622) passes, the register/remove loops run, and the
    // post-publication gate rejects — which is the rollback this covers.
    let gateChecks = 0;

    await expect(
      reloadRuntimeAgents({
        configLoader: {
          listAgents: vi.fn(async () => [
            { slug: 'existing' },
            { slug: 'new-agent' },
          ]),
        } as any,
        activeAgents,
        agentMetadataMap: new Map(),
        agentSpecs: new Map(),
        agentTools: new Map(),
        memoryAdapters: new Map(),
        mcpConfigs: new Map(),
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        voltAgent: { registerAgent, removeAgent },
        logger: { info: vi.fn(), error: vi.fn() },
        eventBus: { emit: vi.fn() },
        ...stagedAgentCallbacks(async (slug) => createAgent(slug)),
        commitPreparedResources,
        assertConfigurationCurrent: () => {
          gateChecks += 1;
          if (gateChecks > 1) throw new Error('revision changed');
        },
        loadAppConfig: async () => ({}) as any,
        applyAppConfig: vi.fn(),
        applyLogLevel: vi.fn(),
      }),
    ).rejects.toThrow('revision changed');

    expect(activeAgents).toEqual(
      new Map([
        ['existing', existing],
        ['retired', retired],
      ]),
    );
    expect(commitPreparedResources).not.toHaveBeenCalled();
    expect(removeAgent).toHaveBeenCalledWith('new-agent');
    expect(removeAgent).toHaveBeenCalledWith('retired');
    expect(registerAgent).toHaveBeenCalledWith(existing);
    expect(registerAgent).toHaveBeenCalledWith(retired);
  });

  test('a stale pass is refused before it writes to the registry at all', async () => {
    // archive#3622: an activation abandoned at its deadline can wake up while
    // a successor pass is publishing. Gating only AFTER the register/remove
    // loops meant the stale pass wrote into the shared registry and then
    // rolled its own writes back over the successor's. The gate now runs
    // first, so a stale pass touches nothing.
    const existing = createAgent('existing');
    const retired = createAgent('retired');
    const activeAgents = new Map([
      ['existing', existing],
      ['retired', retired],
    ]);
    const registerAgent = vi.fn();
    const removeAgent = vi.fn(() => true);
    const commitPreparedResources = vi.fn();
    const cleanupPreparedResources = vi.fn();

    await expect(
      reloadRuntimeAgents({
        configLoader: {
          listAgents: vi.fn(async () => [
            { slug: 'existing' },
            { slug: 'new-agent' },
          ]),
        } as any,
        activeAgents,
        agentMetadataMap: new Map(),
        agentSpecs: new Map(),
        agentTools: new Map(),
        memoryAdapters: new Map(),
        mcpConfigs: new Map(),
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        voltAgent: { registerAgent, removeAgent },
        logger: { info: vi.fn(), error: vi.fn() },
        eventBus: { emit: vi.fn() },
        ...stagedAgentCallbacks(async (slug) => createAgent(slug)),
        commitPreparedResources,
        cleanupPreparedResources,
        assertConfigurationCurrent: () => {
          throw new Error('revision changed');
        },
        loadAppConfig: async () => ({}) as any,
        applyAppConfig: vi.fn(),
        applyLogLevel: vi.fn(),
      }),
    ).rejects.toThrow('revision changed');

    expect(registerAgent).not.toHaveBeenCalled();
    expect(removeAgent).not.toHaveBeenCalled();
    expect(commitPreparedResources).not.toHaveBeenCalled();
    expect(cleanupPreparedResources).toHaveBeenCalledOnce();
    expect(activeAgents).toEqual(
      new Map([
        ['existing', existing],
        ['retired', retired],
      ]),
    );
  });

  test('rolls registry publication back when an Nth registration fails', async () => {
    const existing = createAgent('existing');
    const activeAgents = new Map([['existing', existing]]);
    const registerAgent = vi.fn((agent: any) => {
      if (agent.id === 'new-agent') throw new Error('registration failed');
    });
    const commitPreparedResources = vi.fn();

    await expect(
      reloadRuntimeAgents({
        configLoader: {
          listAgents: vi.fn(async () => [
            { slug: 'existing' },
            { slug: 'new-agent' },
          ]),
        } as any,
        activeAgents,
        agentMetadataMap: new Map(),
        agentSpecs: new Map(),
        agentTools: new Map(),
        memoryAdapters: new Map(),
        mcpConfigs: new Map(),
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        voltAgent: { registerAgent, removeAgent: vi.fn() },
        logger: { info: vi.fn(), error: vi.fn() },
        eventBus: { emit: vi.fn() },
        ...stagedAgentCallbacks(async (slug) => createAgent(slug)),
        commitPreparedResources,
        loadAppConfig: async () => ({}) as any,
        applyAppConfig: vi.fn(),
        applyLogLevel: vi.fn(),
      }),
    ).rejects.toThrow('registration failed');

    expect(activeAgents).toEqual(new Map([['existing', existing]]));
    expect(commitPreparedResources).not.toHaveBeenCalled();
    expect(registerAgent).toHaveBeenLastCalledWith(existing);
  });
});

describe('reloadRuntimeSkillsAndAgents', () => {
  test('discovers skills for the active project and rebuilds agents', async () => {
    const discoverSkills = vi.fn(async () => {});
    const createVoltAgentInstance = vi.fn(async (slug: string) =>
      createAgent(slug),
    );
    const activeAgents = new Map<string, any>();
    const logger = { info: vi.fn(), error: vi.fn() };

    await reloadRuntimeSkillsAndAgents({
      skillService: { discoverSkills },
      configLoader: {
        getProjectHomeDir: () => '/tmp/project',
        listAgents: vi.fn(async () => [{ slug: 'builder' }]),
      } as any,
      storageAdapter: {
        listProjects: () => [{ slug: 'project-a' }],
      } as any,
      activeAgents,
      logger,
      createVoltAgentInstance,
    });

    expect(discoverSkills).toHaveBeenCalledWith('/tmp/project', 'project-a');
    expect(createVoltAgentInstance).toHaveBeenCalledWith('builder');
    expect(activeAgents.get('builder')).toEqual(createAgent('builder'));
  });
});

describe('switchRuntimeAgent', () => {
  test('returns an existing agent without rebuilding', async () => {
    const agent = createAgent('existing');
    const createVoltAgentInstance = vi.fn(async () => createAgent('other'));

    const result = await switchRuntimeAgent({
      targetSlug: 'existing',
      activeAgents: new Map([['existing', agent]]),
      logger: { info: vi.fn() },
      createVoltAgentInstance,
    });

    expect(result).toBe(agent);
    expect(createVoltAgentInstance).not.toHaveBeenCalled();
  });

  test('creates and registers a new agent when missing', async () => {
    const activeAgents = new Map<string, any>();
    const registerAgent = vi.fn();
    const createdAgent = createAgent('new-agent');

    const result = await switchRuntimeAgent({
      targetSlug: 'new-agent',
      activeAgents,
      voltAgent: { registerAgent },
      logger: { info: vi.fn() },
      createVoltAgentInstance: async () => createdAgent,
    });

    expect(result).toBe(createdAgent);
    expect(activeAgents.get('new-agent')).toBe(createdAgent);
    expect(registerAgent).toHaveBeenCalledWith(createdAgent);
  });
});
