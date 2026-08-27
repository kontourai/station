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
});
