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

import { ensureOrchestrationEventStream } from '../ensureOrchestrationEventStream';
import {
  readSequencedLiveEvents,
  recordSequencedLiveEvent,
} from '../sequencedLiveEvents';

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

  test('keeps the owned stream single-flight while its transport retries a transient failure', () => {
    ensureOrchestrationEventStream('http://api-1848-transient');
    expect(mocks.fetchSSE).toHaveBeenCalledOnce();

    // fetchSSE invokes this for a failed attempt but retains its retry loop.
    // A remount in that interval must not create another subscriber.
    mocks.capturedOnError!(new Error('connection reset'));
    ensureOrchestrationEventStream('http://api-1848-transient');

    expect(mocks.fetchSSE).toHaveBeenCalledOnce();
  });

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

  test('a second call for the SAME apiBase is a no-op (existing dedup guard) — no new snapshot state', () => {
    applyOrchestrationSnapshot.mockClear();
    ensureOrchestrationEventStream('http://api-1225-c');
    const firstOnMessage = capturedOnMessage();
    ensureOrchestrationEventStream('http://api-1225-c');
    expect(capturedOnMessage()).toBe(firstOnMessage);
  });

  test('station#1225 review (MEDIUM fix): a supplied queryClient is threaded through to applyOrchestrationSnapshot', () => {
    applyOrchestrationSnapshot.mockClear();
    const fakeQueryClient = { getQueryData: vi.fn() } as any;
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
