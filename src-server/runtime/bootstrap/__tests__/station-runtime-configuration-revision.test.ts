import { AgentRegistry } from '@voltagent/core';
import { describe, expect, test, vi } from 'vitest';
import {
  loadStablePreToolPolicySpec,
  StationRuntime,
} from '../station-runtime.js';

describe('StationRuntime agent configuration revision', () => {
  test.each([
    ['null before loading', [null], 'not stable'],
    ['changed while loading', [4, 5], 'changed during'],
    ['null while loading', [4, null], 'changed during'],
  ])(
    'fails closed when the stable revision is %s',
    async (_name, revisions, message) => {
      let call = 0;
      const getStableRevision = vi.fn(() => revisions[call++] ?? null);
      const loadAgent = vi.fn().mockResolvedValue({ name: 'Claude agent' });

      await expect(
        loadStablePreToolPolicySpec({ getStableRevision, loadAgent }),
      ).rejects.toThrow(message);
      if (revisions[0] === null) expect(loadAgent).not.toHaveBeenCalled();
    },
  );

  test('serializes failed lifecycle recovery with an overlapping reload', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.globalToolRegistry = new Map([['stale', {}]]);
    runtime.toolNameReverseMapping = new Map([['stale', 'stale']]);
    runtime.activeAgents = new Map([['stale', {}]]);
    let releaseFailure!: () => void;
    const failureBlocked = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let releaseSecond!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const events: string[] = [];
    let reload = 0;
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      reload += 1;
      const generation = reload;
      events.push(`reload-${generation}-start`);
      if (generation === 1) {
        await failureBlocked;
        events.push('reload-1-fail');
        throw new Error('injected lifecycle failure');
      }
      if (generation === 2) await secondBlocked;
      runtime.activeAgents.set('persisted', { generation });
      events.push(`reload-${generation}-publish`);
    });
    const resetIntegrationState = vi.fn(() => {
      events.push('recovery-clear');
      runtime.activeAgents.clear();
    });

    const firstLifecycle = runtime
      .reloadAgents()
      .catch(() => runtime.recoverRuntimeProjections(resetIntegrationState));
    await vi.waitFor(() => expect(events).toEqual(['reload-1-start']));
    const secondLifecycle = runtime.reloadAgents();
    releaseFailure();

    await vi.waitFor(() =>
      expect(events).toEqual([
        'reload-1-start',
        'reload-1-fail',
        'reload-2-start',
      ]),
    );
    releaseSecond();

    await expect(
      Promise.all([firstLifecycle, secondLifecycle]),
    ).resolves.toEqual([undefined, undefined]);
    expect(events).toEqual([
      'reload-1-start',
      'reload-1-fail',
      'reload-2-start',
      'reload-2-publish',
      'recovery-clear',
      'reload-3-start',
      'reload-3-publish',
    ]);
    expect(runtime.activeAgents).toEqual(
      new Map([['persisted', { generation: 3 }]]),
    );
  });

  test('serializes mutations and exposes only stable revisions with current app config', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = { region: 'us-east-1' };
    const context = runtime.buildRuntimeContext();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = runtime.mutateAgentConfiguration(async () => {
      order.push('first-start');
      await firstBlocked;
      order.push('first-end');
    });
    await vi.waitFor(() =>
      expect(context.getAgentConfigurationRevision()).toBeNull(),
    );
    const second = runtime.mutateAgentConfiguration(async () => {
      order.push('second');
      runtime.appConfig = { region: 'eu-west-1' };
    });
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(context.getAgentConfigurationRevision()).toBe(4);
    expect(context.appConfig).toEqual({ region: 'eu-west-1' });
  });

  test('keeps persistence and reload inside one unstable revision', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = {};
    const context = runtime.buildRuntimeContext();
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const order: string[] = [];
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      order.push('reload');
    });

    const mutation = runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void) => {
        beginMutation();
        order.push('persist-start');
        await persistence;
        order.push('persist-end');
        return 'saved';
      },
    );
    await vi.waitFor(() =>
      expect(context.getAgentConfigurationRevision()).toBeNull(),
    );

    releasePersistence();
    await expect(mutation).resolves.toBe('saved');

    expect(order).toEqual(['persist-start', 'persist-end', 'reload']);
    expect(context.getAgentConfigurationRevision()).toBe(2);
  });

  test('plugin configuration activation rediscovers Skills before publishing the rebuilt runtime', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.pluginSkillSourceRevision = 0;
    runtime.loadedPluginSkillSourceRevision = 0;
    runtime.storageAdapter = {
      listProjects: () => [{ slug: 'active-project' }],
    };
    const order: string[] = [];
    runtime.skillService = {
      discoverSkills: vi.fn(async () => {
        order.push('skills');
      }),
    };
    runtime.configLoader = {
      getProjectHomeDir: () => '/station-home',
    };
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      order.push('agents');
    });

    await runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void) => {
        beginMutation();
        order.push('persisted');
        return 'installed';
      },
      { rediscoverSkills: true },
    );

    expect(order).toEqual(['persisted', 'skills', 'agents']);
    expect(runtime.skillService.discoverSkills).toHaveBeenCalledExactlyOnceWith(
      '/station-home',
      'active-project',
    );
    expect(runtime.loadedPluginSkillSourceRevision).toBe(1);
  });

  test('retains failed plugin Skill rediscovery for configuration reconciliation', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.pluginSkillSourceRevision = 0;
    runtime.loadedPluginSkillSourceRevision = 0;
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.storageAdapter = { listProjects: () => [] };
    runtime.configLoader = {
      getLaunchabilityRevision: () => 0,
      getProjectHomeDir: () => '/station-home',
    };
    runtime.skillService = {
      discoverSkills: vi
        .fn()
        .mockRejectedValueOnce(new Error('injected discovery failure'))
        .mockResolvedValueOnce(undefined),
    };
    runtime.reloadAgentsFromDisk = vi.fn(async () => undefined);
    runtime.scheduleAgentConfigurationReconciliation = vi.fn();
    runtime.logger = { error: vi.fn() };
    let activation: { status: string } | undefined;

    await runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void, receipt: typeof activation) => {
        activation = receipt;
        beginMutation();
        return 'installed';
      },
      { rediscoverSkills: true },
    );

    expect(activation).toMatchObject({ status: 'pending' });
    expect(runtime.pluginSkillSourceRevision).toBe(1);
    expect(runtime.loadedPluginSkillSourceRevision).toBe(0);
    expect(runtime.scheduleAgentConfigurationReconciliation).toHaveBeenCalled();

    await expect(runtime.reconcileAgentConfigurationSources()).resolves.toBe(
      true,
    );
    expect(runtime.skillService.discoverSkills).toHaveBeenCalledTimes(2);
    expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledOnce();
    expect(runtime.loadedPluginSkillSourceRevision).toBe(1);
  });

  test('forwards mutation options through the production runtime context', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = {};
    const apply = vi.fn(async () => 'saved');
    runtime.applyAgentConfigurationMutation = apply;
    const operation = vi.fn(async () => 'saved');
    const options = {
      resolveAgentSlug: (value: string) => value,
      activationMode: 'defer' as const,
    };

    await expect(
      runtime
        .buildRuntimeContext()
        .applyAgentConfigurationMutation(operation, options),
    ).resolves.toBe('saved');

    expect(apply).toHaveBeenCalledExactlyOnceWith(operation, options);
  });

  test('activates an ordinary agent mutation without reloading the provider or connection graph', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    const reloadPersistedAgentFromDisk = vi.fn(async () => undefined);
    runtime.reloadPersistedAgentFromDisk = reloadPersistedAgentFromDisk;
    runtime.reloadAgentsFromDisk = vi.fn();

    await expect(
      runtime.applyAgentConfigurationMutation(
        async (beginMutation: () => void) => {
          beginMutation();
          return { slug: 'writer' };
        },
        { resolveAgentSlug: (agent: { slug: string }) => agent.slug },
      ),
    ).resolves.toEqual({ slug: 'writer' });

    expect(reloadPersistedAgentFromDisk).toHaveBeenCalledExactlyOnceWith(
      'writer',
    );
    expect(runtime.reloadAgentsFromDisk).not.toHaveBeenCalled();
    expect(runtime.agentConfigurationRevision).toBe(2);
  });

  test('returns a deferred agent mutation after persistence and schedules serialized reconciliation', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.configurationReconciliationAttempt = 2;
    runtime.loadedProviderLaunchabilityRevision = 4;
    runtime.loadedAppConfigLaunchabilityRevision = 7;
    runtime.reloadPersistedAgentFromDisk = vi.fn();
    runtime.reloadAgentsFromDisk = vi.fn();
    runtime.scheduleAgentConfigurationReconciliation = vi.fn();
    let activation: { status: string; reason?: string } | undefined;

    await expect(
      runtime.applyAgentConfigurationMutation(
        async (beginMutation: () => void, receipt: typeof activation) => {
          activation = receipt;
          beginMutation();
          return { slug: 'writer' };
        },
        {
          resolveAgentSlug: (agent: { slug: string }) => agent.slug,
          activationMode: 'defer',
        },
      ),
    ).resolves.toEqual({ slug: 'writer' });

    expect(activation).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('saved'),
    });
    expect(runtime.reloadPersistedAgentFromDisk).not.toHaveBeenCalled();
    expect(runtime.reloadAgentsFromDisk).not.toHaveBeenCalled();
    expect(runtime.loadedProviderLaunchabilityRevision).toBeNull();
    expect(runtime.loadedAppConfigLaunchabilityRevision).toBeNull();
    expect(runtime.configurationReconciliationAttempt).toBe(0);
    expect(
      runtime.scheduleAgentConfigurationReconciliation,
    ).toHaveBeenCalledOnce();
    expect(runtime.agentConfigurationPersistenceRevision).toBe(1);
    expect(runtime.agentConfigurationRevision).toBe(0);
  });

  test('persists a second deferred mutation while background reconciliation is still running', async () => {
    vi.useFakeTimers();
    try {
      const runtime = Object.create(StationRuntime.prototype) as any;
      runtime.agentConfigurationRevision = 0;
      runtime.agentConfigurationMutationQueue = Promise.resolve();
      runtime.agentConfigurationPersistenceQueue = Promise.resolve();
      runtime.agentConfigurationPersistenceRevision = 0;
      runtime.agentConfigurationMutationsClosed = false;
      runtime.configurationReconciliationScheduled = false;
      runtime.configurationReconciliationAttempt = 0;
      runtime.loadedProviderLaunchabilityRevision = 0;
      runtime.loadedAppConfigLaunchabilityRevision = 0;
      runtime.providerService = { getLaunchabilityRevision: () => 0 };
      runtime.configLoader = { getLaunchabilityRevision: () => 0 };
      runtime.timers = [];
      runtime.logger = { error: vi.fn() };
      let releaseReload!: () => void;
      const blockedReload = new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
      runtime.reloadAgentsFromDisk = vi.fn(() => blockedReload);

      await runtime.applyAgentConfigurationMutation(
        async (beginMutation: () => void) => {
          beginMutation();
          return 'first';
        },
        { activationMode: 'defer' },
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledOnce();

      await expect(
        runtime.applyAgentConfigurationMutation(
          async (beginMutation: () => void) => {
            beginMutation();
            return 'second';
          },
          { activationMode: 'defer' },
        ),
      ).resolves.toBe('second');
      expect(runtime.agentConfigurationPersistenceRevision).toBe(2);

      releaseReload();
      await vi.advanceTimersByTimeAsync(250);
      expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('publishes the staged generation for the saved ordinary agent without reloading providers or the default agent', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    const listProviderConnections = vi.fn(() => []);
    const reloadDefaultAgentFromConfig = vi.fn();
    const nextMetadata = { slug: 'writer', name: 'Writer' };
    runtime.providerService = {
      getLaunchabilityRevision: () => 0,
      listProviderConnections,
    };
    runtime.configLoader = {
      getLaunchabilityRevision: () => 0,
      listAgents: vi.fn(async () => [nextMetadata]),
      loadAgent: vi.fn(async () => ({
        name: 'Writer',
        prompt: 'Help write.',
      })),
    };
    // Seed a complete PRIOR generation so the state assertions below prove
    // the staged generation was published, not merely that the live maps
    // ended up non-empty. Publication is the only way an agent edit becomes
    // observable: every reader (chat, tool registry, token accounting)
    // reads these maps, never the returned Agent.
    const previousAgent = { id: 'writer' };
    const previousSpec = { name: 'Writer', prompt: 'Old runtime prompt.' };
    const previousTools = [{ name: 'old-tool' }];
    const previousMetadata = { slug: 'writer', name: 'Old Writer' };
    const unrelatedSpec = { name: 'Editor', prompt: 'Unrelated agent.' };
    const unrelatedMetadata = { slug: 'editor', name: 'Editor' };
    runtime.agentMetadataMap = new Map([
      ['writer', previousMetadata],
      ['editor', unrelatedMetadata],
    ]);
    runtime.activeAgents = new Map([['writer', previousAgent]]);
    runtime.agentSpecs = new Map([
      ['writer', previousSpec],
      ['editor', unrelatedSpec],
    ]);
    runtime.agentTools = new Map([['writer', previousTools]]);
    runtime.agentFixedTokens = new Map([
      ['writer', { systemPromptTokens: 1, mcpServerTokens: 0 }],
    ]);
    runtime.agentHooksMap = new Map([['writer', { generation: 'previous' }]]);
    runtime.memoryAdapters = new Map([['writer', { generation: 'previous' }]]);
    runtime.globalToolRegistry = new Map();
    runtime.integrationMetadata = new Map();
    runtime.mcpConfigs = new Map();
    runtime.mcpConnectionStatus = new Map();
    runtime.toolNameMapping = new Map();
    runtime.toolNameReverseMapping = new Map();
    runtime.voltAgent = { registerAgent: vi.fn() };
    const nextAgent = { id: 'writer' };
    const nextSpec = { name: 'Writer', prompt: 'Help write.' };
    const nextTools: Array<{ name: string }> = [];
    const nextMemoryAdapter = { generation: 'next' };
    const nextHooks = { generation: 'next' };
    const nextFixedTokens = { systemPromptTokens: 7, mcpServerTokens: 0 };
    runtime.preparePersistedAgentInstance = vi.fn(async () => ({
      agent: nextAgent,
      bundle: {
        agent: nextAgent,
        tools: nextTools,
        memoryAdapter: nextMemoryAdapter,
        fixedTokens: nextFixedTokens,
      },
      hooks: nextHooks,
      slug: 'writer',
      spec: nextSpec,
    }));
    runtime.rebuildGlobalToolRegistry = vi.fn();
    runtime.emitAgentsChanged = vi.fn();
    runtime.reloadAgentsFromDisk = vi.fn();
    runtime.reloadDefaultAgentFromConfig = reloadDefaultAgentFromConfig;

    await runtime.reloadPersistedAgentFromDisk('writer');

    expect(runtime.configLoader.listAgents).toHaveBeenCalledOnce();
    expect(runtime.configLoader.loadAgent).toHaveBeenCalledExactlyOnceWith(
      'writer',
    );
    expect(
      runtime.preparePersistedAgentInstance,
    ).toHaveBeenCalledExactlyOnceWith(
      'writer',
      expect.objectContaining({ agentSpecs: expect.any(Map) }),
    );
    expect(runtime.voltAgent.registerAgent).toHaveBeenCalledOnce();
    expect(runtime.reloadAgentsFromDisk).not.toHaveBeenCalled();
    expect(listProviderConnections).not.toHaveBeenCalled();
    expect(reloadDefaultAgentFromConfig).not.toHaveBeenCalled();

    // The staged generation must reach the LIVE maps. Without this the
    // route still answers `status: 'applied'` while the runtime keeps
    // serving the previous prompt, tools, and memory forever.
    expect(runtime.agentSpecs.get('writer')).toBe(nextSpec);
    expect(runtime.agentTools.get('writer')).toBe(nextTools);
    expect(runtime.agentFixedTokens.get('writer')).toBe(nextFixedTokens);
    expect(runtime.agentHooksMap.get('writer')).toBe(nextHooks);
    expect(runtime.memoryAdapters.get('writer')).toBe(nextMemoryAdapter);
    expect(runtime.activeAgents.get('writer')).toBe(nextAgent);
    expect(runtime.agentMetadataMap.get('writer')).toBe(nextMetadata);
    // Publication replaces the live maps wholesale, so an unrelated agent's
    // entries must survive the narrow activation untouched.
    expect(runtime.agentSpecs.get('editor')).toBe(unrelatedSpec);
    expect(runtime.agentMetadataMap.get('editor')).toBe(unrelatedMetadata);
  });

  test('rolls back a failed narrow activation and keeps the runtime generation unavailable', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = {
      getLaunchabilityRevision: () => 0,
      listAgents: vi.fn(async () => [{ slug: 'writer', name: 'Writer' }]),
      loadAgent: vi.fn(async () => ({
        name: 'Writer',
        prompt: 'New persisted prompt.',
      })),
    };
    const previousAgent = { id: 'writer' };
    const previousSpec = { name: 'Writer', prompt: 'Old runtime prompt.' };
    const previousTools = [{ name: 'old-tool' }];
    runtime.activeAgents = new Map([['writer', previousAgent]]);
    runtime.agentMetadataMap = new Map([
      ['writer', { slug: 'writer', name: 'Old Writer' }],
    ]);
    runtime.agentSpecs = new Map([['writer', previousSpec]]);
    runtime.agentTools = new Map([['writer', previousTools]]);
    runtime.agentFixedTokens = new Map([
      ['writer', { systemPromptTokens: 1, mcpServerTokens: 0 }],
    ]);
    runtime.agentHooksMap = new Map([['writer', { old: true }]]);
    runtime.memoryAdapters = new Map([['writer', { old: true }]]);
    runtime.globalToolRegistry = new Map([['old-tool', previousTools[0]]]);
    runtime.integrationMetadata = new Map();
    runtime.mcpConfigs = new Map();
    runtime.mcpConnectionStatus = new Map();
    runtime.toolNameMapping = new Map();
    runtime.toolNameReverseMapping = new Map();
    runtime.preparePersistedAgentInstance = vi.fn(
      async (_slug: string, staged: any) => {
        // A framework may populate all of these before a later build step
        // rejects. They must remain isolated from the live generation.
        staged.agentSpecs.set('writer', {
          name: 'Writer',
          prompt: 'Partial new runtime prompt.',
        });
        staged.agentTools.set('writer', [{ name: 'partial-tool' }]);
        staged.agentFixedTokens.set('writer', {
          systemPromptTokens: 99,
          mcpServerTokens: 0,
        });
        staged.agentHooksMap.set('writer', { partial: true });
        staged.memoryAdapters.set('writer', { partial: true });
        throw new Error('framework build failed');
      },
    );
    runtime.reloadAgentsFromDisk = vi.fn();
    runtime.scheduleAgentConfigurationReconciliation = vi.fn();
    runtime.logger = { error: vi.fn(), info: vi.fn() };

    let activation: { status: string } | undefined;
    await expect(
      runtime.applyAgentConfigurationMutation(
        async (beginMutation: () => void, receipt: typeof activation) => {
          activation = receipt;
          beginMutation();
          return { slug: 'writer' };
        },
        { resolveAgentSlug: (agent: { slug: string }) => agent.slug },
      ),
    ).resolves.toEqual({ slug: 'writer' });

    expect(activation).toMatchObject({ status: 'pending' });
    expect(runtime.activeAgents.get('writer')).toBe(previousAgent);
    expect(runtime.agentMetadataMap.get('writer')).toEqual({
      slug: 'writer',
      name: 'Old Writer',
    });
    expect(runtime.agentSpecs.get('writer')).toBe(previousSpec);
    expect(runtime.agentTools.get('writer')).toBe(previousTools);
    expect(runtime.agentFixedTokens.get('writer')).toEqual({
      systemPromptTokens: 1,
      mcpServerTokens: 0,
    });
    expect(runtime.agentHooksMap.get('writer')).toEqual({ old: true });
    expect(runtime.memoryAdapters.get('writer')).toEqual({ old: true });
    expect(runtime.globalToolRegistry.get('old-tool')).toBe(previousTools[0]);
    expect(runtime.loadedProviderLaunchabilityRevision).toBeNull();
    expect(runtime.loadedAppConfigLaunchabilityRevision).toBeNull();
    expect(runtime.agentConfigurationRevision).toBe(2);
    expect(runtime.getStableAgentConfigurationRevision()).toBeNull();
    expect(
      runtime.scheduleAgentConfigurationReconciliation,
    ).toHaveBeenCalledOnce();
  });

  test('rolls back registry publication failure before exposing staged agent state', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = {
      getLaunchabilityRevision: () => 0,
      listAgents: vi.fn(async () => [{ slug: 'writer', name: 'Writer' }]),
      loadAgent: vi.fn(async () => ({
        name: 'Writer',
        prompt: 'New persisted prompt.',
      })),
    };
    const previousAgent = { id: 'writer' };
    const previousSpec = { name: 'Writer', prompt: 'Old runtime prompt.' };
    runtime.activeAgents = new Map([['writer', previousAgent]]);
    runtime.agentMetadataMap = new Map([
      ['writer', { slug: 'writer', name: 'Old Writer' }],
    ]);
    runtime.agentSpecs = new Map([['writer', previousSpec]]);
    runtime.agentTools = new Map([['writer', [{ name: 'old-tool' }]]]);
    runtime.agentFixedTokens = new Map();
    runtime.agentHooksMap = new Map();
    runtime.memoryAdapters = new Map();
    runtime.globalToolRegistry = new Map();
    runtime.integrationMetadata = new Map();
    runtime.mcpConfigs = new Map();
    runtime.mcpConnectionStatus = new Map();
    runtime.toolNameMapping = new Map();
    runtime.toolNameReverseMapping = new Map();
    runtime.preparePersistedAgentInstance = vi.fn(async () => ({
      agent: { id: 'writer' },
      bundle: {
        agent: { id: 'writer' },
        tools: [{ name: 'new-tool' }],
        memoryAdapter: {},
        fixedTokens: { systemPromptTokens: 0, mcpServerTokens: 0 },
      },
      hooks: {},
      slug: 'writer',
      spec: { name: 'Writer', prompt: 'New persisted prompt.' },
    }));
    runtime.voltAgent = {
      registerAgent: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('registry publication failed');
        })
        .mockImplementationOnce(() => undefined),
    };
    runtime.reloadAgentsFromDisk = vi.fn();
    runtime.scheduleAgentConfigurationReconciliation = vi.fn();
    runtime.logger = { error: vi.fn(), info: vi.fn() };

    await runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void) => {
        beginMutation();
        return { slug: 'writer' };
      },
      { resolveAgentSlug: (agent: { slug: string }) => agent.slug },
    );

    expect(runtime.activeAgents.get('writer')).toBe(previousAgent);
    expect(runtime.agentSpecs.get('writer')).toBe(previousSpec);
    expect(runtime.agentTools.get('writer')).toEqual([{ name: 'old-tool' }]);
    expect(runtime.agentMetadataMap.get('writer')).toEqual({
      slug: 'writer',
      name: 'Old Writer',
    });
    expect(runtime.voltAgent.registerAgent).toHaveBeenLastCalledWith(
      previousAgent,
    );
    expect(runtime.getStableAgentConfigurationRevision()).toBeNull();
  });

  test('keeps MCP-backed agent changes on the broad reload path', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = {
      getLaunchabilityRevision: () => 0,
      listAgents: vi.fn(async () => [{ slug: 'writer', name: 'Writer' }]),
      loadAgent: vi.fn(async () => ({
        name: 'Writer',
        prompt: 'Help write.',
        tools: { mcpServers: ['shared-server'] },
      })),
    };
    runtime.agentSpecs = new Map();
    runtime.reloadAgentsFromDisk = vi.fn(async () => undefined);

    await runtime.reloadPersistedAgentFromDisk('writer');

    expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledOnce();
  });

  test('keeps deletion of an MCP-backed agent on the broad cleanup path', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = {
      getLaunchabilityRevision: () => 0,
      listAgents: vi.fn(async () => []),
    };
    runtime.agentSpecs = new Map([
      [
        'writer',
        {
          name: 'Writer',
          prompt: 'Help write.',
          tools: { mcpServers: ['shared-server'] },
        },
      ],
    ]);
    const cleanupMcpResources = vi.fn();
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      cleanupMcpResources();
    });

    await runtime.reloadPersistedAgentFromDisk('writer');

    expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledOnce();
    expect(cleanupMcpResources).toHaveBeenCalledOnce();
    expect(runtime.configLoader.listAgents).not.toHaveBeenCalled();
  });

  test('keeps the internal default runtime isolated from the public station identity', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    const defaultAgent = { id: 'default' };
    const defaultSpec = { name: 'Default', prompt: 'Built-in.' };
    const defaultMetadata = { slug: 'default', name: 'Default' };
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = {
      getLaunchabilityRevision: () => 0,
      // `station` is registry-owned rather than persisted. AgentService rejects
      // mutation before this private reload path, but the runtime boundary must
      // still treat the public identity as an exact key rather than translating
      // it to the internal `default` runtime key.
      listAgents: vi.fn(async () => []),
      loadAgent: vi.fn(async () => undefined),
    };
    runtime.activeAgents = new Map([['default', defaultAgent]]);
    runtime.agentMetadataMap = new Map([['default', defaultMetadata]]);
    runtime.agentSpecs = new Map([['default', defaultSpec]]);
    runtime.agentTools = new Map([['default', []]]);
    runtime.agentFixedTokens = new Map();
    runtime.agentHooksMap = new Map();
    runtime.memoryAdapters = new Map();
    runtime.globalToolRegistry = new Map();
    runtime.integrationMetadata = new Map();
    runtime.mcpConfigs = new Map();
    runtime.mcpConnectionStatus = new Map();
    runtime.toolNameMapping = new Map();
    runtime.toolNameReverseMapping = new Map();
    runtime.rebuildGlobalToolRegistry = vi.fn();
    runtime.emitAgentsChanged = vi.fn();
    runtime.logger = { error: vi.fn(), info: vi.fn() };
    runtime.reloadAgentsFromDisk = vi.fn(async () => undefined);
    const removeAgent = vi
      .spyOn(AgentRegistry.getInstance(), 'removeAgent')
      .mockReturnValue(false);

    try {
      await runtime.reloadPersistedAgentFromDisk('station');
    } finally {
      removeAgent.mockRestore();
    }

    expect(runtime.reloadAgentsFromDisk).not.toHaveBeenCalled();
    expect(runtime.configLoader.listAgents).toHaveBeenCalledOnce();
    expect(removeAgent).not.toHaveBeenCalled();
    expect(runtime.activeAgents.get('default')).toBe(defaultAgent);
    expect(runtime.agentMetadataMap.get('default')).toBe(defaultMetadata);
    expect(runtime.agentSpecs.get('default')).toBe(defaultSpec);
  });

  test('does not reload or rotate the revision when an operation rejects before mutation', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.reloadAgentsFromDisk = vi.fn();

    await expect(
      runtime.applyAgentConfigurationMutation(async () => {
        throw new Error('duplicate connection');
      }),
    ).rejects.toThrow('duplicate connection');

    expect(runtime.reloadAgentsFromDisk).not.toHaveBeenCalled();
    expect(runtime.agentConfigurationRevision).toBe(0);
  });

  test('reports a durable commit as activation-pending and schedules reconciliation', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.configurationReconciliationScheduled = false;
    runtime.reloadAgentsFromDisk = vi
      .fn()
      .mockRejectedValue(new Error('activation failed'));
    runtime.scheduleAgentConfigurationReconciliation = vi.fn();
    runtime.logger = { error: vi.fn() };
    let activation: { status: string; reason?: string } | undefined;

    const result = await runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void, receipt: typeof activation) => {
        activation = receipt;
        beginMutation();
        return 'persisted';
      },
    );

    expect(result).toBe('persisted');
    expect(activation).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('saved'),
    });
    expect(
      runtime.scheduleAgentConfigurationReconciliation,
    ).toHaveBeenCalledOnce();
    expect(runtime.agentConfigurationRevision).toBe(2);
  });

  test('retries pending activation with bounded backoff until reconciliation succeeds', async () => {
    vi.useFakeTimers();
    try {
      const runtime = Object.create(StationRuntime.prototype) as any;
      runtime.agentConfigurationRevision = 0;
      runtime.agentConfigurationMutationQueue = Promise.resolve();
      runtime.agentConfigurationMutationsClosed = false;
      runtime.configurationReconciliationScheduled = false;
      runtime.configurationReconciliationAttempt = 0;
      runtime.loadedProviderLaunchabilityRevision = null;
      runtime.loadedAppConfigLaunchabilityRevision = null;
      runtime.providerService = { getLaunchabilityRevision: () => 0 };
      runtime.configLoader = { getLaunchabilityRevision: () => 0 };
      runtime.timers = [];
      runtime.logger = { error: vi.fn() };
      runtime.reloadAgentsFromDisk = vi
        .fn()
        .mockRejectedValueOnce(new Error('first failure'))
        .mockRejectedValueOnce(new Error('second failure'))
        .mockResolvedValueOnce(undefined);

      runtime.scheduleAgentConfigurationReconciliation();
      await vi.advanceTimersByTimeAsync(250);
      expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(3);
      expect(runtime.configurationReconciliationAttempt).toBe(0);
      expect(runtime.configurationReconciliationScheduled).toBe(false);
      expect(runtime.timers).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps retrying pending activation at the capped interval after initial failures', async () => {
    vi.useFakeTimers();
    try {
      const runtime = Object.create(StationRuntime.prototype) as any;
      runtime.agentConfigurationRevision = 0;
      runtime.agentConfigurationMutationQueue = Promise.resolve();
      runtime.agentConfigurationMutationsClosed = false;
      runtime.configurationReconciliationScheduled = false;
      runtime.configurationReconciliationAttempt = 3;
      runtime.loadedProviderLaunchabilityRevision = null;
      runtime.loadedAppConfigLaunchabilityRevision = null;
      runtime.providerService = { getLaunchabilityRevision: () => 0 };
      runtime.configLoader = { getLaunchabilityRevision: () => 0 };
      runtime.timers = [];
      runtime.logger = { error: vi.fn() };
      runtime.reloadAgentsFromDisk = vi
        .fn()
        .mockRejectedValueOnce(new Error('still unavailable'))
        .mockResolvedValueOnce(undefined);

      runtime.scheduleAgentConfigurationReconciliation();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(1);
      expect(runtime.configurationReconciliationAttempt).toBe(4);
      expect(runtime.configurationReconciliationScheduled).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(2);
      expect(runtime.configurationReconciliationAttempt).toBe(0);
      expect(runtime.configurationReconciliationScheduled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('reconciles an externally observed launchability revision before admitting new work', async () => {
    vi.useFakeTimers();
    try {
      const runtime = Object.create(StationRuntime.prototype) as any;
      let providerRevision = 0;
      const appRevision = 0;
      let providerListener: (() => void) | undefined;
      let appListener: (() => void) | undefined;
      const providerUnsubscribe = vi.fn();
      const appUnsubscribe = vi.fn();
      const watchedConfigFileListeners: Record<
        string,
        Set<(path: unknown) => void>
      > = { add: new Set(), change: new Set(), remove: new Set() };
      const emit = vi.fn();
      runtime.agentConfigurationRevision = 0;
      runtime.agentConfigurationMutationQueue = Promise.resolve();
      runtime.agentConfigurationMutationsClosed = false;
      runtime.loadedProviderLaunchabilityRevision = 0;
      runtime.loadedAppConfigLaunchabilityRevision = 0;
      runtime.configurationReconciliationScheduled = false;
      runtime.configurationReconciliationAttempt = 0;
      runtime.configurationSourceUnsubscribers = [];
      runtime.timers = [];
      runtime.logger = { error: vi.fn() };
      runtime.eventBus = { emit };
      runtime.providerService = {
        getLaunchabilityRevision: () => providerRevision,
        onLaunchabilityChange: (listener: () => void) => {
          providerListener = listener;
          return providerUnsubscribe;
        },
      };
      runtime.configLoader = {
        getLaunchabilityRevision: () => appRevision,
        getProjectHomeDir: () => '/home/station',
        onLaunchabilityChange: (listener: () => void) => {
          appListener = listener;
          return appUnsubscribe;
        },
        on: (event: string, listener: (path: unknown) => void) => {
          watchedConfigFileListeners[event]?.add(listener);
        },
        off: (event: string, listener: (path: unknown) => void) => {
          watchedConfigFileListeners[event]?.delete(listener);
        },
      };
      runtime.reloadAgentsFromDisk = vi.fn(async () => {
        runtime.recordLoadedConfigurationRevisions({
          provider: providerRevision,
          appConfig: appRevision,
        });
      });
      runtime.reloadAgents = vi.fn(async () => undefined);

      runtime.observeRuntimeConfigurationSources();
      providerRevision = 1;
      providerListener?.();
      expect(runtime.getStableAgentConfigurationRevision()).toBeNull();

      await vi.advanceTimersByTimeAsync(250);

      expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledOnce();
      expect(runtime.getStableAgentConfigurationRevision()).toBe(2);

      // archive#983 scoped advance: a path outside `agents/`/`integrations/`
      // (e.g. `config/hosts.json`) must not trigger a reload or an event —
      // archive#983's scope is exactly the agent/integration events, not every
      // watched config file (`app.json` already has its own dedicated
      // launchability-revision path exercised above). The reload+emit
      // behavior for an in-scope path is covered in its own dedicated
      // tests below (order-of-operations and debounce need deterministic
      // control over when `reloadAgents()` settles, which this test's
      // `providerService`/`configLoader` launchability wiring does not
      // need).
      for (const listener of watchedConfigFileListeners.change) {
        listener('/home/station/config/hosts.json');
      }
      expect(runtime.reloadAgents).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();

      runtime.stopObservingRuntimeConfigurationSources();
      expect(providerUnsubscribe).toHaveBeenCalledOnce();
      expect(appUnsubscribe).toHaveBeenCalledOnce();
      expect(appListener).toBeTypeOf('function');
      expect(watchedConfigFileListeners.change.size).toBe(0);
      expect(watchedConfigFileListeners.add.size).toBe(0);
      expect(watchedConfigFileListeners.remove.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A minimal harness for `observeRuntimeConfigurationSources`'s watched
   * agent/integration config-file wiring specifically (review round 1
   * HIGH 2 + MEDIUM 1) — the launchability-revision machinery
   * (`providerService`/`loaded*Revision`/timers) is irrelevant to this
   * path and left out so the deterministic `reloadAgents()` control below
   * is not entangled with fake timers.
   */
  function makeWatchedConfigFileHarness() {
    const runtime = Object.create(StationRuntime.prototype) as any;
    const watchedConfigFileListeners: Record<
      string,
      Set<(path: unknown) => void>
    > = { add: new Set(), change: new Set(), remove: new Set() };
    const emit = vi.fn();
    const errorLog = vi.fn();
    runtime.configurationSourceUnsubscribers = [];
    runtime.logger = { error: errorLog };
    runtime.eventBus = { emit };
    runtime.providerService = {
      getLaunchabilityRevision: () => 0,
      onLaunchabilityChange: () => vi.fn(),
    };
    runtime.configLoader = {
      getLaunchabilityRevision: () => 0,
      getProjectHomeDir: () => '/home/station',
      onLaunchabilityChange: () => vi.fn(),
      on: (event: string, listener: (path: unknown) => void) => {
        watchedConfigFileListeners[event]?.add(listener);
      },
      off: (event: string, listener: (path: unknown) => void) => {
        watchedConfigFileListeners[event]?.delete(listener);
      },
    };
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;

    // Every call to `reloadAgents()` returns its OWN pending promise, whose
    // resolve/reject the test drives explicitly — no reliance on timers or
    // microtask-count guessing to observe an in-between state.
    const settlers: Array<{
      resolve: () => void;
      reject: (error: unknown) => void;
    }> = [];
    runtime.reloadAgents = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settlers.push({ resolve, reject });
        }),
    );

    const fireChange = (path: string) => {
      for (const listener of watchedConfigFileListeners.change) listener(path);
    };

    return { runtime, emit, errorLog, settlers, fireChange };
  }

  test('emits CONFIG_CHANGED only after reloadAgents() resolves, and not at all on rejection (review round 1 HIGH 2)', async () => {
    const { runtime, emit, errorLog, settlers, fireChange } =
      makeWatchedConfigFileHarness();
    runtime.observeRuntimeConfigurationSources();

    fireChange('/home/station/agents/writer/agent.json');
    expect(runtime.reloadAgents).toHaveBeenCalledOnce();
    // The bug this fixes: emitting up front let a client that refetches on
    // the event win a race and read the pre-change agent list.
    expect(emit).not.toHaveBeenCalled();

    settlers[0].resolve();
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith('config:changed', {
        source: 'config-watcher',
      }),
    );
    // No trailing run: nothing arrived while the reload was in flight, so
    // the queue never armed (contrast the debounce test below, where it
    // does).
    expect(runtime.reloadAgents).toHaveBeenCalledOnce();

    // A rejected reload must not emit — and must log rather than silently
    // swallow the error (review round 1 LOW 1).
    emit.mockClear();
    fireChange('/home/station/agents/writer/agent.json');
    await vi.waitFor(() =>
      expect(runtime.reloadAgents).toHaveBeenCalledTimes(2),
    );
    const failure = new Error('disk read failed');
    settlers[1].reject(failure);
    await vi.waitFor(() =>
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('Failed to reload agents'),
        { error: failure },
      ),
    );
    expect(emit).not.toHaveBeenCalled();

    runtime.stopObservingRuntimeConfigurationSources();
  });

  test('runs exactly one reload for one external agent configuration event', async () => {
    const { runtime, emit, settlers, fireChange } =
      makeWatchedConfigFileHarness();
    runtime.observeRuntimeConfigurationSources();

    fireChange('/home/station/agents/writer/agent.json');
    expect(runtime.reloadAgents).toHaveBeenCalledOnce();

    settlers[0].resolve();
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith('config:changed', {
        source: 'config-watcher',
      }),
    );

    // A single external edit must not acquire the coalescer's trailing pass.
    expect(runtime.reloadAgents).toHaveBeenCalledOnce();
    runtime.stopObservingRuntimeConfigurationSources();
  });

  test('coalesces a burst of watched config file events into one in-flight reload, with exactly one further run queued for whatever arrived during it (review round 1 MEDIUM 1)', async () => {
    const { runtime, emit, settlers, fireChange } =
      makeWatchedConfigFileHarness();
    runtime.observeRuntimeConfigurationSources();

    // Three rapid events while nothing is in flight yet: the first starts
    // the reload; the second and third arrive while it is still pending and
    // must not start their own — mirrors `configurationReconciliationScheduled`'s
    // boolean reentry guard rather than a one-timer-per-event design.
    fireChange('/home/station/agents/writer/agent.json');
    fireChange('/home/station/agents/writer/agent.json');
    fireChange('/home/station/integrations/slack/integration.json');
    expect(runtime.reloadAgents).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();

    settlers[0].resolve();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));

    // Because two events arrived DURING the first reload, exactly one
    // further reload is queued to run right after — proving the coalesce
    // is "collapse the burst, then catch up once", not "silently drop
    // everything past the first event forever".
    await vi.waitFor(() =>
      expect(runtime.reloadAgents).toHaveBeenCalledTimes(2),
    );
    settlers[1].resolve();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));

    // No THIRD run — the queue holds at most one, not one-per-coalesced-event.
    expect(runtime.reloadAgents).toHaveBeenCalledTimes(2);

    runtime.stopObservingRuntimeConfigurationSources();
  });

  test('serializes terminal configuration reads ahead of deferred persistence', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationPersistenceQueue = Promise.resolve();
    runtime.agentConfigurationPersistenceRevision = 0;
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.scheduleAgentConfigurationReconciliation = vi.fn();
    let releaseTerminal!: () => void;
    const terminalBlocked = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const order: string[] = [];

    const terminal = runtime.commitAgentConfigurationRead(0, async () => {
      order.push('terminal-start');
      await terminalBlocked;
      order.push('terminal-end');
      return 'sent';
    });
    await vi.waitFor(() => expect(order).toEqual(['terminal-start']));
    const mutation = runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void) => {
        beginMutation();
        order.push('mutation');
      },
      { activationMode: 'defer' },
    );

    await Promise.resolve();
    expect(order).toEqual(['terminal-start']);
    releaseTerminal();

    await expect(terminal).resolves.toBe('sent');
    await mutation;
    expect(order).toEqual(['terminal-start', 'terminal-end', 'mutation']);
    expect(
      runtime.scheduleAgentConfigurationReconciliation,
    ).toHaveBeenCalledOnce();
    expect(runtime.agentConfigurationPersistenceRevision).toBe(1);
    expect(runtime.agentConfigurationRevision).toBe(0);
  });

  test('invalidates loaded agents when either source generation changes', () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    let providerRevision = 4;
    let appRevision = 6;
    runtime.agentConfigurationRevision = 8;
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 4;
    runtime.loadedAppConfigLaunchabilityRevision = 6;
    runtime.providerService = {
      getLaunchabilityRevision: () => providerRevision,
    };
    runtime.configLoader = { getLaunchabilityRevision: () => appRevision };

    expect(runtime.getStableAgentConfigurationRevision()).toBe(8);
    providerRevision = 5;
    expect(runtime.getStableAgentConfigurationRevision()).toBeNull();
    providerRevision = 4;
    appRevision = 7;
    expect(runtime.getStableAgentConfigurationRevision()).toBeNull();
  });

  test('marks agent hooks stale during mutation and after generation replacement', () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    const hooks = {};
    runtime.agentConfigurationRevision = 8;
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 4;
    runtime.loadedAppConfigLaunchabilityRevision = 6;
    runtime.providerService = {
      getLaunchabilityRevision: () => 4,
      listProviderConnections: () => [],
    };
    runtime.configLoader = { getLaunchabilityRevision: () => 6 };
    runtime.agentHooksMap = new Map([['planner', hooks]]);
    const context = runtime.runtimeAgentBuilderContext('planner', {});

    expect(context.isAgentHooksCurrent('planner', hooks)).toBe(true);
    runtime.agentConfigurationRevision = 9;
    expect(context.isAgentHooksCurrent('planner', hooks)).toBe(false);
    runtime.agentConfigurationRevision = 10;
    runtime.agentHooksMap.set('planner', {});
    expect(context.isAgentHooksCurrent('planner', hooks)).toBe(false);
  });

  test('rebuilds the global tool registry from only the current agent generation', () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    const oldTool = { name: 'removed', execute: vi.fn() };
    const defaultTool = { name: 'shared', execute: vi.fn() };
    const replacement = { name: 'shared', execute: vi.fn() };
    const newTool = { name: 'current', execute: vi.fn() };
    runtime.globalToolRegistry = new Map([
      ['removed', oldTool],
      ['shared', replacement],
    ]);
    runtime.agentTools = new Map([
      ['default', [defaultTool]],
      ['worker', [replacement, newTool]],
    ]);

    runtime.rebuildGlobalToolRegistry();

    expect(runtime.globalToolRegistry).toEqual(
      new Map([
        ['shared', defaultTool],
        ['current', newTool],
      ]),
    );
  });

  test('blocks default-agent tools when their published generation is replaced', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    let stable = true;
    runtime.getStableAgentConfigurationRevision = () => (stable ? 2 : null);
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.agentTools = new Map();
    const execute = vi.fn().mockResolvedValue('done');
    const guarded = runtime.guardDefaultAgentTools([
      { name: 'station_mutation', execute },
    ]);
    runtime.agentTools.set('default', guarded);

    await expect(guarded[0].execute({})).resolves.toBe('done');
    stable = false;
    await expect(guarded[0].execute({})).rejects.toThrow(
      'configuration changed',
    );
    runtime.agentTools.set('default', []);
    stable = true;
    await expect(guarded[0].execute({})).rejects.toThrow(
      'configuration changed',
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  test('holds the generation read lease until a managed tool settles', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.agentTools = new Map();
    let releaseTool!: () => void;
    const toolBlocked = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const order: string[] = [];
    const guarded = runtime.guardDefaultAgentTools([
      {
        name: 'station_mutation',
        execute: async () => {
          order.push('tool-start');
          await toolBlocked;
          order.push('tool-end');
          return 'done';
        },
      },
    ]);
    runtime.agentTools.set('default', guarded);

    const execution = guarded[0].execute({});
    await vi.waitFor(() => expect(order).toEqual(['tool-start']));
    const mutation = runtime.mutateAgentConfiguration(async () => {
      order.push('mutation');
    });
    await Promise.resolve();
    expect(order).toEqual(['tool-start']);

    releaseTool();
    await expect(execution).resolves.toBe('done');
    await mutation;
    expect(order).toEqual(['tool-start', 'tool-end', 'mutation']);
  });

  test('releases the generation read lease when a managed tool never settles', async () => {
    vi.useFakeTimers();
    try {
      const runtime = Object.create(StationRuntime.prototype) as any;
      runtime.agentConfigurationRevision = 0;
      runtime.agentConfigurationMutationQueue = Promise.resolve();
      runtime.agentConfigurationMutationsClosed = false;
      runtime.loadedProviderLaunchabilityRevision = 0;
      runtime.loadedAppConfigLaunchabilityRevision = 0;
      runtime.providerService = { getLaunchabilityRevision: () => 0 };
      runtime.configLoader = { getLaunchabilityRevision: () => 0 };
      runtime.agentTools = new Map();
      const order: string[] = [];
      const guarded = runtime.guardDefaultAgentTools([
        {
          name: 'station_mutation',
          execute: async () => {
            order.push('tool-start');
            return new Promise<never>(() => {});
          },
        },
      ]);
      runtime.agentTools.set('default', guarded);

      const execution = guarded[0].execute({});
      const observedExecution = execution.catch((error: unknown) => error);
      await vi.waitFor(() => expect(order).toEqual(['tool-start']));
      const mutation = runtime.mutateAgentConfiguration(async () => {
        order.push('mutation');
      });
      await Promise.resolve();
      expect(order).toEqual(['tool-start']);

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(observedExecution).resolves.toMatchObject({
        message: expect.stringContaining('configuration changed'),
      });
      await mutation;
      expect(order).toEqual(['tool-start', 'mutation']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('closes new mutations and drains accepted work before shutdown', async () => {
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.shutdownPromise = null;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = runtime.mutateAgentConfiguration(() => blocked);
    runtime.shutdownAfterConfigurationDrain = vi.fn(async () => {
      await runtime.agentConfigurationMutationQueue;
    });

    const shutdown = runtime.shutdown();
    await expect(
      runtime.mutateAgentConfiguration(async () => undefined),
    ).rejects.toThrow('mutations are closed');
    expect(runtime.shutdownAfterConfigurationDrain).toHaveBeenCalledOnce();

    release();
    await mutation;
    await shutdown;
  });
});
