// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  attachmentBlobForObjectUrl,
  attachmentObjectUrlKey,
  peekAttachmentObjectUrl,
  resetAttachmentObjectUrls,
} from '../components/chat/attachment-object-urls';
import { beginConversationHandoffUiState } from '../components/chat-dock/conversationHandoffUiState';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';
import { buildOutgoingUserMessage } from '../hooks/useActiveChatSessions.helpers';

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

const REF = `sha256-${'b'.repeat(64)}`;
const REF_B = `sha256-${'c'.repeat(64)}`;
// Two different pictures with the name a paste always gets: 8 and 9 bytes.
const PNG_A = 'data:image/png;base64,iVBORw0KGgo=';
const PNG_B = 'data:image/png;base64,AAAAAAAAAAAA';
type Recorded = {
  kind: 'image';
  name: string;
  mimeType: 'image/png';
  size: number;
  blobRef?: string;
  dataUrl?: string;
};
function recorded(
  name: string,
  size: number,
  bytes: { blobRef?: string; dataUrl?: string } = {},
): Recorded {
  return { kind: 'image', name, mimeType: 'image/png', size, ...bytes };
}
function startKeyed(
  clientTurnId: string | undefined,
  attachments: Recorded[],
  turnId = 'turn-attached',
) {
  handleTurnStartedEvent({
    eventId: `event-${turnId}`,
    method: 'turn.started',
    provider: 'codex',
    threadId: id,
    turnId,
    createdAt: '2026-09-12T00:00:00Z',
    prompt: 'See this',
    ...(clientTurnId ? { clientTurnId } : {}),
    attachments,
  });
}
function sendBubble(
  key: string,
  files: Array<{ name: string; data: string; size: number }>,
) {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  const { messages } = buildOutgoingUserMessage(
    [],
    'See this',
    files.map((file, index) => ({
      id: `file-${index}`,
      type: 'image/png',
      preview: file.data,
      ...file,
    })),
    key,
  );
  activeChatsStore.updateChat(id, { pendingClientTurnId: key, messages });
}
const bubble = () => activeChatsStore.getSnapshot()[id].messages?.[0];
const fileParts = () =>
  bubble()?.contentParts?.filter((part) => part.type === 'file');
const createObjectURL = vi.fn((_blob: Blob) => 'blob:seeded');
beforeEach(() => {
  createObjectURL.mockClear();
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
});
afterEach(() => resetAttachmentObjectUrls());

test('a send that went out as staged references gains the recorded attachments when its turn starts', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  // After a reload the composer holds only stage descriptors, so the send
  // path writes its bubble with no file parts at all.
  const { messages } = buildOutgoingUserMessage(
    [],
    'See this',
    undefined,
    'key-1',
  );
  activeChatsStore.updateChat(id, { pendingClientTurnId: 'key-1', messages });
  startKeyed('key-1', [recorded('screen.png', 8, { blobRef: REF })]);
  expect(bubble()).toMatchObject({
    clientId: 'key-1',
    turnId: 'turn-attached',
    contentParts: [
      { type: 'text', content: 'See this' },
      {
        type: 'file',
        blobRef: REF,
        mediaType: 'image/png',
        name: 'screen.png',
      },
    ],
  });
});

test('once its turn records a reference, the bubble lets go of its bytes and the cache holds them under that reference', () => {
  sendBubble('key-2', [{ name: 'screen.png', data: PNG_A, size: 8 }]);
  expect(JSON.stringify(bubble())).toContain('data:');
  startKeyed('key-2', [recorded('screen.png', 8, { blobRef: REF })]);
  expect(JSON.stringify(bubble())).not.toContain('data:');
  expect(fileParts()).toEqual([
    { type: 'file', blobRef: REF, mediaType: 'image/png', name: 'screen.png' },
  ]);
  const key = attachmentObjectUrlKey(REF, 'image/png');
  expect(peekAttachmentObjectUrl(key)).toBe('blob:seeded');
  expect(attachmentBlobForObjectUrl('blob:seeded')?.size).toBe(8);
});

