// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { beginConversationHandoffUiState } from '../components/chat-dock/conversationHandoffUiState';
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

test('a live steer that stopped the running step carries that onto its row', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'opencode',
    agentName: 'OpenCode',
    title: 'Steer',
  });
  start('turn-1', 'run the gates');
  handleTurnStartedEvent({
    eventId: 'event-steer',
    method: 'turn.started',
    provider: 'acp',
    threadId: id,
    turnId: 'turn-1',
    createdAt: '2026-09-12T00:00:05Z',
    prompt: 'Still going?',
    inputKind: 'steer',
    steerInterruptedRun: true,
  });
  const steerRow = activeChatsStore
    .getSnapshot()
    [id].messages?.find((message) => message.content === 'Still going?');
  expect(steerRow?.steerInterruptedRun).toBe(true);
});
test('a keyed turn.started binds the bubble carrying its key, never the newest one by position', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  // Two unstarted local sends; the older one's turn starts first. The
  // position heuristic would pin it on the newest bubble.
  activeChatsStore.updateChat(id, {
    pendingClientTurnId: 'key-new',
    status: 'sending',
    sendAwaitingTurnStart: true,
    messages: [
      { role: 'user', content: 'first message', clientId: 'key-old' },
      { role: 'user', content: 'second message', clientId: 'key-new' },
    ],
  });
  handleTurnStartedEvent({
    eventId: 'event-old',
    method: 'turn.started',
    provider: 'codex',
    threadId: id,
    turnId: 'turn-old',
    createdAt: '2026-10-13T00:00:00Z',
    prompt: 'first message',
    clientTurnId: 'key-old',
  });
  const chat = activeChatsStore.getSnapshot()[id];
  expect(chat.messages).toMatchObject([
    { clientId: 'key-old', turnId: 'turn-old' },
    { clientId: 'key-new' },
  ]);
  expect(chat.messages?.[1]?.turnId).toBeUndefined();
  // That was not the pending send's turn: its window stays open.
  expect(chat.pendingClientTurnId).toBe('key-new');
  expect(chat.sendAwaitingTurnStart).toBe(true);
});
test("another device's keyed turn is added as its own row, not pinned on this client's pending bubble", () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  activeChatsStore.updateChat(id, {
    pendingClientTurnId: 'key-mine',
    messages: [{ role: 'user', content: 'mine', clientId: 'key-mine' }],
  });
  handleTurnStartedEvent({
    eventId: 'event-theirs',
    method: 'turn.started',
    provider: 'codex',
    threadId: id,
    turnId: 'turn-theirs',
    createdAt: '2026-10-13T00:00:00Z',
    prompt: 'theirs',
    clientTurnId: 'key-theirs',
  });
  expect(activeChatsStore.getSnapshot()[id].messages).toMatchObject([
    { clientId: 'key-mine' },
    { content: 'theirs', turnId: 'turn-theirs' },
  ]);
  expect(
    activeChatsStore.getSnapshot()[id].messages?.[0]?.turnId,
  ).toBeUndefined();
});
test('a handoff turn whose start carries the dialog key binds the handoff bubble and closes its send window', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  activeChatsStore.updateChat(
    id,
    beginConversationHandoffUiState(activeChatsStore.getSnapshot()[id], {
      message: 'continue on the other engine',
      clientTurnId: 'handoff:dialog-key',
      now: 1,
    }),
  );
  handleTurnStartedEvent({
    eventId: 'event-handoff',
    method: 'turn.started',
    provider: 'codex',
    threadId: id,
    turnId: 'turn-handoff',
    createdAt: '2026-10-13T00:00:00Z',
    prompt: 'continue on the other engine',
    // What Station stamps for a handoff: the key the dialog sent it with.
    clientTurnId: 'handoff:dialog-key',
  });
  const chat = activeChatsStore.getSnapshot()[id];
  expect(chat.messages).toMatchObject([
    { clientId: 'handoff:dialog-key', turnId: 'turn-handoff' },
  ]);
  expect(chat.messages).toHaveLength(1);
  expect(chat.pendingClientTurnId).toBeUndefined();
  expect(chat.sendAwaitingTurnStart).toBeUndefined();
});
