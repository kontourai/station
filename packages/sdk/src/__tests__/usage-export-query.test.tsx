// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';
import type { UsageExportQuery } from '../client/usage-export';
import { useUsageExportQuery } from '../query-domains/usageExport';
import { usageExportFixture } from './usage-export.fixture';

const initialScope = {
  apiBase: 'https://station.example.test',
  authorityKey: 'person-a:1',
};
const initialInput: UsageExportQuery = {
  expectedStationId: 'station-a',
  from: '2026-10-01',
  to: '2026-10-11',
  scope: 'individual',
};
const fetch = vi.fn<typeof globalThis.fetch>();
let scope: ApiRequestScope | undefined;
beforeEach(() => {
  scope = initialScope;
  fetch.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetch);
  setClientCredentialResolver(() => {
    const captured = scope;
    return captured
      ? {
          origin: captured.apiBase,
          requestAuthority: {
            ...captured,
            isCurrent: () => captured === scope,
          },
        }
      : undefined;
  });
});
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}
async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(10));
}

test('the mounted export consumer partitions every authority, source, selection and continuation', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let input = { ...initialInput };
  let reply = usageExportFixture();
  fetch.mockImplementation(async () =>
    Response.json({ success: true, data: reply }),
  );
  const view = renderHook(
    () => useUsageExportQuery(scope, input, { keepPreviousData: true }),
    { wrapper: wrapperFor(client) },
  );
  async function transition(change: () => void) {
    change();
    view.rerender();
    expect(view.result.current.data).toBeUndefined();
    await settle();
    expect(view.result.current.data?.stationId).toBe(reply.stationId);
    expect(view.result.current.data?.window).toEqual(reply.window);
  }
  try {
    await settle();
    expect(view.result.current.data?.stationId).toBe('station-a');
    await transition(() => {
      scope = { ...initialScope, authorityKey: 'person-b:2' };
    });
    await transition(() => {
      scope = {
        apiBase: 'https://other.example.test',
        authorityKey: 'person-b:2',
      };
    });
    await transition(() => {
      input = { ...input, expectedStationId: 'station-b' };
      reply = { ...reply, stationId: 'station-b', observations: [] };
      delete reply.nextCursor;
    });
    await transition(() => {
      input = { ...input, from: '2026-10-02' };
      reply = { ...reply, window: { ...reply.window, from: '2026-10-02' } };
    });
    await transition(() => {
      input = { ...input, to: '2026-10-10' };
      reply = { ...reply, window: { ...reply.window, to: '2026-10-10' } };
    });
    await transition(() => {
      input = { ...input, scope: 'personal-account' };
      reply = { ...reply, scope: 'personal-account' };
    });
    await transition(() => {
      input = { ...input, pageSize: 1 };
    });
    await transition(() => {
      input = {
        ...input,
        cursor: 'cursor_a',
        snapshot: {
          streamEpoch: 'epoch-a',
          highWater: 9,
          afterGlobalSequence: 7,
        },
      };
      reply = { ...reply, observations: [{ globalSequence: 9, receipts: [] }] };
    });
    await transition(() => {
      input = { ...input, cursor: 'cursor_b' };
    });
    await transition(() => {
      input = {
        ...input,
        snapshot: {
          streamEpoch: 'epoch-b',
          highWater: 12,
          afterGlobalSequence: 10,
        },
      };
      reply = {
        ...reply,
        streamEpoch: 'epoch-b',
        highWater: 12,
        observations: [{ globalSequence: 12, receipts: [] }],
      };
    });
    expect(fetch).toHaveBeenCalledTimes(11);
    const cached = client.getQueryCache().getAll();
    expect(cached).toHaveLength(11);
    expect(cached.every((entry) => entry.state.status === 'success')).toBe(
      true,
    );
    expect(cached.some((entry) => entry.queryKey.includes('person-a:1'))).toBe(
      true,
    );
    expect(cached.some((entry) => entry.queryKey.includes('epoch-b'))).toBe(
      true,
    );
  } finally {
    view.unmount();
    client.clear();
  }
});

