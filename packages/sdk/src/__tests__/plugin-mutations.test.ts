import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { requestPluginRegistryInstallAction } from '../query-domains/plugin-mutations';

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
});
