// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';
import {
  type PrivateInsightsQuery,
  syncPrivateInsightsPage,
  syncPrivateInsightsWindow,
} from '../client/private-insights';
import {
  type PrivateInsightsAuthority,
  usePrivateInsightsInventory,
  usePrivateInsightsResult,
} from '../query-domains/privateInsights';

const id = '11234567-89ab-4cde-8fab-0123456789ab',
  indexId = '21234567-89ab-4cde-8fab-0123456789ab',
  summaryId = '31234567-89ab-4cde-8fab-0123456789ab';
let scope: PrivateInsightsAuthority;
let amount = 10,
  fail: number | undefined;
const transport = vi.fn<typeof globalThis.fetch>();
const makeScope = (key: string): PrivateInsightsAuthority => {
  const value = {
    apiBase: 'https://station.example.test',
    authorityKey: key,
    isCurrent: () => scope === value,
  };
  return value;
};
function metadata() {
  return {
    data: {
      sourceIntent: {
        sourceStationId: 'source-a',
        retention: { mode: 'retained-copy' },
      },
      candidate: { claims: { recipientId: id } },
      phase: 'credential-stored',
      sourceConfirmation: {
        revision: 1,
        origin: 'https://source-a.example.test',
      },
      storedCredential: {
        revision: 1,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    },
  };
}
function reply(input: PrivateInsightsQuery) {
  return {
    data: {
      protocol: 'station-private-usage-receipts/v1',
      indexId,
      phase: 'ready',
      validUntil: new Date(Date.now() + 3600000).toISOString(),
      afterGlobalSequence: 10,
      highWater: 10,
      sourceAuthority: 'not-verified-by-storage',
      coverage: 'retained-observations-only',
      receipts: [],
      summary: {
        id: summaryId,
        groupBy: input.groupBy ?? 'provider',
        phase: 'ready',
        scanned: 1,
        rows: [
          {
            key: `${input.groupBy ?? 'provider'}:value`,
            stationId: 'source-a',
            provider: 'claude',
            inputTokens: amount,
            pricingStatus: 'unpriced',
            receiptCount: 1,
          },
        ],
      },
      recipientId: id,
      asOf: {
        stationId: 'source-a',
        streamEpoch: 'epoch-a',
        highWater: 10,
        sourceRevision: 0,
        observedSourceHighWater: 10,
        freshness: 'at-captured-source-head',
      },
    },
  };
}
beforeEach(() => {
  scope = makeScope('alice:1');
  amount = 10;
  fail = undefined;
  vi.useFakeTimers();
  transport.mockReset();
  vi.stubGlobal('fetch', transport);
  setClientCredentialResolver(() => {
    const captured = scope;
    return {
      origin: captured.apiBase,
      requestAuthority: { ...captured, isCurrent: () => captured === scope },
    };
  });
  transport.mockImplementation(async (input, init) => {
    if (String(input).endsWith(`/recipient-candidates/${id}`))
      return Response.json(metadata());
    if (String(input).endsWith('/query')) {
      if (fail)
        return Response.json(
          { error: { code: 'unavailable' } },
          { status: fail },
        );
      return Response.json(reply(JSON.parse(String(init?.body))));
    }
    throw new Error(`Unexpected private test request: ${input}`);
  });
});
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}
async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(20));
}
test('private query keys isolate principal, filters, periods and group while the caller receives access-loss errors', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let input: PrivateInsightsQuery = {
    from: '2026-10-01',
    to: '2026-10-14',
    mode: 'summary',
    groupBy: 'model',
  };
  const view = renderHook(
    () => usePrivateInsightsResult(scope, id, input, 'saved:1'),
    { wrapper: wrapper(client) },
  );
  try {
    await settle();
    expect(view.result.current.data?.summary?.rows[0].inputTokens).toBe(10);
    for (const change of [
      () => {
        input = { ...input, provider: 'claude', accountKey: 'profile-a' };
      },
      () => {
        input = { ...input, model: 'actual-model' };
      },
      () => {
        input = { ...input, from: '2026-10-02' };
      },
      () => {
        input = { ...input, groupBy: 'day' };
      },
      () => {
        scope = makeScope('bob:2');
      },
    ]) {
      amount++;
      change();
      view.rerender();
      expect(view.result.current.data).toBeUndefined();
      await settle();
      expect(view.result.current.data?.summary?.rows[0].inputTokens).toBe(
        amount,
      );
    }
    const keys = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    );
    expect(keys).toContain('profile-a');
    expect(keys).toContain('actual-model');
    expect(keys).toContain('bob:2');
    fail = 403;
    let pending: Promise<unknown>;
    act(() => {
      pending = view.result.current.refetch();
    });
    const rejected = expect(pending!).rejects.toThrow();
    await settle();
    await rejected;
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.historical).toBeUndefined();
    expect(
      client
        .getQueryCache()
        .findAll()
        .some((q) => q.state.status === 'error'),
    ).toBe(true);
  } finally {
    view.unmount();
    client.clear();
  }
});
test('retained history is dated and separate on service failure, then withheld after authority changes', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const input: PrivateInsightsQuery = {
    from: '2026-10-01',
    to: '2026-10-14',
    mode: 'summary',
    groupBy: 'provider',
  };
  const view = renderHook(
    () => usePrivateInsightsResult(scope, id, input, 'view:1'),
    { wrapper: wrapper(client) },
  );
  try {
    await settle();
    fail = 503;
    let pending: Promise<unknown>;
    act(() => {
      pending = view.result.current.refetch();
    });
    const rejected = expect(pending!).rejects.toThrow();
    await settle();
    await rejected;
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.historical?.receivedAt).toBeTruthy();
    scope = makeScope('alice:rotated');
    view.rerender();
    expect(view.result.current.historical).toBeUndefined();
  } finally {
    view.unmount();
    client.clear();
  }
});
test('a late response cannot resolve a refetch caller after the selection changes', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let input: PrivateInsightsQuery = {
    from: '2026-10-01',
    to: '2026-10-14',
    mode: 'summary',
    groupBy: 'model',
  };
  const view = renderHook(
    () => usePrivateInsightsResult(scope, id, input, 'view:1'),
    { wrapper: wrapper(client) },
  );
  try {
    await settle();
    let release!: (response: Response) => void;
    transport.mockImplementation(async (url) =>
      String(url).endsWith('/query')
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Response.json(metadata()),
    );
    let pending: Promise<unknown>;
    act(() => {
      pending = view.result.current.refetch();
    });
    const rejected = expect(pending!).rejects.toThrow();
    await settle();
    input = { ...input, model: 'different' };
    view.rerender();
    await act(async () => {
      release(
        Response.json(
          reply({
            mode: 'summary',
            groupBy: 'model',
            from: '2026-10-01',
            to: '2026-10-14',
          }),
        ),
      );
    });
    await settle();
    await rejected;
    expect(view.result.current.data).toBeUndefined();
  } finally {
    view.unmount();
    client.clear();
  }
});
test('sync sends only the allowed operation/window fields and refuses a stale request authority', async () => {
  transport.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort()).toEqual(['from', 'operationId', 'to']);
    return Response.json({
      data: { ...body, recipientId: id, phase: 'facts-captured' },
    });
  });
  await syncPrivateInsightsPage(scope, id, {
    operationId: indexId,
    from: '2026-10-01',
    to: '2026-10-14',
  });
  const old = scope;
  scope = makeScope('other');
  await expect(
    syncPrivateInsightsPage(old, id, {
      operationId: indexId,
      from: '2026-10-01',
      to: '2026-10-14',
    }),
  ).rejects.toBeInstanceOf(StationRequestAuthorityError);
});

