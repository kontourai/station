// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import type { MessageData } from '../conversation-types';

const { fetchMessages } = vi.hoisted(() => ({ fetchMessages: vi.fn() }));
vi.mock('@kontourai/station-sdk', () => ({
  fetchConversationMessages: fetchMessages,
  deleteConversation: vi.fn(),
}));

import { activeChatsStore } from '../active-chats-store';
import { backgroundTasksStore } from '../background-tasks-store';
import { conversationsStore } from '../conversations-store';

const messages: MessageData[] = [
  { role: 'assistant', content: 'legacy transcript' },
];
function open(key: string) {
  activeChatsStore.initChat(key, {
    agentSlug: 'assistant',
    conversationId: 'conv',
  });
}
afterEach(() => {
  for (const key of Object.keys(activeChatsStore.getSnapshot()))
    activeChatsStore.removeChat(key);
  fetchMessages.mockReset();
});

test('closing the last chat retires its transcript, status and background task bindings', async () => {
  open('first');
  open('second');
  fetchMessages.mockResolvedValue(messages);
  await conversationsStore.fetchMessages('', 'assistant', 'conv');
  conversationsStore.setStatus('assistant', 'conv', 'processing');
  backgroundTasksStore.ingest({
    method: 'session.started',
    provider: 'claude',
    threadId: 'delegate',
    createdAt: '2026-07-29T00:00:00.000Z',
    metadata: { taskId: 'delegate', parentTaskId: 'conv' },
  });
  activeChatsStore.removeChat('first');
  expect(
    conversationsStore.getSnapshot().messages['messages:assistant:conv'],
  ).toEqual(messages);
  expect(backgroundTasksStore.getSnapshot().delegateParents.delegate).toBe(
    'conv',
  );
  activeChatsStore.removeChat('second');
  expect(
    conversationsStore.getSnapshot().messages['messages:assistant:conv'],
  ).toBeUndefined();
  expect(
    conversationsStore.getSnapshot().statuses['assistant:conv'],
  ).toBeUndefined();
  expect(backgroundTasksStore.getSnapshot().entries.delegate).toBeUndefined();
  expect(
    backgroundTasksStore.getSnapshot().delegateParents.delegate,
  ).toBeUndefined();
});

test.each([false, true])(
  'a pending transcript read cannot repopulate a closed chat (guarded: %s)',
  async (guarded) => {
    open('first');
    let resolve!: (messages: MessageData[]) => void;
    fetchMessages.mockImplementationOnce(
      () =>
        new Promise<MessageData[]>((done) => {
          resolve = done;
        }),
    );
    const pending = conversationsStore.fetchMessages(
      '',
      'assistant',
      'conv',
      undefined,
      guarded ? () => true : undefined,
    );
    activeChatsStore.removeChat('first');
    open('reopened');
    fetchMessages.mockResolvedValue([
      { role: 'assistant', content: 'fresh transcript' },
    ]);
    const fresh = conversationsStore.fetchMessages('', 'assistant', 'conv');
    resolve(messages);
    expect(await fresh).toBe(true);
    expect(await pending).toBe(false);
    expect(
      conversationsStore.getSnapshot().messages['messages:assistant:conv'],
    ).toEqual([{ role: 'assistant', content: 'fresh transcript' }]);
  },
);

test('a superseded unguarded read releases its deduplication entry after a guarded read wins', async () => {
  open('first');
  let finish!: (messages: MessageData[]) => void;
  fetchMessages.mockImplementationOnce(
    () =>
      new Promise<MessageData[]>((resolve) => {
        finish = resolve;
      }),
  );
  const old = conversationsStore.fetchMessages('', 'assistant', 'conv');
  fetchMessages.mockResolvedValue(messages);
  expect(
    await conversationsStore.fetchMessages(
      '',
      'assistant',
      'conv',
      undefined,
      () => true,
    ),
  ).toBe(true);
  finish(messages);
  expect(await old).toBe(false);
  fetchMessages.mockResolvedValue([
    { role: 'assistant', content: 'next read' },
  ]);
  expect(await conversationsStore.fetchMessages('', 'assistant', 'conv')).toBe(
    true,
  );
  expect(fetchMessages).toHaveBeenCalledTimes(3);
  expect(
    conversationsStore.getSnapshot().messages['messages:assistant:conv'],
  ).toEqual([{ role: 'assistant', content: 'next read' }]);
});
