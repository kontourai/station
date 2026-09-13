/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useCoreUpdateStatusQuery } from '../query-domains/systemRuntime';

/**
 * update-ux PR4: the source check's correlation scope. A completion from an
 * aborted or superseded scope must never resolve as current data — asserted
 * against BOTH the waiting caller's result and the canonical cache (a caller
 * left unresolved or a cache quietly populated are both failures).
 */

const API_BASE = 'http://station.test:3242';
const QUERY_KEY = ['core-update-check', API_BASE, 'scope-a'] as const;

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

const VALID_STATUS = {
  installKind: 'source-checkout',
  branch: 'main',
  behind: 1,
  ahead: 0,
  updateAvailable: true,
};

describe('useCoreUpdateStatusQuery scope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('a current scope resolves and lands in its own keyed cache entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID_STATUS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderHook(
      () =>
        useCoreUpdateStatusQuery(
          API_BASE,
          { enabled: true },
          { scopeKey: 'scope-a', assertCurrent: () => true },
        ),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.behind).toBe(1);
    // The abort signal reaches the wire: a superseded scope's request can be
    // cancelled, not merely ignored on arrival.
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/system/core-update`,
      { signal: expect.any(AbortSignal) },
    );
    expect(client.getQueryData(QUERY_KEY)).toMatchObject({
      updateAvailable: true,
    });
    client.clear();
  });

  test('an obsolete scope rejected before the request never reaches the wire', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderHook(
      () =>
        useCoreUpdateStatusQuery(
          API_BASE,
          { enabled: true },
          {
            scopeKey: 'scope-a',
            assertCurrent: () => {
              throw new Error('scope superseded before issue');
            },
          },
        ),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe(
      'scope superseded before issue',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getQueryData(QUERY_KEY)).toBeUndefined();
    client.clear();
  });

  test('a completion that went stale in flight never resolves as current data', async () => {
    let current = true;
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderHook(
      () =>
        useCoreUpdateStatusQuery(
          API_BASE,
          { enabled: true },
          {
            scopeKey: 'scope-a',
            assertCurrent: () => {
              if (!current) throw new Error('scope superseded in flight');
            },
          },
        ),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    // The scope is superseded while the request is in flight, then the
    // response arrives anyway — the exact A→B ordering the assertion guards.
    current = false;
    await act(async () => {
      resolveFetch?.(
        new Response(JSON.stringify(VALID_STATUS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe(
      'scope superseded in flight',
    );
    expect(result.current.data).toBeUndefined();
    expect(client.getQueryData(QUERY_KEY)).toBeUndefined();
    client.clear();
  });

  test('the per-attempt abort signal is forwarded from the query', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      if (init?.signal) signals.push(init.signal as AbortSignal);
      return new Promise(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { unmount } = renderHook(
      () =>
        useCoreUpdateStatusQuery(
          API_BASE,
          { enabled: true },
          { scopeKey: 'scope-a', assertCurrent: () => true },
        ),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(signals.length).toBe(1));
    unmount();
    // Unmounting cancels the in-flight attempt through the forwarded signal.
    await waitFor(() => expect(signals[0].aborted).toBe(true));
    client.clear();
  });
});
