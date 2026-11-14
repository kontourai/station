/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { useCliSessionGroupsQuery } from '../query-domains/cliSessionGroups';
import { useReportGroupsQuery } from '../query-domains/reportGroups';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

test.each([
  ['CLI', useCliSessionGroupsQuery],
  ['report', useReportGroupsQuery],
] as const)(
  '%s group lists poll healthy reads and stop after an error',
  async (_kind, useGroups) => {
    vi.useFakeTimers();
    const scope = {
      apiBase: 'https://group-poll.test',
      authorityKey: 'operator',
      isCurrent: () => true,
    };
    setClientCredentialResolver(() => ({
      origin: scope.apiBase,
      credential: 'controlled',
      requestAuthority: scope,
    }));
    let fail = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            fail
              ? { success: false, error: 'Unavailable' }
              : {
                  success: true,
                  data: { groups: [], nextGroupId: null, hasMore: false },
                },
          ),
          {
            status: fail ? 503 : 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = renderHook(() => useGroups(scope, { enabled: true }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(view.result.current.isSuccess).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    fail = true;
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(view.result.current.isError).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetch).toHaveBeenCalledTimes(3);
    view.unmount();
    client.clear();
  },
);
