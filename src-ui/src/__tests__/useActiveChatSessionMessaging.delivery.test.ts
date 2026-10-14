/** @vitest-environment jsdom */
/**
 * The composer send's durability seam: its outbox row is `invoking` BEFORE
 * the request goes out, the composer's saved draft is let go only once that
 * row is durable, and the row then follows what Station's answer proves.
 * Drives the real `useSendMessage` and the real outbox Module over an
 * in-memory storage Adapter; only the network call is scripted.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    namespace: 'authority-1',
    status: 'verified',
  }),
}));

const sendExecutionMessageMock = vi.fn();
const getTurnDeliveryMock = vi.fn();
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  sendExecutionMessage: (...args: unknown[]) =>
    sendExecutionMessageMock(...args),
  getTurnDelivery: (...args: unknown[]) => getTurnDeliveryMock(...args),
}));

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: (id: string, updates: unknown) =>
      activeChatsStore.updateChat(id, updates as never),
    clearInput: (id: string) => activeChatsStore.clearInput(id),
    assignConversationId: (id: string, conversationId: string) =>
      activeChatsStore.assignConversationId(id, conversationId),
    addEphemeralMessage: (id: string, message: unknown) =>
      activeChatsStore.addEphemeralMessage(id, message as never),
    clearEphemeralMessages: (id: string) =>
      activeChatsStore.clearEphemeralMessages(id),
  }),
}));
vi.mock('../hooks/useStreamingMessage', () => ({
  useStreamingMessage: () => ({ clearStreamingMessage: vi.fn() }),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    conversationQueries: {
      inventory: () => ({ queryKey: ['conversation-inventory'] }),
    },
    useEngineConnectionsQuery: () => ({ data: [] }),
    useConfigQuery: () => ({
      data: undefined,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    }),
    useAgentsQuery: () => ({ data: [], error: null }),
    useInvalidateQuery: () => vi.fn(),
    useQueryClient: () => ({ getQueryData: () => undefined }),
    isProvablyNotSent: actual.isProvablyNotSent,
  };
});

import { ChatHttpError } from '@kontourai/station-sdk/client';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useSendMessage } from '../hooks/useActiveChatSessionMessaging';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  outboundDispatch,
} from '../lib/outboundQueue';
import { messageDeliveryStateFor } from '../utils/messageDeliveryState';

const chat = 'chat-delivery-1';

function memoryStorage() {
  let value: unknown;
  _setOutboundQueueStorage({
    getItem: async () => value,
    setItem: async (_key, next) => {
      value = next;
    },
    updateItem: async (_key, updater) => {
      value = updater(value);
    },
  });
}

function receipt(providerTurnId = 'provider-turn-1') {
  return {
    conversationId: chat,
    sessionId: chat,
    providerTurnId,
    target: { kind: 'agent', id: 'codex' },
    resolution: {},
  };
}

describe('useSendMessage: durable before the request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryStorage();
    activeChatsStore.initChat(chat, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'New chat',
      projectSlug: 'station',
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetOutboundQueueStorage();
    activeChatsStore.removeChat(chat);
  });

  it('records the send invoking, then lets the draft go, then makes the request; the bubble and the request share one key', async () => {
    const order: string[] = [];
    let rowAtRequest: unknown;
    sendExecutionMessageMock.mockImplementation(async (_apiBase, body) => {
      order.push('request');
      rowAtRequest = (await outboundDispatch.snapshot()).find(
        (row) => row.clientTurnId === body.clientTurnId,
      );
      return receipt();
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(
        chat,
        'codex',
        undefined,
        'keep me',
        undefined,
        undefined,
        undefined,
        {
          onDurable: () => order.push('durable'),
        },
      );
    });
    expect(order).toEqual(['durable', 'request']);
    const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
      clientTurnId: string;
      conversationId: string;
    };
    expect(rowAtRequest).toMatchObject({
      clientTurnId: body.clientTurnId,
      status: 'invoking',
      origin: 'live',
      content: 'keep me',
      conversationId: body.conversationId,
      projectSlug: 'station',
    });
    const bubble = activeChatsStore
      .getSnapshot()
      [chat]?.messages?.find((message) => message.role === 'user');
    expect(bubble?.clientId).toBe(body.clientTurnId);
    // Station answered with the turn: the row is gone and the bubble reads
    // delivered.
    expect(await outboundDispatch.snapshot()).toEqual([]);
    expect(
      messageDeliveryStateFor(activeChatsStore.getSnapshot()[chat], bubble!),
    ).toBe('delivered');
  });

  it("no answer at all: the row is released for Station's lookup under the SAME key, never resent blind", async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(chat, 'codex', undefined, 'lost in transit');
    });
    const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
      clientTurnId: string;
    };
    const [row] = await outboundDispatch.snapshot();
    expect(row).toMatchObject({
      clientTurnId: body.clientTurnId,
      status: 'invoking',
      content: 'lost in transit',
    });
    expect(row?.liveInFlight).toBeUndefined();
    // Station says it never got it: only now is it pending, same key.
    await outboundDispatch.reconcile(
      async (turn) => ({
        outcome: 'not-received',
        conversationId: turn.conversationId!,
        clientTurnId: turn.clientTurnId,
      }),
      { station: { apiBase: 'http://api.test' } },
    );
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: body.clientTurnId,
        status: 'pending',
      }),
    ]);
  });

  it('a proxy 502 is not Station refusing: the row is kept for the lookup and the composer is not handed a second copy', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(
        { status: 502, message: '<html>Bad gateway</html>' } as never,
        false,
      ),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(chat, 'codex', undefined, 'through a proxy');
    });
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        content: 'through a proxy',
        status: 'invoking',
      }),
    ]);
    expect(activeChatsStore.getSnapshot()[chat]?.input).toBe('');
  });

  it("Station's may-have-started answer keeps the text as unconfirmed, never deletes it", async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      Object.assign(
        new ChatHttpError(
          { status: 409, message: 'may have started' } as never,
          true,
        ),
        { code: 'foreground_message_indeterminate', outcome: 'indeterminate' },
      ),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      // A may-have-started answer is rethrown to the caller by design.
      await result
        .current(chat, 'codex', undefined, 'maybe started')
        .catch(() => undefined);
    });
    const [row] = await outboundDispatch.snapshot();
    expect(row).toMatchObject({
      content: 'maybe started',
      status: 'may-have-started',
    });
    const bubble = activeChatsStore
      .getSnapshot()
      [chat]?.messages?.find((message) => message.role === 'user');
    expect(
      messageDeliveryStateFor(activeChatsStore.getSnapshot()[chat], bubble!),
    ).toBe('unconfirmed');
  });

  it('refused because the engine is busy: moved into the local queue with its durable row kept, same key', async () => {
    // Hold the drain's own settle timer so the held state can be read.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(
        409,
        'The engine is replying on its own',
        'provider_turn_in_progress',
      ),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(chat, 'codex', undefined, 'wait your turn');
    });
    const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
      clientTurnId: string;
    };
    const held = activeChatsStore.getSnapshot()[chat];
    // In the queue, or just popped by the drain that the turn's end allows.
    expect([
      ...(held?.queuedMessageMetadata ?? []).map((entry) => entry.id),
      held?.pendingQueueDispatch?.metadata.id,
    ]).toContain(body.clientTurnId);
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: body.clientTurnId,
        status: 'pending',
        heldBy: expect.objectContaining({ bootId: expect.any(String) }),
      }),
    ]);
  });

  it('a Station refusal lets the row go: the composer holds the text, never both', async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError({ status: 400, message: 'Refused' } as never),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(chat, 'codex', undefined, 'refuse me');
    });
    expect(await outboundDispatch.snapshot()).toEqual([]);
    expect(activeChatsStore.getSnapshot()[chat]?.input).toBe('refuse me');
  });

  it('storage unavailable: still sends, and never claims the draft is safe to drop', async () => {
    _setOutboundQueueStorage({
      getItem: async () => {
        throw new Error('no IndexedDB');
      },
      setItem: async () => {
        throw new Error('no IndexedDB');
      },
      updateItem: async () => {
        throw new Error('no IndexedDB');
      },
    });
    sendExecutionMessageMock.mockResolvedValueOnce(receipt());
    const onDurable = vi.fn();
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(
        chat,
        'codex',
        undefined,
        'no disk',
        undefined,
        undefined,
        undefined,
        {
          onDurable,
        },
      );
    });
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(onDurable).not.toHaveBeenCalled();
  });

  it('a stuck outbox write does not hold the send: it goes after the bound, and the draft is kept', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    _setOutboundQueueStorage({
      getItem: async () => undefined,
      setItem: () => new Promise<void>(() => {}),
      updateItem: () => new Promise<void>(() => {}),
    });
    sendExecutionMessageMock.mockResolvedValueOnce(receipt());
    const onDurable = vi.fn();
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current(
        chat,
        'codex',
        undefined,
        'stuck disk',
        undefined,
        undefined,
        undefined,
        { onDurable },
      );
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      await pending;
    });
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(onDurable).not.toHaveBeenCalled();
  });

  it('a replay is sent under the conversation its row recorded, not one the chat learned since', async () => {
    activeChatsStore.updateChat(chat, {
      conversationId: 'conversation-learned-later',
    });
    sendExecutionMessageMock.mockResolvedValueOnce(receipt());
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(
        chat,
        'codex',
        'conversation-the-row-recorded',
        'replayed',
        undefined,
        undefined,
        'replay-key',
        {
          skipInMemoryQueueOnBusy: true,
          dispatch: { indeterminate: async () => 'applied' as const },
        },
      );
    });
    expect(sendExecutionMessageMock.mock.calls[0]?.[1]).toMatchObject({
      conversationId: 'conversation-the-row-recorded',
      clientTurnId: 'replay-key',
    });
  });

  it('a slow answer: Station is asked, and the bubble reads received while the request is still out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let answer!: (value: unknown) => void;
    sendExecutionMessageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    getTurnDeliveryMock.mockImplementation(
      async (_apiBase, conversationId, clientTurnId) => ({
        outcome: 'received',
        conversationId,
        clientTurnId,
      }),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current(chat, 'codex', undefined, 'slow start');
      await vi.advanceTimersByTimeAsync(0);
    });
    const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
      clientTurnId: string;
      conversationId: string;
    };
    const bubble = () =>
      activeChatsStore
        .getSnapshot()
        [chat]!.messages!.find((message) => message.role === 'user')!;
    expect(
      messageDeliveryStateFor(activeChatsStore.getSnapshot()[chat], bubble()),
    ).toBe('sending');
    expect(getTurnDeliveryMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(getTurnDeliveryMock).toHaveBeenCalledWith(
      'http://api.test',
      body.conversationId,
      body.clientTurnId,
      { projectSlug: 'station' },
    );
    expect(
      messageDeliveryStateFor(activeChatsStore.getSnapshot()[chat], bubble()),
    ).toBe('received');
    // The durable row remembers the answer for a relaunch.
    expect((await outboundDispatch.snapshot())[0]).toMatchObject({
      deliveryCheck: { outcome: 'received' },
    });
    await act(async () => {
      answer(receipt());
      await pending;
    });
    expect(
      messageDeliveryStateFor(activeChatsStore.getSnapshot()[chat], bubble()),
    ).toBe('delivered');
  });
});
