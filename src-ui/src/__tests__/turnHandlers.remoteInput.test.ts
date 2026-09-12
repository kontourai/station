// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';

const id = 'shared-chat';
afterEach(() => activeChatsStore.removeChat(id));
function start(turnId: string, prompt: string) {
  handleTurnStartedEvent({
    eventId: `event-${turnId}`,
    method: 'turn.started',
    provider: 'codex',
    threadId: id,
    turnId,
    createdAt: '2026-09-12T00:00:00Z',
    prompt,
  });
}
test('server routing follows a successor before its first prompt and ignores a stale binding', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
    conversationId: id,
    currentSessionId: id,
  });
  const configured = {
    eventId: 'configured-child',
    method: 'session.configured' as const,
    provider: 'codex' as const,
    threadId: 'child',
    sessionId: 'child',
    createdAt: '2026-09-12T00:00:00Z',
  };
  handleOrchestrationEvent('', configured, undefined, {
    conversationId: id,
    currentSessionId: 'child',
  });
  handleOrchestrationEvent('', {
    ...configured,
    eventId: 'started-child',
    method: 'turn.started',
    turnId: 'next',
    prompt: 'From the desktop',
  });
  expect(activeChatsStore.getSnapshot()[id].currentSessionId).toBe('child');
  expect(activeChatsStore.getSnapshot()[id].conversationOpenPending).toBe(true);
  expect(activeChatsStore.getSnapshot()[id].messages).toMatchObject([
    { content: 'From the desktop', turnId: 'next' },
  ]);
  handleOrchestrationEvent(
    '',
    { ...configured, threadId: 'older-child' },
    undefined,
    { conversationId: id, currentSessionId: 'child' },
  );
  expect(activeChatsStore.getSnapshot()[id].currentSessionId).toBe('child');
});
test('another client receives the new prompt once before its answer starts', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  start('turn-1', 'Message from the phone');
  start('turn-1', 'Message from the phone');
  expect(activeChatsStore.getSnapshot()[id].messages).toMatchObject([
    { role: 'user', content: 'Message from the phone', turnId: 'turn-1' },
  ]);
});
test('a local optimistic input keeps its identity and is not duplicated by its turn receipt', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  activeChatsStore.updateChat(id, {
    pendingClientTurnId: 'request-1',
    messages: [
      { role: 'user', clientId: 'local-input', content: 'Typed message' },
    ],
  });
  start('turn-1', 'Typed message');
  expect(activeChatsStore.getSnapshot()[id].messages).toEqual([
    expect.objectContaining({
      clientId: 'local-input',
      content: 'Typed message',
      turnId: 'turn-1',
    }),
  ]);
  start('turn-2', 'A second message from the other client');
  expect(activeChatsStore.getSnapshot()[id].messages).toHaveLength(2);
});
