import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  requestPluginRegistryInstallAction,
  revokePluginPermissions,
} from '../query-domains/plugin-mutations';

describe('plugin-mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('preserves server message text for registry install failures', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({
        success: false,
        message: 'Plugin install dependencies unavailable',
      }),
    } as Response);

    await expect(
      requestPluginRegistryInstallAction('demo-layout', 'install'),
    ).rejects.toThrow('Plugin install dependencies unavailable');
  });

  it('preserves a 202 winding-down revocation receipt as success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json(
        {
          success: true,
          granted: [],
          reconciliation: {
            status: 'winding-down',
            operationId: 'operation-1',
            generation: 2,
          },
        },
        { status: 202 },
      ),
    );

    await expect(
      revokePluginPermissions({
        name: 'provider-plugin',
        permissions: ['providers.register'],
      }),
    ).resolves.toEqual({
      granted: [],
      reconciliation: {
        status: 'winding-down',
        operationId: 'operation-1',
        generation: 2,
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/plugins/provider-plugin/grant',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
