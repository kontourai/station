import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { fetchAttention } from '../query-domains/attention';

describe('attention SDK domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('loads the cross-session attention projection', async () => {
    const projection = {
      pendingCount: 1,
      items: [
        {
          id: 'needs_input:thread-1',
          kind: 'needs_input' as const,
          title: 'Input needed',
          createdAt: '2026-07-23T12:00:00.000Z',
          updatedAt: '2026-07-23T12:00:00.000Z',
          openHref: '/sessions?session=thread-1',
          source: { threadId: 'thread-1' },
        },
      ],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: projection }),
    } as Response);

    await expect(fetchAttention()).resolves.toEqual(projection);
    expect(fetch).toHaveBeenCalledWith('http://example.test/api/attention');
  });

  it('surfaces a safe API error instead of returning a malformed projection', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        success: false,
        error: 'Attention is temporarily unavailable',
      }),
    } as Response);

    await expect(fetchAttention()).rejects.toThrow(
      'Attention is temporarily unavailable',
    );
  });
});
