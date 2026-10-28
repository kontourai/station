// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { conversationOpenPhase } from '../contexts/conversation-open-policy';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';

// A chat reopened mid-turn resolves `busy`, and its composer now takes a
// queued follow-up. The turn ending must re-read that verdict whichever
// continuation status it waited under, or the follow-up sits behind Check
// again until someone clicks it.
const id = 'busy-turn-end';
afterEach(() => activeChatsStore.removeChat(id));

test.each(['resolved', 'fork-ready'] as const)(
  'a busy wait (%s) is re-read when its turn completes',
  (status) => {
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Busy',
      conversationId: id,
      currentSessionId: id,
    });
    activeChatsStore.updateChat(id, {
      conversationOpenState: {
        status,
        canContinue: false,
        continuationPending: true,
      } as never,
      openTurnId: 'turn-1',
    });
    expect(conversationOpenPhase(activeChatsStore.getSnapshot()[id])).toBe(
      'busy',
    );
    handleOrchestrationEvent('', {
      eventId: 'completed',
      method: 'turn.completed',
      provider: 'codex',
      threadId: id,
      turnId: 'turn-1',
      createdAt: '2026-09-12T00:00:00Z',
      outputText: 'Done',
      finishReason: 'stop',
    } as never);
    expect(activeChatsStore.getSnapshot()[id].conversationOpenPending).toBe(
      true,
    );
  },
);
