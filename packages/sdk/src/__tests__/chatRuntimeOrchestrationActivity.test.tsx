// @vitest-environment jsdom

import type { OrchestrationSessionEventWindow } from '@kontourai/station-contracts/orchestration';
import {
  isCancelledError,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { useOrchestrationSessionActivityQuery } from '../query-domains/chatRuntimeOrchestration';
import { orchestrationQueries } from '../queryFactories';

function windowFor(threadId: string): OrchestrationSessionEventWindow {
  return {
    protocolVersion: 1,
    session: {
      threadId,
      provider: 'codex',
      status: 'running',
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      controlMode: 'station-owned',
      isLoaded: true,
      isPersisted: true,
      eventCount: 10_000,
      answerability: { answerable: true },
    },
    events: [],
    hasMore: true,
    nextCursor: 'older-history',
    watermark: 10_000,
  };
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

test('a relay activity read carries source authority and partitions the same child by grant', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiBase = 'http://source.test';
  const targetApiBase = `${apiBase}/api/environments/peers/receiver/chat-api`;
  let authorityKey = 'source-one';
  setClientCredentialResolver(async () => ({
    origin: apiBase,
    credential: 'fixture-source-credential',
    requestAuthority: { apiBase, authorityKey, isCurrent: () => true },
  }));
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `${targetApiBase}/api/orchestration/sessions/child/event-window?direction=newest&turnLimit=1`,
      );
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer fixture-source-credential',
      );
      return Response.json({ success: true, data: windowFor('child') });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(
    ({ key }) =>
      useOrchestrationSessionActivityQuery('child', undefined, {
        readTarget: {
          targetApiBase,
          runtimeKey: key,
          requestScope: { apiBase, authorityKey: key },
        },
      }),
    { initialProps: { key: authorityKey }, wrapper: wrapperFor(client) },
  );
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  const first = view.result.current.data;
  authorityKey = 'source-two';
  view.rerender({ key: authorityKey });
  expect(view.result.current.data).toBeUndefined();
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    client.getQueryData([
      'orchestration-session-activity',
      'source-one',
      'source-one',
      targetApiBase,
      'child',
    ]),
  ).toBe(first);
  expect(view.result.current.data).not.toBe(first);
  view.unmount();
  client.clear();
});

test('activity caches are separate from full detail, other sessions, and other servers', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const detailKey = orchestrationQueries.session('child').queryKey;
  const detail = { session: windowFor('child').session, events: [] };
  client.setQueryData(detailKey, detail);
  const fetcher = vi.fn(async (url: string) => {
    const threadId = url.includes('/sibling/') ? 'sibling' : 'child';
    return Response.json({ success: true, data: windowFor(threadId) });
  });
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(
    ({ threadId, apiBase }) =>
      useOrchestrationSessionActivityQuery(threadId, apiBase),
    {
      initialProps: { threadId: 'child', apiBase: 'http://station-a.test' },
      wrapper: wrapperFor(client),
    },
  );
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  const ownWindow = view.result.current.data;
  view.rerender({ threadId: 'sibling', apiBase: 'http://station-a.test' });
  expect(view.result.current.data).toBeUndefined();
  await waitFor(() =>
    expect(view.result.current.data?.session.threadId).toBe('sibling'),
  );
  view.rerender({ threadId: 'child', apiBase: 'http://station-b.test' });
  expect(view.result.current.data).toBeUndefined();
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(client.getQueryData(detailKey)).toBe(detail);
  expect(
    client.getQueryData([
      'orchestration-session-activity',
      'http://station-a.test',
      'child',
    ]),
  ).toBe(ownWindow);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'http://station-a.test/api/orchestration/sessions/child/event-window?direction=newest&turnLimit=1',
    'http://station-a.test/api/orchestration/sessions/sibling/event-window?direction=newest&turnLimit=1',
    'http://station-b.test/api/orchestration/sessions/child/event-window?direction=newest&turnLimit=1',
  ]);
  view.unmount();
  client.clear();
});

test('shared activity requests survive one inactive observer and cancel for the final observer and waiting caller', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const fetcher = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const wrapper = wrapperFor(client);
  const first = renderHook(
    () => useOrchestrationSessionActivityQuery('child', 'http://station.test'),
    { wrapper },
  );
  const second = renderHook(
    ({ enabled }) =>
      useOrchestrationSessionActivityQuery('child', 'http://station.test', {
        enabled,
      }),
    { initialProps: { enabled: true }, wrapper },
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const signal = fetcher.mock.calls[0][1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  first.unmount();
  expect(signal?.aborted).toBe(false);
  const waiting = second.result.current.refetch({ throwOnError: true }).then(
    () => 'resolved',
    (error: unknown) => error,
  );
  second.rerender({ enabled: false });
  await waitFor(() => expect(signal?.aborted).toBe(true));
  expect(isCancelledError(await waiting)).toBe(true);
  const key = [
    'orchestration-session-activity',
    'http://station.test',
    'child',
  ];
  expect(client.getQueryState(key)).toMatchObject({
    data: undefined,
    fetchStatus: 'idle',
  });
  expect(client.getQueryData(key)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  second.unmount();
  client.clear();
});
