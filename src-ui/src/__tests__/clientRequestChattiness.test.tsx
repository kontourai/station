/** @vitest-environment jsdom */

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import {
  OrchestrationSessionsContext,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import type { FetchSseOptions } from '@kontourai/station-sdk/client';
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
import { useSessionEventStream } from '../hooks/orchestration/useSessionEventStream';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const stream of streams.values()) stream.close();
  streams.clear();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
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
  const fetcher = vi.fn(async () => Response.json({ success: true, data: [] }));
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  let host = {
    scope: { apiBase: origin, authorityKey: 'alice' },
    streamLive: true,
  };
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
  host = { ...host, streamLive: false };
  view.rerender();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  host = { scope: { apiBase: origin, authorityKey: 'bob' }, streamLive: true };
  view.rerender();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(
    client.getQueryCache().findAll({ queryKey: ['orchestration-sessions'] }),
  ).toHaveLength(2);
});
