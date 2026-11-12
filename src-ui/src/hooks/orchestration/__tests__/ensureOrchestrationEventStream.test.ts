import type {
  FetchSseConnection,
  FetchSseOptions,
} from '@kontourai/station-sdk/client';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const applyOrchestrationSnapshot = vi.fn();
vi.mock('../snapshotHandlers', () => ({
  applyOrchestrationSnapshot: (...args: unknown[]) =>
    applyOrchestrationSnapshot(...args),
}));

const handleOrchestrationEvent = vi.fn();
vi.mock('../eventHandlers', () => ({
  handleOrchestrationEvent: (...args: unknown[]) =>
    handleOrchestrationEvent(...args),
  settleSemanticDeliveryBuffer: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  clearConversationActivity: vi.fn(),
  applyConversationActivity: vi.fn(),
  capturedOnMessage: undefined as
    | ((raw: { event: string; data: string; id?: string }) => void)
    | undefined,
  capturedOnError: undefined as ((error: unknown) => void) | undefined,
  fetchSSE: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  fetchSSE: mocks.fetchSSE,
}));
vi.mock('../../../contexts/active-chats-store', () => ({
  activeChatsStore: {
    clearConversationActivity: mocks.clearConversationActivity,
    applyConversationActivity: mocks.applyConversationActivity,
  },
}));

import {
  ensureOrchestrationEventStream,
  registerOrchestrationStreamQueryClient,
} from '../ensureOrchestrationEventStream';
import {
  readSequencedLiveEvents,
  readSequencedLiveFloor,
  readSequencedLiveTruncation,
  recordSequencedLiveEvent,
} from '../sequencedLiveEvents';
import { subscribeSharedOrchestrationStream } from '../sharedStreamListeners';
import { getStreamConnectionState } from '../streamConnectionState';

