/** @vitest-environment jsdom */

import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { useAcknowledgeConversationMutation } from '../query-domains/chatRuntimeConversations';
import { useMarkReadMutation } from '../query-domains/readMarkers';
import { conversationQueries } from '../queryFactories';

const API = 'https://station.example.test';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Page = { items: ConversationListItem[]; hasMore: boolean };

function seededClient(readState: ConversationListItem['readState']) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData<InfiniteData<Page>>(
    conversationQueries.inventory().queryKey,
    {
      pageParams: [undefined],
      pages: [
        {
          hasMore: false,
          items: [
            {
              id: 'c1',
              source: 'runtime',
              agentSlug: 'default' as ConversationListItem['agentSlug'],
              title: 'One',
              createdAt: '2026-11-01T00:00:00.000Z',
              updatedAt: '2026-11-01T00:00:10.000Z',
              messageCount: 2,
              mutable: false,
              answerability: { answerable: true },
              readState,
            },
          ],
        },
      ],
    },
  );
  return client;
}

const cachedReadState = (client: QueryClient) =>
  client.getQueryData<InfiniteData<Page>>(
    conversationQueries.inventory().queryKey,
  )?.pages[0]?.items[0]?.readState;

const target = { kind: 'agent-conversation', conversationId: 'c1' } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useMarkReadMutation', () => {
  test('reads the row as read before the server answers, then keeps the server answer', async () => {
    _setApiBase(API);
    let answer!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = seededClient({ version: 10, seenVersion: 0, unread: true });
    const { result } = renderHook(() => useMarkReadMutation(), {
      wrapper: wrapperFor(client),
    });

    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.mutateAsync({ target, version: 10 });
    });
    await waitFor(() =>
      expect(cachedReadState(client)).toEqual({
        version: 10,
        seenVersion: 10,
        unread: false,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${API}/api/read-markers/mark`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ target, version: 10 }),
      }),
    );

    answer(
      jsonResponse(
        {
          success: true,
          data: { target, latestVersion: 10, seenVersion: 10, unread: false },
        },
        200,
      ),
    );
    await expect(settled).resolves.toMatchObject({ seenVersion: 10 });
  });

  test('an older version never regresses the cached marker', async () => {
    _setApiBase(API);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const client = seededClient({ version: 10, seenVersion: 8, unread: true });
    const { result } = renderHook(() => useMarkReadMutation(), {
      wrapper: wrapperFor(client),
    });
    act(() => {
      result.current.mutate({ target, version: 3 });
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(cachedReadState(client)).toEqual({
      version: 10,
      seenVersion: 8,
      unread: true,
    });
  });

  test('a refused mark restores the unread row and the caller sees the refusal', async () => {
    _setApiBase(API);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            code: 'read_marker_future_version',
            error: 'Read marker version 10 is above the current version 9',
          },
          409,
        ),
      ),
    );
    const client = seededClient({ version: 10, seenVersion: 0, unread: true });
    const onError = vi.fn();
    const { result } = renderHook(() => useMarkReadMutation({ onError }), {
      wrapper: wrapperFor(client),
    });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current
        .mutateAsync({ target, version: 10 })
        .catch((error: unknown) => error);
    });
    expect(outcome).toMatchObject({ name: 'StationHttpError', status: 409 });
    expect(onError).toHaveBeenCalledOnce();
    expect(cachedReadState(client)).toEqual({
      version: 10,
      seenVersion: 0,
      unread: true,
    });
  });
});

describe('useAcknowledgeConversationMutation (the inbox open path)', () => {
  test('reads the row as read before the server answers, and restores it when the server refuses', async () => {
    _setApiBase(API);
    let answer!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    const client = seededClient({ version: 10, seenVersion: 0, unread: true });
    const { result } = renderHook(() => useAcknowledgeConversationMutation(), {
      wrapper: wrapperFor(client),
    });

    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current
        .mutateAsync({
          conversationId: 'c1',
          updatedAt: new Date(10).toISOString(),
          // The content version this client rendered.
          readVersion: 10,
        })
        .catch((error: unknown) => error);
    });
    await waitFor(() =>
      expect(cachedReadState(client)).toEqual({
        version: 10,
        seenVersion: 10,
        unread: false,
      }),
    );

    answer(
      jsonResponse(
        {
          success: false,
          code: 'read_marker_future_version',
          error: 'Read marker version 10 is above the current version 9',
        },
        409,
      ),
    );
    expect(await outcome).toMatchObject({ status: 409 });
    expect(cachedReadState(client)).toEqual({
      version: 10,
      seenVersion: 0,
      unread: true,
    });
  });

  test('without a rendered content version the row waits for the server: `updatedAt` cannot say what was read', async () => {
    _setApiBase(API);
    let answer!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = seededClient({ version: 10, seenVersion: 0, unread: true });
    const { result } = renderHook(() => useAcknowledgeConversationMutation(), {
      wrapper: wrapperFor(client),
    });
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current.mutateAsync({
        conversationId: 'c1',
        updatedAt: new Date(10).toISOString(),
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({
      updatedAt: new Date(10).toISOString(),
    });
    expect(cachedReadState(client)).toEqual({
      version: 10,
      seenVersion: 0,
      unread: true,
    });
    answer(jsonResponse({ success: true }, 200));
    await expect(outcome).resolves.toBeUndefined();
  });
});
