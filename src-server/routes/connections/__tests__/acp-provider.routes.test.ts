import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { SecretBindingResolutionError } from '../../../services/secrets/secret-binding-administration.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  acpOps: { add: vi.fn() },
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  listProviders: () => [],
}));

const { createACPRoutes } = await import('../acp.js');

function context() {
  const settlement = { settle: vi.fn() };
  return {
    acpBridge: {
      getStatus: vi.fn().mockReturnValue({ connections: [] }),
      setProvider: vi.fn().mockResolvedValue(undefined),
      disableProvider: vi.fn().mockResolvedValue(undefined),
    },
    acpProviderSecretResolver: {
      resolveForAcpProvider: vi.fn().mockResolvedValue({
        environment: { Authorization: 'Bearer canary-secret' },
        settlement,
      }),
    },
    settlement,
  };
}

describe('ACP provider routes (#944)', () => {
  test('resolves secret bindings only for the ACP payload and redacts the response', async () => {
    const ctx = context();
    const app = createACPRoutes(ctx as never);
    const response = await app.request('/connections/opencode/providers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'main',
        apiType: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        secretHeaderRefs: { Authorization: 'openrouter-key' },
      }),
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(
      ctx.acpProviderSecretResolver.resolveForAcpProvider,
    ).toHaveBeenCalledWith({
      connectionId: 'opencode',
      providerId: 'main',
      secretHeaderRefs: { Authorization: 'openrouter-key' },
    });
    expect(ctx.acpBridge.setProvider).toHaveBeenCalledWith('opencode', {
      providerId: 'main',
      apiType: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      headers: {
        Authorization: 'Bearer canary-secret',
      },
    });
    expect(JSON.stringify(body)).not.toContain('canary-secret');
    expect(ctx.settlement.settle).toHaveBeenCalledWith({ outcome: 'success' });
  });

  test.each([
    'https://user:secret@openrouter.ai/api/v1',
    'https://openrouter.ai/api/v1?api_key=secret',
    'https://openrouter.ai/api/v1#secret',
  ])(
    'rejects a credential-bearing or ambiguous base URL: %s',
    async (baseUrl) => {
      const ctx = context();
      const app = createACPRoutes(ctx as never);
      const response = await app.request(
        '/connections/opencode/providers/set',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: 'main',
            apiType: 'openai',
            baseUrl,
            secretHeaderRefs: { Authorization: 'openrouter-key' },
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(ctx.acpBridge.setProvider).not.toHaveBeenCalled();
    },
  );

  test('rejects a literal credential header at schema validation', async () => {
    const ctx = context();
    const app = createACPRoutes(ctx as never);
    const response = await app.request('/connections/opencode/providers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'main',
        apiType: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        headers: { Authorization: 'Bearer must-not-cross' },
      }),
    });

    expect(response.status).toBe(400);
    expect(ctx.acpBridge.setProvider).not.toHaveBeenCalled();
  });

  test('preserves and sends an unknown ACP protocol identifier losslessly', async () => {
    const ctx = context();
    const app = createACPRoutes(ctx as never);
    const response = await app.request('/connections/opencode/providers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'main',
        apiType: '_ollama',
        baseUrl: 'https://ollama.example/v1',
      }),
    });

    expect(response.status).toBe(200);
    expect(ctx.acpBridge.setProvider).toHaveBeenCalledWith('opencode', {
      providerId: 'main',
      apiType: '_ollama',
      baseUrl: 'https://ollama.example/v1',
      headers: undefined,
    });
  });

  test('returns an ordinary capability refusal and settles materialization failure', async () => {
    const ctx = context();
    const unsupported = new Error('unsupported');
    unsupported.name = 'ACPProviderRoutingUnsupportedError';
    ctx.acpBridge.setProvider.mockRejectedValue(unsupported);
    const app = createACPRoutes(ctx as never);
    const response = await app.request('/connections/kiro/providers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'main',
        apiType: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        secretHeaderRefs: { Authorization: 'openrouter-key' },
      }),
    });

    expect(response.status).toBe(409);
    expect(ctx.settlement.settle).toHaveBeenCalledWith({
      outcome: 'failure',
      reason: 'child_establishment_failed',
    });
  });

  test('returns an ordinary refusal for an ungranted secret without calling ACP', async () => {
    const ctx = context();
    ctx.acpProviderSecretResolver.resolveForAcpProvider.mockRejectedValue(
      new SecretBindingResolutionError('grant_missing'),
    );
    const app = createACPRoutes(ctx as never);
    const response = await app.request('/connections/kiro/providers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'main',
        apiType: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        secretHeaderRefs: { Authorization: 'other-consumer-key' },
      }),
    });

    expect(response.status).toBe(400);
    expect(ctx.acpBridge.setProvider).not.toHaveBeenCalled();
  });
});