test('a refused refetch hides retained rows and rejects the caller while the cache records the refusal', async () => {
  const client = new QueryClient();
  let refused = false;
  fetch.mockImplementation(async () =>
    refused
      ? Response.json(
          { error: { code: 'usage_export_authority_changed' } },
          { status: 403 },
        )
      : Response.json({ success: true, data: usageExportFixture() }),
  );
  const view = renderHook(
    () => useUsageExportQuery(scope, initialInput, { refetchInterval: 1000 }),
    { wrapper: wrapperFor(client) },
  );
  try {
    await settle();
    expect(view.result.current.data?.observations).toHaveLength(2);
    refused = true;
    await act(async () => {
      await expect(view.result.current.refetch()).rejects.toMatchObject({
        status: 403,
        code: 'usage_export_authority_changed',
      });
    });
    await settle();
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.isError).toBe(true);
    const state = client.getQueryCache().getAll()[0].state;
    expect(state.status).toBe('error');
    expect(state.error).toMatchObject({ status: 403 });
    const count = fetch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(3010));
    expect(fetch).toHaveBeenCalledTimes(count);
    refused = false;
    await act(async () => {
      expect((await view.result.current.refetch()).data?.stationId).toBe(
        'station-a',
      );
    });
    await settle();
    expect(view.result.current.data?.stationId).toBe('station-a');
  } finally {
    view.unmount();
    client.clear();
  }
});

test('missing captured authority disables dispatch, hides prior pages and refuses explicit refetch', async () => {
  const client = new QueryClient();
  fetch.mockImplementation(async () =>
    Response.json({ success: true, data: usageExportFixture() }),
  );
  const view = renderHook(() => useUsageExportQuery(scope, initialInput), {
    wrapper: wrapperFor(client),
  });
  try {
    await settle();
    expect(view.result.current.data?.stationId).toBe('station-a');
    scope = undefined;
    view.rerender();
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.fetchStatus).toBe('idle');
    await expect(view.result.current.refetch()).rejects.toBeInstanceOf(
      StationRequestAuthorityError,
    );
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((entry) => entry.state.data),
    ).toHaveLength(1);
  } finally {
    view.unmount();
    client.clear();
  }
});

test('a waiting page caller cannot receive a replacement selection while both valid pages remain cached', async () => {
  const client = new QueryClient();
  let input = { ...initialInput };
  let held = false;
  let release!: (response: Response) => void;
  fetch.mockImplementation(async (url) => {
    const from = new URL(String(url)).searchParams.get('from');
    if (held && from === initialInput.from)
      return new Promise((resolve) => {
        release = resolve;
      });
    const data = usageExportFixture();
    if (from === '2026-10-02') {
      data.window.from = '2026-10-02';
      data.observations = [data.observations[1]];
    }
    return Response.json({ success: true, data });
  });
  const view = renderHook(
    () => ({
      moving: useUsageExportQuery(scope, input),
      keeper: useUsageExportQuery(scope, initialInput),
    }),
    { wrapper: wrapperFor(client) },
  );
  try {
    await settle();
    expect(view.result.current.moving.data?.window.from).toBe('2026-10-01');
    held = true;
    const waiting = view.result.current.moving.refetch();
    const refused = expect(waiting).rejects.toThrow(
      'Usage export selection changed while waiting',
    );
    await settle();
    input = { ...input, from: '2026-10-02' };
    view.rerender();
    await settle();
    expect(view.result.current.moving.data?.window.from).toBe('2026-10-02');
    await act(async () => {
      release(Response.json({ success: true, data: usageExportFixture() }));
      await refused;
    });
    await settle();
    expect(view.result.current.keeper.data?.window.from).toBe('2026-10-01');
    expect(view.result.current.moving.data?.window.from).toBe('2026-10-02');
    const cached = client
      .getQueryCache()
      .getAll()
      .map((entry) => entry.state);
    expect(cached).toHaveLength(2);
    expect(cached.every((state) => state.status === 'success')).toBe(true);
    expect(cached.map((state) => state.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          window: expect.objectContaining({ from: '2026-10-01' }),
        }),
        expect.objectContaining({
          window: expect.objectContaining({ from: '2026-10-02' }),
        }),
      ]),
    );
  } finally {
    view.unmount();
    client.clear();
  }
});

test('a late old-authority response fails its waiting observer without publishing into the cache', async () => {
  const client = new QueryClient();
  let release!: (response: Response) => void;
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = renderHook(() => useUsageExportQuery(scope, initialInput), {
    wrapper: wrapperFor(client),
  });
  try {
    await settle();
    const waiting = view.result.current.refetch({ cancelRefetch: false });
    const refused = expect(waiting).rejects.toBeInstanceOf(
      StationRequestAuthorityError,
    );
    scope = { ...initialScope, authorityKey: 'replacement-person' };
    await act(async () => {
      release(Response.json({ success: true, data: usageExportFixture() }));
      await refused;
    });
    await settle();
    expect(view.result.current.data).toBeUndefined();
    const cache = client.getQueryCache().getAll()[0].state;
    expect(cache.data).toBeUndefined();
    expect(cache.error).toBeInstanceOf(StationRequestAuthorityError);
  } finally {
    view.unmount();
    client.clear();
  }
});
