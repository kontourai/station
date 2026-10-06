// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { useUsageQuery } from '../query-domains/analytics';
import { usePairedDevicesQuery } from '../query-domains/devicePairingRequests';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ _getApiBase: async () => 'http://station.test' }));
vi.mock('../client/http', async () => ({
  ...(await vi.importActual<typeof import('../client/http')>('../client/http')),
  authenticatedFetch: fetch,
  getJson: fetch,
}));

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

test('mounted usage observers refetch newer totals without a local mutation', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let messages = 1;
  fetch.mockImplementation(async () =>
    Response.json({ data: { lifetime: { totalMessages: messages } } }),
  );
  const view = renderHook(() => useUsageQuery(), {
    wrapper: wrapperFor(client),
  });
  try {
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(view.result.current.data.lifetime.totalMessages).toBe(1);
    messages = 7;
    await act(() => vi.advanceTimersByTimeAsync(30_010));
    expect(view.result.current.data.lifetime.totalMessages).toBe(7);
  } finally {
    view.unmount();
    client.clear();
    vi.useRealTimers();
    fetch.mockReset();
  }
});

test('paired-profile reads cannot reuse an unscoped registry when authority is unavailable', () => {
  const client = new QueryClient();
  client.setQueryData(
    ['paired-devices', 'default'],
    [{ name: 'Other authority' }],
  );
  const view = renderHook(
    () => usePairedDevicesQuery(undefined, { requireRequestScope: true }),
    { wrapper: wrapperFor(client) },
  );
  try {
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.fetchStatus).toBe('idle');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    client.clear();
  }
});

test.each([401, 403])(
  'paired-profile polling pauses after HTTP %s and resumes after an explicit successful retry',
  async (status) => {
    vi.useFakeTimers();
    fetch
      .mockReset()
      .mockImplementation(async () => Response.json({}, { status }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = renderHook(() => usePairedDevicesQuery(), {
      wrapper: wrapperFor(client),
    });
    try {
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(view.result.current.isError).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(60_010));
      expect(fetch).toHaveBeenCalledOnce();
      fetch.mockImplementation(async () => Response.json({ devices: [] }));
      await act(async () => {
        const retry = await view.result.current.refetch();
        expect(retry.data).toEqual([]);
      });
      await act(() => vi.advanceTimersByTimeAsync(15_010));
      expect(view.result.current.data).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      client.clear();
      vi.useRealTimers();
      fetch.mockReset();
    }
  },
);
