import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../providers/connection-factories.js', () => ({
  createLLMProvider: vi.fn(() => null),
  createEmbeddingProvider: vi.fn(() => null),
  createVectorDbProvider: vi.fn(() => null),
}));

vi.mock('../../../telemetry/metrics.js', () => ({
  adapterReadiness: { add: vi.fn() },
  configOps: { add: vi.fn() },
  modelInventoryDiagnosticCount: { record: vi.fn() },
  modelInventoryModelCount: { record: vi.fn() },
  modelInventoryRefreshDuration: { record: vi.fn() },
  modelInventoryRefreshTotal: { add: vi.fn() },
  modelInventoryResponseTotal: { add: vi.fn() },
  providerCatalogOps: { add: vi.fn() },
  providerCatalogModelCount: { record: vi.fn() },
  providerCatalogBuiltInModelCount: { record: vi.fn() },
}));

const { createConnectionServiceForTest } = await import(
  './connection-service-test-helper.js'
);
const {
  adapterReadiness,
  modelInventoryDiagnosticCount,
  modelInventoryModelCount,
  modelInventoryRefreshDuration,
  modelInventoryRefreshTotal,
  modelInventoryResponseTotal,
  providerCatalogBuiltInModelCount,
  providerCatalogModelCount,
  providerCatalogOps,
} = await import('../../../telemetry/metrics.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function service(
  listProviderConnections: () => any[],
  getProviderAdapters: () => any[] = () => [],
) {
  return createConnectionServiceForTest(
    {
      listProviderConnections,
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn(),
    } as any,
    getProviderAdapters,
    async () => [],
    () => ({ connections: [] }),
    async () => ({}) as any,
    vi.fn(),
  );
}

describe('launchable model inventory telemetry', () => {
  test('records successful refresh counts and duration', async () => {
    await service(() => []).listLaunchableModelInventory();

    expect(modelInventoryRefreshTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'success',
    });
    expect(modelInventoryModelCount.record).toHaveBeenCalledWith(0);
    expect(modelInventoryDiagnosticCount.record).toHaveBeenCalledWith(0);
    expect(modelInventoryRefreshDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
      { outcome: 'success' },
    );
    expect(modelInventoryResponseTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'fresh',
    });
  });

  test('keeps catalog counter dimensions bounded and records counts as histograms', async () => {
    const adapter = {
      provider: 'codex',
      metadata: {
        displayName: 'Codex',
        description: 'Codex',
        capabilities: ['agent-runtime'],
        runtimeId: 'plugin-controlled-secret-shaped-value',
        builtin: true,
        executionClass: 'connected',
      },
      getPrerequisites: vi.fn().mockResolvedValue([]),
      listModels: vi
        .fn()
        .mockResolvedValue([
          { id: 'model-a', name: 'Model A', originalId: 'model-a' },
        ]),
    };

    await service(
      () => [],
      () => [adapter],
    ).listLaunchableModelInventory();

    expect(providerCatalogOps.add).toHaveBeenCalledWith(1, {
      op: 'resolve_catalog',
      provider: 'plugin',
      source: 'live',
      hasModelCapabilities: false,
      hasLiveDiscovery: true,
    });
    expect(
      JSON.stringify(vi.mocked(providerCatalogOps.add).mock.calls),
    ).not.toContain('plugin-controlled-secret-shaped');
    expect(adapterReadiness.add).toHaveBeenCalledWith(1, {
      adapter_id: 'plugin',
      runtime_type: 'plugin',
      state: 'configured',
      reason: 'ready',
      source: 'plugin',
    });
    expect(
      JSON.stringify(vi.mocked(adapterReadiness.add).mock.calls),
    ).not.toContain('plugin-controlled-secret-shaped');
    expect(providerCatalogModelCount.record).toHaveBeenCalledWith(1, {
      provider: 'plugin',
      source: 'live',
      hasModelCapabilities: false,
    });
    expect(providerCatalogBuiltInModelCount.record).toHaveBeenCalledWith(
      expect.any(Number),
      {
        provider: 'plugin',
        source: 'live',
        hasModelCapabilities: false,
      },
    );
  });

  test('records failed refreshes without attaching error text', async () => {
    await expect(
      service(() => {
        throw new Error('credential-shaped failure');
      }).listLaunchableModelInventory(),
    ).rejects.toThrow('credential-shaped failure');

    expect(modelInventoryRefreshTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'error',
    });
    expect(modelInventoryRefreshDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
      { outcome: 'error' },
    );
    expect(modelInventoryResponseTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'error',
    });
  });

  test('records one timed-out generation separately from each stale response', async () => {
    vi.useFakeTimers();
    const getPrerequisites = vi.fn().mockResolvedValue([]);
    const adapter = {
      provider: 'codex',
      metadata: {
        displayName: 'Codex',
        description: 'Codex',
        capabilities: ['agent-runtime'],
        runtimeId: 'codex-runtime',
        executionClass: 'connected',
      },
      getPrerequisites,
      listModels: vi
        .fn()
        .mockResolvedValue([
          { id: 'model-a', name: 'Model A', originalId: 'model-a' },
        ]),
    };
    const instance = service(
      () => [],
      () => [adapter],
    );

    try {
      await instance.listLaunchableModelInventory();
      vi.clearAllMocks();
      adapter.listModels.mockImplementation(
        ({ signal }: { signal?: AbortSignal } = {}) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      );

      const first = instance.listLaunchableModelInventory();
      const second = instance.listLaunchableModelInventory();
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.all([first, second]);

      expect(modelInventoryRefreshTotal.add).toHaveBeenCalledTimes(1);
      expect(modelInventoryRefreshTotal.add).toHaveBeenCalledWith(1, {
        outcome: 'timeout',
      });
      expect(modelInventoryResponseTotal.add).toHaveBeenCalledTimes(2);
      expect(modelInventoryResponseTotal.add).toHaveBeenNthCalledWith(1, 1, {
        outcome: 'stale',
      });
      expect(modelInventoryResponseTotal.add).toHaveBeenNthCalledWith(2, 1, {
        outcome: 'stale',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
