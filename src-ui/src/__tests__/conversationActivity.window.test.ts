/**
 * @vitest-environment jsdom
 *
 * #2309: the bounded event-window read is a carrier of the conversation's
 * activity record. A chat opened on a conversation whose turn is already
 * running learns it from the window read, with no stream frame and no
 * snapshot row naming it.
 */
import type {
  ConversationTurnActivity,
  OrchestrationConversationEventWindow,
} from '@kontourai/station-contracts/orchestration';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const fetchWindow = vi.hoisted(() =>
  vi.fn<
    (...args: unknown[]) => Promise<OrchestrationConversationEventWindow>
  >(),
);
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  fetchSessionEventWindowCapability: async () => true,
  claimSessionEventWindowCapabilityRecovery: () => false,
  resetSessionEventWindowCapabilityRecovery: vi.fn(),
  fetchOrchestrationConversationEventWindow: (...args: unknown[]) =>
    fetchWindow(...args),
}));

import { isTurnInFlight } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useSessionEventWindow } from '../hooks/orchestration/useSessionEventWindow';

const CONVERSATION = 'claude:conv-window-2309';
const CHILD = `${CONVERSATION}:session:child`;

function page(
  activity: ConversationTurnActivity,
): OrchestrationConversationEventWindow {
  return {
    protocolVersion: 1,
    conversationId: CONVERSATION,
    currentSessionId: CHILD,
    handoffs: [],
    contextBoundaries: [],
    events: [],
    hasMore: false,
    watermark: 1,
    session: {
      threadId: CHILD,
      conversationId: CONVERSATION,
      provider: 'claude',
      status: 'running',
      controlMode: 'station-owned',
      createdAt: '2026-09-22T18:00:00Z',
      updatedAt: '2026-09-22T18:55:25Z',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
      hasActiveTurn: true,
      conversationActivity: activity,
    },
  };
}

describe('#2309 the event window feeds the activity record', () => {
  test('a window read of a running conversation makes its chat live and names the child turn', async () => {
    activeChatsStore.initChat(CONVERSATION, {
      agentSlug: 'dev-agent',
      agentName: 'Dev Agent',
      title: 'Window',
      conversationId: CONVERSATION,
    });
    fetchWindow.mockResolvedValue(
      page({
        conversationId: CONVERSATION,
        asOfSequence: 44,
        openTurn: {
          turnId: 'turn-window',
          threadId: CHILD,
          startedAt: '2026-09-22T18:55:25.000Z',
        },
      }),
    );
    // Premise: nothing else has told this chat about the turn.
    expect(isTurnInFlight(activeChatsStore.getSnapshot()[CONVERSATION])).toBe(
      false,
    );

    const { result } = renderHook(() =>
      useSessionEventWindow('http://station.test', CONVERSATION),
    );
    await waitFor(() => expect(result.current.settled).toBe(true));

    const chat = activeChatsStore.getSnapshot()[CONVERSATION];
    expect(chat?.conversationActivity?.openTurn?.turnId).toBe('turn-window');
    expect(isTurnInFlight(chat)).toBe(true);
  });
});
