import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  fetchIntegrationStatus,
  IntegrationStatusUnsupportedError,
} from '../query-domains/integrationStatus';

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('integration status SDK', () => {
  test('reads and validates the computed status from the selected Station', async () => {
    const status = {
      connections: [
        {
          connectionId: 'github',
          provider: 'github',
          actions: [
            {
              action: 'read',
              computedBy: 'github.gh-auth-status',
              state: 'unverified',
              reason: 'Repository access has not been checked.',
            },
          ],
        },
      ],
    };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: status })),
    );
    expect(await fetchIntegrationStatus('https://station.example')).toEqual(
      status,
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'https://station.example/api/integrations/status',
    );
  });

  test('rejects missing computation and treats an older host 404 as unsupported', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            connections: [
              {
                connectionId: 'github',
                provider: 'github',
                actions: [{ action: 'read', state: 'works', reason: 'ready' }],
              },
            ],
          },
        }),
      ),
    );
    await expect(
      fetchIntegrationStatus('https://station.example'),
    ).rejects.toThrow('invalid or unsupported');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(
      fetchIntegrationStatus('https://station.example'),
    ).rejects.toBeInstanceOf(IntegrationStatusUnsupportedError);
  });
});
