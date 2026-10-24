// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { useUsageQuery } from '../query-domains/analytics';
import { usePairedDevicesQuery } from '../query-domains/devicePairingRequests';
import { useStationUsageQuery } from '../query-domains/stationUsage';
import { useUsageRollupQuery } from '../query-domains/usageRollup';

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

test('receipt observers partition credential profiles and current caller authority', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let label = 'work';
  fetch.mockImplementation(async () =>
    Response.json({ success: true, data: { rows: [{ key: label }] } }),
  );
  let profile: string | null | undefined = 'work';
  let scope = {
    apiBase: 'http://station.test',
    authorityKey: 'local',
    isCurrent: () => true,
  };
  const view = renderHook(
    () => {
      const query = useUsageRollupQuery(
        { days: 14, provider: 'claude', credentialProfileRef: profile },
        { requestScope: scope, requireRequestScope: true },
      );
      return { data: query.data, error: query.error };
    },
    { wrapper: wrapperFor(client) },
  );
  try {
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(view.result.current.data?.rows[0].key).toBe('work');
    for (const [nextProfile, nextLabel] of [
      ['personal', 'personal'],
      [null, 'default'],
      [undefined, 'all'],
    ] as const) {
      profile = nextProfile;
      label = nextLabel;
      view.rerender();
      expect(view.result.current.data).toBeUndefined();
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(view.result.current.data?.rows[0].key).toBe(nextLabel);
    }
    label = 'another caller';
    scope = { ...scope, authorityKey: 'other' };
    view.rerender();
    expect(view.result.current.data).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(view.result.current.data?.rows[0].key).toBe('another caller');
    expect(fetch).toHaveBeenCalledTimes(5);
  } finally {
    view.unmount();
    client.clear();
    vi.useRealTimers();
    fetch.mockReset();
  }
});

test('operator overview cache follows authority and pauses refused polling until retry', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let denied = false;
  fetch.mockImplementation(async () =>
    denied
      ? Response.json(
          {
            error: 'Operator access required',
            code: 'OPERATOR_REQUIRED',
            details: { scope: 'local' },
          },
          { status: 403 },
        )
      : Response.json({
          success: true,
          scope: { kind: 'station', stationId: 'instance' },
          data: { byProvider: { codex: {} } },
        }),
  );
  let scope = {
    apiBase: 'http://station.test',
    authorityKey: 'operator',
    isCurrent: () => true,
  };
  const view = renderHook(
    () => {
      const query = useStationUsageQuery(scope);
      return {
        data: query.data,
        isError: query.isError,
        refetch: query.refetch,
      };
    },
    { wrapper: wrapperFor(client) },
  );
  try {
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(view.result.current.data?.stationId).toBe('instance');
    denied = true;
    scope = { ...scope, authorityKey: 'paired-device' };
    view.rerender();
    expect(view.result.current.data).toBeUndefined();
    await act(async () => {
      const result = await view.result.current.refetch();
      expect(result.error).toMatchObject({
        message: 'Operator access required',
        status: 403,
        code: 'OPERATOR_REQUIRED',
        details: { scope: 'local' },
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(view.result.current.isError).toBe(true);
    const refusedCount = fetch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_010));
    expect(fetch).toHaveBeenCalledTimes(refusedCount);
    denied = false;
    await act(async () => {
      await view.result.current.refetch();
    });
    await act(() => vi.advanceTimersByTimeAsync(30_010));
    expect(view.result.current.data?.stationId).toBe('instance');
    expect(fetch).toHaveBeenCalledTimes(refusedCount + 2);
  } finally {
    view.unmount();
    client.clear();
    vi.useRealTimers();
    fetch.mockReset();
  }
});

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
    const view = renderHook(
      () => {
        const { data, isError, refetch } = usePairedDevicesQuery();
        return { data, isError, refetch };
      },
      {
        wrapper: wrapperFor(client),
      },
    );
    try {
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(view.result.current.isError).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(60_010));
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
      fetch.mockImplementation(async () => Response.json({ devices: [] }));
      await act(async () => {
        const retry = await view.result.current.refetch();
        expect(retry.data).toEqual([]);
      });
      await act(() => vi.advanceTimersByTimeAsync(15_010));
      expect(view.result.current.data).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[1]?.[1]?.headers).toBeUndefined();
      expect(fetch.mock.calls[2]?.[1]?.headers).toEqual({
        'X-Station-Background-Refresh': '1',
      });
    } finally {
      view.unmount();
      client.clear();
      vi.useRealTimers();
      fetch.mockReset();
    }
  },
);

test('paired-device data observers keep refetch identity and ignore unobserved fetching state', async () => {
  vi.useFakeTimers();
  fetch
    .mockReset()
    .mockImplementation(async () => Response.json({ devices: [] }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renders = 0;
  const view = renderHook(
    () => {
      renders++;
      const query = usePairedDevicesQuery();
      return { data: query.data, refetch: query.refetch };
    },
    { wrapper: wrapperFor(client) },
  );
  try {
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(view.result.current.data).toEqual([]);
    const refetch = view.result.current.refetch;
    view.rerender();
    expect(view.result.current.refetch).toBe(refetch);
    const settledRenders = renders;
    let finishPoll!: (response: Response) => void;
    fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finishPoll = resolve;
        }),
    );
    await act(() => vi.advanceTimersByTimeAsync(15_010));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(renders).toBe(settledRenders);
    await act(async () => {
      finishPoll(Response.json({ devices: [] }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(renders).toBe(settledRenders);
    expect(view.result.current.refetch).toBe(refetch);
  } finally {
    view.unmount();
    client.clear();
    vi.useRealTimers();
    fetch.mockReset();
  }
});