test('foreground sync resumes the original owned operation, paces new pages and stops observably on cancellation', async () => {
  let writes = 0;
  const operations: string[] = [];
  transport.mockImplementation(async (url, init) => {
    if (String(url).endsWith(`/recipient-candidates/${id}`))
      return Response.json({
        ...metadata(),
        data: {
          ...metadata().data,
          sync: {
            operationId: indexId,
            from: '2026-10-01',
            to: '2026-10-14',
            phase: 'pending',
            restart: false,
          },
        },
      });
    const input = JSON.parse(String(init?.body));
    operations.push(input.operationId);
    writes++;
    return Response.json({
      data: {
        ...input,
        recipientId: id,
        phase: writes === 1 ? 'page-stored' : 'facts-captured',
      },
    });
  });
  const controller = new AbortController();
  const result = syncPrivateInsightsWindow(
    scope,
    id,
    [{ from: '2026-10-01', to: '2026-10-14' }],
    { signal: controller.signal },
  );
  await vi.advanceTimersByTimeAsync(20);
  expect(writes).toBe(1);
  expect(operations[0]).toBe(indexId);
  await vi.advanceTimersByTimeAsync(7000);
  await expect(result).resolves.toEqual({ phase: 'facts-captured', pages: 2 });
  expect(operations[1]).not.toBe(indexId);
  writes = 0;
  const cancel = new AbortController();
  const stopped = syncPrivateInsightsWindow(
    scope,
    id,
    [{ from: '2026-10-01', to: '2026-10-14' }],
    { signal: cancel.signal },
  );
  const rejected = expect(stopped).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(20);
  cancel.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(7000);
  expect(writes).toBe(1);
});

