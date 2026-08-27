import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { loadOrCreateAgentRegistry } from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';

let providerEntries: Array<{
  builtin?: boolean;
  source: string;
  provider: any;
}> = [];

vi.mock('../../../telemetry/metrics.js', () => ({
  acpOps: { add: vi.fn() },
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  listProviders: (type: string) =>
    providerEntries.filter((entry) => entry.source.startsWith(type)),
}));

const { createACPRoutes } = await import('../acp.js');
const homes: string[] = [];

async function createFilesystemRuntimeContext() {
  const home = mkdtempSync(join(tmpdir(), 'station-acp-routes-'));
  homes.push(home);
  const configLoader = new ConfigLoader({ projectHomeDir: home });
  await loadOrCreateAgentRegistry(configLoader);
  const ctx = createMockRuntimeContext() as any;
  ctx.configLoader = configLoader;
  return { ctx, configLoader, home };
}

function createMockRuntimeContext() {
  const beginAgentConfigurationMutation = vi.fn();
  return {
    beginAgentConfigurationMutation,
    acpBridge: {
      getStatus: vi.fn().mockReturnValue({ connected: false, connections: [] }),
      addConnection: vi.fn().mockResolvedValue(undefined),
      removeConnection: vi.fn().mockResolvedValue(undefined),
    },
    configLoader: {
      loadACPConfig: vi.fn().mockResolvedValue({ connections: [] }),
      saveACPConfig: vi.fn().mockResolvedValue(undefined),
    },
    applyAgentConfigurationMutation: vi.fn(
      async <T>(operation: (beginMutation: () => void) => Promise<T>) =>
        operation(beginAgentConfigurationMutation),
    ),
  };
}

