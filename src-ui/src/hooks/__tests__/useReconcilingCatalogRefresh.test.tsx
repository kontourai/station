/**
 * @vitest-environment jsdom
 *
 * The new-chat picker fetches the enriched agents list once per mount while
 * the server serves its last stable snapshot throughout post-write
 * reconciliation. Without a refresh, a just-created agent misses the picker
 * for the whole cache lifetime (observed live: pr-smoke's seeded agent never
 * rendered its row on loaded hosted runners). This suite pins the refresh
 * contract: a reconciling read re-arms exactly one delayed refetch, a stable
 * read schedules nothing, and unmount cancels the pending timer.
 */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useReconcilingCatalogRefresh } from '../useNewChatSelectionModel';

afterEach(() => {
  vi.useRealTimers();
});

describe('useReconcilingCatalogRefresh', () => {
  test('joins an active catalog read instead of starting overlapping transport work', async () => {
    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const snapshot = { catalogState: 'reconciling', agents: [] };
    const key = ['reconciling-catalog-overlap'];
    client.setQueryData(key, snapshot);
    let complete!: (value: typeof snapshot) => void;
    // The agents SDK read does not consume Query's abort signal. A cancelled
    // query operation would leave this transport work running underneath it.
    const read = vi.fn(
      () =>
        new Promise<typeof snapshot>((resolve) => {
          complete = resolve;
        }),
    );
    const view = renderHook(
      () => {
        const catalog = useQuery({ queryKey: key, queryFn: read });
        useReconcilingCatalogRefresh(
          catalog.data?.catalogState,
          catalog.dataUpdatedAt,
          catalog.refetch,
        );
      },
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await act(async () => {
      void client.refetchQueries({ queryKey: key });
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(read).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      complete(snapshot);
    });
    client.clear();
  });
  test('a reconciling read schedules exactly one refetch after the delay', () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    renderHook(() =>
      useReconcilingCatalogRefresh(
        'reconciling',
        { agents: [] },
        refetch,
        1000,
      ),
    );
    expect(refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('a stable read schedules no refetch', () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    renderHook(() =>
      useReconcilingCatalogRefresh(undefined, { agents: [] }, refetch, 1000),
    );
    vi.advanceTimersByTime(60_000);
    expect(refetch).not.toHaveBeenCalled();
  });

  test('a second reconciling response re-arms the refetch (polls to convergence)', () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    const { rerender } = renderHook(
      ({ data }) =>
        useReconcilingCatalogRefresh('reconciling', data, refetch, 1000),
      { initialProps: { data: { revision: 1 } } },
    );
    vi.advanceTimersByTime(1000);
    expect(refetch).toHaveBeenCalledTimes(1);
    // A fresh reconciling payload is a new object identity: without `data`
    // in the effect deps the loop would stop after the first fire and the
    // picker would still miss the agent.
    rerender({ data: { revision: 2 } });
    vi.advanceTimersByTime(1000);
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  test('converging to stable stops further refetches', () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    const { rerender } = renderHook(
      ({ state }) =>
        useReconcilingCatalogRefresh(state, { agents: [] }, refetch, 1000),
      { initialProps: { state: 'reconciling' as string | undefined } },
    );
    vi.advanceTimersByTime(1000);
    expect(refetch).toHaveBeenCalledTimes(1);
    rerender({ state: undefined });
    vi.advanceTimersByTime(60_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('unmount cancels the pending refetch', () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    const { unmount } = renderHook(() =>
      useReconcilingCatalogRefresh(
        'reconciling',
        { agents: [] },
        refetch,
        1000,
      ),
    );
    unmount();
    vi.advanceTimersByTime(60_000);
    expect(refetch).not.toHaveBeenCalled();
  });
});
