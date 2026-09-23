/**
 * @vitest-environment jsdom
 *
 * #2323 S4: the local plugin source status query. Driven through the real
 * hook and a real QueryClient against real `Response` objects.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../api', () => ({ _getApiBase: async () => 'http://station.test' }));
vi.mock('../client/http', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const { usePluginLocalSourcesQuery } = await import(
  '../query-domains/pluginLocalSources'
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function mount(queryClient: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePluginLocalSourcesQuery(), { wrapper });
}

beforeEach(() => {
  authenticatedFetch.mockReset();
});

test('a 404 (not the operator) reads as no sources, never as a status', async () => {
  authenticatedFetch.mockResolvedValue(json({ error: 'Not found' }, 404));
  const { result } = mount(new QueryClient());
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual([]);
  expect(authenticatedFetch).toHaveBeenCalledWith(
    'http://station.test/api/plugin-sources',
  );
});

test('the answer goes stale after 30 seconds and is re-read when the view mounts again, even with refetch-on-mount off globally', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const status = {
      pluginName: 'pulse',
      projectSlug: 'pulse-project',
      status: 'unchanged',
    };
    authenticatedFetch.mockImplementation(async () =>
      json({ sources: [status] }),
    );
    // Station's app client turns refetch-on-mount off for every query.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    });
    const first = mount(queryClient);
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    // Within 30 seconds a remount serves the cached answer.
    vi.advanceTimersByTime(20_000);
    const second = mount(queryClient);
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    second.unmount();
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    // Past 30 seconds a remount reads again.
    vi.advanceTimersByTime(15_000);
    const third = mount(queryClient);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    third.unmount();
  } finally {
    vi.useRealTimers();
  }
});
