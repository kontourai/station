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

const { createACPRoutes, listDetectedUnconnectedACPRegistryEntries } =
  await import('../acp.js');
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
      // `true` = the probe handshaked. The routes gate Agent materialization
      // on this, so the shared default is the success path and each gate test
      // overrides it explicitly.
      addConnection: vi.fn().mockResolvedValue(true),
      removeConnection: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn().mockResolvedValue(true),
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

  // station#1548: the first-run Engines chapter only offers registry entries
  // that are detected AND have no ACP connection. A connected ACP Engine
  // reports engineId 'acp' in listEngineConnectionStates, so exclusion must be
  // keyed on the ACP connection id (user config or plugin-provided), never on
  // the engine id.
  test('listDetectedUnconnectedACPRegistryEntries excludes connected and undetected entries', async () => {
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
              detected: true,
            },
            {
              id: 'opencode',
              name: 'OpenCode',
              command: 'opencode',
              detected: true,
            },
            { id: 'goose', name: 'Goose', command: 'goose', detected: false },
            { id: 'qwen', name: 'Qwen Code', command: 'qwen' },
          ],
        },
      },
      {
        source: 'acpConnections:plugin-a',
        provider: {
          getConnections: () => [
            { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [] },
          ],
        },
      },
    ];
    const configLoader = {
      loadACPConfig: async () => ({
        connections: [
          { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli', args: [] },
        ],
      }),
    };

    expect(
      await listDetectedUnconnectedACPRegistryEntries(configLoader as any),
    ).toEqual([]);

    configLoader.loadACPConfig = async () => ({ connections: [] });
    expect(
      await listDetectedUnconnectedACPRegistryEntries(configLoader as any),
    ).toEqual([{ id: 'kiro', name: 'Kiro CLI' }]);
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
            {
              id: 'kiro',
              name: 'Kiro CLI',
              command: 'kiro-cli',
              detected: true,
            },
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
    expect(first.status).toBe(500);
    // The saved config is not an installed Engine until the same registered
    // identity predicate GET /connections uses can prove it. This makes the
    // retryable partial write visible to first run again.
    expect(
      await listDetectedUnconnectedACPRegistryEntries(configLoader),
    ).toEqual([{ id: 'kiro', name: 'Kiro CLI' }]);
    // Add engine reads GET /registry and hides installed entries, so the
    // same predicate must keep the stranded entry visible there too.
    expect((await json(await app.request('/registry'))).data).toMatchObject([
      { id: 'kiro', installed: false },
    ]);
    const second = await app.request('/registry/kiro/install', {
      method: 'POST',
    });

    expect(second.status).toBe(200);
    expect(await json(second)).toMatchObject({
      agent: { created: true, data: { slug: 'kiro', name: 'Kiro CLI' } },
    });
    expect((await configLoader.loadACPConfig()).connections).toHaveLength(1);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).defaultAgents,
    ).toContainEqual({
      id: 'kiro',
      kind: 'engine-connection',
      engineConnectionId: 'kiro',
    });
  });

  test('POST /registry/:id/install returns one Agent receipt and is idempotent on a second confirm', async () => {
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
    const app = createACPRoutes(ctx);

    const first = await json(
      await app.request('/registry/kiro/install', { method: 'POST' }),
    );
    const second = await json(
      await app.request('/registry/kiro/install', { method: 'POST' }),
    );

    expect(first).toMatchObject({
      success: true,
      agent: { created: true, data: { slug: 'kiro', name: 'Kiro CLI' } },
    });
    expect(second).toMatchObject({
      success: true,
      agent: { created: false, data: { slug: 'kiro', name: 'Kiro CLI' } },
    });
    const registry = await loadOrCreateAgentRegistry(configLoader);
    expect(
      registry.defaultAgents.filter((agent) => agent.id === 'kiro'),
    ).toHaveLength(1);
  });

  test('POST /registry/:id/install names an adopted differently named Agent', async () => {
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
    // Adoption (selectEngineAgentAdoption) takes a differently named Agent
    // only when it carries engine-detection provenance for this engine; a
    // merely bound Agent is left alone and the engine's own id is created.
    await configLoader.createAgent({
      slug: 'my-kiro',
      name: 'My Kiro',
      prompt: '',
      execution: { agentConnectionId: 'kiro' },
      provenance: {
        origin: 'engine-detection',
        engineId: 'kiro',
        detectedAt: '2026-09-01T00:00:00.000Z',
      },
    } as any);

    const body = await json(
      await createACPRoutes(ctx).request('/registry/kiro/install', {
        method: 'POST',
      }),
    );

    expect(body).toMatchObject({
      success: true,
      agent: { created: false, data: { slug: 'my-kiro', name: 'My Kiro' } },
    });
  });

  test('POST /registry/:id/install stays 200 with a slug-only receipt when the Agent file is unreadable after commit', async () => {
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
    const originalLoadAgent = configLoader.loadAgent.bind(configLoader);
    let installed = false;
    configLoader.loadAgent = async (slug: string) => {
      if (installed && slug === 'kiro') {
        throw new Error('simulated unreadable agent file');
      }
      return originalLoadAgent(slug);
    };
    const app = createACPRoutes(ctx);
    const originalAddConnection = ctx.acpBridge.addConnection;
    ctx.acpBridge.addConnection = async (...args: unknown[]) => {
      installed = true;
      return originalAddConnection(...args);
    };

    const res = await app.request('/registry/kiro/install', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      success: true,
      agent: { created: true, data: { slug: 'kiro' } },
    });
  });

  // The engine cannot be onboarded (its probe did not handshake), so nothing
  // user-visible may be created: no Agent file, no registry identity, and no
  // `agent` receipt claiming one. The connection config itself stays —
  // retryable, and invisible to every installed surface until the identity
  // registers — and installing the same entry again after the engine works
  // is the recovery path that finally materializes the Agent.
  test('POST /registry/:id/install creates no Agent when the probe cannot onboard the engine', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [{ id: 'muse', name: 'Muse', command: 'muse' }],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    ctx.acpBridge.addConnection.mockResolvedValue(false);
    const app = createACPRoutes(ctx);

    const body = await json(
      await app.request('/registry/muse/install', { method: 'POST' }),
    );

    expect(body).toMatchObject({ success: true, data: { id: 'muse' } });
    expect(body.agent).toBeUndefined();
    expect(await configLoader.agentExists('muse')).toBe(false);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).engineConnections,
    ).toHaveLength(0);
    // The config entry is retryable, not silently swallowed.
    expect((await configLoader.loadACPConfig()).connections).toHaveLength(1);
    // And it does not count as installed while its identity is unregistered.
    expect((await json(await app.request('/registry'))).data).toMatchObject([
      { id: 'muse', installed: false },
    ]);
  });

  test('POST /registry/:id/install materializes the Agent once the engine can be onboarded', async () => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: {
          listAvailable: () => [{ id: 'muse', name: 'Muse', command: 'muse' }],
        },
      },
    ];
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    ctx.acpBridge.addConnection.mockResolvedValue(false);
    const app = createACPRoutes(ctx);
    await app.request('/registry/muse/install', { method: 'POST' });

    ctx.acpBridge.addConnection.mockResolvedValue(true);
    const body = await json(
      await app.request('/registry/muse/install', { method: 'POST' }),
    );

    expect(body).toMatchObject({
      success: true,
      agent: { created: true, data: { slug: 'muse', name: 'Muse' } },
    });
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).defaultAgents,
    ).toContainEqual({
      id: 'muse',
      kind: 'engine-connection',
      engineConnectionId: 'muse',
    });
  });

  test('POST /connections creates no Agent when the probe rejects', async () => {
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    ctx.acpBridge.addConnection.mockRejectedValue(
      new Error('spawn muse ENOENT'),
    );
    const app = createACPRoutes(ctx);

    const body = await json(
      await app.request('/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'muse', command: 'muse', name: 'Muse' }),
      }),
    );

    expect(body).toMatchObject({ success: true, data: { id: 'muse' } });
    expect(await configLoader.agentExists('muse')).toBe(false);
    expect(
      (await loadOrCreateAgentRegistry(configLoader)).engineConnections,
    ).toHaveLength(0);
  });

  test('POST /connections creates no Agent for a disabled connection', async () => {
    const { ctx, configLoader } = await createFilesystemRuntimeContext();
    const app = createACPRoutes(ctx);

    await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'muse',
        command: 'muse',
        name: 'Muse',
        enabled: false,
      }),
    });

    expect(ctx.acpBridge.addConnection).not.toHaveBeenCalled();
    expect(await configLoader.agentExists('muse')).toBe(false);
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

  test('POST /connections/:id/reconnect returns success on a completed handshake', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus.mockReturnValue({
      connected: true,
      connections: [{ id: 'kiro', name: 'Kiro', status: 'unavailable' }],
    });
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections/kiro/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ success: true });
    expect(ctx.acpBridge.reconnect).toHaveBeenCalledExactlyOnceWith('kiro');
  });

  // station#2253: a failed reconnect used to answer HTTP 200 with
  // `{ success: false }` and no `error` field, so the published CLI could
  // only print "Request failed with HTTP 200". The failure must be a non-2xx
  // with a bounded, sanitized diagnostic.
  test('POST /connections/:id/reconnect returns 502 with a sanitized diagnostic on a failed handshake', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus.mockReturnValue({
      connected: false,
      connections: [
        {
          id: 'kiro',
          name: 'Kiro',
          status: 'unavailable',
          lastError: {
            message:
              'spawn kiro-cli ENOENT: handshake failed for --api-key=abc123 from /Users/brian/private/project',
            phase: 'spawn',
          },
        },
      ],
    });
    ctx.acpBridge.reconnect.mockResolvedValue(false);
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections/kiro/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe('The ACP connection could not be reconnected.');
    expect(body.phase).toBe('spawn');
    // Secret-redacted and path-stripped: the raw credential shape and the
    // absolute path from the probe failure never reach the client.
    expect(body.detail).toContain('[REDACTED]');
    expect(body.detail).not.toContain('abc123');
    expect(body.detail).not.toContain('/Users/brian');
  });

  test('reconnect reports the new attempt error instead of the prior failure', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus
      .mockReturnValueOnce({
        connected: false,
        connections: [
          {
            id: 'opencode',
            lastError: { message: 'old failure', phase: 'spawn' },
          },
        ],
      })
      .mockReturnValue({
        connected: false,
        connections: [
          {
            id: 'opencode',
            lastError: {
              message: 'new initialize timeout',
              phase: 'initialize',
            },
          },
        ],
      });
    ctx.acpBridge.reconnect.mockResolvedValue(false);
    const response = await createACPRoutes(ctx as any).request(
      '/connections/opencode/reconnect',
      { method: 'POST' },
    );
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.detail).toBe('new initialize timeout');
    expect(body.phase).toBe('initialize');
    expect(JSON.stringify(body)).not.toContain('old failure');
  });

  test('POST /connections/:id/reconnect returns a standalone error when the failure carries no diagnostic', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus.mockReturnValue({
      connected: false,
      connections: [{ id: 'kiro', name: 'Kiro', status: 'probing' }],
    });
    ctx.acpBridge.reconnect.mockResolvedValue(false);
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections/kiro/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(502);
    expect(await json(response)).toEqual({
      success: false,
      error: 'The ACP connection could not be reconnected.',
    });
  });

  test('POST /connections/:id/reconnect returns 404 for a connection the bridge does not hold', async () => {
    const ctx = createMockRuntimeContext();
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections/missing/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Connection not found',
    });
    expect(ctx.acpBridge.reconnect).not.toHaveBeenCalled();
  });

  test('POST /connections/:id/reconnect answers 502 with a sanitized detail when the probe throws', async () => {
    const ctx = createMockRuntimeContext();
    ctx.acpBridge.getStatus.mockReturnValue({
      connected: false,
      connections: [{ id: 'muse', name: 'Muse', status: 'unavailable' }],
    });
    ctx.acpBridge.reconnect.mockRejectedValue(
      new Error('spawn muse ENOENT: Bearer sk-test1234 leaked in stderr'),
    );
    const app = createACPRoutes(ctx as any);

    const response = await app.request('/connections/muse/reconnect', {
      method: 'POST',
    });

    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe('The ACP connection could not be reconnected.');
    expect(body.detail).toContain('[REDACTED]');
    expect(body.detail).not.toContain('sk-test1234');
  });
});
