import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  acknowledgeAttentionItem,
  fetchAttention,
} from '../query-domains/attention';

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

  /**
   * #890 review. These two pin the discrimination `acknowledgeAttentionItem`
   * makes between the two ways an acknowledgement can come back non-2xx. Both
   * must hold together: the first alone would be satisfied by swallowing every
   * failure (the pre-#890 defect), the second alone by swallowing none (the
   * regression this pair exists to prevent).
   */
  it('treats the stale-item 404 as a no-op rather than a failure', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        success: false,
        error: 'Attention item is not acknowledgeable',
      }),
    } as Response);

    await expect(
      acknowledgeAttentionItem('session-failed:thread-1'),
    ).resolves.toBeUndefined();
  });

  it('still surfaces an acknowledgement that genuinely failed', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        error: 'Could not record dismissal',
      }),
    } as Response);

    await expect(
      acknowledgeAttentionItem('session-failed:thread-1'),
    ).rejects.toThrow('Could not record dismissal');
  });

  /**
   * The no-op is keyed to the server's message, not to the bare status, so a
   * 404 introduced later for a different reason is not silently absorbed.
   */
  it('propagates a 404 that is not the stale-item case', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        success: false,
        error: 'Attention projection is not mounted',
      }),
    } as Response);

    await expect(
      acknowledgeAttentionItem('session-failed:thread-1'),
    ).rejects.toThrow('Attention projection is not mounted');
  });
});
