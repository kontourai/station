import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { fetchContributedModelManifest } from '../query-domains/workspaceConnections';

describe('contributed model manifest SDK domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('loads the contributed-subset manifest through authenticated transport', async () => {
    // station#1398 slice 2: this endpoint returns
    // `station.fleet-contribution/v1`, not `station.model-inventory/v2` — it
    // is now the contributed subset behind `inference:invoke`, not every
    // model this Station can launch.
    const manifest = {
      schemaVersion: 'station.fleet-contribution/v1',
      projectedAt: '2026-08-01T10:00:01.000Z',
      sourceObservedAt: '2026-08-01T10:00:00.000Z',
      participation: 'contributing',
      models: [],
      diagnostics: [],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: manifest }),
    } as Response);

    await expect(fetchContributedModelManifest()).resolves.toEqual(manifest);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/connections/model-inventory',
    );
  });

  it('surfaces the API safe error without returning a malformed envelope', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({
        success: false,
        error: 'Failed to project the contributed model manifest',
      }),
    } as Response);

    await expect(fetchContributedModelManifest()).rejects.toThrow(
      'Failed to project the contributed model manifest',
    );
  });
});
