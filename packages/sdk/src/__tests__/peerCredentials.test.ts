import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { fetchPeerCredentials } from '../query-domains/peerCredentials';

function mockJsonResponse(payload: unknown, ok = true) {
  vi.mocked(fetch).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  } as Response);
}

describe('Peer credentials SDK domain (station#settings-revamp slice 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('loads the outbound peer-credential summaries from the protected API', async () => {
    mockJsonResponse({
      success: true,
      data: [
        {
          environmentId: 'box-b',
          apiBase: 'https://box-b.tailnet.ts.net',
          scope: 'orchestration:operate',
          label: 'Box B',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    await expect(fetchPeerCredentials()).resolves.toEqual([
      {
        environmentId: 'box-b',
        apiBase: 'https://box-b.tailnet.ts.net',
        scope: 'orchestration:operate',
        label: 'Box B',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/environments/peers',
    );
  });

  it('surfaces the envelope error message when the server reports success:false', async () => {
    mockJsonResponse({
      success: false,
      error: 'Peer credentials are not available to this caller',
    });

    await expect(fetchPeerCredentials()).rejects.toThrow(
      'Peer credentials are not available to this caller',
    );
  });

  it('surfaces a generic failure when the response is not ok and carries no error message (e.g. a 403 from a non-operator caller)', async () => {
    mockJsonResponse({ success: false }, false);

    await expect(fetchPeerCredentials()).rejects.toThrow(
      'Peer credentials request failed',
    );
  });
});
