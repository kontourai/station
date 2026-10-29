/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendExecutionMessageMock = vi.fn();
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  sendExecutionMessage: (...args: unknown[]) =>
    sendExecutionMessageMock(...args),
}));

const updateChatMock = vi.fn((sessionId: string, updates: unknown) => {
  activeChatsStore.updateChat(sessionId, updates as never);
});
const clearInputMock = vi.fn((sessionId: string) => {
  activeChatsStore.clearInput(sessionId);
});
const assignConversationIdMock = vi.fn(
  (sessionId: string, conversationId: string) => {
    activeChatsStore.assignConversationId(sessionId, conversationId);
  },
);
const addEphemeralMessageMock = vi.fn((sessionId: string, message: unknown) => {
  activeChatsStore.addEphemeralMessage(sessionId, message as never);
});
const clearEphemeralMessagesMock = vi.fn((sessionId: string) => {
  activeChatsStore.clearEphemeralMessages(sessionId);
});

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: updateChatMock,
    clearInput: clearInputMock,
    assignConversationId: assignConversationIdMock,
    addEphemeralMessage: addEphemeralMessageMock,
    clearEphemeralMessages: clearEphemeralMessagesMock,
  }),
}));

vi.mock('../hooks/useStreamingMessage', () => ({
  useStreamingMessage: () => ({ clearStreamingMessage: vi.fn() }),
}));

const agentConnectionsMock = vi.fn(() => ({ data: [] as unknown[] }));
const invalidateMock = vi.fn();
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    conversationQueries: {
      inventory: () => ({ queryKey: ['conversation-inventory'] }),
    },
    useEngineConnectionsQuery: () => agentConnectionsMock(),
    useConfigQuery: () => ({
      data: undefined,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    }),
    useAgentsQuery: () => ({ data: [], error: null }),
    useInvalidateQuery: () => invalidateMock,
    interruptOrchestrationTurn: vi.fn(),
    steerOrchestrationTurn: vi.fn(),
    isProvablyNotSent: actual.isProvablyNotSent,
    // #2338: the send path reads the cached session list through the real
    // hook, so it needs a real QueryClient (see renderSendMessage) rather
    // than a stub that would answer every cache read with a fixed value.
    useQueryClient: actual.useQueryClient,
  };
});

vi.mock('../lib/outboundQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/outboundQueue')>();
  return { ...actual };
});

import { activeChatsStore } from '../contexts/active-chats-store';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';
import { useSendMessage } from '../hooks/useActiveChatSessionMessaging';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  outboundDispatch,
} from '../lib/outboundQueue';

const sessionId = 'timeout-late-answer-chat';

/** useSendMessage under a real, empty QueryClient, as production mounts it. */
function renderSendMessage() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return {
    ...renderHook(() => useSendMessage('http://api.test'), { wrapper }),
    queryClient,
  };
}

/**
 * The exact error shape the native transport produces when the 20s
 * `timeout_recv_response` budget in `src-desktop/src/lib.rs` expires before
 * response headers arrive: a plain Error carrying `.code`, no numeric
 * status, so it is neither response evidence nor a TypeError.
 */
function transportTimeoutError() {
  return Object.assign(
    new Error(
      'Native Station request failed: Station request timed out before response headers arrived.',
    ),
    { code: 'transport_timeout' },
  );
}

function retryNotice() {
  return activeChatsStore
    .getSnapshot()
    [sessionId]?.ephemeralMessages?.find(
      (message) => message.action?.label === 'Retry',
    );
}

describe('transport_timeout followed by the late answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    sendExecutionMessageMock.mockRejectedValue(transportTimeoutError());
    activeChatsStore.initChat(sessionId, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'New chat',
      projectSlug: 'station',
      agentConnectionId: 'connection-that-ui-must-not-route',
      provider: 'claude',
    });
  });

  afterEach(() => {
    _resetOutboundQueueStorage();
    activeChatsStore.removeChat(sessionId);
  });

  it.each([false, true])(
    'keeps one durable timeout receipt and reconciles a keyed late start (edited composer: %s)',
    async (edited) => {
      const { result, queryClient, unmount } = renderSendMessage();
      try {
        await act(async () => {
          await result.current(
            sessionId,
            'codex',
            undefined,
            'run the full suite',
          );
        });
        expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
        const { clientTurnId } = sendExecutionMessageMock.mock.calls[0][1];
        expect(clientTurnId).toEqual(expect.any(String));
        const waiting = activeChatsStore.getSnapshot()[sessionId];
        expect(waiting?.status).toBe('queued');
        expect(waiting?.input).toBe('');
        expect(retryNotice()).toBeUndefined();
        expect(await outboundDispatch.snapshot()).toEqual([
          expect.objectContaining({
            clientTurnId,
            content: 'run the full suite',
            status: 'invoking',
            awaitingLookup: true,
          }),
        ]);
        const replay = vi.fn();
        await outboundDispatch.flush(replay, {
          station: { apiBase: 'http://api.test' },
        });
        expect(replay).not.toHaveBeenCalled();
        if (edited)
          activeChatsStore.updateChat(sessionId, {
            input: 'run the full suite plus lint',
          });
        act(() =>
          handleTurnStartedEvent({
            eventId: 'late-turn-started',
            provider: 'claude',
            threadId: sessionId,
            createdAt: '2026-09-22T12:35:00.000Z',
            method: 'turn.started',
            turnId: 'provider-turn-late',
            clientTurnId,
            prompt: 'run the full suite',
          }),
        );
        const reconciled = activeChatsStore.getSnapshot()[sessionId];
        expect(reconciled?.error).toBeUndefined();
        expect(retryNotice()).toBeUndefined();
        expect(reconciled?.input).toBe(
          edited ? 'run the full suite plus lint' : '',
        );
        expect(reconciled?.status).toBe('sending');
        expect(reconciled?.openTurnId).toBe('provider-turn-late');
        expect(reconciled?.deliveryChecks?.[clientTurnId]).toBe('started');
        expect(
          reconciled?.messages?.filter((message) => message.role === 'user'),
        ).toHaveLength(1);
        expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
        queryClient.clear();
      }
    },
  );
});