describe('ensureOrchestrationEventStream reconnect-fallback snapshot gating (station#1225)', () => {
  const capturedOnMessage = () => mocks.capturedOnMessage!;

  beforeEach(() => {
    mocks.fetchSSE.mockClear();
    mocks.capturedOnMessage = undefined;
    mocks.capturedOnError = undefined;
    mocks.fetchSSE.mockImplementation((_url: string, opts: any) => {
      mocks.capturedOnMessage = opts.onMessage;
      mocks.capturedOnError = opts.onError;
      return {
        close: vi.fn(),
        signal: new AbortController().signal,
        completed: Promise.resolve(),
        retry: vi.fn(),
      };
    });
  });

  test('replacement snapshots invalidate session lists and every inbox only for their authority', () => {
    const apiBase = 'https://snapshot-invalidation.example.test';
    const client = new QueryClient();
    const retired = new QueryClient();
    const matching = [
      ['orchestration-sessions', apiBase, 'current'],
      ['orchestration-sessions', apiBase, 'current', 'filtered'],
      ['conversation-inbox', apiBase, 'current', 'one'],
      ['conversation-inbox', apiBase, 'current', 'two'],
    ];
    const foreign = [
      ['orchestration-sessions', apiBase, 'retired'],
      ['conversation-inbox', apiBase, 'retired', 'one'],
      ['orchestration-sessions', 'https://other.example.test', 'current'],
      ['conversation-inbox', 'https://other.example.test', 'current', 'one'],
    ];
    const releaseRetired = ensureOrchestrationEventStream(
      apiBase,
      retired,
      'current',
    );
    const releaseScope = registerOrchestrationStreamQueryClient(
      apiBase,
      client,
      'current',
    );
    const release = ensureOrchestrationEventStream(apiBase, client);
    try {
      for (const id of ['1', '2']) {
        for (const key of [...matching, ...foreign])
          client.setQueryData(key, []);
        for (const key of matching) retired.setQueryData(key, []);
        capturedOnMessage()({
          event: 'orchestration:snapshot',
          data: JSON.stringify({ sessions: [] }),
          id,
        });
        for (const key of matching) {
          expect(client.getQueryState(key)?.isInvalidated, key.join(':')).toBe(
            true,
          );
          expect(retired.getQueryState(key)?.isInvalidated).toBe(false);
        }
        for (const key of foreign)
          expect(client.getQueryState(key)?.isInvalidated, key.join(':')).toBe(
            false,
          );
      }
    } finally {
      release();
      releaseScope();
      releaseRetired();
      client.clear();
      retired.clear();
    }
  });

  test('keeps the owned stream single-flight while its transport retries a transient failure', () => {
    ensureOrchestrationEventStream('http://api-1848-transient');
    expect(mocks.fetchSSE).toHaveBeenCalledOnce();

    // fetchSSE invokes this for a failed attempt but retains its retry loop.
    // A remount in that interval must not create another subscriber.
    mocks.capturedOnError!(new Error('connection reset'));
    ensureOrchestrationEventStream('http://api-1848-transient');

    expect(mocks.fetchSSE).toHaveBeenCalledOnce();
  });

  test.each(['completion rejection', 'retry notification'] as const)(
    'a retired stream’s late %s cannot interrupt its live replacement',
    async (notification) => {
      const apiBase = `https://retired-stream-${notification.replaceAll(' ', '-')}.example.test`;
      const streams: {
        options: FetchSseOptions;
        resolve: () => void;
        reject: (error: Error) => void;
      }[] = [];
      mocks.fetchSSE.mockImplementation(
        (_url: string, options: FetchSseOptions): FetchSseConnection => {
          const controller = new AbortController();
          let resolve!: () => void;
          let reject!: (error: Error) => void;
          const completed = new Promise<void>((done, fail) => {
            resolve = done;
            reject = fail;
          });
          streams.push({ options, resolve, reject });
          return {
            close: () => controller.abort(),
            signal: controller.signal,
            completed,
            retry: vi.fn(),
            restart: vi.fn(),
          };
        },
      );
      const releaseRetired = ensureOrchestrationEventStream(
        apiBase,
        undefined,
        'retired-authority',
      );
      const releaseCurrent = ensureOrchestrationEventStream(
        apiBase,
        undefined,
        'current-authority',
      );
      const onOpen = vi.fn();
      const onError = vi.fn();
      let subscription: { close(): void } | undefined;
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(streams).toHaveLength(2);
        streams[1].options.onOpen?.(
          new Response(null, {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
        streams[1].options.onMessage({
          event: 'orchestration:caughtUp',
          data: '{}',
          id: '1',
        });
        expect(getStreamConnectionState(apiBase).phase).toBe('caught-up');

        if (notification === 'completion rejection')
          streams[0].reject(new Error('retired transport ended late'));
        else streams[0].options.onRetry?.();
        await Promise.resolve();

        expect(getStreamConnectionState(apiBase).phase).toBe('caught-up');
        subscription = subscribeSharedOrchestrationStream(apiBase, {
          onOpen,
          onError,
          onMessage: vi.fn(),
        });
        await Promise.resolve();
        expect(onOpen).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
      } finally {
        subscription?.close();
        releaseCurrent();
        releaseRetired();
        for (const stream of streams) stream.resolve();
        log.mockRestore();
      }
    },
  );

  test('the FIRST snapshot on a fresh stream is never treated as a reconnect fallback', () => {
    applyOrchestrationSnapshot.mockClear();
    ensureOrchestrationEventStream('http://api-1225-a');
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '5',
    });

    expect(applyOrchestrationSnapshot).toHaveBeenCalledTimes(1);
    expect(applyOrchestrationSnapshot).toHaveBeenCalledWith(
      { sessions: [] },
      { apiBase: 'http://api-1225-a', isReconnectFallback: false },
    );
  });

  test('a SECOND snapshot on the same (reconnected) stream IS treated as a reconnect fallback', () => {
    applyOrchestrationSnapshot.mockClear();
    ensureOrchestrationEventStream('http://api-1225-b');
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '1',
    });
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '9001',
    });

    expect(applyOrchestrationSnapshot).toHaveBeenCalledTimes(2);
    expect(applyOrchestrationSnapshot).toHaveBeenNthCalledWith(
      1,
      { sessions: [] },
      { apiBase: 'http://api-1225-b', isReconnectFallback: false },
    );
    expect(applyOrchestrationSnapshot).toHaveBeenNthCalledWith(
      2,
      { sessions: [] },
      { apiBase: 'http://api-1225-b', isReconnectFallback: true },
    );
  });

  test('an epoch change clears stale activity and admits new low sequence events', () => {
    mocks.clearConversationActivity.mockClear();
    const apiBase = 'http://api-epoch-change';
    ensureOrchestrationEventStream(apiBase);
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [], epoch: 'old-epoch' }),
      id: '100',
    });
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [], epoch: 'new-epoch' }),
      id: '1',
    });
    capturedOnMessage()({
      event: 'orchestration:event',
      data: JSON.stringify({
        event: { method: 'turn.started', threadId: 'x' },
      }),
      id: '2',
    });
    expect(mocks.clearConversationActivity).toHaveBeenCalledOnce();
    expect(handleOrchestrationEvent).toHaveBeenCalledOnce();
  });

  test('an epoch change discards foreign sequenced transcript frames', () => {
    const apiBase = 'http://api-epoch-transcript';
    recordSequencedLiveEvent(
      apiBase,
      {
        eventId: 'foreign',
        method: 'turn.started',
        provider: 'claude',
        threadId: 'conversation',
        turnId: 'old',
        createdAt: '2026-09-24T00:00:00.000Z',
        prompt: 'foreign',
      },
      100,
    );
    ensureOrchestrationEventStream(apiBase);
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [], epoch: 'old-epoch' }),
      id: '100',
    });
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [], epoch: 'new-epoch' }),
      id: '1',
    });
    expect(readSequencedLiveEvents(apiBase)).toEqual([]);
  });

  // A snapshot delivers no events, so a transcript window served before its
  // cursor may be missing what lies between (see `useActiveChatTranscript`).
  test('a snapshot records its cursor as the live floor and leaves the truncation mark alone', () => {
    const apiBase = 'http://api-snapshot-floor';
    ensureOrchestrationEventStream(apiBase);
    expect(readSequencedLiveFloor(apiBase)).toBe(0);
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '5000',
    });
    expect(readSequencedLiveFloor(apiBase)).toBe(5000);
    expect(readSequencedLiveTruncation(apiBase)).toBe(0);
    // A caught-up marker ends a replay, whose events did arrive live.
    capturedOnMessage()({
      event: 'orchestration:caughtUp',
      data: '{}',
      id: '6000',
    });
    expect(readSequencedLiveFloor(apiBase)).toBe(5000);
  });

  test('a replacement stream echoes the known store epoch', async () => {
    const apiBase = 'http://api-epoch-echo';
    ensureOrchestrationEventStream(apiBase);
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [], epoch: 'known-epoch' }),
      id: '7',
    });
    await Promise.resolve();
    ensureOrchestrationEventStream(apiBase);
    expect(mocks.fetchSSE).toHaveBeenCalledTimes(2);
    expect(mocks.fetchSSE.mock.calls[1]?.[1]).toMatchObject({
      initialLastEventId: '7',
      headers: { 'X-Station-Stream-Epoch': 'known-epoch' },
    });
  });

  // An in-place retry carries the cursor but not the epoch, so a different
  // store whose head is at or past that cursor answers with a replay. The
  // caught-up marker is the first frame that says which store it was.
  test('a replay that ends on a different store epoch is replaced by a cursorless stream', () => {
    mocks.clearConversationActivity.mockClear();
    applyOrchestrationSnapshot.mockClear();
    const apiBase = 'http://api-epoch-replay';
    ensureOrchestrationEventStream(apiBase);
    const retired = mocks.fetchSSE.mock.results[0]?.value as {
      close: ReturnType<typeof vi.fn>;
    };
    const first = capturedOnMessage();
    first({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [], epoch: 'old-epoch' }),
      id: '100',
    });
    // Control: a marker for the same store replaces nothing.
    first({
      event: 'orchestration:caughtUp',
      data: JSON.stringify({ epoch: 'old-epoch' }),
      id: '100',
    });
    expect(mocks.fetchSSE).toHaveBeenCalledTimes(1);
    recordSequencedLiveEvent(
      apiBase,
      {
        eventId: 'foreign',
        method: 'turn.started',
        provider: 'claude',
        threadId: 'conversation',
        turnId: 'foreign',
        createdAt: '2026-09-24T00:00:00.000Z',
        prompt: 'foreign',
      },
      101,
    );

    first({
      event: 'orchestration:caughtUp',
      data: JSON.stringify({ epoch: 'new-epoch' }),
      id: '150',
    });

    expect(mocks.clearConversationActivity).toHaveBeenCalledOnce();
    expect(readSequencedLiveEvents(apiBase)).toEqual([]);
    expect(retired.close).toHaveBeenCalledOnce();
    expect(mocks.fetchSSE).toHaveBeenCalledTimes(2);
    const replacement = mocks.fetchSSE.mock.calls[1]?.[1] as FetchSseOptions;
    // No cursor: the old one names a position in the other store.
    expect(replacement.initialLastEventId).toBeUndefined();
    expect(replacement.headers).toMatchObject({
      'X-Station-Stream-Epoch': 'new-epoch',
    });
    // Its snapshot repairs what the foreign replay applied.
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [], epoch: 'new-epoch' }),
      id: '150',
    });
    expect(applyOrchestrationSnapshot).toHaveBeenLastCalledWith(
      { sessions: [], epoch: 'new-epoch' },
      { apiBase, isReconnectFallback: true },
    );
    expect(mocks.clearConversationActivity).toHaveBeenCalledOnce();
  });

  test('a replay caught-up frame reconciles present-tense session state once', () => {
    applyOrchestrationSnapshot.mockClear();
    const apiBase = 'http://api-replay-side-effects';
    ensureOrchestrationEventStream(apiBase);
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '1',
    });
    capturedOnMessage()({
      event: 'orchestration:caughtUp',
      data: JSON.stringify({
        sessions: [
          {
            provider: 'claude',
            threadId: 'child',
            status: 'ready',
            openRequestIds: ['waiting'],
          },
        ],
      }),
      id: '2',
    });
    expect(applyOrchestrationSnapshot).toHaveBeenCalledTimes(2);
    expect(applyOrchestrationSnapshot).toHaveBeenLastCalledWith(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'child',
            status: 'ready',
            openRequestIds: ['waiting'],
          },
        ],
      },
      { apiBase, isReconnectFallback: true },
    );
  });

  // station#2530 review D6/4: an empty or malformed caught-up body is a
  // legitimate wire shape (an older server, a rolling deploy mid-response) —
  // never a reason to throw inside the SSE handler and drop the connection's
  // whole message loop. Both must apply nothing and leave the stream able to
  // process the next frame.
  test('a caught-up frame with an empty body applies nothing and the stream stays live', () => {
    applyOrchestrationSnapshot.mockClear();
    handleOrchestrationEvent.mockClear();
    const apiBase = 'http://api-caughtup-empty-body';
    ensureOrchestrationEventStream(apiBase);
    expect(() =>
      capturedOnMessage()({
        event: 'orchestration:caughtUp',
        data: '',
        id: '1',
      }),
    ).not.toThrow();
    expect(applyOrchestrationSnapshot).not.toHaveBeenCalled();
    // The next frame on the same stream is still processed.
    capturedOnMessage()({
      event: 'orchestration:event',
      data: JSON.stringify({
        event: { method: 'turn.started', threadId: 'x' },
      }),
      id: '2',
    });
    expect(handleOrchestrationEvent).toHaveBeenCalledOnce();
  });

  test('a caught-up frame with a malformed JSON body applies nothing and the stream stays live', () => {
    applyOrchestrationSnapshot.mockClear();
    handleOrchestrationEvent.mockClear();
    const apiBase = 'http://api-caughtup-malformed-body';
    ensureOrchestrationEventStream(apiBase);
    expect(() =>
      capturedOnMessage()({
        event: 'orchestration:caughtUp',
        data: '{not valid json',
        id: '1',
      }),
    ).not.toThrow();
    expect(applyOrchestrationSnapshot).not.toHaveBeenCalled();
    capturedOnMessage()({
      event: 'orchestration:event',
      data: JSON.stringify({
        event: { method: 'turn.started', threadId: 'x' },
      }),
      id: '2',
    });
    expect(handleOrchestrationEvent).toHaveBeenCalledOnce();
  });

  test('a trailing activity frame refreshes the current record without moving the cursor', () => {
    const apiBase = 'http://api-trailing-activity';
    mocks.applyConversationActivity.mockClear();
    ensureOrchestrationEventStream(apiBase);
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '1',
    });
    capturedOnMessage()({
      event: 'orchestration:activity',
      data: JSON.stringify({
        conversation: {
          conversationId: 'root',
          currentSessionId: 'child',
          activity: { conversationId: 'root', asOfSequence: 9 },
        },
      }),
    });
    expect(mocks.applyConversationActivity).toHaveBeenCalledWith({
      conversationId: 'root',
      asOfSequence: 9,
    });
  });

  test('station#2301: the orchestration stream sets a stall deadline of 2.5 server keepalives', () => {
    ensureOrchestrationEventStream('http://api-2301-stall');
    const options = mocks.fetchSSE.mock.calls.at(-1)?.[1] as {
      stallTimeoutMs?: number;
    };
    // SSE_KEEPALIVE_INTERVAL_MS is 30s (src-server/constants.ts).
    expect(options.stallTimeoutMs).toBe(75_000);
  });

  test('station#1225 review (MEDIUM fix): a supplied queryClient is threaded through to applyOrchestrationSnapshot', () => {
    applyOrchestrationSnapshot.mockClear();
    const fakeQueryClient = new QueryClient();
    ensureOrchestrationEventStream('http://api-1225-d', fakeQueryClient);
    capturedOnMessage()({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '1',
    });

    expect(applyOrchestrationSnapshot).toHaveBeenCalledWith(
      { sessions: [] },
      {
        apiBase: 'http://api-1225-d',
        isReconnectFallback: false,
        queryClient: fakeQueryClient,
      },
    );
  });
});
