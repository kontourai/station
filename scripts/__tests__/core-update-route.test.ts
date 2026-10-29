/**
 * #3851: the browser fixtures' stub for the server update check must match
 * the URL the SDK really requests. A whole-URL glob stopped matching once
 * the check gained `?staged=1`, and the gallery's Settings capture then
 * waited on a live `git fetch` behind a loading skeleton.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { requestCoreUpdateStatus } from '../../packages/sdk/src/query-domains/systemRuntimeRequests';
import { routeCoreUpdateCheck } from '../../tests/helpers/core-update-route';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL the real SDK check fetches. */
async function sdkCheckUrl(): Promise<URL> {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ updateAvailable: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await requestCoreUpdateStatus('http://gallery.test');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new URL(String(fetchMock.mock.calls[0]?.[0]));
}

/** The matcher a fixture registers through the shared helper. */
async function registeredMatcher(): Promise<unknown> {
  let matcher: unknown;
  await routeCoreUpdateCheck(
    {
      route: async (url: unknown) => {
        matcher = url;
      },
    } as never,
    () => undefined,
  );
  return matcher;
}

test('the fixture stub matches the check the SDK actually sends, query included', async () => {
  const requested = await sdkCheckUrl();
  // Pinned beside the derived URL: the query is what a whole-URL glob missed.
  expect(requested.search).toBe('?staged=1');
  const matcher = await registeredMatcher();
  // A string is a Playwright glob over the WHOLE url; it cannot be trusted to
  // carry the query, so the helper must register a path predicate.
  expect(matcher).toBeTypeOf('function');
  const matches = matcher as (url: URL) => boolean;
  expect(matches(requested)).toBe(true);
  expect(matches(new URL('http://gallery.test/api/system/core-update'))).toBe(
    true,
  );
});

test('the stub leaves the update sub-routes to their own fixtures', async () => {
  const matches = (await registeredMatcher()) as (url: URL) => boolean;
  for (const path of [
    '/api/system/core-update/state',
    '/api/system/core-update/service-update?staged=1',
    '/api/system/core-update/restart-status',
    '/api/system/core-update/running-turns',
  ])
    expect(matches(new URL(`http://gallery.test${path}`)), path).toBe(false);
});

test('no browser fixture routes the check with a whole-URL glob', async () => {
  // Structural: the predicate above only protects fixtures that use it. A
  // string route ending at the bare path cannot match `?staged=1`.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = join(import.meta.dirname, '../../tests');
  const offenders: string[] = [];
  const stringRoute = /\.route\(\s*(['"`])[^'"`]*\/api\/system\/core-update\1/;
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.(ts|mts|mjs|js)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    if (stringRoute.test(readFileSync(path, 'utf8'))) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
