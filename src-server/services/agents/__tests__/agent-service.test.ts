import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  agentOps: { add: vi.fn() },
}));

const { AgentService } = await import('../agent-service.js');

function createMockConfigLoader() {
  return {
    listAgents: vi
      .fn()
      .mockResolvedValue([{ slug: 'default', name: 'Default' }]),
    loadAgent: vi.fn().mockResolvedValue({
      name: 'Default',
      prompt: 'You are helpful',
      slug: 'default',
    }),
    createAgent: vi.fn().mockResolvedValue({
      slug: 'new-agent',
      spec: { name: 'New', prompt: 'test' },
    }),
    updateAgent: vi
      .fn()
      .mockImplementation((_slug: string, updates: any) =>
        Promise.resolve({ name: 'Default', ...updates }),
      ),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    loadACPConfig: vi.fn().mockResolvedValue({ connections: [] }),
  };
}

function createMockStorageAdapter() {
  return {
    findLayoutsUsingAgent: vi.fn().mockReturnValue([]),
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function registryWithEngineDefault(
  id = 'claude',
  /**
   * Real detected engines carry `source: { kind: 'native' }` — that is what
   * makes `registryDefaults()` resolve the capability matrix's display name
   * ("Claude Code") instead of the bare id, which in turn is what the legacy
   * Enable-created name ("Claude Code Agent") was derived from. A fixture
   * without it silently tests the un-branded path.
   */
  source?: { kind: 'native' } | { kind: 'user-acp' },
) {
  return {
    version: 1 as const,
    revision: 0,
    engineConnections: [{ id, ...(source ? { source } : {}) }],
    defaultAgents: [
      { id: 'station', kind: 'station' as const },
      {
        id,
        kind: 'engine-connection' as const,
        engineConnectionId: id,
      },
    ],
  };
}

describe('AgentService', () => {
  test('listAgents delegates to configLoader', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const result = await svc.listAgents();
    expect(result).toEqual([{ slug: 'default', name: 'Default' }]);
  });

  test('lists registry-owned defaults even before an engine is ready', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () => registryWithEngineDefault() as any,
    );

    expect(await svc.listAgents()).toEqual([
      { slug: 'default', name: 'Default' },
      {
        slug: 'station',
        name: 'Station',
      },
      {
        slug: 'claude',
        name: 'claude',
        execution: { agentConnectionId: 'claude' },
      },
    ]);
  });

  // RT-11 — connecting an ACP CLI adds a defaultAgents entry, and the naming
  // fallback had no capability-matrix displayName for a non-native connection,
  // so the alias fell through to the bare id: the Agents list read
  // `opencode / opencode / opencode`.
  test('names a command-backed engine default from its ACP connection name', async () => {
    const loader = createMockConfigLoader();
    loader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'opencode', name: 'OpenCode', command: 'opencode' }],
    });
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () =>
        registryWithEngineDefault('opencode', { kind: 'user-acp' }) as any,
    );

    expect(await svc.listAgents()).toContainEqual({
      slug: 'opencode',
      name: 'OpenCode',
      execution: { agentConnectionId: 'opencode' },
    });
  });

  test('a command-backed engine with no ACP record keeps its id rather than borrowing a brand', async () => {
    const loader = createMockConfigLoader();
    loader.loadACPConfig.mockResolvedValue({ connections: [] });
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () =>
        registryWithEngineDefault('claude', { kind: 'user-acp' }) as any,
    );

    expect(await svc.listAgents()).toContainEqual({
      slug: 'claude',
      name: 'claude',
      execution: { agentConnectionId: 'claude' },
    });
  });

  test('a native engine default keeps its CLI brand and never reads the ACP config', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () =>
        registryWithEngineDefault('claude', { kind: 'native' }) as any,
    );

    expect(await svc.listAgents()).toContainEqual({
      slug: 'claude',
      name: 'Claude Code',
      execution: { agentConnectionId: 'claude' },
    });
    expect(loader.loadACPConfig).not.toHaveBeenCalled();
  });

  test('migration keeps a legacy enabled engine agent and suppresses its registry alias', async () => {
    const loader = createMockConfigLoader();
    loader.listAgents.mockResolvedValueOnce([
      {
        slug: 'claude-code-agent',
        name: 'Claude Code Agent',
        execution: { agentConnectionId: 'claude' },
      },
    ]);
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () => registryWithEngineDefault() as any,
    );
    const agents = await svc.listAgents();
    expect(
      agents.filter((agent) => agent.execution?.agentConnectionId === 'claude'),
    ).toEqual([expect.objectContaining({ slug: 'claude-code-agent' })]);
  });

  describe('materializeEngineAgent — the ONE find-or-create (AC2)', () => {
    function loaderWithFiles(files: Record<string, any>) {
      const store: Record<string, any> = { ...files };
      return {
        listAgents: vi.fn(async () =>
          Object.entries(store).map(([slug, spec]) => ({ slug, ...spec })),
        ),
        loadAgent: vi.fn(async (slug: string) => {
          if (!store[slug]) throw new Error(`Agent '${slug}' not found`);
          return store[slug];
        }),
        agentExists: vi.fn(async (slug: string) => slug in store),
        createAgent: vi.fn(async (spec: any) => {
          const { slug, ...rest } = spec;
          if (slug in store) throw new Error('exists');
          store[slug] = rest;
          return { slug, spec: rest };
        }),
        updateAgent: vi.fn(),
        deleteAgent: vi.fn(),
      };
    }

    function service(loader: any) {
      return new AgentService(
        loader as any,
        createMockStorageAdapter() as any,
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
        async () =>
          registryWithEngineDefault('claude', { kind: 'native' }) as any,
      );
    }

    test('creates one provenance-tagged file for a detected engine', async () => {
      const loader = loaderWithFiles({});
      const result = await service(loader).materializeEngineAgent('claude');
      expect(result).toMatchObject({ slug: 'claude', created: true });
      expect(result.spec).toMatchObject({
        execution: { agentConnectionId: 'claude' },
        provenance: { origin: 'engine-detection', engineId: 'claude' },
      });
      expect(loader.createAgent).toHaveBeenCalledTimes(1);
    });

    test('every surface calling it lands on ONE row per engine', async () => {
      // Boot adoption, the picker's Enable, and first run's batch are three
      // callers of this one function. Before, each wrote its own definition
      // and four engines produced seven rows.
      const loader = loaderWithFiles({});
      const svc = service(loader);
      const first = await svc.materializeEngineAgent('claude');
      const second = await svc.materializeEngineAgent('claude');
      const third = await svc.materializeEngineAgent('claude');
      expect([first, second, third].map((r) => r.created)).toEqual([
        true,
        false,
        false,
      ]);
      expect(new Set([first, second, third].map((r) => r.slug))).toEqual(
        new Set(['claude']),
      );
      expect(loader.createAgent).toHaveBeenCalledTimes(1);
      expect(await loader.listAgents()).toHaveLength(1);
    });

    test('adopts a legacy Enable-created row instead of creating a sibling', async () => {
      // The exact shape the old Enable left behind: a differently-named
      // authored Agent bound to the engine's connection.
      const loader = loaderWithFiles({
        // The exact bytes the old Enable wrote: the engine's display name
        // with the load-bearing ' Agent' suffix, and no provenance.
        'claude-code-agent': {
          name: 'Claude Code Agent',
          execution: { agentConnectionId: 'claude' },
        },
      });
      const result = await service(loader).materializeEngineAgent('claude');
      expect(result).toMatchObject({
        slug: 'claude-code-agent',
        created: false,
      });
      expect(loader.createAgent).not.toHaveBeenCalled();
    });

    test('a project-owned decoy bound to the engine is never adopted', async () => {
      // §3.3: a project-owned Agent is out of scope for a global engine
      // identity. Adopting it would make the engine's row invisible outside
      // that project and hand a project's file the engine's identity.
      const loader = loaderWithFiles({
        'alpha-claude': {
          name: 'Claude Code Agent',
          project: 'alpha',
          execution: { agentConnectionId: 'claude' },
        },
      });
      const result = await service(loader).materializeEngineAgent('claude');
      expect(result).toMatchObject({ slug: 'claude', created: true });
      expect(loader.createAgent).toHaveBeenCalledTimes(1);
    });

    test('a plugin-owned Agent bound to the engine is never adopted', async () => {
      // A plugin owns its file and rewrites it on update; adopting it would
      // make the engine's identity something Station does not control.
      const loader = loaderWithFiles({
        'vendor-claude': {
          name: 'Claude Code Agent',
          plugin: 'vendor-pack',
          execution: { agentConnectionId: 'claude' },
        },
      });
      const result = await service(loader).materializeEngineAgent('claude');
      expect(result).toMatchObject({ slug: 'claude', created: true });
    });

    test("a user's own second Agent on the engine is not mistaken for its seed", async () => {
      // Bound, global, unowned — but matching no tier: it is not at the
      // canonical slug, carries no engine-detection provenance, and is not
      // the legacy Enable shape. It is simply someone's Agent.
      const loader = loaderWithFiles({
        'my-refactorer': {
          name: 'My Refactorer',
          execution: { agentConnectionId: 'claude' },
        },
      });
      const result = await service(loader).materializeEngineAgent('claude');
      expect(result).toMatchObject({ slug: 'claude', created: true });
    });

    test('two bound files resolve to ONE deterministic winner, either way round', async () => {
      // The defect: `find()` over an mtime-sorted listing picked whichever
      // was edited last, so the engine's identity moved on an ordinary save.
      const files = {
        'claude-code-agent': {
          name: 'Claude Code Agent',
          execution: { agentConnectionId: 'claude' },
        },
        'aaa-claude-code-agent': {
          name: 'Claude Code Agent',
          execution: { agentConnectionId: 'claude' },
        },
      };
      const forward = loaderWithFiles(files);
      const reversed = loaderWithFiles(files);
      reversed.listAgents.mockImplementation(async () =>
        [...(await forward.listAgents())].reverse(),
      );
      const a = await service(forward).materializeEngineAgent('claude');
      const b = await service(reversed).materializeEngineAgent('claude');
      expect(a.slug).toBe(b.slug);
      expect(a).toMatchObject({
        slug: 'aaa-claude-code-agent',
        created: false,
      });
      expect(forward.createAgent).not.toHaveBeenCalled();
      expect(reversed.createAgent).not.toHaveBeenCalled();
    });

    test('the canonical slug outranks a legacy row, whatever the listing order', async () => {
      const loader = loaderWithFiles({
        'claude-code-agent': {
          name: 'Claude Code Agent',
          execution: { agentConnectionId: 'claude' },
        },
        claude: {
          name: 'Claude Code',
          execution: { agentConnectionId: 'claude' },
          provenance: {
            origin: 'engine-detection',
            engineId: 'claude',
            detectedAt: '2026-08-20T00:00:00.000Z',
          },
        },
      });
      await expect(
        service(loader).materializeEngineAgent('claude'),
      ).resolves.toMatchObject({ slug: 'claude', created: false });
    });

    test('a renamed materialized row is still recognised by its provenance', async () => {
      const loader = loaderWithFiles({
        'my-claude': {
          name: 'Renamed By Me',
          execution: { agentConnectionId: 'claude' },
          provenance: {
            origin: 'engine-detection',
            engineId: 'claude',
            detectedAt: '2026-08-20T00:00:00.000Z',
          },
        },
      });
      await expect(
        service(loader).materializeEngineAgent('claude'),
      ).resolves.toMatchObject({ slug: 'my-claude', created: false });
      expect(loader.createAgent).not.toHaveBeenCalled();
    });

    test('two TRULY concurrent calls both succeed and write one file', async () => {
      // Sequential calls cannot expose this: the pre-checks are outside the
      // per-slug persistence lock, so both reach the create and the lock
      // makes the loser throw. One file was always correct; the losing
      // REQUEST used to surface as HTTP 400 to a user who did nothing wrong.
      const loader = loaderWithFiles({});
      let gate: () => void = () => {};
      const opened = new Promise<void>((resolve) => {
        gate = resolve;
      });
      const realCreate = loader.createAgent.getMockImplementation()!;
      let first = true;
      loader.createAgent.mockImplementation(async (spec: any) => {
        if (first) {
          first = false;
          const result = await realCreate(spec);
          gate();
          return result;
        }
        await opened;
        return realCreate(spec);
      });
      const svc = service(loader);
      const [a, b] = await Promise.all([
        svc.materializeEngineAgent('claude'),
        svc.materializeEngineAgent('claude'),
      ]);
      expect(a.slug).toBe('claude');
      expect(b.slug).toBe('claude');
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(await loader.listAgents()).toHaveLength(1);
      // Proof the race actually happened: both calls cleared the pre-checks
      // and attempted a create. Without this the test could pass by simply
      // never interleaving.
      expect(loader.createAgent).toHaveBeenCalledTimes(2);
    });

    test('refuses to hand back an unrelated Agent squatting the engine id', async () => {
      // Reachable when the metadata listing does not report the binding: the
      // decision has to come from the file. Handing this row back would make
      // every surface call a foreign Agent "Claude Code".
      const loader = loaderWithFiles({
        claude: { name: 'Someone else', execution: { agentConnectionId: 'x' } },
      });
      loader.listAgents.mockResolvedValue([]);
      await expect(
        service(loader).materializeEngineAgent('claude'),
      ).rejects.toMatchObject({ code: 'DEFAULT_AGENT_MUTATION_FORBIDDEN' });
      expect(loader.createAgent).not.toHaveBeenCalled();
    });

    test('adopts its own definition even when the listing omits the binding', async () => {
      const loader = loaderWithFiles({
        claude: {
          name: 'Claude Code',
          execution: { agentConnectionId: 'claude' },
        },
      });
      loader.listAgents.mockResolvedValue([]);
      await expect(
        service(loader).materializeEngineAgent('claude'),
      ).resolves.toMatchObject({ slug: 'claude', created: false });
      expect(loader.createAgent).not.toHaveBeenCalled();
    });

    test('refuses an id no registry identity claims', async () => {
      const loader = loaderWithFiles({});
      await expect(
        service(loader).materializeEngineAgent('not-an-engine'),
      ).rejects.toMatchObject({ code: 'UNKNOWN_ENGINE_IDENTITY' });
      expect(loader.createAgent).not.toHaveBeenCalled();
    });
  });

  test('projects the internal default external binding onto the public station Agent', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map([
        [
          'default',
          {
            slug: 'default',
            name: 'Station',
            execution: { agentConnectionId: engineConnectionId('codex') },
          },
        ],
      ]),
      new Map(),
      mockLogger,
      async () => registryWithEngineDefault('codex') as any,
    );

    expect(
      (await svc.listAgents()).find((agent) => agent.slug === 'station'),
    ).toEqual({
      slug: 'station',
      name: 'Station',
      execution: { agentConnectionId: 'codex' },
    });
  });

  test('native coding engines self-name like their CLIs; id-squatting ACP keeps its own name (#1575)', async () => {
    const loader = createMockConfigLoader();
    const registry = {
      version: 1 as const,
      revision: 0,
      engineConnections: [
        { id: 'claude', source: { kind: 'native' as const } },
        // An ACP connection that happens to claim the id 'codex' must never
        // wear the Codex brand — identity comes from source, not the string.
        { id: 'codex', source: { kind: 'user-acp' as const } },
      ],
      defaultAgents: [
        { id: 'station', kind: 'station' as const },
        {
          id: 'claude',
          kind: 'engine-connection' as const,
          engineConnectionId: 'claude',
        },
        {
          id: 'codex',
          kind: 'engine-connection' as const,
          engineConnectionId: 'codex',
        },
      ],
    };
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () => registry as any,
    );

    const agents = await svc.listAgents();
    expect(agents.find((agent) => agent.slug === 'claude')?.name).toBe(
      'Claude Code',
    );
    expect(agents.find((agent) => agent.slug === 'codex')?.name).toBe('codex');
  });

  test('an absent-source entry never wears a CLI brand, even on a matrix id (#1575 verify)', async () => {
    const loader = createMockConfigLoader();
    const registry = {
      version: 1 as const,
      revision: 0,
      // Hand-edited shape: no source field at all. The naming boundary is
      // strict — only an explicit native source earns the display name.
      engineConnections: [{ id: 'claude' }],
      defaultAgents: [
        { id: 'station', kind: 'station' as const },
        {
          id: 'claude',
          kind: 'engine-connection' as const,
          engineConnectionId: 'claude',
        },
      ],
    };
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () => registry as any,
    );

    const agents = await svc.listAgents();
    expect(agents.find((agent) => agent.slug === 'claude')?.name).toBe(
      'claude',
    );
  });

  test('allows direct changes to materialized registry-owned agents', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () => registryWithEngineDefault() as any,
    );

    await expect(
      svc.updateAgent('claude', { name: 'Changed' }),
    ).resolves.toEqual({ name: 'Changed' });
    await expect(svc.deleteAgent('station')).resolves.toEqual({
      success: true,
    });
    expect(loader.updateAgent).toHaveBeenCalled();
    expect(loader.deleteAgent).toHaveBeenCalled();
  });

  test('rejects the retired default alias before disk mutation', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () => registryWithEngineDefault() as any,
    );

    await expect(
      svc.createAgent({ slug: 'default', name: 'Hijacked' }),
    ).rejects.toMatchObject({ code: 'AGENT_ID_RESERVED' });
    await expect(
      svc.updateAgent('default', { execution: { agentConnectionId: 'codex' } }),
    ).rejects.toMatchObject({ code: 'AGENT_ID_RESERVED' });
    await expect(svc.deleteAgent('default')).rejects.toMatchObject({
      code: 'AGENT_ID_RESERVED',
    });
    expect(loader.createAgent).not.toHaveBeenCalled();
    expect(loader.updateAgent).not.toHaveBeenCalled();
    expect(loader.deleteAgent).not.toHaveBeenCalled();
  });

  test('projects registry public ids with runtime readiness', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      async () => registryWithEngineDefault() as any,
      async (id) =>
        id === 'default'
          ? { available: true }
          : { available: false, reason: 'Command is unavailable.' },
    );
    const projected = await svc.getEnrichedAgents([]);
    expect(projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'station', available: true }),
        expect.objectContaining({
          slug: 'claude',
          available: false,
          unavailableReason: 'Command is unavailable.',
        }),
      ]),
    );
  });

  test('createAgent delegates and returns slug+spec', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const result = await svc.createAgent({ name: 'New', prompt: 'test' });
    expect(result.slug).toBe('new-agent');
  });

  test('deleteAgent fails if layouts reference agent', async () => {
    const loader = createMockConfigLoader();
    const storageAdapter = createMockStorageAdapter();
    storageAdapter.findLayoutsUsingAgent.mockReturnValue([
      { projectSlug: 'default', layoutSlug: 'dashboard' },
    ]);
    const svc = new AgentService(
      loader as any,
      storageAdapter as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const result = await svc.deleteAgent('custom-agent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('dashboard');
  });

  test('deleteAgent succeeds when no layouts reference agent', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const result = await svc.deleteAgent('custom-agent');
    expect(result.success).toBe(true);
  });

  test('deleteAgent leaves the live generation intact for the reload transaction', async () => {
    const loader = createMockConfigLoader();
    const active = new Map([['default', { id: 'default' }]]);
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      active,
      new Map(),
      new Map(),
      mockLogger,
    );
    await svc.deleteAgent('custom-agent');
    expect(active.has('default')).toBe(true);
  });

  test('deleteAgent does not begin a blocked mutation', async () => {
    const loader = createMockConfigLoader();
    const storageAdapter = createMockStorageAdapter();
    storageAdapter.findLayoutsUsingAgent.mockReturnValue([
      { projectSlug: 'default', layoutSlug: 'dashboard' },
    ]);
    const beginMutation = vi.fn();
    const svc = new AgentService(
      loader as any,
      storageAdapter as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await svc.deleteAgent('custom-agent', beginMutation);

    expect(beginMutation).not.toHaveBeenCalled();
    expect(loader.deleteAgent).not.toHaveBeenCalled();
  });

  test('isAgentActive checks activeAgents map', () => {
    const active = new Map([['default', {}]]);
    const svc = new AgentService(
      {} as any,
      createMockStorageAdapter() as any,
      active,
      new Map(),
      new Map(),
      mockLogger,
    );
    expect(svc.isAgentActive('default')).toBe(true);
    expect(svc.isAgentActive('missing')).toBe(false);
  });

  test('getActiveAgent returns from map', () => {
    const agent = { id: 'default' };
    const active = new Map([['default', agent]]);
    const svc = new AgentService(
      {} as any,
      createMockStorageAdapter() as any,
      active,
      new Map(),
      new Map(),
      mockLogger,
    );
    expect(svc.getActiveAgent('default')).toBe(agent);
    expect(svc.getActiveAgent('missing')).toBeUndefined();
  });

  test('loadAgentSpec delegates to configLoader', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const spec = await svc.loadAgentSpec('custom-agent');
    expect(spec.name).toBe('Default');
    expect(loader.loadAgent).toHaveBeenCalledWith('custom-agent');
  });

  test('updateAgent strips other null fields but passes project: null through as the ownership-clearing signal (station#1004 §4)', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await svc.updateAgent('custom-agent', {
      description: null,
      project: null,
      name: 'Renamed',
    });
    expect(loader.updateAgent).toHaveBeenCalledWith('custom-agent', {
      project: null,
      name: 'Renamed',
    });
  });

  test('updateAgent omitting project leaves it out of the configLoader update entirely', async () => {
    const loader = createMockConfigLoader();
    const svc = new AgentService(
      loader as any,
      createMockStorageAdapter() as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await svc.updateAgent('custom-agent', { name: 'Renamed' });
    expect(loader.updateAgent).toHaveBeenCalledWith('custom-agent', {
      name: 'Renamed',
    });
  });
});
