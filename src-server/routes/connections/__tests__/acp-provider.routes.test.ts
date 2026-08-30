import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { ACPProviderRouteValidationError } from '../../../services/acp/acp-process.js';

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
      assertProviderSupported: vi.fn(),
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
    expect(ctx.acpBridge.assertProviderSupported).toHaveBeenCalledWith(
      'opencode',
      'main',
      'openai',
    );
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

  test('refuses an unadvertised protocol before materializing credentials', async () => {
    const ctx = context();
    ctx.acpBridge.assertProviderSupported.mockImplementation(() => {
      throw new ACPProviderRouteValidationError(
        'protocol_unsupported',
        "ACP provider 'main' did not advertise protocol 'opneai'.",
      );
    });
    const app = createACPRoutes(ctx as never);
    const response = await app.request('/connections/opencode/providers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'main',
        apiType: 'opneai',
        baseUrl: 'https://openrouter.ai/api/v1',
        secretHeaderRefs: { Authorization: 'openrouter-key' },
      }),
    });

    expect(response.status).toBe(409);
    expect(
      ctx.acpProviderSecretResolver.resolveForAcpProvider,
    ).not.toHaveBeenCalled();
    expect(ctx.acpBridge.setProvider).not.toHaveBeenCalled();
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
});
