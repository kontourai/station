import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { ConfigLoader } from '../../../domain/config-loader.js';
import {
  loadIntegrationConfig,
  saveIntegrationConfig,
} from '../../../domain/config-loader-storage.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  mcpLifecycle: { add: vi.fn() },
  mcpUiResolveTotal: { add: vi.fn() },
  mcpUiResourceReadTotal: { add: vi.fn() },
  mcpUiToolCallTotal: { add: vi.fn() },
  toolServerLifecycle: { add: vi.fn() },
  toolServerOAuth: { add: vi.fn() },
  toolServerProbes: { add: vi.fn() },
}));

// MCP-UI reads use Station's raw adapter connection, never the lossy VoltAgent
// client. When no agent currently owns the integration, the service opens a
// transient adapter connection; mock it so that fallback is deterministic.
vi.mock('@kontourai/station-shared/mcp', () => ({ connectMCP: vi.fn() }));

const { MCPService, StoredEnvMigrationError, openSystemBrowser } = await import(
  '../mcp-service.js'
);
const { createToolRoutes } = await import('../../../routes/agents/tools.js');
const { ToolServerCredentialStore } = await import(
  '../tool-server-credential-store.js'
);
const { StationToolServerOAuthProvider, toolServerOAuthResourceIdentity } =
  await import('../tool-server-oauth.js');
const { connectMCP } = await import('@kontourai/station-shared/mcp');
const connectMCPMock = vi.mocked(connectMCP);

function createMockConfigLoader() {
  const loader = withAtomicUpdate({
    listIntegrations: vi
      .fn()
      .mockResolvedValue([{ id: 'mcp-1', name: 'Test' }]),
    getToolAgentMap: vi.fn().mockResolvedValue({ 'mcp-1': ['default'] }),
    saveIntegration: vi.fn().mockResolvedValue(undefined),
    loadIntegration: vi
      .fn()
      .mockResolvedValue({ id: 'mcp-1', name: 'Test', type: 'stdio' }),
    deleteIntegration: vi.fn().mockResolvedValue(undefined),
    loadAgent: vi.fn().mockResolvedValue({
      tools: { mcpServers: ['mcp-1'], available: ['*'] },
    }),
    updateAgent: vi.fn().mockResolvedValue(undefined),
  });
  return Object.assign(loader, {
    loadIntegrationWithOwnership: vi.fn(async (id: string) => ({
      definition: await loader.loadIntegration(id),
      contributed: false,
    })),
  });
}

function withAtomicUpdate<
  T extends {
    loadIntegration(id: string): Promise<any>;
    saveIntegration(id: string, value: any): Promise<void>;
  },
