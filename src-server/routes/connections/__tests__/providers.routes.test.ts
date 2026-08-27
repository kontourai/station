import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  providerOps: { add: vi.fn() },
}));
// Stable spies, not a fresh object per construction: a route test can only
// assert that NO catalogue request was made if the calls are observable
// (#3654 review round 2). Behaviour is unchanged from the literals they
// replace.
const bedrockProvider = vi.hoisted(() => ({
  healthCheck: vi.fn(async () => true),
  listModels: vi.fn(async () => [] as unknown[]),
}));
vi.mock('../../../providers/llm/bedrock-llm-provider.js', () => ({
  BedrockLLMProvider: vi
    .fn()
    .mockImplementation(function MockBedrockProvider() {
      return bedrockProvider;
    }),
}));
vi.mock('../../../providers/llm/ollama-provider.js', () => ({
  OllamaLLMProvider: vi.fn().mockImplementation(function MockOllamaProvider() {
    return { healthCheck: async () => true };
  }),
  OllamaEmbeddingProvider: vi.fn(),
}));
vi.mock('../../../providers/llm/openai-compat-provider.js', () => ({
  OpenAICompatLLMProvider: vi
    .fn()
    .mockImplementation(function MockOpenAICompatProvider() {
      return { healthCheck: async () => true };
    }),
  OpenAICompatEmbeddingProvider: vi.fn(),
}));
vi.mock('../../../providers/llm/bedrock-embedding-provider.js', () => ({
  BedrockEmbeddingProvider: vi.fn(),
}));
vi.mock('../../../providers/lancedb-provider.js', () => ({
  LanceDBProvider: vi.fn(),
}));

const { createProviderRoutes } = await import('../providers.js');
const { BedrockLLMProvider } = await import(
  '../../../providers/llm/bedrock-llm-provider.js'
);
const { BedrockEmbeddingProvider } = await import(
  '../../../providers/llm/bedrock-embedding-provider.js'
);

function createMockProviderService() {
  const connections: any[] = [];
  return {
    listProviderConnections: vi.fn(() => [...connections]),
    saveProviderConnection: vi.fn((c: any) => {
      const index = connections.findIndex((existing) => existing.id === c.id);
      if (index >= 0) connections[index] = c;
      else connections.push(c);
    }),
    deleteProviderConnection: vi.fn((id: string) => {
      const idx = connections.findIndex((c) => c.id === id);
      if (idx >= 0) connections.splice(idx, 1);
    }),
    checkHealth: vi.fn().mockResolvedValue(true),
    findDuplicateConnection: vi.fn((type: string, config: any) =>
      connections.find(
        (connection) =>
          connection.type === type &&
          connection.config?.baseUrl === config?.baseUrl,
      ),
    ),
  };
}

