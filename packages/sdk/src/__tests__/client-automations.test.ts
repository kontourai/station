import { afterEach, expect, test, vi } from 'vitest';
import { StationHttpError } from '../client/api-error-message';
import { listAutomationDeliveries } from '../client/automations';

afterEach(() => vi.unstubAllGlobals());

test('preserves partial source coverage alongside bounded delivery history', async () => {
  const page = {
    deliveries: [],
    polls: [
      {
        sourceId: 'source-1',
        lastPolledAt: '2026-10-29T00:00:00Z',
        lastOutcome: 'partial',
      },
    ],
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ success: true, data: page }));
  vi.stubGlobal('fetch', fetcher);
  expect(
    await listAutomationDeliveries('http://station.test', { limit: 5 }),
  ).toEqual(page);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    'http://station.test/automations/deliveries?limit=5',
  );
});

test('preserves preview refusal details and distinguishes an older host', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            error: 'Enable GitHub automation observations in Settings.',
            code: 'feature_preview_disabled',
            previewId: 'github-automation-observations',
            settingsPath: '/settings?view=feature-previews',
          },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'Not found' }, { status: 404 }),
      ),
  );
  await expect(
    listAutomationDeliveries('http://station.test'),
  ).rejects.toMatchObject({
    status: 404,
    code: 'feature_preview_disabled',
    previewId: 'github-automation-observations',
  });
  await expect(listAutomationDeliveries('http://station.test')).rejects.toThrow(
    'not supported on this Station',
  );
});

test('non-JSON transport failures retain their HTTP status', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unavailable', { status: 503 })),
  );
  await expect(
    listAutomationDeliveries('http://station.test'),
  ).rejects.toBeInstanceOf(StationHttpError);
});