>(loader: T): T & { updateIntegration: ReturnType<typeof vi.fn> } {
  return Object.assign(loader, {
    updateIntegration: vi.fn(
      async (id: string, update: (current: any) => any) => {
        const next = update(await loader.loadIntegration(id));
        await loader.saveIntegration(id, next);
        return next;
      },
    ),
  });
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('MCPService', () => {
  test('probes live package integrations without snapshotting and refuses definition mutations', async () => {
    connectMCPMock.mockReset();
    connectMCPMock.mockResolvedValue({ tools: [], disconnect: vi.fn() } as any);
    const loader = createMockConfigLoader();
    loader.loadIntegration.mockResolvedValue({
      id: 'agent-plugin-live',
      kind: 'mcp',
      transport: 'stdio',
      command: 'node',
    });
    Object.assign(loader, {
      isLiveContributedIntegration: vi.fn(() => true),
      loadIntegrationWithOwnership: vi.fn(async () => ({
        definition: await loader.loadIntegration('agent-plugin-live'),
        contributed: true,
      })),
    });
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await expect(svc.probeIntegration('agent-plugin-live')).resolves.toEqual(
      expect.objectContaining({ probe: expect.objectContaining({ ok: true }) }),
    );
    expect(loader.saveIntegration).not.toHaveBeenCalled();
    await expect(svc.setEnabled('agent-plugin-live', false)).rejects.toThrow(
      /Package-supplied integration definitions are read-only/,
    );
    await expect(
      svc.applyDisabledTools('agent-plugin-live', ['tool']),
    ).rejects.toThrow(/Package-supplied integration definitions are read-only/);
    await expect(svc.startOAuth('agent-plugin-live', 'remote')).rejects.toThrow(
      /Package-supplied integration definitions are read-only/,
    );
    expect(loader.saveIntegration).not.toHaveBeenCalled();
    expect(connectMCPMock).toHaveBeenCalledTimes(1);
  });

  test('never persists a probed package definition after its owner disappears', async () => {
    connectMCPMock.mockReset();
    connectMCPMock.mockResolvedValue({ tools: [], disconnect: vi.fn() } as any);
    const loader = createMockConfigLoader();
    loader.loadIntegration.mockResolvedValue({
      id: 'removed-package-tool',
      kind: 'mcp',
      transport: 'stdio',
      command: 'removed-package-command',
    });
    loader.loadIntegrationWithOwnership.mockImplementationOnce(async () => ({
      definition: await loader.loadIntegration('removed-package-tool'),
      contributed: true,
    }));
    Object.assign(loader, {
      // The package disappears after its definition was returned.
      isLiveContributedIntegration: vi.fn(() => false),
    });
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await expect(svc.probeIntegration('removed-package-tool')).resolves.toEqual(
      expect.objectContaining({ probe: expect.objectContaining({ ok: true }) }),
    );
    expect(loader.saveIntegration).not.toHaveBeenCalled();
  });

  test.each([
    [
      'setEnabled',
      (svc: InstanceType<typeof MCPService>) =>
        svc.setEnabled('removed-package-tool', false),
    ],
    [
      'applyDisabledTools',
      (svc: InstanceType<typeof MCPService>) =>
        svc.applyDisabledTools('removed-package-tool', ['write']),
    ],
  ] as const)(
    'never persists a package definition through %s after its owner disappears',
    async (_operation, mutate) => {
      const loader = createMockConfigLoader();
      loader.loadIntegration.mockResolvedValue({
        id: 'removed-package-tool',
        kind: 'mcp',
        transport: 'stdio',
        command: 'removed-package-command',
      });
      loader.loadIntegrationWithOwnership.mockImplementationOnce(async () => ({
        definition: await loader.loadIntegration('removed-package-tool'),
        contributed: true,
      }));
      Object.assign(loader, {
        // The initial live check has already raced with uninstall. Provenance
        // from the definition read must still forbid persisting its snapshot.
        isLiveContributedIntegration: vi.fn(() => false),
      });
      const svc = new MCPService(
        loader as any,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
      );

      await expect(mutate(svc)).rejects.toThrow(
        /Package-supplied integration definitions are read-only/,
      );
      expect(loader.saveIntegration).not.toHaveBeenCalled();
    },
  );

  test('generic edits retain package ownership after uninstall wins the read-to-save race', async () => {
    const loader = createMockConfigLoader();
    loader.loadIntegration.mockResolvedValue({
      id: 'removed-package-tool',
      kind: 'mcp',
      transport: 'stdio',
      command: 'removed-package-command',
    });
    loader.loadIntegrationWithOwnership.mockImplementationOnce(async () => ({
      definition: await loader.loadIntegration('removed-package-tool'),
      contributed: true,
    }));
    Object.assign(loader, {
      isLiveContributedIntegration: vi.fn(() => false),
    });
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const packageDefinition = await svc.getIntegration('removed-package-tool');
    const genericPutMerge = { ...packageDefinition, enabled: false };

    await expect(svc.saveIntegration(genericPutMerge)).rejects.toThrow(
      /Package-supplied integration definitions are read-only/,
    );
    expect(loader.saveIntegration).not.toHaveBeenCalled();
    expect(JSON.stringify(genericPutMerge)).not.toContain(
      'contributed-integration-definition',
    );
  });

  test('migrates stored env only after a fresh bound child succeeds and retries a safe partial grant', async () => {
    let current: any = {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'github-mcp',
      env: { TOKEN: 'legacy-material-sentinel', OTHER: 'legacy-other' },
      storedEnvNames: ['TOKEN', 'OTHER'],
    };
    const saved: any[] = [];
    const loader = withAtomicUpdate({
      loadIntegration: vi.fn(async () => current),
      saveIntegration: vi.fn(async (_id, next) => {
        current = next;
        saved.push(next);
      }),
      getProjectHomeDir: () => '/tmp/station-stored-env-migration',
    });
    const grants = new Set<string>();
    let failOther = true;
    const bindingView = (id: string) => ({
      id,
      name: id,
      authRef: { env: 'BINDING_TOKEN' },
      revision: 1,
      grants: [...grants]
        .filter((key) => key.startsWith(`${id}:`))
        .map((key) => {
          const [, integrationId, envName] = key.split(':');
          return {
            kind: 'mcp-integration-env' as const,
            integrationId,
            envName,
          };
        }),
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      availability: { backend: 'env' as const, available: true },
    });
    const bindingAuthority = {
      get: vi.fn(async (id: string) => bindingView(id)),
      grant: vi.fn(async (input: any) => {
        if (input.grant.envName === 'OTHER' && failOther) {
          failOther = false;
          throw new Error('second grant refused');
        }
        grants.add(
          `${input.id}:${input.grant.integrationId}:${input.grant.envName}`,
        );
        return bindingView(input.id);
      }),
    };
    const resolver = {
      resolveForIntegration: vi.fn().mockResolvedValue({
        environment: {
          TOKEN: 'datum-token-sentinel',
          OTHER: 'datum-other-sentinel',
        },
        settlement: { settle: vi.fn() },
      }),
    };
    connectMCPMock.mockResolvedValue({
      tools: [],
      disconnect: vi.fn(),
    } as any);
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      undefined,
      resolver,
      bindingAuthority,
    );
    const input = {
      integrationId: 'github',
      bindings: {
        TOKEN: { bindingId: 'token-binding', expectedRevision: 1 },
        OTHER: { bindingId: 'other-binding', expectedRevision: 1 },
      },
    };

    await expect(svc.migrateStoredEnv(input)).rejects.toBeInstanceOf(
      StoredEnvMigrationError,
    );
    expect(current.storedEnvNames).toEqual(['TOKEN', 'OTHER']);
    expect(saved).toEqual([]);

    await expect(svc.migrateStoredEnv(input)).resolves.toEqual({
      outcome: 'migrated',
      migratedEnvNames: ['OTHER', 'TOKEN'],
    });
    expect(bindingAuthority.grant).toHaveBeenCalledTimes(3);
    expect(resolver.resolveForIntegration).toHaveBeenCalledOnce();
    expect(connectMCPMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          TOKEN: 'datum-token-sentinel',
          OTHER: 'datum-other-sentinel',
        }),
      }),
      expect.anything(),
    );
    expect(saved[0]).toMatchObject({
      secretEnvRefs: { TOKEN: 'token-binding', OTHER: 'other-binding' },
      storedEnvNames: ['TOKEN', 'OTHER'],
    });
    expect(saved.at(-1)).toMatchObject({
      removeSecretEnvKeys: ['OTHER', 'TOKEN'],
      secretEnvRefs: { TOKEN: 'token-binding', OTHER: 'other-binding' },
    });
    expect(JSON.stringify(saved)).not.toContain('datum-token-sentinel');
  });

  test('settles a binding-backed probe failure exactly once after connection establishment fails', async () => {
    const settlement = { settle: vi.fn() };
    const loader = withAtomicUpdate({
      loadIntegration: vi.fn().mockResolvedValue({
        id: 'github',
        kind: 'mcp',
        transport: 'stdio',
        command: 'github-mcp',
        secretEnvRefs: { TOKEN: 'github-token' },
      }),
      saveIntegration: vi.fn().mockResolvedValue(undefined),
    });
    const resolver = {
      resolveForIntegration: vi.fn().mockResolvedValue({
        environment: { TOKEN: 'secret-sentinel' },
        settlement,
      }),
    };
    connectMCPMock.mockRejectedValueOnce(new Error('child failed'));
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      undefined,
      resolver,
    );

    await expect(svc.probeIntegration('github')).resolves.toMatchObject({
      probe: { ok: false },
    });
    expect(settlement.settle).toHaveBeenCalledExactlyOnceWith({
      outcome: 'failure',
      reason: 'child_establishment_failed',
    });
  });

  test('settles a short-lived MCP-UI connection failure without treating later UI work as establishment', async () => {
    const settlement = { settle: vi.fn() };
    const loader = withAtomicUpdate({
      loadIntegration: vi.fn().mockResolvedValue({
        id: 'github',
        kind: 'mcp',
        transport: 'stdio',
        command: 'github-mcp',
        secretEnvRefs: { TOKEN: 'github-token' },
      }),
      saveIntegration: vi.fn().mockResolvedValue(undefined),
    });
    const resolver = {
      resolveForIntegration: vi.fn().mockResolvedValue({
        environment: { TOKEN: 'secret-sentinel' },
        settlement,
      }),
    };
    connectMCPMock.mockRejectedValueOnce(new Error('child failed'));
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      undefined,
      resolver,
    );

    await expect(svc.getMCPUIToolCatalog('github')).resolves.toEqual({
      available: false,
    });
    expect(settlement.settle).toHaveBeenCalledExactlyOnceWith({
      outcome: 'failure',
      reason: 'child_establishment_failed',
    });
  });

  test('does not resettle a successful MCP-UI child when a later resource read fails', async () => {
    const settlement = { settle: vi.fn() };
    const loader = withAtomicUpdate({
      loadIntegration: vi.fn().mockResolvedValue({
        id: 'github',
        kind: 'mcp',
        transport: 'stdio',
        command: 'github-mcp',
        secretEnvRefs: { TOKEN: 'github-token' },
      }),
      saveIntegration: vi.fn().mockResolvedValue(undefined),
    });
    const resolver = {
      resolveForIntegration: vi.fn().mockResolvedValue({
        environment: { TOKEN: 'secret-sentinel' },
        settlement,
      }),
    };
    connectMCPMock.mockResolvedValueOnce({
      tools: [],
      close: vi.fn().mockResolvedValue(undefined),
      client: { readResource: vi.fn().mockRejectedValue(new Error('later')) },
    } as any);
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      undefined,
      resolver,
    );

    await expect(
      svc.readMCPUIResource('github', 'ui://github/panel'),
    ).rejects.toThrow('MCP UI resource read failed');
    expect(settlement.settle).toHaveBeenCalledExactlyOnceWith({
      outcome: 'success',
    });
  });

  test('retains every legacy value when a multi-env cleanup fails and allows an exact retry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-stored-env-rollback-'));
    const loader = new ConfigLoader({ projectHomeDir: home });
    const bindingState = new Map<string, Set<string>>();
    const bindingView = (id: string) => ({
      id,
      name: id,
      authRef: { env: 'BINDING_TOKEN' },
      revision: 1,
      grants: [...(bindingState.get(id) ?? [])].map((key) => {
        const [integrationId, envName] = key.split('\u0000');
        return {
          kind: 'mcp-integration-env' as const,
          integrationId,
          envName,
        };
      }),
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      availability: { backend: 'env' as const, available: true },
    });
    try {
      await loader.saveIntegration('github', {
        id: 'github',
        kind: 'mcp',
        transport: 'stdio',
        command: 'github-mcp',
        secretEnv: {
          TOKEN: 'legacy-token-sentinel',
          OTHER: 'legacy-other-sentinel',
        },
      });
      const bindings = {
        get: vi.fn(async (id: string) => bindingView(id)),
        grant: vi.fn(async (input: any) => {
          const grants = bindingState.get(input.id) ?? new Set<string>();
          grants.add(
            `${input.grant.integrationId}\u0000${input.grant.envName}`,
          );
          bindingState.set(input.id, grants);
          return bindingView(input.id);
        }),
      };
      const resolver = {
        resolveForIntegration: vi.fn().mockResolvedValue({
          environment: {
            TOKEN: 'datum-token-sentinel',
            OTHER: 'datum-other-sentinel',
          },
          settlement: { settle: vi.fn() },
        }),
      };
      connectMCPMock.mockResolvedValue({
        tools: [],
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as any);
      const service = new MCPService(
        loader,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
        undefined,
        undefined,
        resolver,
        bindings,
      );
      const reconcile = vi
        .spyOn(ToolServerCredentialStore.prototype, 'reconcileServer')
        .mockRejectedValueOnce(new Error('interrupted batch cleanup'));
      const input = {
        integrationId: 'github',
        bindings: {
          TOKEN: { bindingId: 'token-binding', expectedRevision: 1 },
          OTHER: { bindingId: 'other-binding', expectedRevision: 1 },
        },
      };

      await expect(service.migrateStoredEnv(input)).rejects.toBeInstanceOf(
        StoredEnvMigrationError,
      );
      const restored = await loader.loadIntegration('github');
      expect(restored.storedEnvNames).toEqual(['OTHER', 'TOKEN']);
      expect(restored.env).toMatchObject({
        TOKEN: 'legacy-token-sentinel',
        OTHER: 'legacy-other-sentinel',
      });
      expect(restored.secretEnvRefs).toEqual({
        TOKEN: 'token-binding',
        OTHER: 'other-binding',
      });
      reconcile.mockRestore();

      await expect(service.migrateStoredEnv(input)).resolves.toEqual({
        outcome: 'migrated',
        migratedEnvNames: ['OTHER', 'TOKEN'],
      });
      const migrated = await loader.loadIntegration('github');
      expect(migrated.storedEnvNames).toBeUndefined();
      expect(migrated.env).toEqual({});
      expect(migrated.secretEnvRefs).toEqual({
        TOKEN: 'token-binding',
        OTHER: 'other-binding',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('repairs an exact migration after both cleanup and compensation publication fail', async () => {
    const home = await mkdtemp(
      join(tmpdir(), 'station-stored-env-double-fault-'),
    );
    const loader = new ConfigLoader({ projectHomeDir: home });
    const grants = new Set<string>();
    const bindingView = (id: string) => ({
      id,
      name: id,
      authRef: { env: 'BINDING_TOKEN' },
      revision: 1,
      grants: [...grants].map((key) => {
        const [integrationId, envName] = key.split('\u0000');
        return { kind: 'mcp-integration-env' as const, integrationId, envName };
      }),
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      availability: { backend: 'env' as const, available: true },
    });
    const binding = {
      get: vi.fn(async (id: string) => bindingView(id)),
      grant: vi.fn(async (input: any) => {
        grants.add(`${input.grant.integrationId}\u0000${input.grant.envName}`);
        return bindingView(input.id);
      }),
    };
    try {
      await loader.saveIntegration('github', {
        id: 'github',
        kind: 'mcp',
        transport: 'stdio',
        command: 'github-mcp',
        secretEnv: { TOKEN: 'legacy-token-sentinel' },
      });
      const originalSave = loader.saveIntegration.bind(loader);
      let failCompensation = true;
      loader.saveIntegration = vi.fn(async (id, def) => {
        if (failCompensation && Object.hasOwn(def, 'secretEnv')) {
          failCompensation = false;
          throw new Error('compensation publication failed');
        }
        return originalSave(id, def);
      });
      const resolver = {
        resolveForIntegration: vi.fn().mockResolvedValue({
          environment: { TOKEN: 'datum-token-sentinel' },
          settlement: { settle: vi.fn() },
        }),
      };
      connectMCPMock.mockResolvedValue({
        tools: [],
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as any);
      const service = new MCPService(
        loader,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
        undefined,
        undefined,
        resolver,
        binding,
      );
      const reconcile = vi
        .spyOn(ToolServerCredentialStore.prototype, 'reconcileServer')
        .mockRejectedValueOnce(new Error('cleanup failed'));
      const input = {
        integrationId: 'github',
        bindings: {
          TOKEN: { bindingId: 'token-binding', expectedRevision: 1 },
        },
      };

      await expect(service.migrateStoredEnv(input)).rejects.toBeInstanceOf(
        StoredEnvMigrationError,
      );
      expect((await loader.loadIntegration('github')).secretEnvRefs).toEqual({
        TOKEN: 'token-binding',
      });
      reconcile.mockRestore();

      await expect(service.migrateStoredEnv(input)).resolves.toEqual({
        outcome: 'migrated',
        migratedEnvNames: ['TOKEN'],
      });
      expect(loader.saveIntegration).toHaveBeenCalledWith(
        'github',
        expect.objectContaining({ storedEnvNames: ['TOKEN'] }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('does not clean legacy credentials when probe records an unsuccessful result', async () => {
    const current: any = {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'github-mcp',
      env: { TOKEN: 'legacy-token-sentinel' },
      storedEnvNames: ['TOKEN'],
    };
    const loader = withAtomicUpdate({
      loadIntegration: vi.fn().mockResolvedValue(current),
      saveIntegration: vi.fn().mockResolvedValue(undefined),
    });
    const bindings = {
      get: vi.fn().mockResolvedValue({
        id: 'token-binding',
        grants: [],
        revision: 1,
      }),
      grant: vi.fn().mockResolvedValue(undefined),
    };
    const service = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      undefined,
      undefined,
      bindings,
    );
    vi.spyOn(service, 'probeIntegration').mockResolvedValue({
      ...current,
      probe: {
        ok: false,
        error: 'failed',
        toolCount: 0,
        checkedAt: '2026-08-24T00:00:00.000Z',
      },
    });

    await expect(
      service.migrateStoredEnv({
        integrationId: 'github',
        bindings: {
          TOKEN: { bindingId: 'token-binding', expectedRevision: 1 },
        },
      }),
    ).rejects.toBeInstanceOf(StoredEnvMigrationError);
    expect(loader.saveIntegration).toHaveBeenCalledTimes(1);
    expect(loader.saveIntegration).toHaveBeenLastCalledWith(
      'github',
      expect.objectContaining({ storedEnvNames: ['TOKEN'] }),
    );
  });

  test('refuses secret refs on HTTP management and MCP-UI connection paths without a resolver lookup or transport', async () => {
    connectMCPMock.mockClear();
    const def = {
      id: 'remote',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource.example/mcp',
      secretEnvRefs: { TOKEN: 'binding-id' },
    };
    const loader = withAtomicUpdate({
      loadIntegration: vi.fn().mockResolvedValue(def),
      saveIntegration: vi.fn().mockResolvedValue(undefined),
      getProjectHomeDir: () => '/tmp/station-secret-binding-management',
    });
    const resolver = { resolveForIntegration: vi.fn() };
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      undefined,
      resolver,
    );

    await expect(svc.startOAuth('remote', 'remote')).rejects.toThrow(
      'Tool server authorization could not be started',
    );
    const probed = await svc.probeIntegration('remote');
    expect(probed.probe).toMatchObject({ ok: false, toolCount: 0 });
    await expect(svc.getMCPUIToolCatalog('remote')).resolves.toEqual({
      available: false,
    });
    expect(resolver.resolveForIntegration).not.toHaveBeenCalled();
    expect(connectMCPMock).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(
      'binding-id',
    );
  });

  test('opens every platform browser with argv and no shell interpolation', () => {
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));
    const url = 'https://auth.example/authorize?a=1&b=2';

    openSystemBrowser(url, 'win32', spawnProcess as never);

    expect(spawnProcess).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', url],
      {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  test('rejects a non-http authorization URL before local browser launch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-url-'));
    const def = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource.example/mcp',
    } as const;
    const loader = {
      loadIntegration: vi.fn().mockResolvedValue(def),
      saveIntegration: vi.fn().mockResolvedValue(undefined),
      getProjectHomeDir: () => home,
    };
    connectMCPMock.mockImplementationOnce(async (_def, options) => {
      options?.authProvider?.state?.();
      await options?.authProvider?.redirectToAuthorization(
        new URL('file:///tmp/consent'),
      );
      options?.onTransport?.({ finishAuth: vi.fn() } as never);
      throw new Error('authorization required');
    });
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await expect(svc.startOAuth('mcp-1', 'local')).rejects.toMatchObject({
      name: 'UnsafeOAuthAuthorizationUrlError',
    });
  });

  test('authorize response never exposes remote discovery or registration text', async () => {
    const home = await mkdtemp(
      join(tmpdir(), 'station-oauth-authorize-error-'),
    );
    const remoteText =
      'registration rejected refresh-token-canary-from-remote-body';
    const def = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource.example/mcp',
    } as const;
    const loader = withAtomicUpdate({
      loadIntegration: vi.fn().mockResolvedValue(def),
      saveIntegration: vi.fn().mockResolvedValue(undefined),
      getProjectHomeDir: () => home,
    });
    connectMCPMock.mockRejectedValueOnce(new Error(remoteText));
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    const response = await createToolRoutes(svc, vi.fn()).request(
      '/mcp-1/oauth/authorize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'remote' }),
      },
    );
    const responseText = await response.text();

    expect(response.status).toBe(400);
    expect(responseText).toContain(
      'Tool server authorization could not be started',
    );
    expect(responseText).not.toContain(remoteText);
    expect(responseText).not.toContain('refresh-token-canary');
  });

  test('endpoint changes clear bound OAuth material and project consent as required', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-endpoint-'));
    const endpointA = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource-a.example/mcp',
    } as const;
    const endpointB = {
      ...endpointA,
      endpoint: 'https://resource-b.example/mcp',
    } as const;
    const store = new ToolServerCredentialStore(home);
    await new StationToolServerOAuthProvider(
      store,
      endpointA.id,
      endpointA.endpoint,
      'http://127.0.0.1:3141/integrations/mcp-1/oauth/callback',
    ).saveTokens({ access_token: 'endpoint-a-token', token_type: 'Bearer' });
    const loader = {
      loadIntegration: vi.fn().mockResolvedValue(endpointA),
      saveIntegration: vi.fn().mockResolvedValue(undefined),
      getProjectHomeDir: () => home,
    };
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await svc.saveIntegration(endpointB);

    expect(loader.saveIntegration).toHaveBeenCalledWith(
      'mcp-1',
      expect.objectContaining({
        probe: expect.objectContaining({
          ok: false,
          authorization: { state: 'never-authorized' },
        }),
      }),
    );
    expect(
      await new StationToolServerOAuthProvider(
        store,
        endpointB.id,
        endpointB.endpoint,
        'http://127.0.0.1:3141/integrations/mcp-1/oauth/callback',
      ).tokens(),
    ).toBeUndefined();
  });

  test('disable removes only OAuth credentials and preserves environment credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-disable-'));
    const def = {
      id: 'mcp-1',
      kind: 'mcp',
      enabled: true,
      transport: 'streamable-http',
      endpoint: 'https://resource.example/mcp',
      storedEnvNames: ['API_TOKEN'],
      env: { API_TOKEN: 'environment-secret' },
    } as const;
    const store = new ToolServerCredentialStore(home);
    await store.upsert('mcp-1', 'API_TOKEN', 'environment-secret');
    await new StationToolServerOAuthProvider(
      store,
      def.id,
      def.endpoint,
      'http://127.0.0.1:3141/integrations/mcp-1/oauth/callback',
    ).saveTokens({ access_token: 'oauth-secret', token_type: 'Bearer' });
    let persisted: any = def;
    const loader = {
      loadIntegration: vi.fn(async () => persisted),
      saveIntegration: vi.fn(async (_id, value) => {
        persisted = value;
      }),
      getProjectHomeDir: () => home,
    };
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await svc.setEnabled('mcp-1', false);
    expect(store.get('mcp-1', 'API_TOKEN')).toBe('environment-secret');
    await expect(svc.setEnabled('mcp-1', true)).resolves.toMatchObject({
      enabled: true,
      storedEnvNames: ['API_TOKEN'],
    });
  });

  test('consumes OAuth state on exchange failure and persists/projects only a bounded Station-owned reason', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-replay-'));
    let persisted: any = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource.example/mcp',
    };
    let issuedState = '';
    const serverControlledText =
      'authorization rejected split-secret-left::split-secret-right';
    const finishAuth = vi.fn().mockRejectedValue(
      Object.assign(new Error(serverControlledText), {
        code: 'invalid_grant',
        status: 400,
      }),
    );
    const loader = {
      loadIntegration: vi.fn(async () => persisted),
      saveIntegration: vi.fn(async (_id, value) => {
        persisted = value;
      }),
      getProjectHomeDir: () => home,
    };
    connectMCPMock.mockImplementationOnce(async (_def, options) => {
      const provider = options?.authProvider;
      provider?.saveCodeVerifier('verifier-secret');
      issuedState = String(await provider?.state?.());
      await provider?.redirectToAuthorization(
        new URL(`https://auth.example/authorize?state=${issuedState}`),
      );
      options?.onTransport?.({ finishAuth } as never);
      throw new Error('authorization required');
    });
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      4123,
    );
    await svc.startOAuth('mcp-1', 'remote');
    const callback = `http://127.0.0.1:4123/integrations/mcp-1/oauth/callback?code=one&state=${issuedState}`;

    await expect(svc.finishOAuth('mcp-1', callback)).rejects.toThrow(
      'OAuth authorization failed',
    );
    expect(persisted.probe).toMatchObject({
      error: 'invalid_grant: OAuth authorization grant was rejected or expired',
      authorization: {
        state: 'authorization-failed',
        reason:
          'invalid_grant: OAuth authorization grant was rejected or expired',
      },
    });
    expect(JSON.stringify(persisted)).not.toContain(serverControlledText);
    expect(JSON.stringify(persisted)).not.toContain('split-secret-left');

    const projection = await createToolRoutes(svc, vi.fn()).request('/mcp-1');
    const projectionText = await projection.text();
    expect(projection.status).toBe(200);
    expect(projectionText).not.toContain(serverControlledText);
    expect(projectionText).not.toContain('split-secret-left');
    expect(projectionText).toContain(
      'invalid_grant: OAuth authorization grant was rejected or expired',
    );
    await expect(svc.finishOAuth('mcp-1', callback)).rejects.toThrow(
      'No OAuth consent flow',
    );
    expect(finishAuth).toHaveBeenCalledOnce();
  });

  test('a stale callback does not consume the newer live consent flow', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-stale-state-'));
    let persisted: any = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource.example/mcp',
    };
    const issuedStates: string[] = [];
    const finishAuthOne = vi.fn();
    const finishAuthTwo = vi.fn();
    const loader = {
      loadIntegration: vi.fn(async () => persisted),
      saveIntegration: vi.fn(async (_id, value) => {
        persisted = value;
      }),
      getProjectHomeDir: () => home,
    };
    for (const finishAuth of [finishAuthOne, finishAuthTwo]) {
      connectMCPMock.mockImplementationOnce(async (_def, options) => {
        const state = String(await options?.authProvider?.state?.());
        issuedStates.push(state);
        await options?.authProvider?.redirectToAuthorization(
          new URL(`https://auth.example/authorize?state=${state}`),
        );
        options?.onTransport?.({ finishAuth } as never);
        throw new Error('authorization required');
      });
    }
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      4124,
    );

    await svc.startOAuth('mcp-1', 'remote');
    await svc.startOAuth('mcp-1', 'remote');
    await expect(
      svc.finishOAuth(
        'mcp-1',
        `http://127.0.0.1:4124/integrations/mcp-1/oauth/callback?code=stale&state=${issuedStates[0]}`,
      ),
    ).rejects.toThrow('callback URL state does not match the issued flow');

    await expect(
      svc.finishOAuth(
        'mcp-1',
        `http://127.0.0.1:4124/integrations/mcp-1/oauth/callback?code=current&state=${issuedStates[1]}`,
      ),
    ).resolves.toMatchObject({
      probe: { authorization: { state: 'authorized' } },
    });
    expect(finishAuthOne).not.toHaveBeenCalled();
    expect(finishAuthTwo).toHaveBeenCalledOnce();
  });

  test('a malformed callback preserves the live flow for the legitimate paste-back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-malformed-'));
    let persisted: any = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource.example/mcp',
    };
    let issuedState = '';
    const finishAuth = vi.fn();
    const loader = {
      loadIntegration: vi.fn(async () => persisted),
      saveIntegration: vi.fn(async (_id, value) => {
        persisted = value;
      }),
      getProjectHomeDir: () => home,
    };
    connectMCPMock.mockImplementationOnce(async (_def, options) => {
      issuedState = String(await options?.authProvider?.state?.());
      await options?.authProvider?.redirectToAuthorization(
        new URL(`https://auth.example/authorize?state=${issuedState}`),
      );
      options?.onTransport?.({ finishAuth } as never);
      throw new Error('authorization required');
    });
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      4126,
    );
    await svc.startOAuth('mcp-1', 'remote');
    const healthBeforeMalformedCallback = structuredClone(persisted.probe);
    const savesBeforeMalformedCallback =
      loader.saveIntegration.mock.calls.length;

    await expect(svc.finishOAuth('mcp-1', 'not a URL')).rejects.toThrow(
      'callback URL is not a valid URL',
    );
    expect(persisted.probe).toEqual(healthBeforeMalformedCallback);
    expect(loader.saveIntegration).toHaveBeenCalledTimes(
      savesBeforeMalformedCallback,
    );
    expect(finishAuth).not.toHaveBeenCalled();

    await expect(
      svc.finishOAuth(
        'mcp-1',
        `http://127.0.0.1:4126/integrations/mcp-1/oauth/callback?code=legitimate&state=${issuedState}`,
      ),
    ).resolves.toMatchObject({
      endpoint: 'https://resource.example/mcp',
      probe: { authorization: { state: 'authorized' } },
    });
    expect(finishAuth).toHaveBeenCalledOnce();
  });

  test('atomically claims a matched flow before concurrent callbacks can await', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-atomic-claim-'));
    let persisted: any = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource.example/mcp',
    };
    let issuedState = '';
    const finishAuth = vi.fn();
    const loader = {
      loadIntegration: vi.fn(async () => persisted),
      saveIntegration: vi.fn(async (_id, value) => {
        persisted = value;
      }),
      getProjectHomeDir: () => home,
    };
    connectMCPMock.mockImplementationOnce(async (_def, options) => {
      issuedState = String(await options?.authProvider?.state?.());
      await options?.authProvider?.redirectToAuthorization(
        new URL(`https://auth.example/authorize?state=${issuedState}`),
      );
      options?.onTransport?.({ finishAuth } as never);
      throw new Error('authorization required');
    });
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      4127,
    );
    await svc.startOAuth('mcp-1', 'remote');
    const callback = `http://127.0.0.1:4127/integrations/mcp-1/oauth/callback?code=one&state=${issuedState}`;

    const winner = svc.finishOAuth('mcp-1', callback);
    await expect(svc.finishOAuth('mcp-1', callback)).rejects.toThrow(
      'No OAuth consent flow is awaiting completion',
    );
    await expect(winner).resolves.toMatchObject({
      probe: { authorization: { state: 'authorized' } },
    });
    expect(finishAuth).toHaveBeenCalledOnce();
    expect(persisted.endpoint).toBe('https://resource.example/mcp');
  });

  test('refuses consent completion after an out-of-band endpoint edit without changing health', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-raced-endpoint-'));
    let persisted: any = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource-a.example/mcp',
    };
    let issuedState = '';
    const finishAuth = vi.fn();
    const loader = {
      loadIntegration: vi.fn(async () => persisted),
      saveIntegration: vi.fn(async (_id, value) => {
        persisted = value;
      }),
      getProjectHomeDir: () => home,
    };
    connectMCPMock.mockImplementationOnce(async (_def, options) => {
      issuedState = String(await options?.authProvider?.state?.());
      await options?.authProvider?.redirectToAuthorization(
        new URL(`https://auth.example/authorize?state=${issuedState}`),
      );
      options?.onTransport?.({ finishAuth } as never);
      throw new Error('authorization required');
    });
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      4125,
    );
    await svc.startOAuth('mcp-1', 'remote');
    persisted = { ...persisted, endpoint: 'https://resource-b.example/mcp' };
    const healthBeforeCallback = structuredClone(persisted.probe);
    const savesBeforeCallback = loader.saveIntegration.mock.calls.length;

    await expect(
      svc.finishOAuth(
        'mcp-1',
        `http://127.0.0.1:4125/integrations/mcp-1/oauth/callback?code=one&state=${issuedState}`,
      ),
    ).rejects.toThrow('OAuth tool server endpoint changed during consent');
    expect(finishAuth).not.toHaveBeenCalled();
    expect(persisted.probe).toEqual(healthBeforeCallback);
    expect(loader.saveIntegration).toHaveBeenCalledTimes(savesBeforeCallback);
  });

  test('rechecks endpoint identity after the exchange await without reverting or clearing the new endpoint', async () => {
    const home = await mkdtemp(
      join(tmpdir(), 'station-oauth-exchange-endpoint-race-'),
    );
    let persisted: any = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://resource-a.example/mcp',
    };
    let issuedState = '';
    let resolveExchange!: () => void;
    const finishAuth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExchange = resolve;
        }),
    );
    const loader = {
      loadIntegration: vi.fn(async () => persisted),
      saveIntegration: vi.fn(async (_id, value) => {
        persisted = value;
      }),
      getProjectHomeDir: () => home,
    };
    connectMCPMock.mockImplementationOnce(async (_def, options) => {
      issuedState = String(await options?.authProvider?.state?.());
      await options?.authProvider?.redirectToAuthorization(
        new URL(`https://auth.example/authorize?state=${issuedState}`),
      );
      options?.onTransport?.({ finishAuth } as never);
      throw new Error('authorization required');
    });
    const svc = new MCPService(
      withAtomicUpdate(loader) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
      undefined,
      4128,
    );
    await svc.startOAuth('mcp-1', 'remote');
    const pending = svc.finishOAuth(
      'mcp-1',
      `http://127.0.0.1:4128/integrations/mcp-1/oauth/callback?code=one&state=${issuedState}`,
    );
    await vi.waitFor(() => expect(finishAuth).toHaveBeenCalledOnce());

    persisted = {
      ...persisted,
      endpoint: 'https://resource-b.example/mcp',
    };
    const healthAfterEndpointEdit = structuredClone(persisted.probe);
    const savesAfterEndpointEdit = loader.saveIntegration.mock.calls.length;
    const endpointBProvider = new StationToolServerOAuthProvider(
      new ToolServerCredentialStore(home),
      'mcp-1',
      'https://resource-b.example/mcp',
      'http://127.0.0.1:4128/integrations/mcp-1/oauth/callback',
    );
    await endpointBProvider.saveTokens({
      access_token: 'endpoint-b-token',
      token_type: 'Bearer',
    });
    resolveExchange();

    await expect(pending).rejects.toThrow(
      'OAuth tool server endpoint changed during authorization exchange',
    );
    expect(loader.saveIntegration).toHaveBeenCalledTimes(
      savesAfterEndpointEdit,
    );
    expect(persisted.endpoint).toBe('https://resource-b.example/mcp');
    expect(persisted.probe).toEqual(healthAfterEndpointEdit);
    expect((await endpointBProvider.tokens())?.access_token).toBe(
      'endpoint-b-token',
    );
  });

  test('refuses an endpoint mutation in the post-exchange pre-lock window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-pre-lock-race-'));
    try {
      const loader = new ConfigLoader({ projectHomeDir: home });
      const endpointA = 'https://resource-a.example/mcp';
      const endpointB = 'https://resource-b.example/mcp';
      await loader.saveIntegration('mcp-1', {
        id: 'mcp-1',
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: endpointA,
      });
      let issuedState = '';
      const finishAuth = vi.fn();
      connectMCPMock.mockImplementationOnce(async (_def, options) => {
        issuedState = String(await options?.authProvider?.state?.());
        await options?.authProvider?.redirectToAuthorization(
          new URL(`https://auth.example/authorize?state=${issuedState}`),
        );
        options?.onTransport?.({ finishAuth } as never);
        throw new Error('authorization required');
      });
      const svc = new MCPService(
        loader,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
        undefined,
        4130,
      );
      await svc.startOAuth('mcp-1', 'remote');
      const updateIntegration = loader.updateIntegration.bind(loader);
      loader.updateIntegration = vi.fn(async (id, update) => {
        const current = await loader.loadIntegration(id);
        await svc.saveIntegration({ ...current, endpoint: endpointB });
        return updateIntegration(id, update);
      });

      await expect(
        svc.finishOAuth(
          'mcp-1',
          `http://127.0.0.1:4130/integrations/mcp-1/oauth/callback?code=one&state=${issuedState}`,
        ),
      ).rejects.toThrow(
        'OAuth tool server endpoint changed during authorization exchange',
      );
      expect((await loader.loadIntegration('mcp-1')).endpoint).toBe(endpointB);
      expect((await loader.loadIntegration('mcp-1')).probe).toMatchObject({
        authorization: { state: 'never-authorized' },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('serializes an endpoint mutation initiated inside the locked health derivation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-in-lock-race-'));
    try {
      const loader = new ConfigLoader({ projectHomeDir: home });
      const endpointA = 'https://resource-a.example/mcp';
      const endpointB = 'https://resource-b.example/mcp';
      await loader.saveIntegration('mcp-1', {
        id: 'mcp-1',
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: endpointA,
      });
      let issuedState = '';
      const finishAuth = vi.fn();
      connectMCPMock.mockImplementationOnce(async (_def, options) => {
        issuedState = String(await options?.authProvider?.state?.());
        await options?.authProvider?.redirectToAuthorization(
          new URL(`https://auth.example/authorize?state=${issuedState}`),
        );
        options?.onTransport?.({ finishAuth } as never);
        throw new Error('authorization required');
      });
      const svc = new MCPService(
        loader,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
        undefined,
        4131,
      );
      await svc.startOAuth('mcp-1', 'remote');
      const updateIntegration = loader.updateIntegration.bind(loader);
      let endpointMutation: Promise<void> | undefined;
      loader.updateIntegration = vi.fn((id, update) =>
        updateIntegration(id, (current) => {
          const next = update(current);
          endpointMutation = svc.saveIntegration({
            ...current,
            endpoint: endpointB,
          });
          return next;
        }),
      );

      await expect(
        svc.finishOAuth(
          'mcp-1',
          `http://127.0.0.1:4131/integrations/mcp-1/oauth/callback?code=one&state=${issuedState}`,
        ),
      ).resolves.toMatchObject({ endpoint: endpointA });
      await endpointMutation;

      const persisted = await loader.loadIntegration('mcp-1');
      expect(persisted.endpoint).toBe(endpointB);
      expect(persisted.probe).toMatchObject({
        authorization: { state: 'never-authorized' },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('a callback received by a runtime without the flow preserves shared OAuth state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-shared-state-'));
    try {
      const loader = new ConfigLoader({ projectHomeDir: home });
      await loader.saveIntegration('mcp-1', {
        id: 'mcp-1',
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://resource.example/mcp',
      });
      let issuedState = '';
      const finishAuth = vi.fn();
      connectMCPMock.mockImplementationOnce(async (_def, options) => {
        issuedState = String(await options?.authProvider?.state?.());
        await options?.authProvider?.redirectToAuthorization(
          new URL(`https://auth.example/authorize?state=${issuedState}`),
        );
        options?.onTransport?.({ finishAuth } as never);
        throw new Error('authorization required');
      });
      const createService = () =>
        new MCPService(
          loader,
          new Map(),
          new Map(),
          new Map(),
          new Map(),
          new Map(),
          mockLogger,
          undefined,
          4132,
        );
      const flowOwner = createService();
      const otherRuntime = createService();
      await flowOwner.startOAuth('mcp-1', 'remote');
      const callback = `http://127.0.0.1:4132/integrations/mcp-1/oauth/callback?code=one&state=${issuedState}`;

      await expect(otherRuntime.finishOAuth('mcp-1', callback)).rejects.toThrow(
        'No OAuth consent flow is awaiting completion',
      );
      expect(
        new ToolServerCredentialStore(home).get('mcp-1', 'oauth.state'),
      ).toBeTruthy();
      await expect(
        flowOwner.finishOAuth('mcp-1', callback),
      ).resolves.toMatchObject({
        probe: { authorization: { state: 'authorized' } },
      });
      expect(finishAuth).toHaveBeenCalledOnce();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('OAuth resource identity strips fragments but preserves HTTP request-target distinctions', () => {
    const base = {
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'streamable-http',
    } as const;
    expect(
      toolServerOAuthResourceIdentity({
        ...base,
        endpoint: 'https://example.test/mcp#one',
      }),
    ).toBe('https://example.test/mcp');
    expect(
      toolServerOAuthResourceIdentity({
        ...base,
        endpoint: 'https://example.test/mcp#two',
      }),
    ).toBe('https://example.test/mcp');
    expect(
      toolServerOAuthResourceIdentity({
        ...base,
        endpoint: 'https://example.test/mcp/',
      }),
    ).not.toBe(
      toolServerOAuthResourceIdentity({
        ...base,
        endpoint: 'https://example.test/mcp',
      }),
    );
    expect(
      toolServerOAuthResourceIdentity({
        ...base,
        endpoint: 'https://example.test/mcp?a=1&b=2',
      }),
    ).not.toBe(
      toolServerOAuthResourceIdentity({
        ...base,
        endpoint: 'https://example.test/mcp?b=2&a=1',
      }),
    );
  });
  test('probing a legacy integration preserves the omitted enabled field', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-probe-legacy-'));
    try {
      const integrationDir = join(home, 'integrations', 'mcp-1');
      const path = join(integrationDir, 'integration.json');
      await mkdir(integrationDir, { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ id: 'mcp-1', kind: 'mcp', command: 'demo' }, null, 2),
      );
      connectMCPMock.mockResolvedValueOnce({
        tools: [],
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as any);
      const loader = createMockConfigLoader();
      loader.loadIntegration.mockImplementation(() =>
        loadIntegrationConfig(home, 'mcp-1'),
      );
      loader.saveIntegration.mockImplementation((id, def) =>
        saveIntegrationConfig(home, id, def),
      );
      const svc = new MCPService(
        withAtomicUpdate(loader) as any,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
      );

      await svc.probeIntegration('mcp-1');

      expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty(
        'enabled',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  test('persists and projects only a bounded probe reason when remote text contains a split secret', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-probe-bounded-'));
    const integrationDir = join(home, 'integrations', 'mcp-1');
    const path = join(integrationDir, 'integration.json');
    const remoteText =
      'invalid grant split-secret-left::attacker-gap::split-secret-right';
    try {
      await mkdir(integrationDir, { recursive: true });
      await writeFile(
        path,
        JSON.stringify(
          {
            id: 'mcp-1',
            kind: 'mcp',
            transport: 'streamable-http',
            endpoint: 'https://resource.example/mcp',
          },
          null,
          2,
        ),
      );
      connectMCPMock.mockRejectedValueOnce(
        Object.assign(new Error(remoteText), {
          code: 'invalid_grant',
          status: 401,
        }),
      );
      const loader = createMockConfigLoader();
      loader.loadIntegration.mockImplementation(() =>
        loadIntegrationConfig(home, 'mcp-1'),
      );
      loader.saveIntegration.mockImplementation((id, def) =>
        saveIntegrationConfig(home, id, def),
      );
      Object.assign(loader, { getProjectHomeDir: () => home });
      const svc = new MCPService(
        loader as any,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
      );

      const result = await svc.probeIntegration('mcp-1');
      expect(result.probe).toMatchObject({
        ok: false,
        error: 'authentication_error: Tool server authentication failed',
        toolCount: 0,
      });
      const persistedText = await readFile(path, 'utf8');
      expect(persistedText).not.toContain(remoteText);
      expect(persistedText).not.toContain('split-secret-left');
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(
        remoteText,
      );

      const projection = await createToolRoutes(svc, vi.fn()).request('/mcp-1');
      const projectionText = await projection.text();
      expect(projection.status).toBe(200);
      expect(projectionText).toContain(
        'authentication_error: Tool server authentication failed',
      );
      expect(projectionText).not.toContain(remoteText);
      expect(projectionText).not.toContain('split-secret-left');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  test('records probe completion time after a delayed successful connection', async () => {
    vi.useFakeTimers();
    const loader = createMockConfigLoader();
    let resolveConnection!: (value: unknown) => void;
    connectMCPMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConnection = resolve;
      }) as never,
    );
    vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'));
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const pending = svc.probeIntegration('mcp-1');
    vi.setSystemTime(new Date('2026-08-14T10:00:05.000Z'));
    resolveConnection({ tools: [], disconnect: vi.fn() });
    const result = await pending;

    expect(result.probe?.checkedAt).toBe('2026-08-14T10:00:05.000Z');
    vi.useRealTimers();
  });
  test('listIntegrations delegates to configLoader', async () => {
    const loader = createMockConfigLoader();
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const result = await svc.listIntegrations();
    expect(result).toEqual([{ id: 'mcp-1', name: 'Test' }]);
  });

  test('getToolAgentMap delegates', async () => {
    const loader = createMockConfigLoader();
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const result = await svc.getToolAgentMap();
    expect(result).toEqual({ 'mcp-1': ['default'] });
  });

  test('saveIntegration delegates', async () => {
    const loader = createMockConfigLoader();
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await svc.saveIntegration({ id: 'new', name: 'New' } as any);
    expect(loader.saveIntegration).toHaveBeenCalled();
  });

  test('ordinary edits preserve hidden binding references', async () => {
    const loader = createMockConfigLoader();
    loader.loadIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'server',
      secretEnvRefs: { TOKEN: 'binding' },
    });
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await svc.saveIntegration({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'server',
      displayName: 'Edited name',
    });
    expect(loader.saveIntegration).toHaveBeenCalledWith(
      'mcp-1',
      expect.objectContaining({ secretEnvRefs: { TOKEN: 'binding' } }),
    );
  });

  test('bound lifecycle and tool edits retain an unchanged hidden reference map', async () => {
    const loader = createMockConfigLoader();
    const home = await mkdtemp(join(tmpdir(), 'station-bound-lifecycle-'));
    const bound = {
      id: 'mcp-1',
      kind: 'mcp' as const,
      transport: 'stdio' as const,
      command: 'server',
      secretEnvRefs: { TOKEN: 'binding' },
    };
    loader.loadIntegration.mockResolvedValue(bound);
    Object.assign(loader, { getProjectHomeDir: () => home });
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    try {
      await svc.setEnabled('mcp-1', false);
      await svc.setEnabled('mcp-1', true);
      await svc.applyDisabledTools('mcp-1', ['write']);

      expect(loader.saveIntegration).toHaveBeenCalledTimes(3);
      for (const [, saved] of loader.saveIntegration.mock.calls) {
        expect(saved).toMatchObject({ secretEnvRefs: { TOKEN: 'binding' } });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('rejects a caller-provided binding map unless it exactly matches the existing map', async () => {
    const loader = createMockConfigLoader();
    loader.loadIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'server',
      secretEnvRefs: { TOKEN: 'binding' },
    });
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await svc.saveIntegration({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'server',
      secretEnvRefs: { TOKEN: 'binding' },
    });
    await expect(
      svc.saveIntegration({
        id: 'mcp-1',
        kind: 'mcp',
        transport: 'stdio',
        command: 'server',
        secretEnvRefs: { TOKEN: 'different-binding' },
      }),
    ).rejects.toThrow('operator binding API');
  });

  test.each([
    { command: 'other-server' },
    { args: ['--other'] },
    { env: { TOKEN: 'other' } },
    {
      transport: 'streamable-http' as const,
      endpoint: 'https://example.test/mcp',
    },
  ])('refuses a bound child execution change: %j', async (change) => {
    const loader = createMockConfigLoader();
    loader.loadIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'server',
      args: ['--safe'],
      env: { TOKEN: 'safe' },
      secretEnvRefs: { TOKEN: 'binding' },
    });
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await expect(
      svc.saveIntegration({
        id: 'mcp-1',
        kind: 'mcp',
        transport: 'stdio',
        command: 'server',
        args: ['--safe'],
        env: { TOKEN: 'safe' },
        ...change,
      }),
    ).rejects.toThrow('Unbind secret bindings');
    expect(loader.saveIntegration).not.toHaveBeenCalled();
  });

  test('ordinary integration writes cannot author binding references', async () => {
    const loader = createMockConfigLoader();
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await expect(
      svc.saveIntegration({
        id: 'mcp-1',
        kind: 'mcp',
        transport: 'stdio',
        command: 'server',
        secretEnvRefs: { TOKEN: 'binding' },
      }),
    ).rejects.toThrow('operator binding API');
    expect(loader.saveIntegration).not.toHaveBeenCalled();
  });

  test('deleteIntegration delegates', async () => {
    const loader = createMockConfigLoader();
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await svc.deleteIntegration('mcp-1');
    expect(loader.deleteIntegration).toHaveBeenCalledWith('mcp-1');
  });

  test('deleteIntegration clears an in-memory OAuth consent flow', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-delete-'));
    try {
      const def = {
        id: 'mcp-1',
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://resource.example/mcp',
      } as const;
      const loader = {
        loadIntegration: vi.fn().mockResolvedValue(def),
        saveIntegration: vi.fn().mockResolvedValue(undefined),
        deleteIntegration: vi.fn().mockResolvedValue(undefined),
        getProjectHomeDir: () => home,
      };
      let issuedState = '';
      connectMCPMock.mockImplementationOnce(async (_def, options) => {
        issuedState = String(await options?.authProvider?.state?.());
        await options?.authProvider?.redirectToAuthorization(
          new URL(`https://auth.example/authorize?state=${issuedState}`),
        );
        options?.onTransport?.({ finishAuth: vi.fn() } as never);
        throw new Error('authorization required');
      });
      const svc = new MCPService(
        withAtomicUpdate(loader) as any,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
      );
      await svc.startOAuth('mcp-1', 'remote');

      await svc.deleteIntegration('mcp-1');
      const loadCallsBeforeRejectedCallback =
        loader.loadIntegration.mock.calls.length;

      await expect(
        svc.finishOAuth(
          'mcp-1',
          `http://127.0.0.1:3141/integrations/mcp-1/oauth/callback?code=one&state=${issuedState}`,
        ),
      ).rejects.toThrow('No OAuth consent flow');
      expect(loader.loadIntegration).toHaveBeenCalledTimes(
        loadCallsBeforeRejectedCallback,
      );
      expect(loader.deleteIntegration).toHaveBeenCalledWith('mcp-1');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('getAgentTools returns empty for unknown agent', () => {
    const svc = new MCPService(
      {} as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    expect(svc.getAgentTools('unknown')).toEqual([]);
  });

  test('getAgentTools maps tool metadata', () => {
    const tools = new Map([
      [
        'default',
        [{ name: 'myServer_doThing', id: 't1', description: 'Does thing' }],
      ],
    ]);
    const mapping = new Map([
      [
        'myServer_doThing',
        {
          original: 'doThing',
          normalized: 'myServer_doThing',
          server: 'myServer',
          tool: 'doThing',
        },
      ],
    ]);
    const svc = new MCPService(
      {} as any,
      new Map(),
      new Map(),
      new Map(),
      tools,
      mapping,
      mockLogger,
    );
    const result = svc.getAgentTools('default');
    expect(result).toHaveLength(1);
    expect(result[0].server).toBe('myServer');
    expect(result[0].toolName).toBe('doThing');
  });

  test('getAgentTools preserves MCP UI metadata from production tool records', () => {
    const tools = new Map([
      [
        'default',
        [
          {
            name: 'myServer_render',
            id: 't1',
            description: 'Renders UI',
            _meta: { ui: { resourceUri: 'ui://myServer/render.html' } },
          },
        ],
      ],
    ]);
    const mapping = new Map([
      [
        'myServer_render',
        {
          original: 'render',
          normalized: 'myServer_render',
          server: 'myServer',
          tool: 'render',
        },
      ],
    ]);
    const svc = new MCPService(
      {} as any,
      new Map(),
      new Map(),
      new Map(),
      tools,
      mapping,
      mockLogger,
    );

    expect(svc.getAgentTools('default')[0]).toMatchObject({
      server: 'myServer',
      serverId: 'myServer',
      toolName: 'render',
      _meta: { ui: { resourceUri: 'ui://myServer/render.html' } },
      ui: { resourceUri: 'ui://myServer/render.html' },
      resource: { uri: 'ui://myServer/render.html' },
    });
  });

  test('getMCPToolCatalog exposes UI-capable tools across agents', () => {
    const tools = new Map([
      [
        'agent-a',
        [
          {
            name: 'serverA_render',
            _meta: { 'ui/resourceUri': 'ui://serverA/render.html' },
          },
        ],
      ],
      [
        'agent-b',
        [
          {
            name: 'serverB_chart',
            _meta: { ui: { resourceUri: 'ui://serverB/chart.html' } },
          },
        ],
      ],
    ]);
    const mapping = new Map([
      [
        'serverA_render',
        {
          original: 'render',
          normalized: 'serverA_render',
          server: 'serverA',
          tool: 'render',
        },
      ],
      [
        'serverB_chart',
        {
          original: 'chart',
          normalized: 'serverB_chart',
          server: 'serverB',
          tool: 'chart',
        },
      ],
    ]);
    const svc = new MCPService(
      {} as any,
      new Map(),
      new Map(),
      new Map(),
      tools,
      mapping,
      mockLogger,
    );

    expect(svc.getMCPToolCatalog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: 'serverA',
          toolName: 'render',
          ui: { resourceUri: 'ui://serverA/render.html' },
        }),
        expect.objectContaining({
          serverId: 'serverB',
          toolName: 'chart',
          ui: { resourceUri: 'ui://serverB/chart.html' },
        }),
      ]),
    );
  });

  test('addToolToAgent adds to mcpServers list', async () => {
    const loader = createMockConfigLoader();
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const result = await svc.addToolToAgent('default', 'mcp-2');
    expect(result).toContain('mcp-2');
    expect(loader.updateAgent).toHaveBeenCalled();
  });

  test('addToolToAgent deduplicates', async () => {
    const loader = createMockConfigLoader();
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const result = await svc.addToolToAgent('default', 'mcp-1');
    expect(result.filter((id: string) => id === 'mcp-1')).toHaveLength(1);
  });

  test('removeToolFromAgent removes from list', async () => {
    const loader = createMockConfigLoader();
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await svc.removeToolFromAgent('default', 'mcp-1');
    expect(loader.updateAgent).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({
        tools: expect.objectContaining({ mcpServers: [] }),
      }),
    );
  });

  test('getConnectionStatus returns undefined for unknown', () => {
    const svc = new MCPService(
      {} as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    expect(svc.getConnectionStatus('default', 'mcp-1')).toBeUndefined();
  });

  test('getConnectionStatus returns stored status', () => {
    const status = new Map([['mcp-1', { connected: true }]]);
    const svc = new MCPService(
      {} as any,
      new Map(),
      status as any,
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    expect(svc.getConnectionStatus('default', 'mcp-1')).toEqual({
      connected: true,
    });
  });

  function svcWithMcpUiConnection(
    client: Record<string, unknown>,
    tools: unknown[] = [],
  ) {
    connectMCPMock.mockResolvedValue({
      client,
      serverId: 'mcp-1',
      tools,
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    const configLoader = {
      loadIntegration: vi
        .fn()
        .mockResolvedValue({ id: 'mcp-1', kind: 'mcp', transport: 'stdio' }),
    };
    return new MCPService(
      configLoader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
  }

  function svcWithClient(readResource: (req: unknown) => Promise<unknown>) {
    return svcWithMcpUiConnection({ readResource, callTool: vi.fn() });
  }

  test('readMCPUIResource returns content from the connected server client', async () => {
    const svc = svcWithClient(
      vi.fn().mockResolvedValue({
        contents: [
          {
            uri: 'ui://mcp-1/panel',
            mimeType: 'text/html',
            text: '<h1>hi</h1>',
          },
        ],
      }),
    );
    const result = await svc.readMCPUIResource('mcp-1', 'ui://mcp-1/panel');
    expect(result).toEqual({
      uri: 'ui://mcp-1/panel',
      mimeType: 'text/html',
      text: '<h1>hi</h1>',
      blob: undefined,
      truncated: undefined,
    });
  });

  test('MCP-UI resource and tool errors cross the shared bounded boundary', async () => {
    const resourceRemoteText =
      'resource failed refresh-token-canary-from-remote-server';
    const toolRemoteText = 'tool failed access-token-canary-from-remote-server';
    const readService = svcWithMcpUiConnection({
      readResource: vi.fn().mockRejectedValue(new Error(resourceRemoteText)),
      callTool: vi.fn(),
    });
    await expect(
      readService.readMCPUIResource('mcp-1', 'ui://mcp-1/panel'),
    ).rejects.toThrow('MCP UI resource read failed');

    const callService = svcWithMcpUiConnection(
      {
        readResource: vi.fn(),
        callTool: vi.fn().mockRejectedValue(new Error(toolRemoteText)),
      },
      [
        {
          name: 'mcp-1_render',
          originalName: 'render',
          serverId: 'mcp-1',
        },
      ],
    );

    await expect(callService.callMCPUITool('mcp-1', 'render')).rejects.toThrow(
      'MCP tool call failed',
    );
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(
      'token-canary',
    );
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(
      'token-canary',
    );
  });

  test('MCP-UI HTTP handlers never return remote resource or tool text', async () => {
    const resourceRemoteText =
      'resource failed refresh-token-canary-from-remote-server';
    const toolRemoteText = 'tool failed access-token-canary-from-remote-server';
    const active = {
      client: {
        readResource: vi.fn().mockRejectedValue(new Error(resourceRemoteText)),
        callTool: vi.fn().mockRejectedValue(new Error(toolRemoteText)),
      },
      serverId: 'mcp-1',
      tools: [
        {
          name: 'mcp-1_render',
          originalName: 'render',
          serverId: 'mcp-1',
          _meta: { ui: { resourceUri: 'ui://mcp-1/render.html' } },
        },
      ],
    };
    const svc = new MCPService(
      createMockConfigLoader() as any,
      new Map([['mcp-1', active]]) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    const routes = createToolRoutes(svc, vi.fn());

    const resourceResponse = await routes.request('/mcp-1/ui/render/resource');
    const resourceText = await resourceResponse.text();
    expect(resourceResponse.status).toBe(502);
    expect(resourceText).toContain('MCP UI resource read failed');
    expect(resourceText).not.toContain(resourceRemoteText);
    expect(resourceText).not.toContain('refresh-token-canary');

    const callResponse = await routes.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', arguments: {} }),
    });
    const callText = await callResponse.text();
    expect(callResponse.status).toBe(502);
    expect(callText).toContain('MCP tool call failed');
    expect(callText).not.toContain(toolRemoteText);
    expect(callText).not.toContain('access-token-canary');
  });

  test('a transient HTTP MCP-UI connection receives the bound OAuth provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-mcp-ui-oauth-'));
    try {
      const readResource = vi.fn().mockResolvedValue({
        contents: [{ uri: 'ui://mcp-1/panel', text: '<p>secured</p>' }],
      });
      connectMCPMock.mockResolvedValueOnce({
        client: { readResource, callTool: vi.fn() },
        serverId: 'mcp-1',
        tools: [],
        close: vi.fn().mockResolvedValue(undefined),
      } as never);
      const def = {
        id: 'mcp-1',
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://resource.example/mcp',
      } as const;
      const svc = new MCPService(
        {
          loadIntegration: vi.fn().mockResolvedValue(def),
          getProjectHomeDir: () => home,
        } as any,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        mockLogger,
        undefined,
        4555,
      );

      await svc.readMCPUIResource('mcp-1', 'ui://mcp-1/panel');

      expect(connectMCPMock).toHaveBeenCalledWith(
        def,
        expect.objectContaining({
          authProvider: expect.objectContaining({
            redirectUrl:
              'http://127.0.0.1:4555/integrations/mcp-1/oauth/callback',
          }),
        }),
      );
      expect(readResource).toHaveBeenCalledWith({ uri: 'ui://mcp-1/panel' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('shares the active Station-owned connection without a parallel spawn', async () => {
    connectMCPMock.mockClear();
    const readResource = vi.fn().mockResolvedValue({
      contents: [
        {
          uri: 'ui://mcp-1/panel',
          mimeType: 'text/html;profile=mcp-app',
          text: '<h1>shared</h1>',
        },
      ],
    });
    const active = {
      client: { readResource, callTool: vi.fn() },
      serverId: 'mcp-1',
      tools: [],
      negotiation: {
        era: 'modern',
        extensionIds: [],
        fellBackToLegacy: false,
      },
      close: vi.fn(),
      disconnect: vi.fn(),
    };
    const svc = new MCPService(
      createMockConfigLoader() as any,
      new Map([['mcp-1', active]]) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    const result = await svc.readMCPUIResource('mcp-1', 'ui://mcp-1/panel');

    expect(result.text).toBe('<h1>shared</h1>');
    expect(readResource).toHaveBeenCalledWith({ uri: 'ui://mcp-1/panel' });
    expect(connectMCPMock).not.toHaveBeenCalled();
    expect(active.close).not.toHaveBeenCalled();
  });

  test('disabled MCP-UI resolve, resource read, and call never connect', async () => {
    connectMCPMock.mockClear();
    const loader = {
      ...createMockConfigLoader(),
      loadIntegration: vi.fn().mockResolvedValue({
        id: 'mcp-1',
        kind: 'mcp',
        enabled: false,
      }),
    };
    const svc = new MCPService(
      loader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await expect(svc.getMCPUIToolCatalog('mcp-1')).resolves.toEqual({
      available: true,
      tools: [],
    });
    await expect(
      svc.readMCPUIResource('mcp-1', 'ui://mcp-1/panel'),
    ).rejects.toThrow("MCP server 'mcp-1' is disabled");
    await expect(svc.callMCPUITool('mcp-1', 'render')).rejects.toThrow(
      "MCP server 'mcp-1' is disabled",
    );
    expect(connectMCPMock).not.toHaveBeenCalled();
  });

  test('hides disabled tools from the UI catalog and refuses both UI call paths', async () => {
    const callTool = vi.fn();
    const connection = {
      client: { callTool, readResource: vi.fn() },
      tools: [
        { name: 'mcp-1_render', originalName: 'render', serverId: 'mcp-1' },
      ],
    };
    const loader = {
      ...createMockConfigLoader(),
      loadIntegration: vi.fn().mockResolvedValue({
        id: 'mcp-1',
        kind: 'mcp',
        enabled: true,
        disabledTools: ['mcp-1_render'],
      }),
    };
    const svc = new MCPService(
      loader as any,
      new Map([['mcp-1', connection]]) as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );

    await expect(svc.getMCPUIToolCatalog('mcp-1')).resolves.toEqual({
      available: true,
      tools: [],
    });
    await expect(svc.callMCPUITool('mcp-1', 'render')).rejects.toThrow(
      "MCP tool 'render' is disabled",
    );
    await expect(
      svc.readMCPUIResourceFromTool('mcp-1', 'render'),
    ).rejects.toThrow("MCP tool 'render' is disabled");
    expect(callTool).not.toHaveBeenCalled();
  });

  test('reads metadata from the shared integration key', () => {
    const svc = new MCPService(
      createMockConfigLoader() as any,
      new Map(),
      new Map(),
      new Map([['mcp-1', { type: 'mcp', transport: 'stdio', toolCount: 2 }]]),
      new Map(),
      new Map(),
      mockLogger,
    );

    expect(svc.getIntegrationMetadata('writer', 'mcp-1')).toEqual({
      type: 'mcp',
      transport: 'stdio',
      toolCount: 2,
    });
  });

  test('readMCPUIResource byte-caps oversized text and flags truncation', async () => {
    const huge = 'a'.repeat(600 * 1024);
    const svc = svcWithClient(
      vi.fn().mockResolvedValue({
        contents: [{ mimeType: 'text/html', text: huge }],
      }),
    );
    const result = await svc.readMCPUIResource('mcp-1', 'ui://mcp-1/panel');
    expect(result.truncated).toBe(true);
    expect(result.text?.length).toBe(512 * 1024);
  });

  test('readMCPUIResource preserves authoritative resource-content policy', async () => {
    const svc = svcWithClient(
      vi.fn().mockResolvedValue({
        contents: [
          {
            uri: 'ui://mcp-1/panel',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>panel</main>',
            _meta: {
              ui: {
                csp: { connectDomains: ['https://resource.example.com'] },
                permissions: { clipboardWrite: {} },
              },
            },
          },
        ],
      }),
    );

    await expect(
      svc.readMCPUIResource('mcp-1', 'ui://mcp-1/panel'),
    ).resolves.toMatchObject({
      _meta: {
        ui: {
          csp: { connectDomains: ['https://resource.example.com'] },
          permissions: { clipboardWrite: {} },
        },
      },
      ui: {
        csp: {
          connectDomains: ['https://resource.example.com'],
        },
        permissions: { clipboardWrite: {} },
      },
    });
  });

  function svcWithToolClient(
    callTool: (call: {
      name: string;
      arguments: Record<string, unknown>;
    }) => Promise<unknown>,
  ) {
    return svcWithMcpUiConnection({ callTool, readResource: vi.fn() }, [
      {
        name: 'mcp-1_render',
        originalName: 'render',
        serverId: 'mcp-1',
        _meta: { ui: { visibility: ['model', 'app'] } },
      },
    ]);
  }

  test('readMCPUIResourceFromTool extracts the mcp-ui.dev embedded resource', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'status ok' },
        {
          type: 'resource',
          resource: {
            uri: 'ui://mcp-1/panel',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>panel</main>',
          },
        },
      ],
    });
    const svc = svcWithToolClient(callTool);
    const result = await svc.readMCPUIResourceFromTool('mcp-1', 'render');
    expect(result).toMatchObject({
      uri: 'ui://mcp-1/panel',
      mimeType: 'text/html;profile=mcp-app',
      text: '<main>panel</main>',
    });
    // Pinned tool, fixed empty args — no client-supplied input.
    expect(callTool).toHaveBeenCalledWith({ name: 'render', arguments: {} });
  });

  test('readMCPUIResourceFromTool throws when the result has no UI resource', async () => {
    const svc = svcWithToolClient(
      vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'no ui' }] }),
    );
    await expect(
      svc.readMCPUIResourceFromTool('mcp-1', 'render'),
    ).rejects.toThrow(/no embedded UI resource/);
  });

  test('readMCPUIResourceFromTool byte-caps oversized embedded text', async () => {
    const huge = 'a'.repeat(600 * 1024);
    const svc = svcWithToolClient(
      vi.fn().mockResolvedValue({
        content: [
          {
            type: 'resource',
            resource: { uri: 'ui://mcp-1/panel', text: huge },
          },
        ],
      }),
    );
    const result = await svc.readMCPUIResourceFromTool('mcp-1', 'render');
    expect(result.truncated).toBe(true);
    expect(result.text?.length).toBe(512 * 1024);
  });

  test('readMCPUIResource rejects when the server cannot be connected', async () => {
    connectMCPMock.mockRejectedValueOnce(new Error('spawn failed'));
    const svc = new MCPService(
      { loadIntegration: vi.fn().mockResolvedValue({ id: 'mcp-1' }) } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await expect(
      svc.readMCPUIResource('mcp-1', 'ui://mcp-1/panel'),
    ).rejects.toThrow('Tool server connection failed');
  });

  test('readMCPUIResource throws when content is empty', async () => {
    const svc = svcWithClient(vi.fn().mockResolvedValue({ contents: [] }));
    await expect(
      svc.readMCPUIResource('mcp-1', 'ui://mcp-1/panel'),
    ).rejects.toThrow('no content');
  });

  test('callMCPUITool uses the raw Station connection and returns the full result', async () => {
    // The voltagent client strips resource/structured content; the SDK client
    // returns the full CallToolResult (incl. embedded resources) to the View.
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'resource', resource: { uri: 'ui://mcp-1/x' } }],
      structuredContent: { ok: true },
    });
    const svc = svcWithToolClient(callTool);
    const result = await svc.callMCPUITool('mcp-1', 'render', { id: 7 });
    expect(callTool).toHaveBeenCalledWith({
      name: 'render',
      arguments: { id: 7 },
    });
    expect(result).toEqual({
      content: [{ type: 'resource', resource: { uri: 'ui://mcp-1/x' } }],
      structuredContent: { ok: true },
    });
  });

  test('callMCPUITool rejects resolved remote failures without retaining text', async () => {
    const canary = 'remote-mcp-ui-result-canary';
    const svc = svcWithToolClient(
      vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: canary }],
      }),
    );
    await expect(svc.callMCPUITool('mcp-1', 'render')).rejects.toThrow(
      'MCP tool call failed',
    );
    expect(JSON.stringify(mockLogger)).not.toContain(canary);
  });

  test('callMCPUITool rejects when the server cannot be connected', async () => {
    connectMCPMock.mockRejectedValueOnce(new Error('spawn failed'));
    const svc = new MCPService(
      { loadIntegration: vi.fn().mockResolvedValue({ id: 'mcp-1' }) } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      mockLogger,
    );
    await expect(svc.callMCPUITool('mcp-1', 'render', {})).rejects.toThrow(
      'Tool server connection failed',
    );
  });

  test('callMCPUITool rejects model-only and cross-server names before dispatch', async () => {
    const callTool = vi.fn();
    const svc = svcWithMcpUiConnection({ callTool, readResource: vi.fn() }, [
      {
        name: 'mcp-1_model_only',
        originalName: 'model_only',
        serverId: 'mcp-1',
        _meta: { ui: { visibility: ['model'] } },
      },
    ]);

    await expect(svc.callMCPUITool('mcp-1', 'model_only', {})).rejects.toThrow(
      /not available/,
    );
    await expect(
      svc.callMCPUITool('mcp-1', 'other-server-tool', {}),
    ).rejects.toThrow(/not available/);
    expect(callTool).not.toHaveBeenCalled();
  });
});
