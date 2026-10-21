import { afterEach, expect, test, vi } from 'vitest';
import { inspectEnsemble } from '../client/ensembles';
import { setClientCredentialResolver } from '../client/http';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

test('inspection keeps the path in the bounded POST body and preserves scope refusal codes', async () => {
  const fetch = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          success: false,
          code: 'ensemble_inspection_stale',
          error: 'Source changed.',
        }),
        { status: 409 },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const input = { path: '/private/team.json', bindings: {} };
  await expect(
    inspectEnsemble('https://station.test', input),
  ).rejects.toMatchObject({ status: 409, code: 'ensemble_inspection_stale' });
  expect(fetch.mock.calls[0][0]).toBe(
    'https://station.test/api/orchestration/ensembles/inspect',
  );
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify(input),
  });
  expect(String(fetch.mock.calls[0][0])).not.toContain('/private');
});

test('the client refuses oversized input before transport and oversized output before JSON projection', async () => {
  const fetch = vi.fn(async () => new Response(' '.repeat(300_000)));
  vi.stubGlobal('fetch', fetch);
  await expect(
    inspectEnsemble('https://station.test', {
      path: 'x'.repeat(20_000),
      bindings: {},
    }),
  ).rejects.toThrow('byte limit');
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    inspectEnsemble('https://station.test', {
      path: '/team.json',
      bindings: {},
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a changed request authority cannot dispatch inspection under another caller', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  setClientCredentialResolver(() => ({
    credential: 'private',
    origin: 'https://station.test',
    requestAuthority: {
      apiBase: 'https://station.test',
      authorityKey: 'new-owner',
      isCurrent: () => true,
    },
  }));
  await expect(
    inspectEnsemble(
      'https://station.test',
      { path: '/team.json', bindings: {} },
      {
        requestScope: {
          apiBase: 'https://station.test',
          authorityKey: 'old-owner',
        },
      },
    ),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
