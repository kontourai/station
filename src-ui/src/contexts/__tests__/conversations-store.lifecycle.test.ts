// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { MessageData } from '../conversation-types';

const { fetchMessages } = vi.hoisted(() => ({ fetchMessages: vi.fn() }));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  fetchConversationMessages: fetchMessages,
  deleteConversation: vi.fn(),
}));

vi.mock('../ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    initChat: (...args: Parameters<typeof activeChatsStore.initChat>) =>
      activeChatsStore.initChat(...args),
    updateChat: (...args: Parameters<typeof activeChatsStore.updateChat>) =>
      activeChatsStore.updateChat(...args),
    removeChat: (id: string) => activeChatsStore.removeChat(id),
  }),
}));

import { rehydrateChatSession } from '../../hooks/orchestration/rehydrateChatSession';
import { useOpenConversation } from '../../hooks/useActiveChatSessionLifecycle';
import { activeChatsStore } from '../active-chats-store';
import { backgroundTasksStore } from '../background-tasks-store';
import { ConversationsProvider } from '../ConversationsContext';
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

test('overlapping successful reads release their deduplication entries', async () => {
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
  expect(await old).toBe(true);
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

test('a guarded open survives an overlapping successful rehydration of the same conversation', async () => {
  let finishOpen!: (messages: MessageData[]) => void;
  fetchMessages.mockImplementationOnce(
    () =>
      new Promise<MessageData[]>((resolve) => {
        finishOpen = resolve;
      }),
  );
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ConversationsProvider, null, children),
    );
  const { result, unmount } = renderHook(() => useOpenConversation(''), {
    wrapper,
  });
  let chatKey = '';
  const cleanup = vi.fn((id: string) => activeChatsStore.removeChat(id));
  try {
    const pending = result.current(
      'conv',
      'assistant',
      'Assistant',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      {
        initialized: (id) => {
          chatKey = id;
        },
        current: () => true,
        cleanup,
      },
    );
    expect(activeChatsStore.getSnapshot()[chatKey]).toBeDefined();
    fetchMessages.mockResolvedValue([
      { role: 'assistant', content: 'rehydrated transcript' },
    ]);
    await rehydrateChatSession(
      '',
      chatKey,
      activeChatsStore.getSnapshot()[chatKey],
    );
    finishOpen(messages);
    expect(await pending).toBe(chatKey);
    expect(cleanup).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[chatKey].messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'legacy transcript',
      }),
    ]);
  } finally {
    unmount();
    queryClient.clear();
  }
});

test('a guarded read whose hydration is no longer current still refuses publication', async () => {
  open('first');
  fetchMessages.mockResolvedValue(messages);
  expect(
    await conversationsStore.fetchMessages(
      '',
      'assistant',
      'conv',
      undefined,
      () => false,
    ),
  ).toBe(false);
  expect(
    conversationsStore.getSnapshot().messages['messages:assistant:conv'],
  ).toBeUndefined();
});