describe('ACP Routes', () => {
  beforeEach(() => {
    providerEntries = [];
  });

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('GET /status returns ACP status', async () => {
    const ctx = createMockRuntimeContext();
    const app = createACPRoutes(ctx as any);
    const body = await json(await app.request('/status'));
    expect(body.success).toBe(true);
    expect(body.data.connected).toBe(false);
  });

  test('rejects an invalid engine identity before any durable write', async () => {
    const ctx = createMockRuntimeContext();
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bad_id', command: 'bad' }),
    });

    expect(response.status).toBe(400);
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
    expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
  });

  test('GET /connections returns connection list', async () => {
    const ctx = createMockRuntimeContext();
    const app = createACPRoutes(ctx as any);
    const body = await json(await app.request('/connections'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('GET /registry returns ACP connection registry entries', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'kiro',
              name: 'Kiro CLI',
              command: 'kiro-cli',
              args: ['acp'],
            },
          ],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    const app = createACPRoutes(ctx as any);
    const body = await json(await app.request('/registry'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([
      {
        id: 'kiro',
        name: 'Kiro CLI',
        command: 'kiro-cli',
        args: ['acp'],
        source: 'core',
        sourceName: 'acpConnectionRegistry:core',
        installed: false,
      },
    ]);
  });

  test('GET /registry marks saved and plugin-provided connections as installed', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
            { id: 'cursor', name: 'Cursor', command: 'cursor' },
          ],
        },
      },
      {
        source: 'acpConnections:plugin',
        provider: {
          getConnections: () => [{ id: 'cursor', name: 'Cursor' }],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'kiro', name: 'Kiro', command: 'kiro-cli' }],
    });
    const app = createACPRoutes(ctx as any);
    const body = await json(await app.request('/registry'));
    expect(body.data).toEqual([
      expect.objectContaining({
        id: 'cursor',
        installed: true,
        installedSource: 'plugin',
      }),
      expect.objectContaining({
        id: 'kiro',
        installed: true,
        installedSource: 'user',
      }),
    ]);
  });

  test('GET /registry preserves saved config precedence when plugin connection uses same id', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
          ],
        },
      },
      {
        source: 'acpConnections:plugin',
        provider: {
          getConnections: () => [{ id: 'kiro', name: 'Plugin Kiro' }],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'kiro', name: 'User Kiro', command: 'kiro-cli' }],
    });
    const app = createACPRoutes(ctx as any);
    const body = await json(await app.request('/registry'));

    expect(body.data).toEqual([
      expect.objectContaining({
        id: 'kiro',
        installed: true,
        installedSource: 'user',
      }),
    ]);
  });

  test('POST /registry/:id/install saves an ACP registry entry as a user connection', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            {
              id: 'kiro',
              name: 'Kiro CLI',
              command: 'kiro-cli',
              args: ['acp'],
              icon: 'K',
            },
          ],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    const app = createACPRoutes(ctx as any);
    const body = await json(
      await app.request('/registry/kiro/install', { method: 'POST' }),
    );

    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: 'kiro',
      name: 'Kiro CLI',
      command: 'kiro-cli',
      args: ['acp'],
    });
    expect(ctx.configLoader.saveACPConfig).toHaveBeenCalledWith({
      connections: [
        expect.objectContaining({
          id: 'kiro',
          command: 'kiro-cli',
          args: ['acp'],
        }),
      ],
    });
    expect(ctx.acpBridge.addConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kiro' }),
    );
    expect(ctx.applyAgentConfigurationMutation).toHaveBeenCalledOnce();
  });

  test('POST /registry/:id/install returns 409 when connection already exists', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
          ],
        },
      },
    ];
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'kiro', command: 'kiro-cli' }],
    });
    const app = createACPRoutes(ctx as any);
    const res = await app.request('/registry/kiro/install', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  test('POST /registry/:id/install repairs a persisted config after registry commit failure', {
    timeout: 15_000,
  }, async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [
            { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' },
          ],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    const originalAgentExists = configLoader.agentExists.bind(configLoader);
    let failRegistryPreflight = true;
    configLoader.agentExists = async (slug: string) => {
      if (failRegistryPreflight) {
        failRegistryPreflight = false;
        throw new Error('simulated registry commit failure');
      }
      return originalAgentExists(slug);
    };
    const app = createACPRoutes(ctx);

    const first = await app.request('/registry/kiro/install', {
      method: 'POST',
    });
    const second = await app.request('/registry/kiro/install', {
      method: 'POST',
    });

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect((await configLoader.loadACPConfig()).connections).toHaveLength(1);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).defaultAgents,
    ).toContainEqual({
      id: 'kiro',
      kind: 'engine-connection',
      engineConnectionId: 'kiro',
    });
  });

  test('POST /connections creates connection', async () => {
    const ctx = createMockRuntimeContext();
    const app = createACPRoutes(ctx as any);
    const body = await json(
      await app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'test', command: 'kiro-cli', name: 'Test' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('test');
  });

  test('POST /connections retries identically after JSON normalization and registry commit failure', async () => {
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    const originalAgentExists = configLoader.agentExists.bind(configLoader);
    let failRegistryPreflight = true;
    configLoader.agentExists = async (slug: string) => {
      if (failRegistryPreflight) {
        failRegistryPreflight = false;
        throw new Error('simulated registry commit failure');
      }
      return originalAgentExists(slug);
    };
    const app = createACPRoutes(ctx);
    const request = () =>
      app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'kiro', command: 'kiro-cli' }),
      });

    const first = await request();
    const persistedAfterFailure = await configLoader.loadACPConfig();
    const listedAfterFailure = await json(await app.request('/connections'));
    const second = await request();

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(persistedAfterFailure.connections).toHaveLength(1);
    expect(listedAfterFailure.data).toEqual([]);
    expect(persistedAfterFailure.connections[0]).not.toHaveProperty('cwd');
    expect((await configLoader.loadACPConfig()).connections).toHaveLength(1);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).engineConnections,
    ).toContainEqual(
      expect.objectContaining({ id: 'kiro', source: { kind: 'user-acp' } }),
    );
  });

  test('POST /connections returns an activation-pending receipt after durable commit', async () => {
    const ctx = createMockRuntimeContext();
    ctx.applyAgentConfigurationMutation.mockImplementation(
      async (operation: any) => {
        const activation = { status: 'applied' as 'applied' | 'pending' };
        const result = await operation(
          ctx.beginAgentConfigurationMutation,
          activation,
        );
        activation.status = 'pending';
        Object.assign(activation, {
          reason:
            'Configuration was saved, but runtime activation is pending reconciliation.',
        });
        return result;
      },
    );
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test', command: 'kiro-cli' }),
    });

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      success: true,
      data: { id: 'test' },
      configurationActivation: { status: 'pending' },
    });
    expect(ctx.configLoader.saveACPConfig).toHaveBeenCalledOnce();
  });

  test('POST /connections returns 409 for duplicate', async () => {
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [{ id: 'test', command: 'x' }],
    });
    const app = createACPRoutes(ctx as any);
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test', command: 'kiro-cli' }),
    });
    expect(res.status).toBe(409);
    expect(ctx.beginAgentConfigurationMutation).not.toHaveBeenCalled();
  });

  test('serializes duplicate detection with concurrent ACP creation', async () => {
    const ctx = createMockRuntimeContext();
    let stored = { connections: [] as any[] };
    ctx.configLoader.loadACPConfig.mockImplementation(async () =>
      structuredClone(stored),
    );
    ctx.configLoader.saveACPConfig.mockImplementation(async (next) => {
      stored = structuredClone(next);
    });
    let mutationQueue = Promise.resolve();
    ctx.applyAgentConfigurationMutation.mockImplementation(
      <T>(operation: (beginMutation: () => void) => Promise<T>): Promise<T> => {
        const result = mutationQueue.then(() =>
          operation(ctx.beginAgentConfigurationMutation),
        );
        mutationQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    const app = createACPRoutes(ctx as any);
    const request = () =>
      app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'kiro', command: 'kiro-cli' }),
      });

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200,
    ]);
    expect(stored.connections).toHaveLength(1);
    expect(ctx.acpBridge.addConnection).toHaveBeenCalledTimes(2);
    expect(ctx.beginAgentConfigurationMutation).toHaveBeenCalledTimes(2);
  });

  test('DELETE /connections/:id returns 404 without beginning a mutation when absent', async () => {
    const ctx = createMockRuntimeContext();
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections/missing', {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(ctx.beginAgentConfigurationMutation).not.toHaveBeenCalled();
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
    expect(ctx.acpBridge.removeConnection).not.toHaveBeenCalled();
  });

  test('empty and same-value updates do not begin a mutation or restart the bridge', async () => {
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [
        { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      ],
    });
    const app = createACPRoutes(ctx as any);

    const empty = await app.request('/connections/kiro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const same = await app.request('/connections/kiro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Kiro' }),
    });

    expect(empty.status).toBe(200);
    expect(same.status).toBe(200);
    expect(ctx.beginAgentConfigurationMutation).not.toHaveBeenCalled();
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
    expect(ctx.acpBridge.removeConnection).not.toHaveBeenCalled();
    expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
  });

  test('does not mutate the live ACP connection when durable update fails', async () => {
    const ctx = createMockRuntimeContext();
    const previous = {
      id: 'kiro',
      name: 'Kiro',
      command: 'kiro-cli',
      enabled: true,
    };
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [previous],
    });
    ctx.configLoader.saveACPConfig.mockRejectedValue(new Error('write failed'));
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections/kiro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'kiro-cli-v2' }),
    });

    expect(response.status).toBe(500);
    expect(ctx.acpBridge.removeConnection).not.toHaveBeenCalled();
    expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
  });

  test('serializes ACP connection updates and deletion', async () => {
    const ctx = createMockRuntimeContext();
    let stored = {
      connections: [
        { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      ],
    };
    ctx.configLoader.loadACPConfig.mockImplementation(async () =>
      structuredClone(stored),
    );
    ctx.configLoader.saveACPConfig.mockImplementation(async (next) => {
      stored = structuredClone(next) as typeof stored;
    });
    const app = createACPRoutes(ctx as any);

    const update = await app.request('/connections/kiro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Kiro Updated' }),
    });
    const remove = await app.request('/connections/kiro', {
      method: 'DELETE',
    });

    expect(update.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(ctx.applyAgentConfigurationMutation).toHaveBeenCalledTimes(2);
    expect(ctx.acpBridge.removeConnection).toHaveBeenCalledTimes(2);
    expect(stored.connections).toEqual([]);
  });

  test('MCP passthrough (docs/design/connections-onboarding.md §5): PUT persists `provideToolServers`, off by default on create', async () => {
    const ctx = createMockRuntimeContext();
    let stored: {
      connections: Array<{
        id: string;
        name: string;
        command: string;
        enabled: boolean;
        provideToolServers?: string[];
      }>;
    } = {
      connections: [
        {
          id: 'opencode',
          name: 'OpenCode',
          command: 'opencode',
          enabled: true,
        },
      ],
    };
    ctx.configLoader.loadACPConfig.mockImplementation(async () =>
      structuredClone(stored),
    );
    ctx.configLoader.saveACPConfig.mockImplementation(async (next) => {
      stored = structuredClone(next) as typeof stored;
    });
    const app = createACPRoutes(ctx as any);

    // Create: no provideToolServers supplied ⇒ absent, never inferred.
    expect(stored.connections[0].provideToolServers).toBeUndefined();

    const update = await app.request('/connections/opencode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provideToolServers: ['filesystem'] }),
    });
    expect(update.status).toBe(200);
    expect(await json(update)).toMatchObject({
      success: true,
      data: { provideToolServers: ['filesystem'] },
    });
    expect(stored.connections[0].provideToolServers).toEqual(['filesystem']);

    // Explicitly clearing the selection turns passthrough back off.
    const cleared = await app.request('/connections/opencode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provideToolServers: [] }),
    });
    expect(cleared.status).toBe(200);
    expect(stored.connections[0].provideToolServers).toEqual([]);
  });

  test('MED-1 (repo review, 2026-07-26): PUT /connections/:id rejects a path-traversal provideToolServers id at the schema layer', async () => {
    const ctx = createMockRuntimeContext();
    ctx.configLoader.loadACPConfig.mockResolvedValue({
      connections: [
        {
          id: 'opencode',
          name: 'OpenCode',
          command: 'opencode',
          enabled: true,
        },
      ],
    });
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections/opencode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provideToolServers: ['../outside'] }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ success: false });
    expect(ctx.configLoader.saveACPConfig).not.toHaveBeenCalled();
  });
});
