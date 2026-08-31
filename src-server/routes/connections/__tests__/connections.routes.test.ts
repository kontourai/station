import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { ModelSelectionRequiredError } from '../../../services/connections/connection-service.js';
import { createConnectionRoutes } from '../connections.js';

function createMockConnectionService() {
  const connections = [
    {
      id: 'bedrock-model',
      kind: 'model' as const,
      type: 'bedrock',
      name: 'Bedrock',
      enabled: true,
      description: 'AWS Bedrock models',
      capabilities: ['llm'],
      config: {},
      status: 'ready' as const,
      prerequisites: [],
      lastCheckedAt: null,
    },
    {
      id: 'claude',
      kind: 'agent' as const,
      type: 'claude',
      name: 'Claude Runtime',
      enabled: true,
      description: 'Claude Agent SDK',
      capabilities: ['agent-runtime'],
      config: {},
      status: 'ready' as const,
      prerequisites: [],
      lastCheckedAt: null,
    },
  ];

  return {
    listConnections: vi.fn().mockResolvedValue(connections),
    listModelConnections: vi.fn().mockResolvedValue([connections[0]]),
    listModelConnectionInventory: vi
      .fn()
      .mockResolvedValue({ connections: [connections[0]], failures: [] }),
    listRuntimeConnections: vi.fn().mockResolvedValue([connections[1]]),
    listRuntimeConnectionInventory: vi
      .fn()
      .mockResolvedValue({ connections: [connections[1]], failures: [] }),
    listRuntimeConnectionCatalog: vi.fn().mockResolvedValue([connections[1]]),
    listLaunchableModelInventory: vi.fn().mockResolvedValue({
      schemaVersion: 'station.model-inventory/v2',
      observedAt: '2026-07-19T13:00:00.000Z',
      models: [],
      diagnostics: [],
    }),
    getFleetContributionManifest: vi.fn().mockResolvedValue({
      schemaVersion: 'station.fleet-contribution/v1',
      projectedAt: '2026-08-01T10:00:01.000Z',
      sourceObservedAt: '2026-08-01T10:00:00.000Z',
      participation: 'disabled',
      models: [],
      diagnostics: [],
    }),
    getConnection: vi.fn(
      async (id: string) =>
        connections.find((connection) => connection.id === id) ?? null,
    ),
    saveConnection: vi.fn(async (connection: any) => connection),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    testConnection: vi
      .fn()
      .mockResolvedValue({ healthy: true, status: 'ready', prerequisites: [] }),
    smokeConnection: vi.fn().mockResolvedValue({
      evidenceVersion: 1,
      level: 'smoke-passed',
      observedAt: '2026-07-13T20:00:00.000Z',
      freshness: 'fresh',
      summary: 'A bounded chat smoke completed successfully.',
      smoke: { status: 'passed', freshness: 'fresh', turnLimit: 1 },
    }),
    readQuotaSnapshot: vi.fn().mockResolvedValue({
      kind: 'unavailable',
      reason: 'unsupported-provider',
    }),
  };
}

