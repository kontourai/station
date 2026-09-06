/** @vitest-environment jsdom */

import { CONVERSATION_INTENT_SUMMARY_MAX_ITEMS } from '@kontourai/station-contracts/conversation-intent-summary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { resolveConversationOpen } from '../conversation-open';
import {
  fetchSessionSummary,
  useConversationInventoryQuery,
  useConversationsQuery,
  useDeleteConversationMutation,
  useRegenerateConversationTitleMutation,
  useRenameConversationMutation,
} from '../query-domains/chatRuntimeConversations';
import { conversationQueries } from '../queryFactories';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function successResponse(): Response {
  return new Response(JSON.stringify({ success: true, data: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('conversation intent summary normalization', () => {
  test('rejects hostile and unavailable conversation-open responses as typed failures', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              status: 'resolved',
              canContinue: true,
              recoveryActions: [],
              // A guessed child must never become a valid open merely because
              // the outer envelope says success.
              currentSessionId: 'guessed-child',
              conversation: { id: 'c', title: 'Cool', agentSlug: 'codex' },
              transcript: { available: false, owner: 'runtime' },
              answerability: { answerable: true },
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(resolveConversationOpen('c')).rejects.toMatchObject({
      kind: 'invalid-response',
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(resolveConversationOpen('c')).rejects.toMatchObject({
      kind: 'network',
    });
  });

  test('preserves v2 ranges, usage, and observed references while rejecting future/corrupt payloads', async () => {
    _setApiBase('https://station.example.test');
    const payload = {
      version: 2,
      text: 'overview',
      overview: 'overview',
      goals: [],
      constraints: [],
      progress: [],
      nextSteps: [],
      reportedCompletion: [],
      relatedEvidenceRefs: [
        { kind: 'task-turn', taskId: 'task', turnId: 'turn', eventId: 'event' },
      ],
      verificationRefs: [
        {
          kind: 'task-turn',
          state: 'observed',
          taskId: 'task',
          turnId: 'turn',
          eventId: 'event',
        },
      ],
      model: 'model',
      generatedAt: '2026-08-01T00:00:00.000Z',
      sourceRange: {
        fromMessageId: 'm1',
        throughMessageId: 'm2',
        messageCount: 2,
      },
      sourceRanges: [
        { fromMessageId: 'm1', throughMessageId: 'm2', messageCount: 2 },
        { fromMessageId: 'm8', throughMessageId: 'm9', messageCount: 2 },
      ],
      sourceRevision: 'revision',
      sourceMessageCount: 4,
      partialMessageIncluded: false,
      contextBoundaryCount: 1,
      contextBoundaries: [
        {
          boundaryId: 'boundary',
          policy: 'empty-next-cold-start',
          priorTranscriptInjected: false,
        },
      ],
      generationUsage: { state: 'observed', inputTokens: 10, outputTokens: 20 },
      stale: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: payload }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const value = await fetchSessionSummary('station', 'conversation');
    expect(value?.sourceRanges).toHaveLength(2);
    expect(value?.generationUsage).toEqual({
      state: 'observed',
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(value?.verificationRefs[0]).toMatchObject({
      taskId: 'task',
      eventId: 'event',
    });
    expect(value?.relatedEvidenceRefs[0]).toMatchObject({ taskId: 'task' });
    expect(value?.contextBoundaries[0]).toMatchObject({
      policy: 'empty-next-cold-start',
    });
    payload.relatedEvidenceRefs = Array.from(
      { length: CONVERSATION_INTENT_SUMMARY_MAX_ITEMS },
      (_, index) => ({
        kind: 'task-turn',
        taskId: `task-${index}`,
        turnId: `turn-${index}`,
        eventId: `event-${index}`,
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true, data: payload }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    expect(await fetchSessionSummary('station', 'conversation')).not.toBeNull();
    payload.relatedEvidenceRefs.push({
      kind: 'task-turn',
      taskId: 'task-over',
      turnId: 'turn-over',
      eventId: 'event-over',
    });
    expect(await fetchSessionSummary('station', 'conversation')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { version: 3 } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    expect(await fetchSessionSummary('station', 'conversation')).toBeNull();
  });
});

describe('conversation mutation cache coherence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('rename invalidates both legacy and global conversation lists', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse()));
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRenameConversationMutation(), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync({
        agentSlug: 'codex',
        conversationId: 'conversation-1',
        title: 'Renamed',
      });
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['conversations', 'codex'],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: conversationQueries.inventory().queryKey,
    });
  });

  test('delete invalidates both legacy and global conversation lists', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse()));
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteConversationMutation(), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync({
        agentSlug: 'codex',
        conversationId: 'conversation-1',
      });
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['conversations', 'codex'],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: conversationQueries.inventory().queryKey,
    });
  });

  test('regenerate forwards the explicit manual-title replacement decision', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(
      () => useRegenerateConversationTitleMutation(),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      await result.current.mutateAsync({
        agentSlug: 'codex',
        conversationId: 'conversation-1',
        replaceManualTitle: true,
      });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://station.example.test/agents/codex/conversations/conversation-1/regenerate-title',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ replaceManualTitle: true }),
      }),
    );
  });
});

