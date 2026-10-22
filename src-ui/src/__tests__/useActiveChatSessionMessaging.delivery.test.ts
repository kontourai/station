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
    orchestrationQueries: actual.orchestrationQueries,
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

import {
  ChatHttpError,
  StationRequestTimeoutError,
} from '@kontourai/station-sdk/client';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';
import { useSendMessage } from '../hooks/useActiveChatSessionMessaging';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  type OutboundDispatchTurn,
  outboundDispatch,
} from '../lib/outboundQueue';
import { messageDeliveryStateFor } from '../utils/messageDeliveryState';

const chat = 'chat-delivery-1';

function memoryStorage() {
  const values = new Map<string, unknown>();
  _setOutboundQueueStorage({
    getItem: async (key) => values.get(key),
    setItem: async (key, next) => {
      values.set(key, next);
    },
    updateItem: async (key, updater) => {
      values.set(key, updater(values.get(key)));
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

  it("no answer: the notice's Discard asks first, then withdraws the row awaiting Station's lookup", async () => {
    sendExecutionMessageMock.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(chat, 'codex', undefined, 'no answer came back');
    });
    const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
      clientTurnId: string;
    };
    const notice = activeChatsStore
      .getSnapshot()
      [chat]?.ephemeralMessages?.find(
        (message) => message.action?.label === 'Discard…',
      );
    expect(notice?.content).toContain(
      "Send wasn't confirmed — queued to retry automatically",
    );
    // The message may already have reached Station: the shared confirmation
    // states the risk before the handler runs.
    expect(notice?.action?.confirm).toBe('unconfirmed-discard');
    await act(async () => {
      await notice!.action!.handler();
    });
    expect(activeChatsStore.getSnapshot()[chat]?.error).toBeUndefined();
    expect(await outboundDispatch.snapshot()).toEqual([]);
    expect(
      activeChatsStore
        .getSnapshot()
        [chat]?.messages?.some(
          (message) => message.clientId === body.clientTurnId,
        ),
    ).toBe(false);
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

  it.each([
    ['attachment', 'network_changed'],
    ['storage-failure', 'network_changed'],
    ['attachment', 'fetch'],
    ['attachment', 'proxy'],
    ['attachment', 'transport_reset'],
    ['attachment', 'transport_timeout'],
    ['attachment', 'transport_tls'],
    ['attachment', 'sdk-timeout'],
    ['attachment', 'abort'],
  ])(
    'looks up a received %s send after %s without a live row before any flush',
    async (mode, failure) => {
      const attachments =
        mode === 'attachment'
          ? [
              {
                id: 'image-1',
                name: 'screen.png',
                type: 'image/png',
                size: 3,
                data: 'data:image/png;base64,YWJj',
              },
            ]
          : undefined;
      if (attachments)
        activeChatsStore.updateChat(chat, {
          attachmentStages: attachments.map((attachment) => ({
            clientAttachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.type,
            size: attachment.size,
            state: 'complete',
            progress: 1,
            delivery: 'legacy-inline',
          })),
        });
      if (mode === 'storage-failure') {
        const values = new Map<string, unknown>();
        let writes = 0;
        _setOutboundQueueStorage({
          getItem: async (key) => values.get(key),
          setItem: async (key, value) => {
            values.set(key, value);
          },
          updateItem: async (key, updater) => {
            if (++writes === 1)
              throw new Error('storage unavailable before send');
            values.set(key, updater(values.get(key)));
          },
        });
      }
      // This fixture records the server effect before losing its response.
      const turns: string[] = [];
      sendExecutionMessageMock.mockImplementation(async (_apiBase, body) => {
        expect(await outboundDispatch.snapshot()).toEqual([]);
        turns.push(body.clientTurnId);
        if (failure === 'proxy')
          throw new ChatHttpError(
            { status: 502, message: 'Bad gateway' } as never,
            false,
          );
        if (failure === 'fetch') throw new TypeError('Failed to fetch');
        if (failure === 'sdk-timeout')
          throw new StationRequestTimeoutError('http://api.test', 60000, {
            method: 'POST',
          });
        if (failure === 'abort')
          throw new DOMException('Aborted after send', 'AbortError');
        throw Object.assign(
          failure === 'network_changed'
            ? new TypeError('Network changed')
            : new Error('Lost response'),
          { code: failure },
        );
      });
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      await act(async () => {
        await result.current(
          chat,
          'codex',
          undefined,
          'received once',
          attachments,
        );
      });
      expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
      const key = turns[0]!;
      expect(await outboundDispatch.snapshot()).toEqual([
        expect.objectContaining({
          clientTurnId: key,
          conversationId: chat,
          status: 'invoking',
          awaitingLookup: true,
          station: { apiBase: 'http://api.test' },
        }),
      ]);
      await expect(outboundDispatch.edit(key, 'changed')).rejects.toThrow();
      await expect(outboundDispatch.discard(key)).rejects.toThrow();
      const replay = vi.fn(async (turn: Readonly<OutboundDispatchTurn>) => {
        turns.push(turn.clientTurnId);
        return { kind: 'accepted' as const, providerTurnId: 'duplicate-turn' };
      });
      await outboundDispatch.flush(replay, {
        station: { apiBase: 'http://api.test' },
      });
      expect(replay).not.toHaveBeenCalled();
      const lookup = vi.fn(async (turn: Readonly<OutboundDispatchTurn>) => ({
        clientTurnId: turn.clientTurnId,
        conversationId: turn.conversationId!,
        outcome: 'started' as const,
      }));
      await outboundDispatch.reconcile(lookup, {
        station: { apiBase: 'http://api.test' },
      });
      expect(lookup).toHaveBeenCalledWith(
        expect.objectContaining({ clientTurnId: key }),
      );
      await outboundDispatch.flush(replay, {
        station: { apiBase: 'http://api.test' },
      });
      expect(replay).not.toHaveBeenCalled();
      expect(turns).toEqual([key]);
      expect(await outboundDispatch.snapshot()).toEqual([]);
    },
  );

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

  it.each([
    ['the engine is busy', 'provider_turn_in_progress'],
    ['its session is still starting', 'provider_session_starting'],
  ])(
    'refused because %s: moved into the local queue with its durable row kept, same key',
    async (_why, code) => {
      // Hold the drain's own settle timer so the held state can be read.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      sendExecutionMessageMock.mockRejectedValueOnce(
        new ChatHttpError(409, 'Not yet', code),
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
    },
  );

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

  it('a resend of a key the outbox holds as possibly started is not sent', async () => {
    const earlier = await outboundDispatch.beginLive({
      clientTurnId: 'possibly-started',
      sessionId: chat,
      agentSlug: 'codex',
      content: 'once only',
    });
    await earlier.indeterminate('Station could not confirm the start.');
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    let sent: unknown;
    const onAdmission = vi.fn();
    await act(async () => {
      sent = await result.current(
        chat,
        'codex',
        undefined,
        'once only',
        undefined,
        undefined,
        'possibly-started',
        { onAdmission },
      );
    });
    expect(sent).toBe(false);
    // Never "not sent": a caller told that would offer a second send.
    expect(onAdmission).toHaveBeenCalledWith('indeterminate');
    expect(onAdmission).not.toHaveBeenCalledWith('not-invoked');
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[chat]?.input).toBe('');
  });

  it('sending a message that was discarded puts its text back in the composer, never loses it, and sends nothing', async () => {
    await outboundDispatch.syncHeld([
      {
        clientTurnId: 'discarded-key',
        sessionId: chat,
        agentSlug: 'codex',
        content: 'changed my mind',
      },
    ]);
    await outboundDispatch.discard('discarded-key');
    const onAdmission = vi.fn();
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(
        chat,
        'codex',
        undefined,
        'changed my mind',
        undefined,
        undefined,
        'discarded-key',
        { onAdmission },
      );
    });
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[chat]?.input).toBe('changed my mind');
    expect(onAdmission).toHaveBeenCalledWith('not-invoked');
  });

  /** An in-memory outbox whose next write runs `before` first, once. */
  function armableStorage() {
    const values = new Map<string, unknown>();
    let before: (() => Promise<void> | void) | undefined;
    _setOutboundQueueStorage({
      getItem: async (key) => values.get(key),
      setItem: async (key, next) => {
        values.set(key, next);
      },
      updateItem: async (key, updater) => {
        const hook = before;
        before = undefined;
        await hook?.();
        values.set(key, updater(values.get(key)));
      },
    });
    return {
      arm: (hook: () => Promise<void> | void) => {
        before = hook;
      },
    };
  }

  it('a discarded message resent over a newer draft keeps that draft and carries the text in the notice', async () => {
    const storage = armableStorage();
    await outboundDispatch.syncHeld([
      {
        clientTurnId: 'discarded-over-draft',
        sessionId: chat,
        agentSlug: 'codex',
        content: 'the old words',
      },
    ]);
    await outboundDispatch.discard('discarded-over-draft');
    // The user starts a new draft while the outbox is being written.
    storage.arm(() => {
      activeChatsStore.updateChat(chat, { input: 'a newer draft' });
    });
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(
        chat,
        'codex',
        undefined,
        'the old words',
        undefined,
        undefined,
        'discarded-over-draft',
      );
    });
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    const state = activeChatsStore.getSnapshot()[chat];
    expect(state?.input).toBe('a newer draft');
    const notice = state?.ephemeralMessages?.find(
      (message) =>
        message.role === 'system' &&
        String(message.content).includes('discarded'),
    );
    expect(String(notice?.content)).toContain('the old words');
    expect(String(notice?.content)).not.toContain('back in the composer');
  });

  it('an offline send of a discarded message is not reported as "Send unavailable"; its text comes back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const storage = armableStorage();
    await outboundDispatch.syncHeld([
      {
        clientTurnId: 'discarded-offline',
        sessionId: chat,
        agentSlug: 'codex',
        content: 'once more',
      },
    ]);
    await outboundDispatch.discard('discarded-offline');
    // The durable write outlasts its bound, so the send goes without a row
    // and, offline, reaches the queue's enqueue, which refuses the key.
    storage.arm(
      () => new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    );
    sendExecutionMessageMock.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    const onAdmission = vi.fn();
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current(
        chat,
        'codex',
        undefined,
        'once more',
        undefined,
        undefined,
        'discarded-offline',
        { onAdmission },
      );
      await vi.advanceTimersByTimeAsync(3_500);
    });
    await act(async () => {
      await pending;
    });
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    const state = activeChatsStore.getSnapshot()[chat];
    expect(state?.error ?? '').not.toContain('Send unavailable');
    expect(state?.status).toBe('idle');
    expect(state?.input).toBe('once more');
    // Not shown as sent: no bubble for it, and no turn awaited.
    expect(
      state?.messages?.some(
        (message) => message.clientId === 'discarded-offline',
      ),
    ).toBe(false);
    expect(state?.pendingClientTurnId).toBeUndefined();
    expect(onAdmission).toHaveBeenCalledWith('not-invoked');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(await outboundDispatch.snapshot()).toEqual([]);
  });

  it('an offline send of a message already delivered says so, is not "Send unavailable", and is not queued', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const storage = armableStorage();
    const delivered = await outboundDispatch.beginLive({
      clientTurnId: 'delivered-offline',
      sessionId: chat,
      agentSlug: 'codex',
      content: 'done already',
    });
    await delivered.accepted();
    storage.arm(
      () => new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    );
    sendExecutionMessageMock.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    const onAdmission = vi.fn();
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current(
        chat,
        'codex',
        undefined,
        'done already',
        undefined,
        undefined,
        'delivered-offline',
        { onAdmission },
      );
      await vi.advanceTimersByTimeAsync(3_500);
    });
    await act(async () => {
      await pending;
    });
    const state = activeChatsStore.getSnapshot()[chat];
    expect(state?.error ?? '').not.toContain('Send unavailable');
    expect(state?.status).toBe('idle');
    expect(
      state?.ephemeralMessages?.some((message) =>
        String(message.content).includes('already delivered'),
      ),
    ).toBe(true);
    expect(onAdmission).toHaveBeenCalledWith('accepted');
    // Not shown as a fresh send: its bubble goes and no turn is awaited.
    expect(
      state?.messages?.some(
        (message) => message.clientId === 'delivered-offline',
      ),
    ).toBe(false);
    expect(state?.pendingClientTurnId).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(await outboundDispatch.snapshot()).toEqual([]);
  });

  it('sending a message already delivered sends nothing and says it was delivered', async () => {
    const delivered = await outboundDispatch.beginLive({
      clientTurnId: 'delivered-key',
      sessionId: chat,
      agentSlug: 'codex',
      content: 'done already',
    });
    await delivered.accepted();
    const onAdmission = vi.fn();
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    await act(async () => {
      await result.current(
        chat,
        'codex',
        undefined,
        'done already',
        undefined,
        undefined,
        'delivered-key',
        { onAdmission },
      );
    });
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(onAdmission).toHaveBeenCalledWith('accepted');
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

  it.each([
    'lookup',
    'turn-started',
    'during-release',
    'newer-send',
    'other-key',
    'unkeyed-turn',
    'received',
    'indeterminate',
    'unknown',
    'late-received',
    'late-unknown',
    'late-not-received',
  ] as const)(
    'a late transport failure respects the exact send evidence (%s)',
    async (witness) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const storage =
        witness === 'during-release' ? armableStorage() : undefined;
      let rejectSend!: (reason: Error) => void;
      sendExecutionMessageMock.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSend = reject;
          }),
      );
      let resolveLookup: (() => void) | undefined;
      getTurnDeliveryMock.mockImplementation(
        (_apiBase, conversationId, clientTurnId) => {
          const outcome = witness.startsWith('late-')
            ? witness.slice('late-'.length)
            : ['received', 'indeterminate', 'unknown'].includes(witness)
              ? witness
              : 'started';
          const answer = { outcome, conversationId, clientTurnId };
          return witness.startsWith('late-')
            ? new Promise((resolve) => {
                resolveLookup = () => resolve(answer);
              })
            : Promise.resolve(answer);
        },
      );
      const { result } = renderHook(() => useSendMessage('http://api.test'));
      let pending!: Promise<unknown>;
      const onAdmission = vi.fn();
      await act(async () => {
        pending = result.current(
          chat,
          'codex',
          undefined,
          'delivered before the response',
          undefined,
          undefined,
          undefined,
          { onAdmission },
        );
        await vi.advanceTimersByTimeAsync(0);
      });
      const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
        clientTurnId: string;
      };
      const observeStart = (clientTurnId: string | null = body.clientTurnId) =>
        handleTurnStartedEvent({
          provider: 'codex',
          threadId: chat,
          turnId: 'provider-turn-1',
          eventId: 'started-event',
          createdAt: '2026-10-16T03:00:00.000Z',
          method: 'turn.started',
          ...(clientTurnId ? { clientTurnId } : {}),
          prompt: 'delivered before the response',
        });
      const newerController = new AbortController();
      await act(async () => {
        if (witness === 'lookup' || witness === 'newer-send') {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(
            activeChatsStore.getSnapshot()[chat]?.deliveryChecks?.[
              body.clientTurnId
            ],
          ).toBe('started');
          activeChatsStore.updateChat(chat, { status: 'idle' });
        } else if (
          witness === 'received' ||
          witness === 'indeterminate' ||
          witness === 'unknown'
        ) {
          await vi.advanceTimersByTimeAsync(5_000);
        } else if (witness.startsWith('late-')) {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(resolveLookup).toBeDefined();
          observeStart();
          resolveLookup!();
          await vi.advanceTimersByTimeAsync(0);
          expect(
            activeChatsStore.getSnapshot()[chat]?.deliveryChecks?.[
              body.clientTurnId
            ],
          ).toBe('started');
        } else if (witness === 'turn-started') {
          observeStart();
        } else if (witness === 'during-release') {
          storage!.arm(observeStart);
        } else if (witness === 'unkeyed-turn') {
          observeStart(null);
        } else {
          observeStart('other-key');
        }
        if (witness === 'newer-send')
          activeChatsStore.updateChat(chat, {
            status: 'sending',
            abortController: newerController,
            pendingClientTurnId: 'newer-key',
            sendAwaitingTurnStart: true,
            input: 'newer draft',
          });
      });
      let outcome: unknown;
      await act(async () => {
        rejectSend(new TypeError('Failed to fetch'));
        outcome = await pending;
      });
      const delivered =
        witness.startsWith('late-') ||
        ['lookup', 'turn-started', 'during-release', 'newer-send'].includes(
          witness,
        );
      const state = activeChatsStore.getSnapshot()[chat];
      expect(outcome).toBe(delivered);
      expect(state?.status).toBe(
        !delivered ? 'queued' : witness === 'lookup' ? 'idle' : 'sending',
      );
      expect(
        state?.ephemeralMessages?.some((message) => message.queuedRetry) ??
          false,
      ).toBe(!delivered);
      if (delivered) {
        expect(await outboundDispatch.snapshot()).toEqual([]);
        expect((await outboundDispatch.retiredKeys()).accepted).toContain(
          body.clientTurnId,
        );
        await outboundDispatch.flush(async () => {
          throw new Error('Delivered message must not be resent');
        });
      } else {
        expect(await outboundDispatch.snapshot()).toEqual([
          expect.objectContaining({
            clientTurnId: body.clientTurnId,
            status: 'invoking',
          }),
        ]);
      }
      if (witness === 'newer-send')
        expect(state).toMatchObject({
          abortController: newerController,
          pendingClientTurnId: 'newer-key',
          sendAwaitingTurnStart: true,
          input: 'newer draft',
        });
      expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
      expect(onAdmission).toHaveBeenCalledWith('accepted');
    },
  );

  it("records this window's own send, and whether it was saved on the device, until Station starts it", async () => {
    let answer!: (value: unknown) => void;
    sendExecutionMessageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { result } = renderHook(() => useSendMessage('http://api.test'));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current(chat, 'codex', undefined, 'mine');
      await vi.waitFor(() =>
        expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1),
      );
    });
    const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
      clientTurnId: string;
    };
    const state = () => activeChatsStore.getSnapshot()[chat];
    expect(state()?.localSendKeys).toEqual([body.clientTurnId]);
    // Its outbox row was written before the request.
    expect(state()?.durableClientTurnId).toBe(body.clientTurnId);
    await act(async () => {
      answer(receipt());
      await pending;
    });
    // Started: delivered for good, never "Not confirmed" later.
    expect(state()?.localSendKeys).toEqual([]);
  });

  it('a send that waited on a starting session and went back to the queue loses its earlier "received"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let refuse!: (error: unknown) => void;
    sendExecutionMessageMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
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
      pending = result.current(chat, 'codex', undefined, 'slow session');
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
      clientTurnId: string;
    };
    // Station held the claim while the session started: it read received.
    expect(activeChatsStore.getSnapshot()[chat]?.deliveryChecks).toMatchObject({
      [body.clientTurnId]: 'received',
    });
    await act(async () => {
      refuse(
        new ChatHttpError(409, 'Still starting', 'provider_session_starting'),
      );
      await pending;
    });
    // Queued to be sent again: nothing may still say Station has it.
    expect(
      activeChatsStore.getSnapshot()[chat]?.deliveryChecks?.[body.clientTurnId],
    ).toBeUndefined();
    const [row] = await outboundDispatch.snapshot();
    expect(row).toMatchObject({
      clientTurnId: body.clientTurnId,
      status: 'pending',
    });
    expect(row?.deliveryCheck).toBeUndefined();
  });

  it('a resend of a key drops the earlier "received": a refusal lost in transit does not label the lookup-driven resend', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let lose!: (error: unknown) => void;
    sendExecutionMessageMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          lose = reject;
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
    let first!: Promise<unknown>;
    await act(async () => {
      first = result.current(chat, 'codex', undefined, 'refusal lost');
      // The request goes out after the outbox write and lazy imports.
      await vi.waitFor(() =>
        expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1),
      );
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const body = sendExecutionMessageMock.mock.calls[0]?.[1] as {
      clientTurnId: string;
    };
    // Station's refusal never arrives: the request just fails.
    await act(async () => {
      lose(new TypeError('Failed to fetch'));
      await first;
    });
    const bubble = () =>
      activeChatsStore
        .getSnapshot()
        [chat]!.messages!.find(
          (message) =>
            message.role === 'user' && message.clientId === body.clientTurnId,
        )!;
    // The earlier attempt's answer is still on record.
    expect(
      activeChatsStore.getSnapshot()[chat]?.deliveryChecks?.[body.clientTurnId],
    ).toBe('received');
    // Station says it never got it: the outbox resends it under the same key.
    await outboundDispatch.reconcile(
      async (turn) => ({
        outcome: 'not-received',
        conversationId: turn.conversationId!,
        clientTurnId: turn.clientTurnId,
      }),
      { station: { apiBase: 'http://api.test' } },
    );
    let answer!: (value: unknown) => void;
    sendExecutionMessageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    let resend!: Promise<unknown>;
    await act(async () => {
      resend = result.current(
        chat,
        'codex',
        undefined,
        'refusal lost',
        undefined,
        undefined,
        body.clientTurnId,
        {
          skipInMemoryQueueOnBusy: true,
          dispatch: { indeterminate: async () => 'applied' as const },
        },
      );
      await vi.waitFor(() =>
        expect(sendExecutionMessageMock).toHaveBeenCalledTimes(2),
      );
    });
    // The resend is on its way, not something Station already has.
    expect(
      activeChatsStore.getSnapshot()[chat]?.deliveryChecks?.[body.clientTurnId],
    ).toBeUndefined();
    expect(
      messageDeliveryStateFor(activeChatsStore.getSnapshot()[chat], bubble()),
    ).toBe('sending');
    await act(async () => {
      answer(receipt());
      await resend;
    });
    expect(
      messageDeliveryStateFor(activeChatsStore.getSnapshot()[chat], bubble()),
    ).toBe('delivered');
  });
});
