/** @vitest-environment jsdom */

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import {
  OrchestrationSessionsContext,
  StationRequestAuthorityError,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import type { FetchSseOptions } from '@kontourai/station-sdk/client';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../../../packages/sdk/src/api-core';
import { useBoardRecentWorkQuery } from '../../../packages/sdk/src/query-domains/personalBoards';

const providerScope = vi.hoisted(() => ({
  apiBase: 'https://provider-lifecycle.example.test',
  authorityKey: 'provider-person',
  isCurrent: () => true,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: providerScope.apiBase }),
  useHostRequestAuthorityScope: () => providerScope,
}));
const streams = vi.hoisted(
  () => new Map<string, { options: FetchSseOptions; close(): void }>(),
);
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...sdk,
    fetchSSE: vi.fn((url: string, options: FetchSseOptions) => {
      const controller = new AbortController();
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const close = () => {
        controller.abort();
        finish();
      };
      streams.set(url, { options, close });
      return {
        close,
        signal: controller.signal,
        completed,
        retry: vi.fn(),
        restart: vi.fn(),
      };
    }),
    fetchSessionEventWindowCapability: () => Promise.resolve(true),
    fetchEventStreamResumeCapability: () => Promise.resolve(true),
  };
});
vi.mock('../hooks/orchestration/eventHandlers', () => ({
  handleOrchestrationEvent: vi.fn(),
  settleSemanticDeliveryBuffer: vi.fn(),
}));
vi.mock('../hooks/orchestration/snapshotHandlers', () => ({
  applyOrchestrationSnapshot: vi.fn(),
}));

vi.mock('../components/session-detail/AttachedSessionDetail', () => ({
  AttachedSessionDetail: ({ events }: { events: { eventId?: string }[] }) => (
    <output data-testid="detail-events">
      {events.map((event) => event.eventId).join(',')}
    </output>
  ),
}));
vi.mock('../components/session-detail/MutableSessionDetail', () => ({
  MutableSessionDetail: () => null,
}));

import { SessionDetail } from '../components/session-detail/SessionDetail';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import { SessionReadModelProvider } from '../hooks/orchestration/SessionReadModelProvider';
import { useSessionEventStream } from '../hooks/orchestration/useSessionEventStream';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const stream of streams.values()) stream.close();
  streams.clear();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
  setClientCredentialResolver();
  vi.useRealTimers();
});

const event = (threadId: string, eventId: string) => ({
  threadId,
  eventId,
  provider: 'claude',
  method: 'session.started',
  sessionId: threadId,
  createdAt: '2026-10-22T00:00:00.000Z',
});