describe('Provider Routes', () => {
  test('GET / returns empty list', async () => {
    const app = createProviderRoutes(createMockProviderService() as any);
    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('POST / creates provider connection', async () => {
    const app = createProviderRoutes(createMockProviderService() as any);
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bedrock', name: 'Test', config: {} }),
    });
    expect(res.status).toBe(201);
  });

  test('keeps provider persistence inside the configuration mutation', async () => {
    const service = createMockProviderService();
    const mutationObserved = vi.fn();
    const applyConfigurationMutation = async <T>(
      operation: (beginMutation: () => void) => Promise<T>,
    ): Promise<T> => {
      mutationObserved();
      return operation(() => undefined);
    };
    const app = createProviderRoutes(service as any, {
      applyConfigurationMutation,
    });

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bedrock', name: 'Test', config: {} }),
    });

    expect(response.status).toBe(201);
    expect(mutationObserved).toHaveBeenCalledOnce();
    expect(service.saveProviderConnection).toHaveBeenCalledOnce();
  });

  test('DELETE /:id removes provider', async () => {
    const svc = createMockProviderService();
    svc.saveProviderConnection({
      id: 'p1',
      type: 'bedrock',
      name: 'Primary',
      config: {},
    });
    const app = createProviderRoutes(svc as any);
    const body = await json(await app.request('/p1', { method: 'DELETE' }));
    expect(body.success).toBe(true);
    expect(svc.deleteProviderConnection).toHaveBeenCalledWith('p1');
  });

  test('PUT /:id makes the path authoritative and updates exactly one provider', async () => {
    const svc = createMockProviderService();
    svc.saveProviderConnection({
      id: 'p1',
      type: 'bedrock',
      name: 'Before',
      config: {},
    });
    const app = createProviderRoutes(svc as any);

    const response = await app.request('/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bedrock', name: 'After', config: {} }),
    });

    expect(response.status).toBe(200);
    expect(svc.listProviderConnections()).toEqual([
      expect.objectContaining({ id: 'p1', name: 'After' }),
    ]);
  });

  test('missing DELETE and unchanged PUT do not begin a mutation', async () => {
    const svc = createMockProviderService();
    const existing = {
      id: 'p1',
      type: 'bedrock',
      name: 'Primary',
      config: {},
    };
    svc.saveProviderConnection(existing);
    const beginMutation = vi.fn();
    const app = createProviderRoutes(svc as any, {
      applyConfigurationMutation: (operation) => operation(beginMutation),
    });

    const missing = await app.request('/missing', { method: 'DELETE' });
    const unchanged = await app.request('/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bedrock', name: 'Primary', config: {} }),
    });

    expect(missing.status).toBe(404);
    expect(unchanged.status).toBe(200);
    expect(beginMutation).not.toHaveBeenCalled();
  });

  test('POST /:id/test returns 404 for missing provider', async () => {
    const app = createProviderRoutes(createMockProviderService() as any);
    const res = await app.request('/missing/test', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('GET /:id/health returns 404 for missing provider', async () => {
    const app = createProviderRoutes(createMockProviderService() as any);
    const body = await json(await app.request('/missing/health'));
    expect(body.success).toBe(false);
  });

  test('GET /:id/models returns only a bounded catalog for an enabled LLM connection', async () => {
    vi.mocked(BedrockLLMProvider).mockImplementationOnce(
      function MockBoundedBedrockProvider() {
        return {
          listModels: async () =>
            Array.from({ length: 1001 }, (_, index) => ({
              id: `model-${index}`,
              name: `Model ${index}`,
            })),
        } as any;
      },
    );
    const svc = createMockProviderService();
    svc.saveProviderConnection({
      id: 'bedrock-main',
      type: 'bedrock',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    });
    const app = createProviderRoutes(svc as any);

    const res = await app.request('/bedrock-main/models');
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1000);
  });

  test('GET /:id/models rejects a disabled connection', async () => {
    const svc = createMockProviderService();
    svc.saveProviderConnection({
      id: 'bedrock-disabled',
      type: 'bedrock',
      enabled: false,
      capabilities: ['llm'],
      config: {},
    });
    const app = createProviderRoutes(svc as any);

    const res = await app.request('/bedrock-disabled/models');

    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      success: false,
      error: 'Provider is not an enabled LLM connection',
    });
  });

  test('POST /:id/test-embedding reports an unprobeable provider as unknown', async () => {
    vi.mocked(BedrockEmbeddingProvider).mockImplementationOnce(
      function MockUnprobeableEmbeddingProvider() {
        return {} as any;
      },
    );
    const svc = createMockProviderService();
    svc.saveProviderConnection({
      id: 'bedrock-embedding',
      type: 'bedrock',
      name: 'Embedding',
      capabilities: ['embedding'],
      config: {},
    });
    const app = createProviderRoutes(svc as any);

    const response = await app.request('/bedrock-embedding/test-embedding', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      success: true,
      data: { healthy: null },
    });
  });

  test('POST / rejects a duplicate Ollama connection with 409 (#191 R5)', async () => {
    const svc = createMockProviderService();
    const beginMutation = vi.fn();
    (svc.findDuplicateConnection as any).mockReturnValue({
      id: 'existing-ollama',
      name: 'Ollama (existing)',
    });
    const app = createProviderRoutes(svc as any, {
      applyConfigurationMutation: (operation) => operation(beginMutation),
    });

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'ollama',
        name: 'Ollama (detected)',
        config: { baseUrl: 'http://127.0.0.1:11434' },
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.existingId).toBe('existing-ollama');
    expect(body.error).toBe(
      'A connection to this Ollama server already exists: Ollama (existing)',
    );
    expect(svc.saveProviderConnection).not.toHaveBeenCalled();
    expect(beginMutation).not.toHaveBeenCalled();
  });

  test('serializes duplicate detection with concurrent provider creation', async () => {
    const svc = createMockProviderService();
    let mutationQueue = Promise.resolve();
    const applyConfigurationMutation = <T>(
      operation: (beginMutation: () => void) => Promise<T>,
    ): Promise<T> => {
      const result = mutationQueue.then(() => operation(() => undefined));
      mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const app = createProviderRoutes(svc as any, {
      applyConfigurationMutation,
    });
    const request = () =>
      app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ollama',
          name: 'Ollama',
          config: { baseUrl: 'http://127.0.0.1:11434' },
        }),
      });

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(svc.saveProviderConnection).toHaveBeenCalledOnce();
  });

  // #191 code-review M2: the 409 message must derive the provider-type
  // label from the request body's type, not hardcode "Ollama" — proven
  // here with a non-Ollama type so a future HOST_IDENTIFIED_PROVIDER_TYPES
  // addition (the code comment names Bedrock as a plausible candidate)
  // doesn't inherit a stale, wrong vendor name.
  test('POST / dedup-conflict message is derived generically from the connection type, not hardcoded', async () => {
    const svc = createMockProviderService();
    (svc.findDuplicateConnection as any).mockReturnValue({
      id: 'existing-bedrock',
      name: 'Bedrock (existing)',
    });
    const app = createProviderRoutes(svc as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'bedrock',
        name: 'Bedrock (detected)',
        config: {},
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(409);
    expect(body.error).toBe(
      'A connection to this Bedrock server already exists: Bedrock (existing)',
    );
    expect(body.error).not.toContain('Ollama');
  });
});

