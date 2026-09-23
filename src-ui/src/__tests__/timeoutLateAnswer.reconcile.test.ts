/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
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
  };
});

vi.mock('../lib/outboundQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/outboundQueue')>();
  return { ...actual };
});

import { activeChatsStore } from '../contexts/active-chats-store';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';
import { useSendMessage } from '../hooks/useActiveChatSessionMessaging';

const sessionId = 'timeout-late-answer-chat';

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
    activeChatsStore.removeChat(sessionId);
  });

  it('holds the draft with a Retry notice while the turn actually started server-side', async () => {
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'run the full suite');
    });

    // The timeout is terminal client-side: failed status, the submitted
    // draft rolled back into the composer, and a Retry affordance that
    // reuses the same client turn id.
    const failed = activeChatsStore.getSnapshot()[sessionId];
    expect(failed?.status).toBe('error');
    expect(failed?.input).toBe('run the full suite');
    expect(retryNotice()?.content).toContain(
      'Connection to this Station timed out',
    );
  });

  it('releases the failed-turn state when the timed-out turn starts late', async () => {
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'run the full suite');
    });
    expect(retryNotice()).toBeDefined();

    // The server kept the turn: its `turn.started` arrives after the
    // client already failed the send. The failure claim is disproved —
    // the error, the Retry card, and the held draft must all go.
    handleTurnStartedEvent({
      eventId: 'late-turn-started',
      provider: 'claude',
      threadId: sessionId,
      createdAt: '2026-09-22T12:35:00.000Z',
      method: 'turn.started',
      turnId: 'provider-turn-late',
      prompt: 'run the full suite',
    } as any);

    const reconciled = activeChatsStore.getSnapshot()[sessionId];
    expect(reconciled?.error).toBeUndefined();
    expect(retryNotice()).toBeUndefined();
    expect(reconciled?.input).toBe('');
    expect(reconciled?.status).toBe('sending');
    expect(reconciled?.openTurnId).toBe('provider-turn-late');
  });

  it('never clobbers a composer the user edited after the failure', async () => {
    const { result } = renderHook(() => useSendMessage('http://api.test'));

    await act(async () => {
      await result.current(sessionId, 'codex', undefined, 'run the full suite');
    });
    // The user typed more into the held draft before the late start landed.
    activeChatsStore.updateChat(sessionId, {
      input: 'run the full suite plus lint',
    });

    handleTurnStartedEvent({
      eventId: 'late-turn-started-edited',
      provider: 'claude',
      threadId: sessionId,
      createdAt: '2026-09-22T12:35:00.000Z',
      method: 'turn.started',
      turnId: 'provider-turn-late',
      prompt: 'run the full suite',
    } as any);

    expect(activeChatsStore.getSnapshot()[sessionId]?.input).toBe(
      'run the full suite plus lint',
    );
  });
});