describe('conversation inventory query controls', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('forwards React Query cancellation to inventory fetch and cancels only after the final observer unmounts', async () => {
    _setApiBase('https://station.example.test');
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? undefined;
            requestSignal?.addEventListener('abort', () =>
              reject(requestSignal?.reason),
            );
          }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = renderHook(
      () => useConversationInventoryQuery({ cancelWhenInactive: true }),
      { wrapper: wrapperFor(client) },
    );
    const second = renderHook(
      () => useConversationInventoryQuery({ cancelWhenInactive: true }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(requestSignal).toBeDefined());
    first.unmount();
    expect(requestSignal?.aborted).toBe(false);
    second.unmount();
    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
  });

  test('does not expose a next page for a terminal inventory response', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { items: [], hasMore: false, nextCursor: 'ignored' },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useConversationInventoryQuery({ retry: false }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.hasNextPage).toBe(false);
  });

  test('projects the real next-page fetch state and failure state for history consumers', async () => {
    _setApiBase('https://station.example.test');
    let rejectSecondPage: ((error: Error) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                items: [{ id: 'newest' }],
                hasMore: true,
                nextCursor: 'older-page',
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockImplementationOnce(
          () =>
            new Promise<Response>((_resolve, reject) => {
              rejectSecondPage = reject;
            }),
        ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useConversationInventoryQuery({ retry: false }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    let nextPageResult: ReturnType<typeof result.current.loadMore>;
    act(() => {
      nextPageResult = result.current.loadMore();
    });
    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(true));
    expect(result.current.loadingMore).toBe(true);

    let settledNextPage!: Awaited<ReturnType<typeof result.current.loadMore>>;
    await act(async () => {
      rejectSecondPage?.(new Error('offline'));
      settledNextPage = await nextPageResult!;
    });
    expect(settledNextPage.isFetchNextPageError).toBe(true);
    await waitFor(() => expect(result.current.loadMoreError).toBe(true));
    expect(result.current.loadMoreError).toBe(true);
    expect(result.current.hasMore).toBe(true);
  });

  test('honors a query-key gcTime default for the infinite inventory query', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { items: [], hasMore: false },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryDefaults(conversationQueries.inventory().queryKey, {
      gcTime: 1_234,
    });
    const { result } = renderHook(() => useConversationInventoryQuery(), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client
        .getQueryCache()
        .find({ queryKey: conversationQueries.inventory().queryKey })?.options
        .gcTime,
    ).toBe(1_234);
  });

  test('normalizes an agent route page envelope for existing array consumers', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [{ id: 'conversation-1' }],
              hasMore: true,
              nextCursor: 'opaque-next',
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useConversationsQuery('codex'), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      result.current.data?.map(
        (conversation: { id: string }) => conversation.id,
      ),
    ).toEqual(['conversation-1']);
  });
});

test('conversation open accepts exact execution metadata and refuses wrong-child or cursor-bearing snapshots', async () => {
  const data = {
    status: 'resolved',
    currentSessionId: 'child-b',
    canContinue: true,
    recoveryActions: [],
    answerability: { answerable: true },
    conversation: {
      id: 'conversation',
      title: 'Restored',
      agentSlug: 'claude-agent',
    },
    transcript: { available: true, owner: 'runtime', messageCount: 2 },
    execution: {
      sessionId: 'child-b',
      agentId: 'claude-agent',
      provider: 'claude',
      engineConnectionId: 'claude-connection',
      model: 'reported',
      acceptedModel: 'accepted',
    },
  };
  try {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ success: true, data })),
    );
    await expect(
      resolveConversationOpen('conversation', 'https://station.example'),
    ).resolves.toEqual(data);
    for (const execution of [
      { ...data.execution, sessionId: 'child-a' },
      { ...data.execution, agentId: 'codex-agent' },
      { ...data.execution, resumeCursor: 'private' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ success: true, data: { ...data, execution } }),
          ),
      );
      await expect(
        resolveConversationOpen('conversation', 'https://station.example'),
      ).rejects.toMatchObject({ kind: 'invalid-response' });
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
