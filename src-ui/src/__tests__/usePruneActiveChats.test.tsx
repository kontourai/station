/**
 * @vitest-environment jsdom
 */

import {
  fetchAgentConversationPage,
  fetchOrchestrationSessions,
} from '@kontourai/station-sdk';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { usePruneActiveChats } from '../hooks/usePruneActiveChats';

vi.mock('@kontourai/station-sdk', () => ({
  fetchAgentConversationPage: vi.fn(),
  fetchOrchestrationSessions: vi.fn(),
}));

const fetchConversationPage = vi.mocked(fetchAgentConversationPage);
const fetchSessions = vi.mocked(fetchOrchestrationSessions);

function clearChats() {
  for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(sessionId);
  }
}

function seedChat(sessionId: string, conversationId: string) {
  activeChatsStore.initChat(sessionId, {
    agentSlug: 'agent-one',
    agentName: 'Agent One',
    title: 'Agent One Chat',
  });
  activeChatsStore.assignConversationId(sessionId, conversationId);
}

describe('usePruneActiveChats', () => {
  beforeEach(() => {
    clearChats();
    fetchConversationPage.mockReset();
    fetchSessions.mockReset();
    fetchSessions.mockResolvedValue([]);
  });

  afterEach(clearChats);

  test('removes only persisted chats whose durable conversation is gone', async () => {
    seedChat('session-kept', 'conversation-kept');
    seedChat('session-pruned', 'conversation-pruned');
    fetchConversationPage.mockResolvedValue({
      items: [{ id: 'conversation-kept' }],
      hasMore: false,
    });

    renderHook(() => usePruneActiveChats());

    await waitFor(() => {
      expect(activeChatsStore.getSnapshot()['session-pruned']).toBeUndefined();
    });
    expect(activeChatsStore.getSnapshot()['session-kept']).toBeDefined();
  });

  test('keeps persisted chats when conversation reconciliation is unavailable', async () => {
    seedChat('session-kept', 'conversation-kept');
    fetchConversationPage.mockRejectedValue(new Error('offline'));

    renderHook(() => usePruneActiveChats());

    await waitFor(() => expect(fetchConversationPage).toHaveBeenCalledOnce());
    expect(activeChatsStore.getSnapshot()['session-kept']).toBeDefined();
  });

  test('reconciles canonical provider chats against orchestration sessions', async () => {
    seedChat('thread-kept', 'thread-kept');
    seedChat('thread-pruned', 'thread-pruned');
    activeChatsStore.updateChat('thread-kept', {
      provider: 'claude',
      orchestrationSessionStarted: true,
    });
    activeChatsStore.updateChat('thread-pruned', {
      provider: 'claude',
      orchestrationSessionStarted: true,
    });
    fetchSessions.mockResolvedValue([{ threadId: 'thread-kept' }] as Awaited<
      ReturnType<typeof fetchOrchestrationSessions>
    >);

    renderHook(() => usePruneActiveChats());

    await waitFor(() => {
      expect(activeChatsStore.getSnapshot()['thread-pruned']).toBeUndefined();
    });
    expect(activeChatsStore.getSnapshot()['thread-kept']).toBeDefined();
    expect(fetchConversationPage).not.toHaveBeenCalled();
  });

  test('keeps pre-session provider chats in the shared conversation catalog', async () => {
    seedChat('acp-tab', 'acp-conversation');
    activeChatsStore.updateChat('acp-tab', {
      provider: 'acp',
      orchestrationSessionStarted: false,
    });
    fetchConversationPage.mockResolvedValue({
      items: [{ id: 'acp-conversation' }],
      hasMore: false,
    });

    renderHook(() => usePruneActiveChats());

    await waitFor(() => {
      expect(fetchConversationPage).toHaveBeenCalledWith('agent-one', {
        limit: 100,
      });
    });
    expect(activeChatsStore.getSnapshot()['acp-tab']).toBeDefined();
    expect(fetchSessions).not.toHaveBeenCalled();
  });

  test('does not prune when the bounded first page has more conversations', async () => {
    seedChat('session-first-page', 'conversation-first-page');
    seedChat('session-later-page', 'conversation-later-page');
    fetchConversationPage.mockResolvedValue({
      items: [{ id: 'conversation-first-page' }],
      hasMore: true,
      nextCursor: 'opaque-second-page',
    });

    renderHook(() => usePruneActiveChats());

    await waitFor(() =>
      expect(fetchConversationPage).toHaveBeenCalledWith('agent-one', {
        limit: 100,
      }),
    );
    expect(activeChatsStore.getSnapshot()['session-first-page']).toBeDefined();
    expect(activeChatsStore.getSnapshot()['session-later-page']).toBeDefined();
    expect(fetchConversationPage).toHaveBeenCalledTimes(1);
  });
});
