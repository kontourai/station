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

  it('no answer at all: the row goes back to pending with the SAME key, and the chat is not given a second copy', async () => {
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
    const rows = await outboundDispatch.snapshot();
    expect(rows).toEqual([
      expect.objectContaining({
        clientTurnId: body.clientTurnId,
        status: 'pending',
        content: 'lost in transit',
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
