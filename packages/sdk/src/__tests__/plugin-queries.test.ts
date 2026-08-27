import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  requestAgentHealth,
  waitForAgentHealth,
} from '../query-domains/plugin-queries';

describe('plugin-queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('requests agent health from the agent health endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, healthy: true, status: 'ok' }),
    } as Response);

    await expect(requestAgentHealth('agent one')).resolves.toEqual({
      success: true,
      healthy: true,
      status: 'ok',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/agents/agent%20one/health',
    );
  });

  it('polls until the agent reports healthy', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'booting' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, healthy: false }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, healthy: true, status: 'ready' }),
      } as Response);

    await expect(
      waitForAgentHealth('agent-1', { attempts: 3, intervalMs: 0 }),
    ).resolves.toEqual({
      success: true,
      healthy: true,
      status: 'ready',
    });

    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
