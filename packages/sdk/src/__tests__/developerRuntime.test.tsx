/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));
vi.mock('../client/http', () => ({ authenticatedFetch }));

import { useServerLogsQuery } from '../query-domains/developerRuntime';

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

describe('useServerLogsQuery', () => {
  test('keeps cached logs scoped to the API authority in its key and requests that authority', async () => {
    authenticatedFetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify({
            entries: [{ msg: url.includes('station-a') ? 'from A' : 'from B' }],
            truncated: false,
            scannedFiles: 0,
            unreadableFiles: 0,
            oldestScannedDay: null,
            skippedMalformedLines: 0,
            scanBudgetExhausted: false,
          }),
        ),
    );
    const mounted = renderHook(
      ({ apiBase }) => useServerLogsQuery(apiBase, { limit: 100 }),
      { initialProps: { apiBase: 'https://station-a.example.test' }, wrapper },
    );
    await waitFor(() =>
      expect(mounted.result.current.data?.entries[0].msg).toBe('from A'),
    );

    mounted.rerender({ apiBase: 'https://station-b.example.test' });
    await waitFor(() =>
      expect(mounted.result.current.data?.entries[0].msg).toBe('from B'),
    );

    expect(authenticatedFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://station-a.example.test/api/diagnostics/logs?limit=100',
      'https://station-b.example.test/api/diagnostics/logs?limit=100',
    ]);
  });
});