test('two different pictures both named image.png, recorded in the other order, carry no bytes across', () => {
  sendBubble('key-3', [
    { name: 'image.png', data: PNG_A, size: 8 },
    { name: 'image.png', data: PNG_B, size: 9 },
  ]);
  startKeyed('key-3', [
    recorded('image.png', 9, { blobRef: REF_B }),
    recorded('image.png', 8, { blobRef: REF }),
  ]);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(
    peekAttachmentObjectUrl(attachmentObjectUrlKey(REF, 'image/png')),
  ).toBeUndefined();
  expect(
    peekAttachmentObjectUrl(attachmentObjectUrlKey(REF_B, 'image/png')),
  ).toBeUndefined();

  // Without references the swapped parts would otherwise keep each other's
  // inline bytes; they keep none.
  sendBubble('key-3b', [
    { name: 'image.png', data: PNG_A, size: 8 },
    { name: 'image.png', data: PNG_B, size: 9 },
  ]);
  startKeyed('key-3b', [recorded('image.png', 9), recorded('image.png', 8)]);
  expect(fileParts()).toEqual([
    { type: 'file', mediaType: 'image/png', name: 'image.png' },
    { type: 'file', mediaType: 'image/png', name: 'image.png' },
  ]);
});

test('a recorded attachment under another name keeps none of the sent bytes', () => {
  sendBubble('key-4', [{ name: 'screen.png', data: PNG_A, size: 8 }]);
  startKeyed('key-4', [recorded('other.png', 8)]);
  expect(fileParts()).toEqual([
    { type: 'file', mediaType: 'image/png', name: 'other.png' },
  ]);
});

test('with no reference, the bytes the event itself carries become the part', () => {
  sendBubble('key-5', [{ name: 'screen.png', data: PNG_A, size: 8 }]);
  startKeyed('key-5', [recorded('screen.png', 9, { dataUrl: PNG_B })]);
  expect(fileParts()).toEqual([
    { type: 'file', url: PNG_B, mediaType: 'image/png', name: 'screen.png' },
  ]);
});

test('a row with only plain content keeps its text when it adopts files', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  activeChatsStore.updateChat(id, {
    pendingClientTurnId: 'key-6',
    messages: [{ role: 'user', clientId: 'key-6', content: 'See this' }],
  });
  startKeyed('key-6', [recorded('screen.png', 8, { blobRef: REF })]);
  expect(bubble()?.contentParts).toEqual([
    { type: 'text', content: 'See this' },
    { type: 'file', blobRef: REF, mediaType: 'image/png', name: 'screen.png' },
  ]);
});

test('the recorded list is authoritative when it names fewer files than the bubble', () => {
  sendBubble('key-7', [
    { name: 'a.png', data: PNG_A, size: 8 },
    { name: 'b.png', data: PNG_B, size: 9 },
  ]);
  startKeyed('key-7', [recorded('a.png', 8, { blobRef: REF })]);
  expect(fileParts()).toEqual([
    { type: 'file', blobRef: REF, mediaType: 'image/png', name: 'a.png' },
  ]);
});

test('a repeated turn.started leaves the adopted bubble as it was', () => {
  sendBubble('key-8', [{ name: 'screen.png', data: PNG_A, size: 8 }]);
  const attachments = [recorded('screen.png', 8, { blobRef: REF })];
  startKeyed('key-8', attachments);
  const first = activeChatsStore.getSnapshot()[id].messages;
  startKeyed('key-8', attachments);
  expect(activeChatsStore.getSnapshot()[id].messages).toEqual(first);
  expect(activeChatsStore.getSnapshot()[id].messages).toHaveLength(1);
});

test('a turn keyed to another send leaves this bubble and its bytes alone', () => {
  sendBubble('key-9', [{ name: 'screen.png', data: PNG_A, size: 8 }]);
  const before = bubble();
  startKeyed('someone-else', [recorded('screen.png', 8, { blobRef: REF })]);
  expect(bubble()).toEqual(before);
  expect(createObjectURL).not.toHaveBeenCalled();
});

test('an unkeyed turn never rewrites a row an earlier turn already bound', () => {
  activeChatsStore.initChat(id, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Shared',
  });
  const bound = {
    role: 'user' as const,
    clientId: 'earlier',
    turnId: 'turn-earlier',
    content: 'Earlier',
    contentParts: [
      { type: 'text', content: 'Earlier' },
      { type: 'file', url: PNG_A, mediaType: 'image/png', name: 'screen.png' },
    ],
  };
  activeChatsStore.updateChat(id, {
    pendingClientTurnId: 'pending',
    messages: [bound],
  });
  startKeyed(
    undefined,
    [recorded('screen.png', 8, { blobRef: REF })],
    'turn-new',
  );
  expect(bubble()).toEqual(bound);
});
