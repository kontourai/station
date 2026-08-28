import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import {
  loadIntegrationConfig,
  saveIntegrationConfig,
} from '../../../domain/config-loader-storage.js';
import { rebuildOrClearRuntimeProjections } from '../../../runtime/bootstrap/runtime-projection-recovery.js';

// Spread the real module rather than enumerating instruments by hand: this
// list grew to 14 and still went stale when the route recorded
// `toolDefinitionOps`, failing three tests with an assertion message that
// named the mock nowhere (archive#3112).
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  toolCalls: { add: vi.fn() },
  integrationIconAssetReads: { add: vi.fn() },
  mcpUiResolveTotal: { add: vi.fn() },
  mcpUiResourceReadTotal: { add: vi.fn() },
  mcpUiToolCallTotal: { add: vi.fn() },
  mcpUiToolCallRequestOpened: { add: vi.fn() },
  mcpUiToolCallRequestResolved: { add: vi.fn() },
  mcpUiRenderPermissionChecks: { add: vi.fn() },
  mcpUiRenderPermissionRevokes: { add: vi.fn() },
  mcpUiRenderPermissionAllows: { add: vi.fn() },
  toolServerLifecycle: { add: vi.fn() },
  toolServerOAuth: { add: vi.fn() },
  toolServerProbes: { add: vi.fn() },
  toolServerCredentialWrites: { add: vi.fn() },
}));

const { createToolRoutes } = await import('../tools.js');
const { mcpUiToolCallRequestResolved } = await import(
  '../../../telemetry/metrics.js'
);
const { MCPService } = await import('../../../services/plugins/mcp-service.js');
const { MCPAppsToolAccessError } = await import(
  '../../../runtime/mcp/mcp-apps-metadata.js'
);

function createMockMCPService() {
  return {
    listIntegrations: vi
      .fn()
      .mockResolvedValue([{ id: 'mcp-1', name: 'Test MCP' }]),
    getToolAgentMap: vi.fn().mockResolvedValue({ 'mcp-1': ['default'] }),
    getConnectionStatus: vi.fn().mockReturnValue({ connected: true }),
    saveIntegration: vi.fn().mockResolvedValue(undefined),
    getIntegration: vi
      .fn()
      .mockResolvedValue({ id: 'mcp-1', name: 'Test MCP', type: 'stdio' }),
    deleteIntegration: vi.fn().mockResolvedValue(undefined),
    resetRuntimeState: vi
      .fn()
      .mockResolvedValue({ rebuilt: false, scope: 'integration' }),
    setEnabled: vi
      .fn()
      .mockResolvedValue({ id: 'mcp-1', kind: 'mcp', enabled: false }),
    applyDisabledTools: vi.fn().mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      disabledTools: ['mcp-1_write'],
    }),
    probeIntegration: vi.fn().mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      enabled: true,
      probe: {
        ok: true,
        toolCount: 1,
        checkedAt: '2026-08-14T00:00:00.000Z',
      },
    }),
    getMCPToolCatalog: vi.fn().mockResolvedValue([
      {
        name: 'mcp-1_render',
        originalName: 'render',
        serverId: 'mcp-1',
        _meta: { ui: { resourceUri: 'ui://mcp-1/render.html' } },
      },
    ]),
    getMCPUIToolCatalog: vi.fn().mockResolvedValue({
      available: false,
    }),
    readMCPUIResource: vi.fn().mockResolvedValue({
      uri: 'ui://mcp-1/render.html',
      mimeType: 'text/html',
      text: '<h1>panel</h1>',
    }),
    callMCPUITool: vi.fn().mockResolvedValue({ content: [{ type: 'text' }] }),
    readMCPUIResourceFromTool: vi.fn().mockResolvedValue({
      uri: 'ui://mcp-1/render',
      mimeType: 'text/html;profile=mcp-app',
      text: '<main>embedded</main>',
    }),
  };
}

function enableReadOnlyInitialResult(
  service: ReturnType<typeof createMockMCPService>,
) {
  service.getMCPUIToolCatalog.mockResolvedValue({
    available: true,
    tools: [
      {
        name: 'mcp-1_render',
        toolName: 'mcp-1_render',
        originalName: 'render',
        annotations: { readOnlyHint: true },
      },
    ],
  });
}

