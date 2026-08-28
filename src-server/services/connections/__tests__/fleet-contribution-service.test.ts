/**
 * archive#1398 — `ConnectionService#getFleetContributionManifest`
 * wiring (`docs/design/inference-fleet.md` §11 slice 1).
 *
 * The first test is the reversibility pin: a Station that has not opted in
 * must do exactly what it did before this feature existed — no inventory
 * refresh, no provider discovery, no I/O at all.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../providers/connection-factories.js', () => ({
  createLLMProvider: vi.fn((connection: { type: string }) =>
    connection.type === 'ollama'
      ? {
          execution: {
            runtime: { id: 'ollama', version: null },
            adapter: { id: 'station-ollama', version: null },
            locality: 'local',
          },
          listModels: vi.fn(async () => [
            { id: 'qwen3:30b', name: 'qwen3:30b', contextWindow: 32_768 },
          ]),
        }
      : null,
  ),
  createEmbeddingProvider: vi.fn(() => null),
  createVectorDbProvider: vi.fn(() => null),
}));

vi.mock('../../../telemetry/metrics.js', () => ({
  adapterReadiness: { add: vi.fn() },
  configOps: { add: vi.fn() },
  credentialProfileApplication: { add: vi.fn() },
  fleetContributionManifestTotal: { add: vi.fn() },
  fleetContributionModelCount: { record: vi.fn() },
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
  fleetContributionManifestTotal,
  fleetContributionModelCount,
  modelInventoryRefreshTotal,
} = await import('../../../telemetry/metrics.js');

beforeEach(() => {
  vi.clearAllMocks();
});

const OLLAMA_CONNECTION = {
  id: 'ollama-local',
  type: 'ollama',
  name: 'Local Ollama',
  config: {},
  enabled: true,
  status: 'ready',
  capabilities: ['llm'],
};

function service(options: {
  appConfig: Record<string, unknown>;
  listProviderConnections?: () => unknown[];
}) {
  const listProviderConnections = vi.fn(
    options.listProviderConnections ?? (() => [OLLAMA_CONNECTION]),
  );
  const instance = createConnectionServiceForTest(
    {
      listProviderConnections,
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    } as never,
    () => [],
    async () => [],
    () => ({ connections: [] }),
    async () => options.appConfig as never,
    vi.fn(),
  );
  return { instance, listProviderConnections };
}

describe('ConnectionService#getFleetContributionManifest', () => {
  test('a Station that never opted in does no inventory work at all', async () => {
    const { instance, listProviderConnections } = service({ appConfig: {} });

    const manifest = await instance.getFleetContributionManifest();

    expect(manifest.participation).toBe('disabled');
    expect(manifest.models).toEqual([]);
    expect(listProviderConnections).not.toHaveBeenCalled();
    expect(modelInventoryRefreshTotal.add).not.toHaveBeenCalled();
  });

  test('the opt-in on with nothing marked still does no inventory work', async () => {
    const { instance, listProviderConnections } = service({
      appConfig: { fleetContribution: { enabled: true } },
    });

    const manifest = await instance.getFleetContributionManifest();

    expect(manifest.participation).toBe('nothing-contributed');
    expect(listProviderConnections).not.toHaveBeenCalled();
  });

  test('an opted-in Station offers exactly the marked local connection', async () => {
    const { instance } = service({
      appConfig: {
        fleetContribution: { enabled: true, connectionIds: ['ollama-local'] },
      },
    });

    const manifest = await instance.getFleetContributionManifest();

    expect(manifest.participation).toBe('contributing');
    expect(manifest.models).toHaveLength(1);
    expect(manifest.models[0]).toMatchObject({
      connectionId: 'ollama-local',
      providerModel: 'qwen3:30b',
      locality: 'local',
      availability: 'available',
      effectiveContextTokens: 32_768,
    });
    expect(manifest.diagnostics).toEqual([]);
  });

  test('an inventory that cannot be read reports unknown, not an empty contribution', async () => {
    const { instance } = service({
      appConfig: {
        fleetContribution: { enabled: true, connectionIds: ['ollama-local'] },
      },
      listProviderConnections: () => {
        throw new Error('provider registry unavailable');
      },
    });

    const manifest = await instance.getFleetContributionManifest();

    expect(manifest.participation).toBe('contributed-unavailable');
    expect(manifest.models).toEqual([]);
    expect(manifest.diagnostics.map((item) => item.code)).toEqual([
      'inventory-unavailable',
    ]);
  });

  test('records participation and offered-model telemetry', async () => {
    const { instance } = service({
      appConfig: {
        fleetContribution: { enabled: true, connectionIds: ['ollama-local'] },
      },
    });

    await instance.getFleetContributionManifest();

    expect(fleetContributionManifestTotal.add).toHaveBeenCalledWith(1, {
      participation: 'contributing',
    });
    expect(fleetContributionModelCount.record).toHaveBeenCalledWith(1);
  });
});