describe('Connection Routes', () => {
  test('GET /:id resolves the public Agent Apps identity used by an unverifiable-engine CTA', async () => {
    const service = createMockConnectionService();
    const publicCodexConnection = {
      id: 'codex',
      kind: 'agent' as const,
      type: 'codex',
      name: 'Codex',
      enabled: true,
      description: 'Codex Agent App',
      capabilities: ['agent-runtime'],
      config: {},
      status: 'ready' as const,
      prerequisites: [],
      lastCheckedAt: null,
    };
    service.getConnection.mockImplementation(async (id: string) =>
      id === 'codex' ? publicCodexConnection : null,
    );
    const response = await createConnectionRoutes(service as any).request(
      '/codex',
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      success: true,
      data: { id: 'codex', name: 'Codex' },
    });
    expect(service.getConnection).toHaveBeenCalledWith('codex');
  });

  test('GET / returns projected connections', async () => {
    const app = createConnectionRoutes(createMockConnectionService() as any);
    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  test('GET /models and /agents return filtered lists', async () => {
    const app = createConnectionRoutes(createMockConnectionService() as any);
    const models = await json(await app.request('/models'));
    const runtimes = await json(await app.request('/agents'));
    expect(models.data[0].kind).toBe('model');
    expect(runtimes.data[0].kind).toBe('agent');
  });

  test('GET /agents/catalog exposes onboarding candidates independently of configured identities', async () => {
    const service = createMockConnectionService();
    service.listRuntimeConnectionInventory.mockResolvedValue({
      connections: [],
      failures: [],
    });
    const app = createConnectionRoutes(service as any);

    const configured = await json(await app.request('/agents'));
    const catalog = await json(await app.request('/agents/catalog'));

    expect(configured.data).toEqual([]);
    expect(catalog.data).toEqual([
      expect.objectContaining({ id: 'claude', kind: 'agent' }),
    ]);
    expect(service.listRuntimeConnectionCatalog).toHaveBeenCalledOnce();
  });

  test('GET /models and /agents carry the rows they could not read (station#3748)', async () => {
    const service = createMockConnectionService();
    const failures = [
      { connectionId: 'broken-1', name: 'Broken', reason: 'bad capabilities' },
    ];
    service.listModelConnectionInventory.mockResolvedValue({
      connections: [],
      failures,
    });
    service.listRuntimeConnectionInventory.mockResolvedValue({
      connections: [],
      failures,
    });
    const app = createConnectionRoutes(service as any);

    // An empty `data` with a non-empty `failures` is what tells a consumer
    // this is an error and not "you have no connections".
    expect(await json(await app.request('/models'))).toMatchObject({
      success: true,
      data: [],
      failures,
    });
    expect(await json(await app.request('/agents'))).toMatchObject({
      success: true,
      data: [],
      failures,
    });
  });

  test('GET /model-inventory returns the CONTRIBUTED-SUBSET manifest, not the full inventory (station#1398 §5.3)', async () => {
    const service = createMockConnectionService();
    const app = createConnectionRoutes(service as any);
    const response = await app.request('/model-inventory');
    const body = await json(response);

    expect(response.status).toBe(200);
    // The schema version IS the contract signal that this endpoint changed
    // what it discloses. Raising the scope tier without changing the payload
    // would have handed the full enumeration to exactly the fleet-peer class
    // the completion route's refusal parity keeps it from.
    expect(body.data.schemaVersion).toBe('station.fleet-contribution/v1');
    expect(service.getFleetContributionManifest).toHaveBeenCalledOnce();
    expect(service.listLaunchableModelInventory).not.toHaveBeenCalled();
  });

  test('GET /model-inventory shows an inference-preset peer only contributed models, never the withheld ones', async () => {
    // The enumeration oracle this endpoint used to be. `withheld-model` is
    // launchable on this Station and deliberately not contributed; it must
    // not appear here, by name or by any other identifier, exactly as
    // `POST /api/inference/completions` refuses it indistinguishably from a
    // model that does not exist.
    const service = createMockConnectionService();
    service.listLaunchableModelInventory.mockResolvedValue({
      schemaVersion: 'station.model-inventory/v2',
      observedAt: '2026-08-01T10:00:00.000Z',
      models: [
        { id: 'contributed-model', connectionId: 'ollama-local' },
        { id: 'withheld-model', connectionId: 'bedrock-private' },
      ],
      diagnostics: [],
    });
    service.getFleetContributionManifest.mockResolvedValue({
      schemaVersion: 'station.fleet-contribution/v1',
      projectedAt: '2026-08-01T10:00:01.000Z',
      sourceObservedAt: '2026-08-01T10:00:00.000Z',
      participation: 'contributing',
      models: [
        {
          id: 'contributed-model',
          connectionId: 'ollama-local',
          providerModel: 'llama3.3:70b',
          model: { id: 'llama3.3', revision: null, quantization: null },
          aliases: [],
          displayName: 'Llama 3.3 70B',
          locality: 'local',
          availability: 'available',
          freshness: 'live',
          observedAt: '2026-08-01T10:00:00.000Z',
          effectiveContextTokens: 131072,
          supportsVision: false,
        },
      ],
      diagnostics: [],
    });

    const app = createConnectionRoutes(service as any);
    const response = await app.request('/model-inventory');
    const body = await json(response);
    const serialized = JSON.stringify(body);

    expect(body.data.models).toHaveLength(1);
    expect(body.data.models[0].id).toBe('contributed-model');
    expect(serialized).toContain('contributed-model');
    expect(serialized).not.toContain('withheld-model');
    expect(serialized).not.toContain('bedrock-private');
  });

  test('GET /model-inventory does not expose projection failure details', async () => {
    const service = createMockConnectionService();
    service.getFleetContributionManifest.mockRejectedValueOnce(
      new Error('api key must-not-escape'),
    );
    const app = createConnectionRoutes(service as any);
    const response = await app.request('/model-inventory');
    const body = await json(response);

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: 'Failed to project the contributed model manifest',
    });
    expect(JSON.stringify(body)).not.toContain('must-not-escape');
  });

  test('POST / persists model connections', async () => {
    const service = createMockConnectionService();
    const mutationObserved = vi.fn();
    const applyConfigurationMutation = async <T>(
      operation: (beginMutation: () => void) => Promise<T>,
    ): Promise<T> => {
      mutationObserved();
      return operation(() => undefined);
    };
    const app = createConnectionRoutes(service as any, {
      applyConfigurationMutation,
    });
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'model',
        type: 'openai-compat',
        name: 'OpenAI Compat',
        enabled: true,
        config: { baseUrl: 'https://example.com' },
        capabilities: ['llm'],
      }),
    });
    expect(res.status).toBe(201);
    expect(service.saveConnection).toHaveBeenCalled();
    expect(mutationObserved).toHaveBeenCalledOnce();
  });

  test('POST / returns installed model choices when Ollama selection is ambiguous', async () => {
    const service = createMockConnectionService();
    service.saveConnection.mockRejectedValueOnce(
      new ModelSelectionRequiredError('Choose an Ollama model.', [
        { id: 'llama3.2', name: 'Llama 3.2', originalId: 'llama3.2' },
        { id: 'qwen3:30b', name: 'Qwen 3 30B', originalId: 'qwen3:30b' },
      ]),
    );
    const app = createConnectionRoutes(service as any);

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'model',
        type: 'ollama',
        name: 'Local Ollama',
        enabled: true,
        config: { baseUrl: 'http://localhost:11434' },
        capabilities: ['llm'],
      }),
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'Choose an Ollama model.',
      modelOptions: [
        { id: 'llama3.2', name: 'Llama 3.2', originalId: 'llama3.2' },
        { id: 'qwen3:30b', name: 'Qwen 3 30B', originalId: 'qwen3:30b' },
      ],
    });
  });

  test('PUT and DELETE keep every connection kind inside configuration mutations', async () => {
    const service = createMockConnectionService();
    const mutationObserved = vi.fn();
    const applyConfigurationMutation = async <T>(
      operation: (beginMutation: () => void) => Promise<T>,
    ): Promise<T> => {
      mutationObserved();
      return operation(() => undefined);
    };
    const app = createConnectionRoutes(service as any, {
      applyConfigurationMutation,
    });

    const update = await app.request('/bedrock-model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'model',
        type: 'bedrock',
        name: 'Bedrock',
        enabled: true,
        config: {},
        capabilities: ['llm'],
      }),
    });
    const remove = await app.request('/bedrock-model', { method: 'DELETE' });
    const updateAgent = await app.request('/claude', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'agent',
        type: 'claude',
        name: 'Claude Code',
        enabled: true,
        config: {},
        capabilities: ['agent-runtime'],
      }),
    });
    const removeAgent = await app.request('/claude', {
      method: 'DELETE',
    });

    expect(update.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(updateAgent.status).toBe(200);
    expect(removeAgent.status).toBe(200);
    expect(mutationObserved).toHaveBeenCalledTimes(4);
  });

  test('POST /:id/test returns 404 for missing connection', async () => {
    const service = createMockConnectionService();
    service.testConnection.mockRejectedValueOnce(
      new Error('Connection not found'),
    );
    const app = createConnectionRoutes(service as any);
    const res = await app.request('/missing/test', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('GET /:id/quota returns a provider-reported snapshot', async () => {
    const service = createMockConnectionService();
    service.readQuotaSnapshot.mockResolvedValueOnce({
      kind: 'snapshot',
      snapshot: {
        connectionId: 'claude',
        provider: 'codex',
        observedAt: '2026-08-09T19:00:00.000Z',
        source: 'provider-reported',
        windows: [{ id: 'primary', usedPercent: 42 }],
      },
    });
    const response = await createConnectionRoutes(service as any).request(
      '/claude/quota',
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ kind: 'snapshot' });
  });

  test('GET /:id/quota returns typed unsupported-provider unavailability', async () => {
    const service = createMockConnectionService();
    const response = await createConnectionRoutes(service as any).request(
      '/claude/quota',
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      kind: 'unavailable',
      reason: 'unsupported-provider',
    });
  });

  test('POST /:id/smoke requires and forwards explicit billable-turn confirmation', async () => {
    const service = createMockConnectionService();
    const app = createConnectionRoutes(service as any);

    const response = await app.request('/claude/smoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, timeoutMs: 30_000 }),
    });

    expect(response.status).toBe(200);
    expect(service.smokeConnection).toHaveBeenCalledWith('claude', {
      confirmed: true,
      timeoutMs: 30_000,
    });
  });
});
