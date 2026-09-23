/**
 * @vitest-environment jsdom
 */

/**
 * station#2327 — these read hooks used to call their fetchers without the
 * signal react-query hands every attempt. Cancelling the query then only made
 * query-core stop listening: the request itself kept running, and on desktop
 * it kept its place in the native broker's bounded queue behind a stalled
 * Station. Each case mounts the REAL hook, waits for the request to be
 * issued, cancels the query, and asserts the request's own signal aborted.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/http')>()),
  authenticatedFetch: mocks.authenticatedFetch,
}));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  _getApiBase: async () => 'https://station.test',
}));

import { useLiveActivityQuery } from '../query-domains/liveActivity';
import {
  useAuthStatusQuery,
  useBrandingQuery,
  useFleetRoutingReceiptsQuery,
  useFleetServeReceiptsQuery,
  useMonitoringMetricsQuery,
  useMonitoringStatsQuery,
  useServerCapabilitiesQuery,
  useSystemStatusQuery,
} from '../query-domains/systemRuntime';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  mocks.authenticatedFetch.mockReset();
  // A Station that never answers: the request settles only if its own signal
  // aborts, which is exactly the property under test.
  mocks.authenticatedFetch.mockImplementation(
    (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
  );
});

const cases: Array<[string, () => unknown]> = [
  ['useServerCapabilitiesQuery', () => useServerCapabilitiesQuery()],
  ['useLiveActivityQuery', () => useLiveActivityQuery()],
  ['useSystemStatusQuery', () => useSystemStatusQuery()],
  ['useAuthStatusQuery', () => useAuthStatusQuery()],
  ['useMonitoringStatsQuery', () => useMonitoringStatsQuery()],
  ['useMonitoringMetricsQuery', () => useMonitoringMetricsQuery('today')],
  ['useFleetRoutingReceiptsQuery', () => useFleetRoutingReceiptsQuery()],
  ['useFleetServeReceiptsQuery', () => useFleetServeReceiptsQuery()],
  ['useBrandingQuery', () => useBrandingQuery()],
];

describe('read hooks forward the query signal to the request (station#2327)', () => {
  test.each(cases)(
    '%s: cancelling the query aborts its request',
    async (_name, useHook) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      renderHook(useHook, { wrapper: wrapperFor(client) });

      await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalled());
      const init = mocks.authenticatedFetch.mock.calls[0]?.[1] as
        | RequestInit
        | undefined;
      const requestSignal = init?.signal;
      expect(requestSignal, 'the request carries a signal').toBeInstanceOf(
        AbortSignal,
      );
      expect(requestSignal?.aborted).toBe(false);

      await client.cancelQueries();

      expect(requestSignal?.aborted).toBe(true);
      client.clear();
    },
  );
});