/**
 * #3654 review, M2 — these legacy endpoints used to expose the provider's own
 * `healthCheck()` boolean directly.
 *
 * Bedrock's now answers "did AWS return a catalogue", so an IAM identity
 * allowed `InvokeModel` and denied `ListFoundationModels` — a connection the
 * classified check can prove works, by asking the chat route — read
 * `healthy: false` here while the connections surface read it as verified.
 * Two derivations of one fact, disagreeing.
 */
describe('Provider health and test answer from the classified check', () => {
  function invokeOnlyBedrock() {
    const svc = createMockProviderService();
    svc.saveProviderConnection({
      id: 'bedrock-1',
      type: 'bedrock',
      name: 'Bedrock',
      enabled: true,
      capabilities: ['llm'],
      config: { region: 'us-east-1', defaultModel: 'a-model' },
    });
    // The catalogue is denied for this identity, so the bare provider boolean
    // is false.
    (svc.checkHealth as any).mockResolvedValue(false);
    return svc;
  }

  function checkAuthority(
    check: { status: string; reason?: string } | null,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      testConnection: vi.fn(),
      getModelConnectionCheck: vi.fn(() => check),
      // Not part of the interface any more. Spied so a regression that reaches
      // for the whole listing again is caught as what it is: a targeted read
      // amplified into discovery against every configured provider.
      listModelConnections: vi.fn(async () => []),
      ...overrides,
    };
  }

  test('GET /:id/health reports the standing pass an explicit test earned', async () => {
    const connectionService = checkAuthority({ status: 'passed' });
    const app = createProviderRoutes(invokeOnlyBedrock() as any, {
      connectionService: connectionService as any,
    });

    const body = await json(await app.request('/bedrock-1/health'));

    expect(body.data.healthy).toBe(true);
    expect(body.data.status).toBe('passed');
    // Reading a receipt must not run a chat probe on a GET.
    expect(connectionService.testConnection).not.toHaveBeenCalled();
  });

  test('GET /:id/health reads one receipt: no discovery, no provider request, no other connection', async () => {
    bedrockProvider.listModels.mockClear();
    bedrockProvider.healthCheck.mockClear();
    const svc = invokeOnlyBedrock();
    // A second connection, so "only the requested id is read" has something to
    // be wrong about.
    svc.saveProviderConnection({
      id: 'other-1',
      type: 'openai-compat',
      name: 'Other',
      enabled: true,
      capabilities: ['llm'],
      config: { baseUrl: 'http://other.test/v1' },
    });
    const connectionService = checkAuthority({ status: 'passed' });
    const app = createProviderRoutes(svc as any, {
      connectionService: connectionService as any,
    });

    const body = await json(await app.request('/bedrock-1/health'));

    expect(body.data.healthy).toBe(true);
    // The whole point: one targeted read stays one targeted read.
    expect(connectionService.listModelConnections).not.toHaveBeenCalled();
    expect(connectionService.getModelConnectionCheck).toHaveBeenCalledTimes(1);
    expect(connectionService.getModelConnectionCheck).toHaveBeenCalledWith(
      'bedrock-1',
    );
    // No catalogue request reached any provider — not for this connection and
    // not for the one next to it.
    expect(bedrockProvider.listModels).not.toHaveBeenCalled();
    expect(bedrockProvider.healthCheck).not.toHaveBeenCalled();
    expect(svc.checkHealth).not.toHaveBeenCalled();
  });

  test('GET /:id/health distinguishes reachable-but-unproven from refused', async () => {
    const connectionService = checkAuthority({
      status: 'catalog-unavailable',
      reason: 'These credentials are not allowed to list Bedrock models.',
    });
    const app = createProviderRoutes(invokeOnlyBedrock() as any, {
      connectionService: connectionService as any,
    });

    const body = await json(await app.request('/bedrock-1/health'));

    expect(body.data.healthy).toBe(false);
    expect(body.data.status).toBe('catalog-unavailable');
    expect(body.data.reason).toContain('not allowed to list');
  });

  test('POST /:id/test runs the classified check, chat fallback and all', async () => {
    const connectionService = checkAuthority(null, {
      testConnection: vi.fn(async () => ({ healthy: true })),
    });
    const svc = invokeOnlyBedrock();
    const app = createProviderRoutes(svc as any, {
      connectionService: connectionService as any,
    });

    const body = await json(
      await app.request('/bedrock-1/test', { method: 'POST' }),
    );

    expect(connectionService.testConnection).toHaveBeenCalledWith('bedrock-1');
    expect(body.data.healthy).toBe(true);
    // The narrower boolean is not what answered.
    expect(svc.checkHealth).not.toHaveBeenCalled();
  });

  test('falls back to the provider health boolean when there is no receipt', async () => {
    const svc = invokeOnlyBedrock();
    const app = createProviderRoutes(svc as any, {
      connectionService: checkAuthority({ status: 'not-checked' }) as any,
    });

    const body = await json(await app.request('/bedrock-1/health'));

    expect(body.data.healthy).toBe(false);
    expect(body.data.status).toBeUndefined();
    expect(svc.checkHealth).toHaveBeenCalled();
  });

  test('falls back to the provider health boolean when no classified check is composed', async () => {
    const svc = invokeOnlyBedrock();
    const app = createProviderRoutes(svc as any);

    const body = await json(await app.request('/bedrock-1/health'));

    expect(body.data.healthy).toBe(false);
    expect(body.data.status).toBeUndefined();
    expect(svc.checkHealth).toHaveBeenCalled();
  });
});
