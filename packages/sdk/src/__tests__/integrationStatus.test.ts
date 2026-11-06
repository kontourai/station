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

test('CLI metadata is an explicit request; an older response remains readable with missing metadata', async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ success: true, data: { connections: [] } }),
  );
  expect(
    await fetchIntegrationStatus('https://station.example', {
      includeGithubAuthentication: true,
    }),
  ).toEqual({ connections: [] });
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
    'https://station.example/api/integrations/status?include=github-authentication',
  );
});

test('preview-off metadata preserves the Settings remedy instead of telling the user to update the host', async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json(
      {
        success: false,
        code: 'feature_preview_disabled',
        error:
          'Enable Repository sign-in details in Settings → Advanced → Feature previews.',
      },
      { status: 404 },
    ),
  );
  await expect(
    fetchIntegrationStatus('https://station.example', {
      includeGithubAuthentication: true,
    }),
  ).rejects.toThrow('Enable Repository sign-in details');
});
