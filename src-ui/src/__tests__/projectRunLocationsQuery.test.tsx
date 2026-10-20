// @vitest-environment jsdom
/**
 * #3391 review: the start composer's run-locations read is live state. It
 * must refetch on a mount once its answer is stale, even though Station's
 * client defaults never refetch on mount, and it must never be written to
 * the persisted (IndexedDB) query cache, which replays `'projects'` reads
 * across reloads for up to a day.
 */
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { stationQueryDefaults } from '../lib/queryDefaults';
import { shouldPersistQuery } from '../lib/queryPersistence';

const scope = {
  apiBase: 'http://station.test',
  authorityKey: 'connection-a:generation-1',
  isCurrent: () => true,
};

vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => scope,
}));
vi.mock('../contexts/AuthorityPersistenceContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuthorityPersistence: () => ({ namespace: 'ns-1' }),
}));

const { useScopedProjectRunLocationsQuery } = await import(
  '../contexts/ProjectsContext'
);

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function setup() {
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: scope,
  }));
  let answer = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    answer += 1;
    return new Response(
      JSON.stringify({
        success: true,
        data: { mono: { kind: 'folder', path: `/work/mono-${answer}` } },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { ...stationQueryDefaults(), retry: false } },
  });
  return { client, fetch };
}

test('a mount refetches run locations once the answer is stale, despite the app’s no-refetch-on-mount default', async () => {
  const { client, fetch } = setup();
  const first = renderHook(() => useScopedProjectRunLocationsQuery(), {
    wrapper: wrapper(client),
  });
  await waitFor(() =>
    expect(first.result.current.data).toEqual({
      mono: { kind: 'folder', path: '/work/mono-1' },
    }),
  );
  first.unmount();

  // Within the stale time a remount keeps the cached answer.
  const fresh = renderHook(() => useScopedProjectRunLocationsQuery(), {
    wrapper: wrapper(client),
  });
  expect(fresh.result.current.data).toEqual({
    mono: { kind: 'folder', path: '/work/mono-1' },
  });
  fresh.unmount();
  expect(fetch).toHaveBeenCalledTimes(1);

  // Past it, a remount asks again.
  const later = Date.now() + 31_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  const stale = renderHook(() => useScopedProjectRunLocationsQuery(), {
    wrapper: wrapper(client),
  });
  await waitFor(() =>
    expect(stale.result.current.data).toEqual({
      mono: { kind: 'folder', path: '/work/mono-2' },
    }),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('run locations are never written to the persisted query cache', async () => {
  const { client } = setup();
  const view = renderHook(() => useScopedProjectRunLocationsQuery(), {
    wrapper: wrapper(client),
  });
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

  const queries = client.getQueryCache().getAll();
  expect(queries).toHaveLength(1);
  expect(queries[0].state.status).toBe('success');
  expect(shouldPersistQuery(queries[0])).toBe(false);
});
