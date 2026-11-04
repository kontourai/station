import { afterEach, expect, test, vi } from 'vitest';
import { getJson, setClientCredentialResolver } from '../client/http';

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('concurrent same-origin requests select and snapshot their own authority', async () => {
  const base = 'https://station.example.test';
  const a = { apiBase: base, authorityKey: 'profile-a' };
  const b = { apiBase: base, authorityKey: 'profile-b' };
  const seen: string[] = [];
  setClientCredentialResolver(async (selector) => {
    const scope = selector?.requestScope;
    if (!scope) return undefined;
    await Promise.resolve();
    seen.push(`${selector.url}:${scope.authorityKey}`);
    return {
      origin: base,
      credential: scope.authorityKey,
      requestAuthority: { ...scope, isCurrent: () => true },
    };
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const first = getJson(`${base}/api/a`, { requestScope: a });
  const second = getJson(`${base}/api/b`, { requestScope: b });
  a.authorityKey = 'changed';
  await Promise.all([first, second]);

  expect(seen).toEqual([`${base}/api/a:profile-a`, `${base}/api/b:profile-b`]);
  expect(
    new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization'),
  ).toBe('Bearer profile-a');
  expect(
    new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization'),
  ).toBe('Bearer profile-b');
});
