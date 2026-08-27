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
