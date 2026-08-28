/**
 * @vitest-environment jsdom
 *
 * archive#1223 (offline) — reconnect invalidation.
 *
 * Mirrors ConnectionBannerSource.test.tsx's mock shape for `@kontourai/station-connect`
 * (same shared connection-status signal, no new offline detector).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSISTED_QUERY_KEY_PREFIXES } from '../lib/queryPersistence';

const connectionStatus: { status: 'connected' | 'connecting' | 'error' } = {
  status: 'connecting',
};

vi.mock('@kontourai/station-connect', () => ({
  useConnectionStatus: () => ({
    status: connectionStatus.status,
    checking: false,
    reason: null,
    blocked: false,
    recheck: vi.fn(),
  }),
}));

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  probeServerConnection: vi.fn(),
}));

import { useQueryCacheReconnectSync } from '../hooks/useQueryCacheReconnectSync';

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  connectionStatus.status = 'connecting';
});

describe('useQueryCacheReconnectSync', () => {
  it('invalidates every whitelisted query on the first successful connect after boot (connecting -> connected)', () => {
    connectionStatus.status = 'connecting';
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { rerender } = renderHook(() => useQueryCacheReconnectSync(), {
      wrapper: wrapper(queryClient),
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    connectionStatus.status = 'connected';
    rerender();

    for (const prefix of PERSISTED_QUERY_KEY_PREFIXES) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [prefix] });
    }
  });

  it('invalidates on an offline -> online reconnect', () => {
    connectionStatus.status = 'connected';
    const queryClient = new QueryClient();
    const { rerender } = renderHook(() => useQueryCacheReconnectSync(), {
      wrapper: wrapper(queryClient),
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    connectionStatus.status = 'error';
    rerender();
    expect(invalidateSpy).not.toHaveBeenCalled();

    connectionStatus.status = 'connected';
    rerender();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agents'] });
  });

/**
* archive#3069. These two drive REAL query state rather than only spying on
* the client: the defect was that an errored, non-persisted query had no
* path back to a refetch, so a spy on `invalidateQueries` could not have
* caught it — `invalidateQueries` was being called correctly the whole time,
* just never for these keys, and an invalidation of an observer-less query
* does not refetch it either way.
*/
  it('refetches a query that errored during the outage even though its key is not persisted', async () => {
    connectionStatus.status = 'error';
    const queryClient = new QueryClient();
// 'orchestration-sessions' is deliberately excluded from
// PERSISTED_QUERY_KEY_PREFIXES, so the whitelist path cannot reach it.
// It backs Home's "Recent work", the card observed stuck on-device.
    expect(PERSISTED_QUERY_KEY_PREFIXES as readonly string[]).not.toContain(
      'orchestration-sessions',
    );
    const queryFn = vi.fn().mockRejectedValue(new Error('unreachable'));
    await queryClient.prefetchQuery({
      queryKey: ['orchestration-sessions'],
      queryFn,
      retry: false,
    });
    expect(queryClient.getQueryState(['orchestration-sessions'])?.status).toBe(
      'error',
    );
    expect(queryFn).toHaveBeenCalledTimes(1);

    const { rerender } = renderHook(() => useQueryCacheReconnectSync(), {
      wrapper: wrapper(queryClient),
    });
    queryFn.mockResolvedValue(['session-1']);
    connectionStatus.status = 'connected';
    rerender();

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
// The refetch is in flight at that point; the card only clears once it
// lands, so assert the recovered state rather than just the call.
    await vi.waitFor(() =>
      expect(
        queryClient.getQueryState(['orchestration-sessions'])?.status,
      ).toBe('success'),
    );
  });

  it('leaves a query that already holds data alone, so reconnect is recovery and not a blanket refetch', async () => {
    connectionStatus.status = 'error';
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockResolvedValue(['ok']);
    await queryClient.prefetchQuery({
      queryKey: ['attention'],
      queryFn,
    });
    expect(queryFn).toHaveBeenCalledTimes(1);

    const { rerender } = renderHook(() => useQueryCacheReconnectSync(), {
      wrapper: wrapper(queryClient),
    });
    connectionStatus.status = 'connected';
    rerender();

    await Promise.resolve();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate on a transition that never reaches connected', () => {
    connectionStatus.status = 'connecting';
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { rerender } = renderHook(() => useQueryCacheReconnectSync(), {
      wrapper: wrapper(queryClient),
    });

    connectionStatus.status = 'error';
    rerender();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
