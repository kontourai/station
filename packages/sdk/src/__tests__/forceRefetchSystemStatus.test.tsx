/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  useForceRefetchSystemStatus,
  useSystemStatusForApiBaseQuery,
} from '../query-domains/systemRuntime';

/**
 * These run against a REAL QueryClient and a real fetch call path, on purpose.
 *
 * The defect this file exists for was invisible to every mocked test. The
 * connect screen's "Try again" called `refetch()`; a mocked `refetch` recorded
 * the call and the assertion passed — while no new network attempt ever
 * happened. query-core gates its cancel-and-restart on
 * `state.data !== undefined` (`query.ts`'s `fetch()`), so on a query that has
 * never loaded — exactly the never-connected state behind the connect screen —
 * a mid-flight `refetch()` falls through to `continueRetry()` and re-attaches
 * to the attempt already running.
 *
 * Only a real client with an observable request path can tell "the handler is
 * wired" apart from "a request was actually made", which is the whole
 * distinction the button's honesty rests on.
 */

const API_BASE = 'http://station.test:3242';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function renderBoth(client: QueryClient) {
  return renderHook(
    () => ({
      query: useSystemStatusForApiBaseQuery(API_BASE),
      force: useForceRefetchSystemStatus(API_BASE),
    }),
    { wrapper: wrapperFor(client) },
  );
}

describe('useForceRefetchSystemStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('starts a genuinely new request while the first is still in flight', async () => {
    // Never settles on its own, so the query stays pending and every started
    // attempt shows up as one more fetch call.
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderBoth(client);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The precondition that makes a bare refetch a no-op: still pending, and
    // no data has ever been held under this key.
    expect(result.current.query.isLoading).toBe(true);
    expect(result.current.query.data).toBeUndefined();

    await act(async () => {
      void result.current.force();
    });

    // The whole point. A bare `refetch()` here leaves this at 1.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

    client.clear();
  });

  test('aborts the abandoned request instead of leaving it in flight', async () => {
    // cancelQueries only makes query-core stop listening. Unless the queryFn
    // forwards react-query's per-attempt signal, the fetch it walked away from
    // keeps running against the host until its own 5s timeout — one orphaned
    // request per click of "Try again".
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      if (init?.signal) signals.push(init.signal as AbortSignal);
      return new Promise(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderBoth(client);
    await waitFor(() => expect(signals.length).toBe(1));
    expect(signals[0].aborted).toBe(false);

    await act(async () => {
      void result.current.force();
    });

    await waitFor(() => expect(signals[0].aborted).toBe(true));

    client.clear();
  });

  test('still refetches when nothing is in flight to cancel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ready: true, prerequisites: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderBoth(client);
    await waitFor(() => expect(result.current.query.isLoading).toBe(false));
    const settled = fetchMock.mock.calls.length;

    await act(async () => {
      await result.current.force();
    });

    // Cancelling an idle query must be harmless rather than wedging the hook:
    // the refetch still goes out.
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(settled),
    );

    client.clear();
  });

  test('revalidates a fresh persisted status when the app remounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ready: true, prerequisites: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          // Keep the cached value fresh to prove the hook's explicit
          // refetchOnMount policy wins over stale-time caching.
          staleTime: 60_000,
        },
      },
    });

    const first = renderHook(() => useSystemStatusForApiBaseQuery(API_BASE), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useSystemStatusForApiBaseQuery(API_BASE), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    second.unmount();
    client.clear();
  });

  /**
   * fix-round M-3: `resolveSystemStatusRefetchInterval` got the terminal
   * split, but `useSystemStatusForApiBaseQuery` — behind the connect/pairing
   * screen, where a stale or rejected credential is the single most common
   * error — still had a flat `retry: 2` burning two more attempts against a
   * 401 before the interval resolver ever got a say. Deliberately does NOT
   * override `retry` in the client defaults, so this proves the query's OWN
   * `retry: shouldRetrySystemStatus` is what stops it, not a test-harness
   * default masking a hook that still retries.
   */
  test('does not retry a 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: 0 } },
    });

    renderHook(() => useSystemStatusForApiBaseQuery(API_BASE), {
      wrapper: wrapperFor(client),
    });

    // Deliberately does not wait for `isError` first: under `retry: 2` the
    // query is still mid-retry (isLoading, not yet isError) well past
    // `waitFor`'s default real timeout, since the first retry alone waits
    // out `retryDelay`'s attempt-0 value (1000ms). Wait for the first
    // request directly instead.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Past the first retry delay (1000ms) — a query that was still retrying
    // would have made a second attempt by now.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    client.clear();
  });
});
