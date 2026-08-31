// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { newChatLastChosenModel } from '../components/modals/new-chat-modal-utils';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  buildLastChosenModelBindingKeyFromIdentity,
  getLastChosenModelMap,
} from '../hooks/lastChosenModel';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';

const threadId = 'conversation-model-memory';

describe('accepted sticky model memory', () => {
  beforeEach(() => {
    localStorage.clear();
    activeChatsStore.removeChat(threadId);
    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Model memory',
      agentConnectionId: 'claude',
      provider: 'claude',
      requestedModel: 'claude-sonnet',
      requestedModelSource: 'session override',
    });
  });

  test('persists only the adapter-accepted choice for new chats', async () => {
    handleTurnStartedEvent({
      eventId: 'accepted-model',
      provider: 'claude',
      threadId,
      createdAt: '2026-08-24T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      metadata: { effectiveModel: 'claude-sonnet' },
    } as any);

    await vi.waitFor(() =>
      expect(getLastChosenModelMap()).toEqual({
        [buildLastChosenModelBindingKeyFromIdentity('claude', 'claude')]:
          'claude-sonnet',
      }),
    );
    expect(
      newChatLastChosenModel(
        {
          slug: 'claude',
          execution: { agentConnectionId: 'claude' },
        } as never,
        getLastChosenModelMap(),
      ),
    ).toBe('claude-sonnet');
  });

  test('a rejected override cannot become sticky accepted memory', () => {
    handleTurnStartedEvent({
      eventId: 'engine-kept-existing-model',
      provider: 'claude',
      threadId,
      createdAt: '2026-08-24T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      metadata: { effectiveModel: 'claude-opus' },
    } as any);

    // The rejected requested Sonnet never becomes the new-chat preference.
    expect(getLastChosenModelMap()).toEqual({});
  });
});