describe('Tool Routes', () => {
  test('serves only a resolver-approved local icon with private caching and nosniff', async () => {
    const asset = {
      body: Buffer.from('png'),
      contentType: 'image/png' as const,
      etag: '"asset"',
    };
    const app = createToolRoutes(createMockMCPService() as any, vi.fn(), {
      integrationIconAssets: {
        resolve: vi.fn().mockResolvedValue({ status: 'found', asset }),
      },
    });
    const response = await app.request('/local/icon');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('etag')).toBe('"asset"');
    const cached = await app.request('/local/icon', {
      headers: { 'if-none-match': '"asset"' },
    });
    expect(cached.status).toBe(304);
  });

  test('does not serve a missing or invalid icon', async () => {
    const app = createToolRoutes(createMockMCPService() as any, vi.fn(), {
      integrationIconAssets: {
        resolve: vi.fn().mockResolvedValue({ status: 'invalid' }),
      },
    });
    const response = await app.request('/../../etc/icon');
    expect(response.status).toBe(404);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('GET / lists tools with agent usage', async () => {
    const app = createToolRoutes(createMockMCPService() as any, vi.fn());
    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.data[0].usedBy).toEqual(['default']);
  });

  test('POST / saves integration', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const body = await json(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'new', name: 'New', type: 'stdio' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(svc.saveIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new', enabled: false }),
    );
  });

  test('POST / strips caller-supplied service-owned probe state', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'new',
        kind: 'mcp',
        probe: {
          ok: false,
          error: 'caller-controlled text',
          toolCount: 0,
          checkedAt: '2026-08-15T00:00:00.000Z',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(svc.saveIntegration.mock.calls[0]?.[0]).not.toHaveProperty('probe');
  });

  test('POST / converts submitted env material to the write-only secret channel', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'secure',
        kind: 'mcp',
        env: { API_TOKEN: 'write-boundary-canary' },
      }),
    });
    expect(svc.saveIntegration).toHaveBeenCalledWith({
      id: 'secure',
      kind: 'mcp',
      secretEnv: { API_TOKEN: 'write-boundary-canary' },
      enabled: false,
    });
    expect(svc.saveIntegration.mock.calls[0]?.[0]).not.toHaveProperty('env');
  });

  test('POST / persists a new integration disabled and reloads it disabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-new-disabled-'));
    try {
      const svc = createMockMCPService();
      svc.saveIntegration.mockImplementation((def) =>
        saveIntegrationConfig(home, def.id, def),
      );
      const app = createToolRoutes(svc as any, vi.fn());
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'new', name: 'New', type: 'stdio' }),
      });

      const bytes = await readFile(
        join(home, 'integrations', 'new', 'integration.json'),
        'utf8',
      );
      expect(bytes).toContain('"enabled": false');
      expect((await loadIntegrationConfig(home, 'new')).enabled).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('real create route and canonical loader persist an OAuth authorization projection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-oauth-create-route-'));
    try {
      const loader = new ConfigLoader({ projectHomeDir: home });
      const svc = new MCPService(
        loader,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        { warn: vi.fn() },
      );
      const app = createToolRoutes(svc, vi.fn());
      const response = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'oauth-server',
          kind: 'mcp',
          transport: 'streamable-http',
          endpoint: 'https://resource.example/mcp',
        }),
      });
      const responseBody = await response.clone().json();
      expect(response.status, JSON.stringify(responseBody)).toBe(200);

      const created = await loader.loadIntegration('oauth-server');
      await svc.saveIntegration({
        ...created,
        probe: {
          ok: false,
          toolCount: 0,
          checkedAt: '2026-08-15T00:00:00.000Z',
          authorization: { state: 'awaiting-operator-consent' },
        },
      });

      await expect(
        loader.loadIntegration('oauth-server'),
      ).resolves.toMatchObject({
        enabled: false,
        transport: 'streamable-http',
        probe: {
          authorization: { state: 'awaiting-operator-consent' },
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('applies multiple per-tool changes through one atomic service call', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const response = await app.request('/mcp-1/tools/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabledTools: ['mcp-1_write', 'mcp-1_delete'] }),
    });
    expect(response.status).toBe(200);
    expect(svc.applyDisabledTools).toHaveBeenCalledTimes(1);
    expect(svc.applyDisabledTools).toHaveBeenCalledWith('mcp-1', [
      'mcp-1_write',
      'mcp-1_delete',
    ]);
  });

  test('reinitializes delivery when a server is disabled', async () => {
    const svc = createMockMCPService();
    const reinitialize = vi.fn();
    const app = createToolRoutes(svc as any, reinitialize);
    const response = await app.request('/mcp-1/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(200);
    expect(svc.setEnabled).toHaveBeenCalledWith('mcp-1', false);
    expect(reinitialize).toHaveBeenCalledTimes(1);
  });

  test.each([
    { label: 'enable', enabled: true },
    { label: 'disable', enabled: false },
  ])(
    'rolls back persisted $label when runtime activation fails',
    async ({ enabled }) => {
      const svc = createMockMCPService();
      let stored = { id: 'mcp-1', kind: 'mcp', enabled: !enabled };
      svc.getIntegration.mockImplementation(async () => ({ ...stored }));
      svc.setEnabled.mockImplementation(async (_id: string, next: boolean) => {
        stored = { ...stored, enabled: next };
        return { ...stored };
      });
      svc.saveIntegration.mockImplementation(async (def: typeof stored) => {
        stored = { ...def };
      });
      const reinitialize = vi
        .fn()
        .mockRejectedValueOnce(new Error('injected activation failure'))
        .mockResolvedValueOnce(undefined);
      const app = createToolRoutes(svc as any, reinitialize);
      const response = await app.request('/mcp-1/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(body.error).toContain('Change was not applied');
      expect(stored.enabled).toBe(!enabled);
      expect(reinitialize).toHaveBeenCalledTimes(2);
    },
  );

  test('rolls back Apply when runtime activation fails', async () => {
    const svc = createMockMCPService();
    let stored = { id: 'mcp-1', kind: 'mcp', disabledTools: ['before'] };
    svc.getIntegration.mockImplementation(async () => ({ ...stored }));
    svc.applyDisabledTools.mockImplementation(
      async (_id: string, next: string[]) => {
        stored = { ...stored, disabledTools: [...next] };
        return { ...stored };
      },
    );
    svc.saveIntegration.mockImplementation(async (def: typeof stored) => {
      stored = { ...def, disabledTools: [...def.disabledTools] };
    });
    const reinitialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('injected apply activation failure'))
      .mockResolvedValueOnce(undefined);
    const app = createToolRoutes(svc as any, reinitialize);
    const response = await app.request('/mcp-1/tools/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabledTools: ['after'] }),
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body.error).toContain('Change was not applied');
    expect(stored.disabledTools).toEqual(['before']);
  });

  test('reports persisted-but-not-live state when rollback persistence fails', async () => {
    const svc = createMockMCPService();
    let stored = { id: 'mcp-1', kind: 'mcp', enabled: false };
    svc.getIntegration.mockImplementation(async () => ({ ...stored }));
    svc.setEnabled.mockImplementation(async () => {
      stored = { ...stored, enabled: true };
      return { ...stored };
    });
    svc.saveIntegration.mockRejectedValueOnce(
      new Error('injected rollback failure'),
    );
    const app = createToolRoutes(
      svc as any,
      vi.fn().mockRejectedValue(new Error('injected activation failure')),
    );
    const response = await app.request('/mcp-1/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const body = await json(response);

    expect(response.status).toBe(202);
    expect(body.success).toBe(true);
    expect(body).not.toHaveProperty('error');
    expect(body.data.enabled).toBe(true);
    expect(body.data.live).toBe(false);
    expect(body.data.restartRequired).toBe(true);
    expect(body.data.restartRequiredScope).toBe('integration');
    expect(svc.resetRuntimeState).toHaveBeenCalledOnce();
  });

  test('unrelated agents survive double failure when the persisted runtime rebuild succeeds', async () => {
    const stored = { id: 'mcp-1', kind: 'mcp', enabled: false } as const;
    const configLoader = {
      loadIntegration: vi.fn().mockResolvedValue(stored),
      saveIntegration: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('injected reconciliation failure')),
    };
    const globalToolRegistry = new Map([
      ['failed_tool', { name: 'failed_tool' }],
    ]);
    const toolNameReverseMapping = new Map([['failed_tool', 'failed_tool']]);
    const activeAgents = new Map([['agent-1', { tools: ['failed_tool'] }]]);
    const svc = new MCPService(
      configLoader as any,
      new Map(),
      new Map(),
      new Map(),
      new Map([['agent-1', [{ name: 'failed_tool' }]]]),
      new Map(),
      { warn: vi.fn() },
      (resetIntegrationState) =>
        rebuildOrClearRuntimeProjections(
          async () => {
            resetIntegrationState();
            globalToolRegistry.set('ordinary_tool', { name: 'ordinary_tool' });
            activeAgents.set('ordinary-agent', { tools: ['ordinary_tool'] });
          },
          () => {
            globalToolRegistry.clear();
            toolNameReverseMapping.clear();
            activeAgents.clear();
          },
        ),
    );
    const app = createToolRoutes(
      svc,
      vi.fn().mockRejectedValue(new Error('injected late activation failure')),
    );

    const response = await app.request('/mcp-1/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(202);
    const body = await json(response);
    expect(globalToolRegistry.has('ordinary_tool')).toBe(true);
    expect(activeAgents.has('ordinary-agent')).toBe(true);
    expect(body.data.live).toBe(true);
    expect(body.data.restartRequired).toBe(false);
    expect(body.data).not.toHaveProperty('restartRequiredScope');
    expect(svc.getAgentTools('agent-1')).toEqual([]);
  });

  test('reports runtime-scoped restartRequired when the full rebuild also fails', async () => {
    const svc = createMockMCPService();
    svc.setEnabled.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      enabled: true,
    });
    svc.saveIntegration.mockRejectedValueOnce(
      new Error('injected reconciliation failure'),
    );
    svc.resetRuntimeState.mockResolvedValue({
      rebuilt: false,
      scope: 'runtime',
    });
    const app = createToolRoutes(
      svc as any,
      vi.fn().mockRejectedValue(new Error('injected activation failure')),
    );
    const response = await app.request('/mcp-1/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const body = await json(response);

    expect(response.status).toBe(202);
    expect(body.data.live).toBe(false);
    expect(body.data.restartRequired).toBe(true);
    expect(body.data.restartRequiredScope).toBe('runtime');
  });

  test('GET /:id returns integration metadata without secret env values', async () => {
    const svc = createMockMCPService();
    svc.getIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'example-mcp',
      env: { API_TOKEN: 'secret-value' },
      secretEnvRefs: { API_TOKEN: 'github-token' },
    });
    const app = createToolRoutes(svc as any, vi.fn());
    const body = await json(await app.request('/mcp-1'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'example-mcp',
      // CI-R7: server-derived built-in marker; false for a user-added server.
      builtin: false,
      secretEnvKeys: ['API_TOKEN'],
      requiresEnvSecrets: true,
    });
    expect(body.data).not.toHaveProperty('env');
    expect(body.data).not.toHaveProperty('secretEnvBindingIds');
  });

  test('saving a secret then fetching the integration never returns its material', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-tool-secret-route-'));
    try {
      const svc = createMockMCPService();
      svc.saveIntegration.mockImplementation((def) =>
        saveIntegrationConfig(home, def.id, def),
      );
      svc.getIntegration.mockImplementation((id) =>
        loadIntegrationConfig(home, id),
      );
      const app = createToolRoutes(svc as any, vi.fn());
      const secret = 'route-canary-secret-material';
      expect(
        (
          await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: 'secure',
              kind: 'mcp',
              env: { API_TOKEN: secret },
            }),
          })
        ).status,
      ).toBe(200);
      const disk = await readFile(
        join(home, 'integrations', 'secure', 'integration.json'),
        'utf8',
      );
      expect(disk).not.toContain(secret);
      expect(disk).toContain('storedEnvNames');
      const response = await app.request('/secure');
      const payload = await response.text();
      expect(payload).not.toContain(secret);
      expect(JSON.parse(payload).data).not.toHaveProperty('storedEnvNames');
      expect(JSON.parse(payload).data.secretEnvKeys).toEqual(['API_TOKEN']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('public input cannot persist a client-supplied credential ref', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-tool-ref-route-'));
    try {
      const svc = createMockMCPService();
      svc.saveIntegration.mockImplementation((def) =>
        saveIntegrationConfig(home, def.id, def),
      );
      const app = createToolRoutes(svc as any, vi.fn());
      const response = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'attacker',
          kind: 'mcp',
          storedEnvNames: ['STOLEN'],
        }),
      });
      expect(response.status).toBe(200);
      expect(
        await readFile(
          join(home, 'integrations', 'attacker', 'integration.json'),
          'utf8',
        ),
      ).not.toContain('victim:TOKEN');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('PUT /:id preserves stored secrets when a redacted edit omits env', async () => {
    const svc = createMockMCPService();
    svc.getIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'example-mcp',
      description: 'Before',
      env: { API_TOKEN: 'secret-value' },
    });
    const app = createToolRoutes(svc as any, vi.fn());
    const response = await app.request('/mcp-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'After' }),
    });

    expect(response.status).toBe(200);
    expect(svc.saveIntegration).toHaveBeenCalledWith({
      id: 'mcp-1',
      kind: 'mcp',
      transport: 'stdio',
      command: 'example-mcp',
      description: 'After',
      env: { API_TOKEN: 'secret-value' },
    });
  });

  test('PUT /:id ignores caller probe replacement and preserves service-owned state', async () => {
    const svc = createMockMCPService();
    const serviceProbe = {
      ok: true,
      toolCount: 2,
      checkedAt: '2026-08-15T01:00:00.000Z',
      authorization: { state: 'authorized' },
    };
    svc.getIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      description: 'Before',
      probe: serviceProbe,
    });
    const app = createToolRoutes(svc as any, vi.fn());
    const response = await app.request('/mcp-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'After',
        probe: {
          ok: false,
          error: 'caller-controlled text',
          toolCount: 0,
          checkedAt: '2026-08-15T02:00:00.000Z',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(svc.saveIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'After',
        probe: serviceProbe,
      }),
    );
  });

  test('GET and unrelated PUT preserve a legacy omitted enabled field until explicitly set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-legacy-enabled-'));
    try {
      const dir = join(home, 'integrations', 'mcp-1');
      const path = join(dir, 'integration.json');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ id: 'mcp-1', kind: 'mcp', description: 'before' }),
      );
      const svc = createMockMCPService();
      svc.getIntegration.mockImplementation(() =>
        loadIntegrationConfig(home, 'mcp-1'),
      );
      svc.saveIntegration.mockImplementation((def) =>
        saveIntegrationConfig(home, 'mcp-1', def),
      );
      const app = createToolRoutes(svc as any, vi.fn());

      expect((await json(await app.request('/mcp-1'))).data.enabled).toBe(true);
      await app.request('/mcp-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'changed' }),
      });
      expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty(
        'enabled',
      );

      await app.request('/mcp-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(JSON.parse(await readFile(path, 'utf8')).enabled).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('PUT /:id upserts submitted secrets and preserves untouched keys', async () => {
    const svc = createMockMCPService();
    svc.getIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      env: { API_TOKEN: 'old-secret', UNTOUCHED: 'keep-me' },
    });
    const app = createToolRoutes(svc as any, vi.fn());
    await app.request('/mcp-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: { API_TOKEN: 'replacement-secret' } }),
    });

    expect(svc.saveIntegration).toHaveBeenCalledWith({
      id: 'mcp-1',
      kind: 'mcp',
      secretEnv: { API_TOKEN: 'replacement-secret' },
    });
  });

  test('PUT /:id treats an explicit empty env object as a no-op', async () => {
    const svc = createMockMCPService();
    svc.getIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      env: { API_TOKEN: 'old-secret' },
    });
    const app = createToolRoutes(svc as any, vi.fn());
    await app.request('/mcp-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: {} }),
    });

    expect(svc.saveIntegration).toHaveBeenCalledWith({
      id: 'mcp-1',
      kind: 'mcp',
      secretEnv: {},
    });
  });

  test('PUT /:id removes only explicitly named secret keys', async () => {
    const svc = createMockMCPService();
    svc.getIntegration.mockResolvedValue({
      id: 'mcp-1',
      kind: 'mcp',
      env: { TOKEN_A: 'a', TOKEN_B: 'b' },
    });
    const app = createToolRoutes(svc as any, vi.fn());
    await app.request('/mcp-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeSecretEnvKeys: ['TOKEN_A'] }),
    });
    expect(svc.saveIntegration).toHaveBeenCalledWith({
      id: 'mcp-1',
      kind: 'mcp',
      env: { TOKEN_A: 'a', TOKEN_B: 'b' },
      removeSecretEnvKeys: ['TOKEN_A'],
    });
  });

  test('GET /:serverId/ui/:toolName resolves MCP UI metadata', async () => {
    const app = createToolRoutes(createMockMCPService() as any, vi.fn());
    const body = await json(await app.request('/mcp-1/ui/render'));
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      status: 'success',
      ref: 'mcp-1/render',
      resourceUri: 'ui://mcp-1/render.html',
    });
  });

  test('GET /:serverId/ui/:toolName/resource reads the resolved resource content', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/render/resource');
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      mimeType: 'text/html',
      text: '<h1>panel</h1>',
    });
    // The client never supplies a URI; the route reads only the resolved one.
    expect(svc.readMCPUIResource).toHaveBeenCalledWith(
      'mcp-1',
      'ui://mcp-1/render.html',
    );
  });

  test('GET /:serverId/ui/:toolName/resource 404s when the UI resource is unresolvable', async () => {
    const svc = createMockMCPService();
    svc.getMCPToolCatalog.mockResolvedValue([
      { name: 'mcp-1_render', originalName: 'render', serverId: 'mcp-1' },
    ]);
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/render/resource');
    const body = await json(res);
    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.status).toBe('missing_resource');
    expect(svc.readMCPUIResource).not.toHaveBeenCalled();
  });

  test('GET /:serverId/ui/:toolName/embedded extracts the mcp-ui.dev embedded resource', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/render/embedded');
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.text).toContain('embedded');
    // Pinned to the server+tool; no client-supplied args.
    expect(svc.readMCPUIResourceFromTool).toHaveBeenCalledWith(
      'mcp-1',
      'render',
    );
  });

  test('GET /:serverId/ui/:toolName/embedded 502s when no embedded UI is returned', async () => {
    const svc = createMockMCPService();
    svc.readMCPUIResourceFromTool = vi
      .fn()
      .mockRejectedValue(
        new Error('MCP tool returned no embedded UI resource'),
      );
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/render/embedded');
    expect(res.status).toBe(502);
  });

  test('POST /:serverId/ui/call proxies a UI tool call to the pinned server', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', arguments: { id: 1 } }),
    });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(svc.callMCPUITool).toHaveBeenCalledWith('mcp-1', 'render', {
      id: 1,
    });
  });

  test('POST /:serverId/ui/call rejects a missing tool name', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(res.status).toBe(400);
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
  });

  test('POST /:serverId/ui/call returns 403 when Apps visibility rejects the tool', async () => {
    const svc = createMockMCPService();
    svc.callMCPUITool.mockRejectedValue(
      new MCPAppsToolAccessError('mcp-1', 'model-only'),
    );
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'model-only', arguments: {} }),
    });
    expect(res.status).toBe(403);
  });

  test('GET /:serverId/ui/:toolName reports missing MCP UI resource', async () => {
    const svc = createMockMCPService();
    svc.getMCPToolCatalog.mockResolvedValue([
      {
        name: 'mcp-1_render',
        originalName: 'render',
        serverId: 'mcp-1',
      },
    ]);
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/render');
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('missing_resource');
  });

  test('POST /:serverId/ui/call denies read-only components without calling the tool', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', approvalPolicy: 'read-only' }),
    });
    expect(res.status).toBe(403);
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
  });

  test("POST /:serverId/ui/call blocks on the inbox approval for 'require' and runs once approved", async () => {
    const svc = createMockMCPService();
    const registerForOutcome = vi.fn().mockResolvedValue('approved');
    const app = createToolRoutes(svc as any, vi.fn(), {
      approvalRegistry: { registerForOutcome },
    });
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'render',
        arguments: { id: 1 },
        approvalPolicy: 'require',
      }),
    });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(registerForOutcome).toHaveBeenCalledTimes(1);
    expect(svc.callMCPUITool).toHaveBeenCalledWith('mcp-1', 'render', {
      id: 1,
    });
  });

  test("POST /:serverId/ui/call returns an error and does NOT run the tool when a 'require' approval is denied", async () => {
    const svc = createMockMCPService();
    const registerForOutcome = vi.fn().mockResolvedValue('denied');
    const app = createToolRoutes(svc as any, vi.fn(), {
      approvalRegistry: { registerForOutcome },
    });
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', approvalPolicy: 'require' }),
    });
    const body = await json(res);
    expect(res.status).toBe(403);
    expect(registerForOutcome).toHaveBeenCalledTimes(1);
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
    // Someone answered and said no: the message must say so, and must not
    // hedge that it might instead have gone unanswered (archive#3158).
    expect(body.error).toContain('denied in the approval inbox');
    expect(body.error).not.toMatch(/expired|never answered|timed out/);
  });

  test("POST /:serverId/ui/call says a 'require' approval expired unanswered, never that it was denied", async () => {
    const svc = createMockMCPService();
    const registerForOutcome = vi.fn().mockResolvedValue('expired');
    const app = createToolRoutes(svc as any, vi.fn(), {
      approvalRegistry: { registerForOutcome },
    });
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', approvalPolicy: 'require' }),
    });
    const body = await json(res);
    expect(res.status).toBe(403);
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
    expect(body.error).toContain('never answered');
    expect(body.error).toContain('expired');
    // Nobody rejected this call, so nothing in the message may claim they did.
    expect(body.error).not.toContain('denied');
  });

  test("POST /:serverId/ui/call says a 'require' approval was cancelled before anyone answered", async () => {
    const svc = createMockMCPService();
    const registerForOutcome = vi.fn().mockResolvedValue('cancelled');
    const app = createToolRoutes(svc as any, vi.fn(), {
      approvalRegistry: { registerForOutcome },
    });
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', approvalPolicy: 'require' }),
    });
    const body = await json(res);
    expect(res.status).toBe(403);
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
    expect(body.error).toContain('cancelled');
    expect(body.error).not.toMatch(/denied|expired/);
  });

  test("POST /:serverId/ui/call says a 'require' approval was never opened when the registry refuses an unbound request", async () => {
    const svc = createMockMCPService();
    const registerForOutcome = vi.fn().mockResolvedValue('unbound');
    const app = createToolRoutes(svc as any, vi.fn(), {
      approvalRegistry: { registerForOutcome },
    });
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', approvalPolicy: 'require' }),
    });
    const body = await json(res);
    expect(res.status).toBe(403);
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
    expect(body.error).toContain('could not be sent for approval');
    expect(body.error).not.toMatch(/denied|expired|cancelled/);
  });

  test('POST /:serverId/ui/call records the resolved approval outcome, not an approved/denied collapse', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn(), {
      approvalRegistry: {
        registerForOutcome: vi.fn().mockResolvedValue('expired'),
      },
    });
    vi.mocked(mcpUiToolCallRequestResolved.add).mockClear();
    await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', approvalPolicy: 'require' }),
    });
    expect(vi.mocked(mcpUiToolCallRequestResolved.add)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ tool: 'render', decision: 'expired' }),
    );
  });

  test('POST /:serverId/ui/call stays direct (no approval) when no approvalPolicy is given', async () => {
    const svc = createMockMCPService();
    const registerForOutcome = vi.fn().mockResolvedValue('approved');
    const app = createToolRoutes(svc as any, vi.fn(), {
      approvalRegistry: { registerForOutcome },
    });
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', arguments: {} }),
    });
    expect(res.status).toBe(200);
    expect(registerForOutcome).not.toHaveBeenCalled();
    expect(svc.callMCPUITool).toHaveBeenCalled();
  });

  test('POST initial-result calls only the fixed read-only tool with descriptor arguments', async () => {
    const svc = createMockMCPService();
    enableReadOnlyInitialResult(svc);
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/render/initial-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: { scope: 'answer', turnId: 'turn-a' },
      }),
    });
    expect(res.status).toBe(200);
    expect(svc.callMCPUITool).toHaveBeenCalledWith('mcp-1', 'render', {
      scope: 'answer',
      turnId: 'turn-a',
    });
  });

  test('POST initial-result prefers the exact Request-authorized host reader over app-visible MCP dispatch', async () => {
    const svc = createMockMCPService();
    enableReadOnlyInitialResult(svc);
    const readInitialMcpAppResult = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'authorized' }],
      structuredContent: { projection: true },
    });
    const app = createToolRoutes(svc as any, vi.fn(), {
      readInitialMcpAppResult,
    });
    const res = await app.request('/mcp-1/ui/render/initial-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: { scope: 'answer' } }),
    });
    expect(res.status).toBe(200);
    expect(readInitialMcpAppResult).toHaveBeenCalledWith({
      serverId: 'mcp-1',
      toolName: 'render',
      arguments: { scope: 'answer' },
      request: expect.any(Request),
    });
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
  });

  test.each([
    ['array arguments', { arguments: [] }],
    ['scalar arguments', { arguments: 'answer' }],
    ['body-selected tool', { tool: 'other', arguments: {} }],
    ['body-selected tenant', { tenantId: 'other', arguments: {} }],
  ])(
    'POST initial-result rejects %s without dispatch',
    async (_label, body) => {
      const svc = createMockMCPService();
      const app = createToolRoutes(svc as any, vi.fn());
      const res = await app.request('/mcp-1/ui/render/initial-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(svc.callMCPUITool).not.toHaveBeenCalled();
    },
  );

  test('POST initial-result rejects malformed JSON without dispatch', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/render/initial-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
  });

  test('POST initial-result respects render revocation before catalog or dispatch', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn(), {
      isRenderRevoked: () => true,
    });
    const res = await app.request('/mcp-1/ui/render/initial-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(res.status).toBe(403);
    expect(svc.getMCPUIToolCatalog).not.toHaveBeenCalled();
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
  });

  test('POST initial-result refuses non-read-only tools', async () => {
    const svc = createMockMCPService();
    svc.getMCPUIToolCatalog.mockResolvedValue({
      available: true,
      tools: [
        {
          originalName: 'render',
          annotations: { readOnlyHint: false },
        },
      ],
    });
    const app = createToolRoutes(svc as any, vi.fn());
    const res = await app.request('/mcp-1/ui/render/initial-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(res.status).toBe(404);
    expect(svc.callMCPUITool).not.toHaveBeenCalled();
  });

  test('POST initial-result caps results and never leaks downstream errors', async () => {
    const svc = createMockMCPService();
    enableReadOnlyInitialResult(svc);
    svc.callMCPUITool.mockResolvedValueOnce({ text: 'x'.repeat(129 * 1024) });
    const app = createToolRoutes(svc as any, vi.fn());
    const oversized = await app.request('/mcp-1/ui/render/initial-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(oversized.status).toBe(503);
    expect(await json(oversized)).toEqual({
      success: false,
      error: 'Initial result unavailable',
    });

    svc.callMCPUITool.mockRejectedValueOnce(
      new Error('tenant-secret/session-secret'),
    );
    const failed = await app.request('/mcp-1/ui/render/initial-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await json(failed))).not.toMatch(
      /tenant-secret|session-secret/,
    );
  });

  test('POST /:serverId/ui/call attaches a Flow-evidence receipt for an approved call with a threadId', async () => {
    const svc = createMockMCPService();
    const attachMcpUiEvidence = vi.fn().mockResolvedValue(undefined);
    const app = createToolRoutes(svc as any, vi.fn(), {
      approvalRegistry: {
        registerForOutcome: vi.fn().mockResolvedValue('approved'),
      },
      attachMcpUiEvidence,
    });
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'render',
        arguments: { id: 2 },
        approvalPolicy: 'require',
        threadId: 'thread-7',
      }),
    });
    expect(res.status).toBe(200);
    expect(attachMcpUiEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-7',
        serverId: 'mcp-1',
        toolName: 'render',
      }),
    );
  });

  test('POST /:serverId/ui/call still succeeds when evidence attachment throws (non-blocking)', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn(), {
      attachMcpUiEvidence: vi.fn().mockRejectedValue(new Error('flow down')),
    });
    const res = await app.request('/mcp-1/ui/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'render', threadId: 'thread-7' }),
    });
    expect(res.status).toBe(200);
    expect(svc.callMCPUITool).toHaveBeenCalled();
  });

  test('GET / reports renderAllowed per server from the revoke check', async () => {
    const app = createToolRoutes(createMockMCPService() as any, vi.fn(), {
      isRenderRevoked: (id) => id === 'mcp-1',
    });
    const body = await json(await app.request('/'));
    expect(body.data[0].renderAllowed).toBe(false);
  });

  test('GET / defaults renderAllowed to true when no revoke check is wired', async () => {
    const app = createToolRoutes(createMockMCPService() as any, vi.fn());
    const body = await json(await app.request('/'));
    expect(body.data[0].renderAllowed).toBe(true);
  });

  test('GET /:serverId/ui/:toolName returns render_revoked for a revoked server', async () => {
    const app = createToolRoutes(createMockMCPService() as any, vi.fn(), {
      isRenderRevoked: () => true,
    });
    const body = await json(await app.request('/mcp-1/ui/render'));
    expect(body.data.status).toBe('render_revoked');
  });

  test('GET /:serverId/ui/:toolName/embedded 403s for a revoked server', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn(), {
      isRenderRevoked: () => true,
    });
    const res = await app.request('/mcp-1/ui/render/embedded');
    expect(res.status).toBe(403);
    expect(svc.readMCPUIResourceFromTool).not.toHaveBeenCalled();
  });

  test('POST /:serverId/ui/permissions revokes and re-allows render', async () => {
    const setRenderAllowed = vi.fn();
    const app = createToolRoutes(createMockMCPService() as any, vi.fn(), {
      setRenderAllowed,
    });
    const revoke = await json(
      await app.request('/mcp-1/ui/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowRender: false }),
      }),
    );
    expect(revoke.success).toBe(true);
    expect(setRenderAllowed).toHaveBeenCalledWith('mcp-1', false);

    await app.request('/mcp-1/ui/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowRender: true }),
    });
    expect(setRenderAllowed).toHaveBeenCalledWith('mcp-1', true);
  });

  test('POST /:serverId/ui/permissions rejects a non-boolean allowRender', async () => {
    const setRenderAllowed = vi.fn();
    const app = createToolRoutes(createMockMCPService() as any, vi.fn(), {
      setRenderAllowed,
    });
    const res = await app.request('/mcp-1/ui/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowRender: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect(setRenderAllowed).not.toHaveBeenCalled();
  });

  test('DELETE /:id removes integration', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const body = await json(await app.request('/mcp-1', { method: 'DELETE' }));
    expect(body.success).toBe(true);
    expect(svc.deleteIntegration).toHaveBeenCalledWith('mcp-1');
  });

  // Audit CI-R7: the runtime re-registers its own tool servers on every
  // start, so this delete removed the directory and the row returned on the
  // next reload — the caller was shown an irreversible-action confirmation,
  // told it succeeded, and nothing had happened.
  test('DELETE /:id refuses a runtime-registered built-in and says why', async () => {
    const svc = createMockMCPService();
    const app = createToolRoutes(svc as any, vi.fn());
    const response = await app.request('/station-docs', { method: 'DELETE' });
    const body = await json(response);
    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toContain('built into Station');
    expect(body.error).toContain('Disable it instead');
    expect(svc.deleteIntegration).not.toHaveBeenCalled();
  });

  test('GET / marks the runtime-registered built-ins, which persist as kind mcp', async () => {
    const svc = createMockMCPService();
    svc.listIntegrations.mockResolvedValue([
      { id: 'station-docs', name: 'Station Docs', kind: 'mcp' },
      { id: 'mcp-1', name: 'Test MCP', kind: 'mcp' },
    ]);
    const app = createToolRoutes(svc as any, vi.fn());
    const body = await json(await app.request('/'));
    const byId = Object.fromEntries(
      body.data.map((entry: { id: string; builtin?: boolean }) => [
        entry.id,
        entry.builtin,
      ]),
    );
    expect(byId['station-docs']).toBe(true);
    expect(byId['mcp-1']).toBe(false);
  });
});
