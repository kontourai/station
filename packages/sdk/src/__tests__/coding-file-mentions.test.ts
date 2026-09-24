import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { fetchCodingFileMentionCandidates } from '../query-domains/chatRuntimeCoding';

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('binds the bounded search request to the captured authority and exact URL', async () => {
  const scope = {
    apiBase: 'https://station.test',
    authorityKey: 'person-device-generation',
    isCurrent: () => true,
  };
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: scope,
  }));
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }],
        scanTruncated: false,
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);

  await expect(
    fetchCodingFileMentionCandidates(
      { projectSlug: 'acme', workingDir: '/repo one' },
      'a b',
      scope,
    ),
  ).resolves.toEqual({
    entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }],
    partial: false,
  });
  expect(String(fetch.mock.calls[0][0])).toBe(
    'https://station.test/api/coding/files/search?projectSlug=acme&path=%2Frepo%20one&query=a%20b&maxResults=201',
  );
});

test('rejects a late response after the captured authority is revoked', async () => {
  let current = true;
  const scope = {
    apiBase: 'https://station.test',
    authorityKey: 'epoch-a',
    isCurrent: () => current,
  };
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: scope,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      current = false;
      return new Response(
        JSON.stringify({
          success: true,
          data: [],
          scanTruncated: false,
        }),
      );
    }),
  );

  await expect(
    fetchCodingFileMentionCandidates(
      { projectSlug: 'acme', workingDir: '/repo' },
      'a',
      scope,
    ),
  ).rejects.toThrow();
});
