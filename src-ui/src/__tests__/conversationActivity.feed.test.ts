/**
 * @vitest-environment jsdom
 *
 * #2309 (ported from the independent verifier): the list carriers — the
 * sessions list (how the watchdog's silence arrives) and the conversation
 * list — feed the store only for reads made after this mount. A list
 * restored from a persisted query cache can be a previous page load's copy,
 * and its open turn would otherwise read as live.
 */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  ConversationListItem,
  ConversationTurnActivity,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { isTurnInFlight } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useConversationActivityFeed } from '../hooks/orchestration/useConversationActivityFeed';

function record(conversationId: string, seq: number): ConversationTurnActivity {
  return {
    conversationId,
    asOfSequence: seq,
    openTurn: {
      turnId: 't',
      threadId: `${conversationId}:child`,
      startedAt: '2026-09-22T18:55:25.000Z',
    },
  };
}

function summary(
  conversationId: string,
  seq: number,
): OrchestrationSessionSummary {
  return {
    threadId: conversationId,
    conversationId,
    provider: 'claude',
    status: 'running',
    controlMode: 'station-owned',
    createdAt: '2026-09-22T18:00:00Z',
    updatedAt: '2026-09-22T18:55:25Z',
    isLoaded: true,
    isPersisted: true,
    answerability: { answerable: true },
    eventCount: 3,
    conversationActivity: record(conversationId, seq),
  };
}

function listItem(conversationId: string, seq: number): ConversationListItem {
  return {
    id: conversationId,
    source: 'runtime',
    agentSlug: agentId('dev-agent'),
    title: 'Listed',
    createdAt: '2026-09-22T18:00:00Z',
    updatedAt: '2026-09-22T18:55:25Z',
    messageCount: 2,
    mutable: true,
    answerability: { answerable: true },
    hasActiveTurn: true,
    activity: record(conversationId, seq),
  };
}

function init(conversationId: string) {
  activeChatsStore.initChat(conversationId, {
    agentSlug: 'dev-agent',
    agentName: 'Dev Agent',
    title: 'Feed',
    conversationId,
  });
}

describe('#2309 useConversationActivityFeed', () => {
  test('a sessions read made after mount makes the thread live', () => {
    const conv = 'claude:feed-sessions';
    init(conv);
    renderHook(() =>
      useConversationActivityFeed({
        sessions: [summary(conv, 3)],
        sessionsFetchedAfterMount: true,
        conversations: undefined,
        conversationsFetchedAfterMount: false,
      }),
    );
    expect(isTurnInFlight(activeChatsStore.getSnapshot()[conv])).toBe(true);
  });

  test('a conversation-list read made after mount makes the thread live', () => {
    const conv = 'claude:feed-list';
    init(conv);
    renderHook(() =>
      useConversationActivityFeed({
        sessions: [],
        sessionsFetchedAfterMount: false,
        conversations: [listItem(conv, 4)],
        conversationsFetchedAfterMount: true,
      }),
    );
    expect(isTurnInFlight(activeChatsStore.getSnapshot()[conv])).toBe(true);
  });

  test('a list restored from a persisted cache (not fetched after mount) never feeds liveness', () => {
    const conv = 'claude:feed-cached';
    init(conv);
    renderHook(() =>
      useConversationActivityFeed({
        sessions: [summary(conv, 5)],
        sessionsFetchedAfterMount: false,
        conversations: [listItem(conv, 6)],
        conversationsFetchedAfterMount: false,
      }),
    );
    expect(
      activeChatsStore.getSnapshot()[conv]?.conversationActivity,
    ).toBeUndefined();
    expect(isTurnInFlight(activeChatsStore.getSnapshot()[conv])).toBe(false);
  });
});
