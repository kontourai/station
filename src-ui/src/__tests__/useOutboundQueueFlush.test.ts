/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  outboundDispatch,
} from '../lib/outboundQueue';

const sendMessage = vi.fn();
const getTurnDelivery = vi.fn();

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  getTurnDelivery: (...args: unknown[]) => getTurnDelivery(...args),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnectionStatus: () => ({ status: 'connected' }),
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => sendMessage,
}));

import { useOutboundQueueFlush } from '../hooks/useOutboundQueueFlush';

describe('useOutboundQueueFlush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setOutboundQueueStorage({
      getItem: async () => [],
      setItem: async () => {},
      updateItem: async () => {
        throw new Error('IndexedDB is unavailable');
      },
    });
    activeChatsStore.initChat('session-1', {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Queued chat',
    });
  });

  afterEach(() => {
    activeChatsStore.removeChat('session-1');
    _resetOutboundQueueStorage();
  });

  it('surfaces a durable-settlement outage without invoking transport', async () => {
    renderHook(() => useOutboundQueueFlush('http://api.test'));

    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()['session-1']).toMatchObject({
        status: 'error',
        error: expect.stringContaining('delivery status is unavailable'),
      }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('replays the model and provider options captured when the turn was queued', async () => {
    let stored: unknown;
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    await outboundDispatch.enqueue({
      clientTurnId: 'queued-model-x',
      sessionId: 'session-1',
      agentSlug: 'codex',
      content: 'keep my model',
      requestedModel: 'model-x',
      requestedProviderOptions: { effort: 'high' },
      model: 'model-x-resolved',
      providerOptions: { effort: 'high', fastMode: true },
    });
    activeChatsStore.updateChat('session-1', {
      requestedModel: 'model-y',
      providerOptions: { effort: 'low' },
    });
    sendMessage.mockResolvedValue({
      kind: 'accepted',
      providerTurnId: 'provider-turn-1',
    });

    renderHook(() => useOutboundQueueFlush('http://api.test'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[7]).toMatchObject({
      executionSnapshot: {
        requestedModel: 'model-x',
        requestedProviderOptions: { effort: 'high' },
        model: 'model-x-resolved',
        providerOptions: { effort: 'high', fastMode: true },
      },
    });
  });

  it('sends a waiting row once its chat becomes writable, after the pass that deferred it', async () => {
    let stored: unknown;
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    // A reloaded chat re-proves its conversation before it may send.
    activeChatsStore.updateChat('session-1', { conversationOpenPending: true });
    await outboundDispatch.enqueue({
      clientTurnId: 'waits-for-open',
      sessionId: 'session-1',
      agentSlug: 'codex',
      content: 'send me when writable',
    });
    sendMessage.mockResolvedValue({
      kind: 'accepted',
      providerTurnId: 'provider-turn-open',
    });
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(() =>
      expect(
        activeChatsStore.getSnapshot()['session-1']?.outboundQueuedTurns,
      ).toEqual([expect.objectContaining({ clientTurnId: 'waits-for-open' })]),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    activeChatsStore.updateChat('session-1', {
      conversationOpenPending: false,
    });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[6]).toBe('waits-for-open');
  });

  it("keeps a durable copy of each follow-up held in a chat's queue, and drops it when the queue no longer holds it", async () => {
    let stored: unknown;
    _setOutboundQueueStorage({
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      updateItem: async (_key, updater) => {
        stored = updater(stored);
      },
    });
    activeChatsStore.updateChat('session-1', {
      queuedMessages: ['held one', 'steering one'],
      queuedMessageMetadata: [
        { id: 'held-key', mode: 'queue' },
        { id: 'steer-key', mode: 'steer', delivery: 'steering' },
      ],
    });
    renderHook(() => useOutboundQueueFlush('http://api.test'));
    await waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual([
        expect.objectContaining({
          clientTurnId: 'held-key',
          content: 'held one',
          status: 'pending',
          heldBy: expect.objectContaining({ bootId: expect.any(String) }),
          station: { apiBase: 'http://api.test' },
        }),
      ]),
    );
    // Held rows are the queue's to send while this app lives.
    expect(sendMessage).not.toHaveBeenCalled();
    activeChatsStore.updateChat('session-1', {
      queuedMessages: [],
      queuedMessageMetadata: [],
    });
    await waitFor(async () =>
      expect(await outboundDispatch.snapshot()).toEqual([]),
    );
  });

  describe('a reload while messages were held or mid-drain', () => {
    function storedRows(turns: unknown[]) {
      let stored: unknown = {
        version: 2,
        terminalEvidence: [],
        completedTerminals: [],
        turns,
      };
      _setOutboundQueueStorage({
        getItem: async () => stored,
        setItem: async (_key, value) => {
          stored = value;
        },
        updateItem: async (_key, updater) => {
          stored = updater(stored);
        },
      });
    }
    const longAgo = Date.now() - 10 * 60_000;

    it("the restored queue takes back a held copy before the flush could send it, so the queue's edit is the only sender", async () => {
      storedRows([
        {
          clientTurnId: 'held-key',
          sessionId: 'session-1',
          conversationId: 'session-1',
          agentSlug: 'codex',
          content: 'original text',
          createdAt: longAgo,
          attempts: 0,
          status: 'pending',
          // The previous page's renderer, gone well past the grace period.
          heldBy: {
            bootId: 'renderer-before-reload',
            heldAt: longAgo,
            orphanSince: longAgo,
          },
        },
      ]);
      activeChatsStore.updateChat('session-1', {
        queuedMessages: ['edited text'],
        queuedMessageMetadata: [{ id: 'held-key', mode: 'queue' }],
      });
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(async () =>
        expect(await outboundDispatch.snapshot()).toEqual([
          expect.objectContaining({
            clientTurnId: 'held-key',
            content: 'edited text',
            heldBy: expect.objectContaining({
              bootId: expect.not.stringMatching(/^renderer-before-reload$/),
            }),
          }),
        ]),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('a send that was mid-drain at the reload is taken back by the restored queue when Station never received it, not also flushed', async () => {
      storedRows([
        {
          clientTurnId: 'drained-key',
          sessionId: 'session-1',
          conversationId: 'session-1',
          agentSlug: 'codex',
          content: 'mid drain',
          createdAt: longAgo,
          attempts: 1,
          status: 'invoking',
          origin: 'live',
          dispatchBootId: 'renderer-before-reload',
          claimedAt: longAgo,
        },
      ]);
      // The reload restored it to the head of the chat's queue.
      activeChatsStore.updateChat('session-1', {
        queuedMessages: ['mid drain'],
        queuedMessageMetadata: [{ id: 'drained-key', mode: 'queue' }],
      });
      getTurnDelivery.mockImplementation(
        async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'not-received',
          conversationId,
          clientTurnId,
        }),
      );
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(() => expect(getTurnDelivery).toHaveBeenCalled());
      await waitFor(async () =>
        expect(await outboundDispatch.snapshot()).toEqual([
          expect.objectContaining({
            clientTurnId: 'drained-key',
            status: 'pending',
            heldBy: expect.objectContaining({ bootId: expect.any(String) }),
          }),
        ]),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('a send the app was closed during', () => {
    function orphanedLiveRow() {
      let stored: unknown = {
        version: 2,
        terminalEvidence: [],
        completedTerminals: [],
        turns: [
          {
            clientTurnId: 'key-orphan',
            sessionId: 'session-1',
            conversationId: 'session-1',
            agentSlug: 'codex',
            content: 'sent as the app closed',
            createdAt: Date.now() - 10 * 60_000,
            attempts: 1,
            status: 'invoking',
            origin: 'live',
            // A renderer that no longer exists; this platform has no Web
            // Locks, so the row's age decides it is abandoned.
            dispatchBootId: 'renderer-that-was-killed',
            claimedAt: Date.now() - 10 * 60_000,
          },
        ],
      };
      _setOutboundQueueStorage({
        getItem: async () => stored,
        setItem: async (_key, value) => {
          stored = value;
        },
        updateItem: async (_key, updater) => {
          stored = updater(stored);
        },
      });
    }

    it('Station never received it: sent again on launch with the same key, once', async () => {
      orphanedLiveRow();
      getTurnDelivery.mockImplementation(
        async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'not-received',
          conversationId,
          clientTurnId,
        }),
      );
      sendMessage.mockResolvedValue({
        kind: 'accepted',
        providerTurnId: 'provider-turn-orphan',
      });
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(getTurnDelivery).toHaveBeenCalledWith(
        'http://api.test',
        'session-1',
        'key-orphan',
        undefined,
      );
      expect(sendMessage.mock.calls[0]?.[6]).toBe('key-orphan');
      expect(sendMessage.mock.calls[0]?.[3]).toBe('sent as the app closed');
    });

    it('Station started it: delivered, nothing is sent', async () => {
      orphanedLiveRow();
      getTurnDelivery.mockImplementation(
        async (_apiBase, conversationId, clientTurnId) => ({
          outcome: 'started',
          conversationId,
          clientTurnId,
          sessionId: 'session-1',
          turnId: 'provider-turn-orphan',
        }),
      );
      renderHook(() => useOutboundQueueFlush('http://api.test'));
      await waitFor(async () =>
        expect(await outboundDispatch.snapshot()).toEqual([]),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