test('mounted details share one host stream, hydrate before it opens, isolate threads and survive snapshot cursor reset', async () => {
  const origin = 'https://shared-details.example.test';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          protocolVersion: 1,
          session: {},
          events: [],
          hasMore: false,
          watermark: 0,
        },
      }),
    ),
  );
  const session: OrchestrationSessionSummary = {
    threadId: 'first',
    provider: 'claude',
    status: 'ready',
    controlMode: 'read-only-attached',
    answerability: { answerable: true },
    isLoaded: false,
    isPersisted: true,
    eventCount: 0,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
  let authorityCurrent = true;
  const detail = render(
    <OrchestrationSessionsContext.Provider
      value={{
        scope: {
          apiBase: origin,
          authorityKey: 'detail-authority',
          isCurrent: () => authorityCurrent,
        },
        streamLive: false,
      }}
    >
      <SessionDetail
        apiBase={origin}
        session={session}
        onTaskChanged={() => {}}
        onAdopted={() => {}}
        getSelectionIntent={() => 0}
      />
    </OrchestrationSessionsContext.Provider>,
  );
  const first = renderHook(() => useSessionEventStream(origin, 'first', true));
  const second = renderHook(() =>
    useSessionEventStream(origin, 'second', true),
  );
  const foreign = renderHook(() =>
    useSessionEventStream('https://other-details.example.test', 'first', true),
  );
  await waitFor(() => {
    expect(first.result.current.historyLoaded).toBe(true);
    expect(second.result.current.historyLoaded).toBe(true);
    expect(foreign.result.current.historyLoaded).toBe(true);
  });
  expect(first.result.current.connected).toBe(false);
  expect([...streams.keys()]).toEqual([
    `${origin}/api/orchestration/events`,
    'https://other-details.example.test/api/orchestration/events',
  ]);
  const shared = streams.get(`${origin}/api/orchestration/events`)!;
  await act(async () => {
    shared.options.onOpen?.(new Response());
    shared.options.onMessage({
      event: 'orchestration:snapshot',
      data: '{"sessions":[],"epoch":"old"}',
      id: '100',
    });
    shared.options.onMessage({
      event: 'orchestration:event',
      data: JSON.stringify({ event: event('first', 'a') }),
      id: '101',
    });
    shared.options.onMessage({
      event: 'orchestration:event',
      data: JSON.stringify({ event: event('second', 'b') }),
      id: '102',
    });
  });
  await waitFor(() =>
    expect(first.result.current.events.map((item) => item.eventId)).toEqual([
      'a',
    ]),
  );
  await waitFor(() =>
    expect(second.result.current.events.map((item) => item.eventId)).toEqual([
      'b',
    ]),
  );
  expect(foreign.result.current.events).toEqual([]);
  await waitFor(() =>
    expect(detail.getByTestId('detail-events').textContent).toBe('a'),
  );
  authorityCurrent = false;
  await act(async () => {
    shared.options.onMessage({
      event: 'orchestration:event',
      id: '103',
      data: JSON.stringify({ event: event('first', 'retired-authority') }),
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(detail.getByTestId('detail-events').textContent).toBe('a');
  detail.unmount();
  first.unmount();
  await act(async () => {
    shared.options.onError?.(new Error('offline'));
    shared.options.onOpen?.(new Response());
    shared.options.onMessage({
      event: 'orchestration:snapshot',
      data: '{"sessions":[],"epoch":"new"}',
      id: '1',
    });
    shared.options.onMessage({
      event: 'orchestration:event',
      data: JSON.stringify({ event: event('second', 'after-restart') }),
      id: '2',
    });
  });
  await waitFor(() =>
    expect(second.result.current.events.map((item) => item.eventId)).toContain(
      'after-restart',
    ),
  );
  expect(second.result.current.connected).toBe(true);
  expect(streams.size).toBe(2);
  ensureOrchestrationEventStream(origin, undefined, 'new-person');
  const replacement = streams.get(`${origin}/api/orchestration/events`)!;
  expect(replacement).not.toBe(shared);
  expect(replacement.options.initialLastEventId).toBeUndefined();
  expect(
    replacement.options.headers?.['X-Station-Stream-Epoch'],
  ).toBeUndefined();
  await act(async () => {
    shared.options.onMessage({
      event: 'orchestration:event',
      id: '999',
      data: JSON.stringify({ event: event('second', 'retired-source') }),
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(
    second.result.current.events.map((item) => item.eventId),
  ).not.toContain('retired-source');
});

test('board and shell share scoped list requests, pause idle polling live, and retain a disconnected fallback', async () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  const origin = 'https://shared-list.example.test';
  _setApiBase(origin);
  let failNext = false;
  const fetcher = vi.fn(async () => {
    if (failNext) {
      failNext = false;
      throw new Error('temporary list failure');
    }
    return Response.json({ success: true, data: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  let host = {
    scope: { apiBase: origin, authorityKey: 'alice' },
    streamLive: true,
  };
  setClientCredentialResolver(() => {
    const scope = host.scope;
    return {
      origin,
      requestAuthority: { ...scope, isCurrent: () => host.scope === scope },
    };
  });
  const view = renderHook(
    () => ({
      shell: useOrchestrationSessionsQuery(),
      board: useBoardRecentWorkQuery(host.scope),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <OrchestrationSessionsContext.Provider value={host}>
            {children}
          </OrchestrationSessionsContext.Provider>
        </QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(view.result.current.shell.isSuccess).toBe(true);
  expect(view.result.current.board.isSuccess).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['orchestration-sessions'] });
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  failNext = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['orchestration-sessions'] });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(view.result.current.shell.isRefetchError).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(view.result.current.shell.isSuccess).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(4);
  host = { ...host, streamLive: false };
  view.rerender();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetcher).toHaveBeenCalledTimes(5);
  host = { scope: { apiBase: origin, authorityKey: 'bob' }, streamLive: true };
  view.rerender();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(
    client.getQueryCache().findAll({ queryKey: ['orchestration-sessions'] }),
  ).toHaveLength(2);
});

test('a retained list scope refuses a same-origin authority switch before dispatch and after its pending body read', async () => {
  const apiBase = 'https://list-authority.example.test';
  const scopeA = { apiBase, authorityKey: 'alice' };
  let current = scopeA;
  setClientCredentialResolver(() => {
    const captured = current;
    return {
      origin: apiBase,
      requestAuthority: { ...captured, isCurrent: () => current === captured },
    };
  });
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const view = renderHook(
    () => useOrchestrationSessionsQuery({ retry: false }, scopeA),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const waiting = view.result.current.refetch({ cancelRefetch: false });
  current = { apiBase, authorityKey: 'bob' };
  await act(async () => {
    body.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          success: true,
          data: [{ threadId: 'alice-private' }],
        }),
      ),
    );
    body.close();
    const result = await waiting;
    expect(result.error).toBeInstanceOf(StationRequestAuthorityError);
  });
  const key = ['orchestration-sessions', apiBase, 'alice'];
  expect(client.getQueryData(key)).toBeUndefined();
  expect(client.getQueryState(key)?.error).toBeInstanceOf(
    StationRequestAuthorityError,
  );
  await act(async () => {
    expect((await view.result.current.refetch()).error).toBeInstanceOf(
      StationRequestAuthorityError,
    );
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(client.getQueryData(key)).toBeUndefined();
});

test('the mounted provider refreshes lists from detail-only lifecycle frames without a ChatDock registration', async () => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
  const apiBase = providerScope.apiBase;
  let rows: { threadId: string; displayTitle?: string }[] = [];
  let reads = 0;
  setClientCredentialResolver(() => ({
    origin: apiBase,
    requestAuthority: providerScope,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/sessions/read-model')) {
        reads++;
        return Response.json({ success: true, data: rows });
      }
      if (String(input).includes('/event-window'))
        return Response.json({
          success: true,
          data: {
            protocolVersion: 1,
            session: {},
            events: [],
            hasMore: false,
            watermark: 0,
          },
        });
      throw new Error(`Unexpected HTTP request: ${String(input)}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const session: OrchestrationSessionSummary = {
    threadId: 'inspected',
    provider: 'claude',
    status: 'ready',
    controlMode: 'read-only-attached',
    answerability: { answerable: true },
    isLoaded: false,
    isPersisted: true,
    eventCount: 0,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
  const view = renderHook(
    () => {
      const query = useOrchestrationSessionsQuery();
      return {
        data: query.data,
        error: query.error,
        isSuccess: query.isSuccess,
      };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <SessionReadModelProvider>
            <SessionDetail
              apiBase={apiBase}
              session={session}
              onTaskChanged={() => {}}
              onAdopted={() => {}}
              getSelectionIntent={() => 0}
            />
            {children}
          </SessionReadModelProvider>
        </QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(view.result.current.isSuccess).toBe(true);
  expect(reads).toBe(1);
  const stream = streams.get(`${apiBase}/api/orchestration/events`)!;
  await act(async () => {
    stream.options.onOpen?.(new Response());
    stream.options.onMessage({
      event: 'orchestration:caughtUp',
      data: '{}',
      id: '0',
    });
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(reads).toBe(2);
  rows = [{ threadId: 'created-elsewhere' }];
  await act(async () => {
    stream.options.onMessage({
      event: 'orchestration:event',
      id: '1',
      data: JSON.stringify({ event: event('created-elsewhere', 'created') }),
    });
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect({
    reads,
    error: view.result.current.error?.message,
    data: view.result.current.data,
  }).toMatchObject({
    reads: 3,
    error: undefined,
    data: [{ threadId: 'created-elsewhere' }],
  });
  rows = [
    { threadId: 'created-elsewhere', displayTitle: 'Configured elsewhere' },
  ];
  await act(async () => {
    stream.options.onMessage({
      event: 'orchestration:event',
      id: '2',
      data: JSON.stringify({
        event: {
          ...event('created-elsewhere', 'configured'),
          method: 'session.configured',
          config: {},
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(view.result.current.data?.[0]?.displayTitle).toBe(
    'Configured elsewhere',
  );
  expect(reads).toBe(4);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(reads).toBe(4);
});
