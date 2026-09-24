// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  useProjectQuery,
  useProjectsQuery,
  useReorderProjectsMutation,
} from '../query-domains/workspaceProjects';

const scopeA = {
  apiBase: 'http://station.test',
  authorityKey: 'connection-a:generation-1',
};
const scopeB = {
  apiBase: 'http://station.test',
  authorityKey: 'connection-b:generation-2',
};

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function response(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }));
}

describe('Project query authority scope', () => {
  test('Project lists at one endpoint remain distinct across connection authorities', async () => {
    let active = scopeA;
    setClientCredentialResolver(() => ({
      origin: active.apiBase,
      requestAuthority: { ...active, isCurrent: () => true },
    }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response([{ slug: 'shared-slug', name: 'A' }]))
      .mockResolvedValueOnce(response([{ slug: 'shared-slug', name: 'B' }]));
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      ({ requestScope }) =>
        useProjectsQuery({ requestScope, requireRequestScope: true }),
      { wrapper: wrapper(client), initialProps: { requestScope: scopeA } },
    );
    await waitFor(() =>
      expect(observer.result.current.data).toEqual([
        { slug: 'shared-slug', name: 'A' },
      ]),
    );
    active = scopeB;
    observer.rerender({ requestScope: scopeB });
    expect(observer.result.current.data).toBeUndefined();
    await waitFor(() =>
      expect(observer.result.current.data).toEqual([
        { slug: 'shared-slug', name: 'B' },
      ]),
    );
    expect(client.getQueryData(['projects'])).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('same-origin authorities with colliding slugs stay partitioned and reject the late old body', async () => {
    let active = scopeA;
    setClientCredentialResolver(() => {
      const captured = active;
      return {
        origin: captured.apiBase,
        requestAuthority: {
          ...captured,
          isCurrent: () => active === captured,
        },
      };
    });
    let releaseA!: (value: Response) => void;
    let releaseB!: (value: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseA = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseB = resolve)),
      );
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      ({ requestScope }) =>
        useProjectQuery('shared-slug', {
          requestScope,
          requireRequestScope: true,
        }),
      { wrapper: wrapper(client), initialProps: { requestScope: scopeA } },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    active = scopeB;
    observer.rerender({ requestScope: scopeB });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(observer.result.current.data).toBeUndefined();
    await act(async () =>
      releaseB(response({ slug: 'shared-slug', name: 'B' })),
    );
    await waitFor(() =>
      expect(observer.result.current.data).toMatchObject({ name: 'B' }),
    );
    await act(async () =>
      releaseA(response({ slug: 'shared-slug', name: 'PRIVATE_A' })),
    );
    expect(observer.result.current.data).toMatchObject({ name: 'B' });
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain('PRIVATE_A');
  });

  test('missing required authority stays inert under manual refetch despite primed legacy data', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(['projects'], [{ slug: 'legacy-private' }]);
    client.setQueryData(['projects', 'shared-slug'], {
      slug: 'shared-slug',
      name: 'legacy-private',
    });
    const list = renderHook(
      () =>
        useProjectsQuery({
          requestScope: undefined,
          requireRequestScope: true,
          retry: false,
        }),
      { wrapper: wrapper(client) },
    );
    const detail = renderHook(
      () =>
        useProjectQuery('shared-slug', {
          requestScope: undefined,
          requireRequestScope: true,
          retry: false,
        }),
      { wrapper: wrapper(client) },
    );
    expect(list.result.current.data).toBeUndefined();
    expect(detail.result.current.data).toBeUndefined();
    await act(async () => {
      await expect(list.result.current.refetch()).resolves.toMatchObject({
        error: { name: 'StationRequestAuthorityError' },
      });
      await expect(detail.result.current.refetch()).resolves.toMatchObject({
        error: { name: 'StationRequestAuthorityError' },
      });
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('captures immutable authority scalars before a caller mutates its scope object', async () => {
    const mutableScope = { ...scopeA };
    setClientCredentialResolver(() => ({
      origin: scopeA.apiBase,
      requestAuthority: { ...scopeA, isCurrent: () => true },
    }));
    let releaseCaptured!: (value: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseCaptured = resolve)),
      )
      .mockRejectedValue(new Error('replacement authority withheld'));
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      () =>
        useProjectQuery('shared-slug', {
          requestScope: mutableScope,
          requireRequestScope: true,
          retry: false,
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    mutableScope.apiBase = 'http://attacker.test';
    mutableScope.authorityKey = 'replacement';
    await act(async () =>
      releaseCaptured(response({ slug: 'shared-slug', name: 'Captured' })),
    );
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'http://station.test/api/projects/shared-slug',
    );
    await waitFor(() =>
      expect(
        client.getQueryData([
          'projects',
          'shared-slug',
          'detail',
          scopeA.apiBase,
          scopeA.authorityKey,
        ]),
      ).toMatchObject({ name: 'Captured' }),
    );
    expect(observer.result.current.data).toBeUndefined();
    expect(
      client.getQueryData([
        'projects',
        'shared-slug',
        'detail',
        'http://attacker.test',
        'replacement',
      ]),
    ).toBeUndefined();
  });
});

describe('Project query durable authority identity (#481)', () => {
  const durable = 'v1|env=home|principal=human:alice|grant=operator';

  function resolvingFetch(
    fetch: ReturnType<typeof vi.fn>,
    data: unknown = [{ slug: 'shared-slug', name: 'A' }],
  ) {
    // Fresh Response per call: a body can only be read once, so a shared
    // mockResolvedValue starves every fetch after the first.
    fetch.mockImplementation(() => Promise.resolve(response(data)));
    vi.stubGlobal('fetch', fetch);
  }

  test('one durable id keeps one entry across live authority rotations (no refetch)', async () => {
    setClientCredentialResolver(() => ({
      origin: scopeA.apiBase,
      requestAuthority: { ...scopeA, isCurrent: () => true },
    }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    resolvingFetch(fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      ({ requestScope }) =>
        useProjectsQuery({
          requestScope,
          requireRequestScope: true,
          durableAuthorityId: durable,
        }),
      { wrapper: wrapper(client), initialProps: { requestScope: scopeA } },
    );
    await waitFor(() =>
      expect(observer.result.current.data).toEqual([
        { slug: 'shared-slug', name: 'A' },
      ]),
    );
    expect(fetch).toHaveBeenCalledTimes(1);

    // Same durable identity, rotated live authority: the STABLE entry is
    // reused, not refetched. (The wire scope still guards dispatch; the
    // key is what survives reloads.)
    observer.rerender({ requestScope: scopeB });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(observer.result.current.data).toEqual([
      { slug: 'shared-slug', name: 'A' },
    ]);
    expect(
      client.getQueryData(['projects', 'list', scopeA.apiBase, durable]),
    ).toEqual([{ slug: 'shared-slug', name: 'A' }]);
  });

  test('different durable ids partition one live authority', async () => {
    setClientCredentialResolver(() => ({
      origin: scopeA.apiBase,
      requestAuthority: { ...scopeA, isCurrent: () => true },
    }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    resolvingFetch(fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      ({ durableAuthorityId }: { durableAuthorityId: string }) =>
        useProjectsQuery({
          requestScope: scopeA,
          requireRequestScope: true,
          durableAuthorityId,
        }),
      { wrapper: wrapper(client), initialProps: { durableAuthorityId: 'a' } },
    );
    await waitFor(() => expect(observer.result.current.data).toBeDefined());
    observer.rerender({ durableAuthorityId: 'b' });
    await waitFor(() =>
      expect(
        client.getQueryData(['projects', 'list', scopeA.apiBase, 'b']),
      ).toBeDefined(),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('an empty durable id falls back to the live key (never a merged entry)', async () => {
    setClientCredentialResolver(() => ({
      origin: scopeA.apiBase,
      requestAuthority: { ...scopeA, isCurrent: () => true },
    }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    resolvingFetch(fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      () =>
        useProjectsQuery({
          requestScope: scopeA,
          requireRequestScope: true,
          durableAuthorityId: '',
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(observer.result.current.data).toBeDefined());
    expect(
      client.getQueryData([
        'projects',
        'list',
        scopeA.apiBase,
        scopeA.authorityKey,
      ]),
    ).toBeDefined();
    expect(
      client.getQueryData(['projects', 'list', scopeA.apiBase, '']),
    ).toBeUndefined();
  });

  test('the detail key honors the durable id', async () => {
    setClientCredentialResolver(() => ({
      origin: scopeA.apiBase,
      requestAuthority: { ...scopeA, isCurrent: () => true },
    }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    resolvingFetch(fetch, { slug: 'shared-slug', name: 'A' });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      () =>
        useProjectQuery('shared-slug', {
          requestScope: scopeA,
          requireRequestScope: true,
          durableAuthorityId: durable,
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() =>
      expect(observer.result.current.data).toMatchObject({ name: 'A' }),
    );
    expect(
      client.getQueryData([
        'projects',
        'shared-slug',
        'detail',
        scopeA.apiBase,
        durable,
      ]),
    ).toMatchObject({ name: 'A' });
  });

  test('a reorder with the same durable id settles the reader entry, not the live-key sibling', async () => {
    setClientCredentialResolver(() => ({
      origin: scopeA.apiBase,
      requestAuthority: { ...scopeA, isCurrent: () => true },
    }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockImplementation(async (input: unknown) => {
      if (String(input).endsWith('/api/projects/order')) {
        return response([]);
      }
      return response([{ slug: 'shared-slug', name: 'A' }]);
    });
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const durableEntry = ['projects', 'list', scopeA.apiBase, durable];
    const liveEntry = ['projects', 'list', scopeA.apiBase, scopeA.authorityKey];
    client.setQueryData(durableEntry, [
      { slug: 'b', name: 'b' },
      { slug: 'a', name: 'a' },
    ]);
    client.setQueryData(liveEntry, [{ slug: 'decoy', name: 'decoy' }]);

    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({
        order: ['a', 'b'],
        requestScope: scopeA,
        requireRequestScope: true,
        durableAuthorityId: durable,
      });
    });

    // Optimistic write + settle targeted the durable entry the reader owns.
    expect(client.getQueryData(durableEntry)).toEqual([
      { slug: 'a', name: 'a' },
      { slug: 'b', name: 'b' },
    ]);
    // The live-key sibling was never touched.
    expect(client.getQueryData(liveEntry)).toEqual([
      { slug: 'decoy', name: 'decoy' },
    ]);
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).endsWith('/api/projects/order'),
      ),
    ).toHaveLength(1);
  });
});