test('known access loss cannot be followed by a service error that revives retained history', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const input: PrivateInsightsQuery = {
    from: '2026-10-01',
    to: '2026-10-14',
    mode: 'summary',
    groupBy: 'provider',
  };
  const view = renderHook(
    () => usePrivateInsightsResult(scope, id, input, 'view:revocation'),
    { wrapper: wrapper(client) },
  );
  try {
    await settle();
    expect(view.result.current.data).toBeTruthy();
    for (const status of [403, 503]) {
      fail = status;
      let pending: Promise<unknown>;
      act(() => {
        pending = view.result.current.refetch();
      });
      const rejected = expect(pending!).rejects.toThrow();
      await settle();
      await rejected;
      expect(view.result.current.data).toBeUndefined();
      expect(view.result.current.historical).toBeUndefined();
    }
  } finally {
    view.unmount();
    client.clear();
  }
});

test('a source refusal invalidates other windows and survives remount until a newer successful source check', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const a: PrivateInsightsQuery = {
      from: '2026-10-01',
      to: '2026-10-14',
      mode: 'summary',
      groupBy: 'provider',
    },
    b = { ...a, from: '2026-09-01', to: '2026-09-14' };
  const first = renderHook(
    () => usePrivateInsightsResult(scope, id, a, 'first'),
    { wrapper: wrapper(client) },
  );
  const other = renderHook(
    () => usePrivateInsightsResult(scope, id, b, 'other'),
    { wrapper: wrapper(client) },
  );
  try {
    await settle();
    expect(first.result.current.data).toBeTruthy();
    expect(other.result.current.data).toBeTruthy();
    fail = 403;
    let pending: Promise<unknown>;
    act(() => {
      pending = first.result.current.refetch();
    });
    const rejected = expect(pending!).rejects.toThrow();
    await settle();
    await rejected;
    expect(other.result.current.data).toBeUndefined();
    first.unmount();
    fail = 503;
    const again = renderHook(
      () => usePrivateInsightsResult(scope, id, a, 'first'),
      { wrapper: wrapper(client) },
    );
    try {
      await settle();
      expect(again.result.current.historical).toBeUndefined();
      fail = undefined;
      await act(async () => {
        await again.result.current.refetch();
      });
      await settle();
      expect(again.result.current.data).toBeTruthy();
      expect(other.result.current.data).toBeUndefined();
      await act(async () => {
        await other.result.current.refetch();
      });
      await settle();
      expect(other.result.current.data).toBeTruthy();
    } finally {
      again.unmount();
    }
  } finally {
    first.unmount();
    other.unmount();
    client.clear();
  }
});

test.each(['restored-slot', 'person-refused'] as const)(
  'inventory %s cannot be followed by an outage that revives an older retained snapshot',
  async (mode) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const original = transport.getMockImplementation();
    if (!original) throw new Error('missing transport');
    let outage = false;
    transport.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (outage)
        return Response.json(
          { error: { code: 'unavailable' } },
          { status: 503 },
        );
      if (path === '/api/analytics/recipient-candidates')
        return mode === 'person-refused'
          ? Response.json(
              { error: { code: 'authority_changed' } },
              { status: 403 },
            )
          : Response.json({
              data: [
                {
                  sourceIntent: metadata().data.sourceIntent,
                  candidate: metadata().data.candidate,
                  phase: 'restore-required',
                },
              ],
            });
      if (path === '/api/analytics/saved-views')
        return Response.json({ data: [] });
      return original(input, init);
    });
    const view = renderHook(
      () =>
        usePrivateInsightsResult(
          scope,
          id,
          {
            from: '2026-10-01',
            to: '2026-10-14',
            mode: 'summary',
            groupBy: 'provider',
          },
          'inventory-loss',
        ),
      { wrapper: wrapper(client) },
    );
    let unmountInventory: (() => void) | undefined;
    try {
      await settle();
      expect(view.result.current.data?.summary?.rows[0].inputTokens).toBe(10);
      const inventory = renderHook(() => usePrivateInsightsInventory(scope), {
        wrapper: wrapper(client),
      });
      unmountInventory = inventory.unmount;
      await settle();
      if (mode === 'restored-slot')
        expect(inventory.result.current.sources.data).toMatchObject([
          { id, ready: false },
        ]);
      else expect(inventory.result.current.sources.isError).toBe(true);
      outage = true;
      let pending: Promise<unknown>;
      act(() => {
        pending = view.result.current.refetch();
      });
      const rejected = expect(pending!).rejects.toThrow();
      await settle();
      await rejected;
      expect(view.result.current.data).toBeUndefined();
      expect(view.result.current.historical).toBeUndefined();
    } finally {
      unmountInventory?.();
      view.unmount();
      client.clear();
    }
  },
);
