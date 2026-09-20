/**
 * @vitest-environment jsdom
 *
 * station#3315 — `useReorderProjectsMutation`'s optimistic write and its
 * rollback. Independent fault injection deleted the `onError` rollback and no
 * suite noticed: nothing exercised the mutation's cache lifecycle at all. A
 * failed reorder that leaves the optimistic order in the cache is the sidebar
 * showing an order the server never accepted, so the rollback is pinned here
 * against an exact prior order that name-sorting cannot reproduce.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { reorderProjectsMock } = vi.hoisted(() => ({
  reorderProjectsMock: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

vi.mock('../client/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/projects')>()),
  reorderProjects: (...args: unknown[]) => reorderProjectsMock(...args),
}));

import { useReorderProjectsMutation } from '../query-domains/workspaceProjects';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

// Deliberately NOT in name order: a rollback that merely re-sorted by name
// would produce alder/birch/cedar and pass a weaker assertion.
const PREVIOUS = [
  { slug: 'birch', name: 'Birch' },
  { slug: 'cedar', name: 'Cedar' },
  { slug: 'alder', name: 'Alder' },
];

function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  client.setQueryData(['projects'], PREVIOUS);
  return client;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useReorderProjectsMutation cache lifecycle (station#3315)', () => {
  test('applies the requested order optimistically, then restores the exact prior order when the server rejects', async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    reorderProjectsMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );

    const client = seededClient();
    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate(['cedar', 'alder', 'birch']);
    });

    // Optimistic: the cache reflects the drag before the server answers.
    await waitFor(() =>
      expect(
        client
          .getQueryData<{ slug: string }[]>(['projects'])
          ?.map((p) => p.slug),
      ).toEqual(['cedar', 'alder', 'birch']),
    );

    act(() => {
      rejectRequest?.(new Error('order rejected'));
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(['projects'])).toEqual(PREVIOUS);
  });

  test('reports the rejection to the caller and keeps the persisted order on success', async () => {
    const onError = vi.fn();
    reorderProjectsMock.mockRejectedValueOnce(new Error('order rejected'));

    const client = seededClient();
    const { result, rerender } = renderHook(
      () => useReorderProjectsMutation({ onError }),
      { wrapper: wrapperFor(client) },
    );

    act(() => {
      result.current.mutate(['cedar', 'alder', 'birch']);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onError).toHaveBeenCalledWith(expect.any(Error), [
      'cedar',
      'alder',
      'birch',
    ]);
    expect(client.getQueryData(['projects'])).toEqual(PREVIOUS);

    // A successful reorder keeps the optimistic order — no rollback fires.
    reorderProjectsMock.mockResolvedValueOnce([]);
    rerender();
    act(() => {
      result.current.mutate(['alder', 'cedar', 'birch']);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client.getQueryData<{ slug: string }[]>(['projects'])?.map((p) => p.slug),
    ).toEqual(['alder', 'cedar', 'birch']);
  });
});

describe('useReorderProjectsMutation captured-authority reorder (#481)', () => {
  const scopeA = {
    apiBase: 'http://station.test',
    authorityKey: 'home-a:gen-1',
  };
  const scopeB = {
    apiBase: 'http://station.test',
    authorityKey: 'home-b:gen-2',
  };
  const listA = [
    { slug: 'shared', name: 'A first' },
    { slug: 'other', name: 'A second' },
  ];
  const listB = [
    { slug: 'other', name: 'B first' },
    { slug: 'shared', name: 'B second' },
  ];

  function seededTwoHomeClient(): QueryClient {
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    client.setQueryData(
      ['projects', 'list', scopeA.apiBase, scopeA.authorityKey],
      listA,
    );
    client.setQueryData(
      ['projects', 'list', scopeB.apiBase, scopeB.authorityKey],
      listB,
    );
    return client;
  }

  test('normal order optimism: the captured authority list reorders optimistically and settles there', async () => {
    reorderProjectsMock.mockResolvedValueOnce([]);
    const client = seededTwoHomeClient();
    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate({
        order: ['other', 'shared'],
        requestScope: scopeA,
        requireRequestScope: true,
      });
    });

    // Optimistic: visible on the scoped key before the server answers.
    await waitFor(() =>
      expect(
        client
          .getQueryData<{ slug: string }[]>([
            'projects',
            'list',
            scopeA.apiBase,
            scopeA.authorityKey,
          ])
          ?.map((p) => p.slug),
      ).toEqual(['other', 'shared']),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The request went to the CAPTURED origin with the CAPTURED scope —
    // never an ambient _getApiBase() resolution.
    expect(reorderProjectsMock).toHaveBeenCalledWith(
      scopeA.apiBase,
      ['other', 'shared'],
      { requestScope: scopeA },
    );
    // Settle invalidates only the captured authority's entry.
    expect(
      client.getQueryState([
        'projects',
        'list',
        scopeA.apiBase,
        scopeA.authorityKey,
      ])?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState([
        'projects',
        'list',
        scopeB.apiBase,
        scopeB.authorityKey,
      ])?.isInvalidated ?? false,
    ).toBe(false);
  });

  test('two homes with colliding ids: reordering home A never touches home B', async () => {
    reorderProjectsMock.mockResolvedValueOnce([]);
    const client = seededTwoHomeClient();
    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate({
        order: ['other', 'shared'],
        requestScope: scopeA,
        requireRequestScope: true,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Home B's cache entry is byte-identical to its pre-reorder content.
    expect(
      client.getQueryData([
        'projects',
        'list',
        scopeB.apiBase,
        scopeB.authorityKey,
      ]),
    ).toEqual(listB);
  });

  test('a pending reorder for home A that FAILS after home B reordered rolls back A only', async () => {
    let rejectA: ((error: Error) => void) | undefined;
    reorderProjectsMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    reorderProjectsMock.mockResolvedValueOnce([]);
    const client = seededTwoHomeClient();
    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapperFor(client),
    });

    // Home A starts a reorder and stays pending.
    act(() => {
      result.current.mutate({
        order: ['other', 'shared'],
        requestScope: scopeA,
        requireRequestScope: true,
      });
    });
    await waitFor(() =>
      expect(
        client
          .getQueryData<{ slug: string }[]>([
            'projects',
            'list',
            scopeA.apiBase,
            scopeA.authorityKey,
          ])
          ?.map((p) => p.slug),
      ).toEqual(['other', 'shared']),
    );

    // The user switches to home B and reorders there; B settles successfully.
    act(() => {
      result.current.mutate({
        order: ['shared', 'other'],
        requestScope: scopeB,
        requireRequestScope: true,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client
        .getQueryData<{ slug: string }[]>([
          'projects',
          'list',
          scopeB.apiBase,
          scopeB.authorityKey,
        ])
        ?.map((p) => p.slug),
    ).toEqual(['shared', 'other']);

    // NOW home A's old request fails: its rollback must clobber ONLY A.
    act(() => {
      rejectA?.(new Error('stale home A rejected'));
    });
    // A's late failure rolls back A to its exact prior order. (The shared
    // mutation hook's isError reflects the LATEST call — home B, which
    // succeeded — so the rollback itself is the observable here.)
    await waitFor(() =>
      expect(
        client.getQueryData([
          'projects',
          'list',
          scopeA.apiBase,
          scopeA.authorityKey,
        ]),
      ).toEqual(listA),
    );
    expect(
      client
        .getQueryData<{ slug: string }[]>([
          'projects',
          'list',
          scopeB.apiBase,
          scopeB.authorityKey,
        ])
        ?.map((p) => p.slug),
    ).toEqual(['shared', 'other']);
  });

  test('missing required authority rejects before the request and before any cache work', async () => {
    const client = seededTwoHomeClient();
    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate({
        order: ['shared', 'other'],
        requireRequestScope: true,
      });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.name).toBe('StationRequestAuthorityError');
    expect(reorderProjectsMock).not.toHaveBeenCalled();
    expect(
      client.getQueryData([
        'projects',
        'list',
        scopeA.apiBase,
        scopeA.authorityKey,
      ]),
    ).toEqual(listA);
    expect(
      client.getQueryData([
        'projects',
        'list',
        scopeB.apiBase,
        scopeB.authorityKey,
      ]),
    ).toEqual(listB);
  });

  test('legacy bare-array variables keep the ambient path and legacy cache surface', async () => {
    reorderProjectsMock.mockResolvedValueOnce([]);
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    client.setQueryData(['projects'], PREVIOUS);
    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate(['cedar', 'alder', 'birch']);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reorderProjectsMock).toHaveBeenCalledWith('http://example.test', [
      'cedar',
      'alder',
      'birch',
    ]);
    expect(
      client.getQueryData<{ slug: string }[]>(['projects'])?.map((p) => p.slug),
    ).toEqual(['cedar', 'alder', 'birch']);
  });
});
