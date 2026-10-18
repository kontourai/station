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
    agentName: 'Assistant',
    title: 'Conversation',
    conversationId: 'conv',
  });
}
afterEach(() => {
  for (const key of Object.keys(activeChatsStore.getSnapshot()))
    activeChatsStore.removeChat(key);
  backgroundTasksStore.reset();
  activeChatsStore.clearConversationActivity();
  fetchMessages.mockReset();
});

test('closing the last chat retires its transcript and status while preserving live delegate state', async () => {
  open('first');
  open('second');
  fetchMessages.mockResolvedValue(messages);
  await conversationsStore.fetchMessages('', 'assistant', 'conv');
  conversationsStore.setStatus('assistant', 'conv', 'processing');
  backgroundTasksStore.ingest({
    method: 'session.started',
    sessionId: 'delegate',
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
  expect(backgroundTasksStore.getSnapshot().entries.delegate).toMatchObject({
    state: 'running',
    chatThreadId: 'conv',
  });
  expect(backgroundTasksStore.getSnapshot().delegateParents.delegate).toBe(
    'conv',
  );
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
        content: 'rehydrated transcript',
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

test('a guarded open keeps the newer post-turn refresh when reads complete out of order', async () => {
  open('first');
  let finishOpen!: (messages: MessageData[]) => void;
  fetchMessages.mockImplementationOnce(
    () =>
      new Promise<MessageData[]>((resolve) => {
        finishOpen = resolve;
      }),
  );
  const pending = conversationsStore.fetchMessages(
    '',
    'assistant',
    'conv',
    undefined,
    () => true,
  );
  const refreshed: MessageData[] = [
    { role: 'assistant', content: 'first turn' },
    { role: 'assistant', content: 'latest turn' },
  ];
  fetchMessages.mockResolvedValue(refreshed);
  expect(
    await conversationsStore.refreshMessages('', 'assistant', 'conv'),
  ).toBe(true);
  finishOpen(refreshed.slice(0, 1));
  expect(await pending).toBe(true);
  expect(
    conversationsStore.getSnapshot().messages['messages:assistant:conv'],
  ).toEqual(refreshed);
});

test('two guarded opens of the same conversation both succeed', async () => {
  open('first');
  let finishFirst!: (messages: MessageData[]) => void;
  fetchMessages
    .mockImplementationOnce(
      () =>
        new Promise<MessageData[]>((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockResolvedValue(messages);
  const first = conversationsStore.fetchMessages(
    '',
    'assistant',
    'conv',
    undefined,
    () => true,
  );
  const second = conversationsStore.fetchMessages(
    '',
    'assistant',
    'conv',
    undefined,
    () => true,
  );
  expect(await second).toBe(true);
  finishFirst(messages);
  expect(await first).toBe(true);
});

test('the SDK open hook reuses known turn activity while refetching a closed conversation transcript', async () => {
  open('first');
  activeChatsStore.applyConversationActivity({
    conversationId: 'conv',
    asOfSequence: 10,
    currentThreadId: 'conv',
    openTurn: {
      turnId: 'running-turn',
      threadId: 'conv',
      startedAt: '2026-07-29T00:00:00.000Z',
    },
  });
  activeChatsStore.removeChat('first');
  const refreshed: MessageData[] = [
    { role: 'assistant', content: 'refetched transcript' },
  ];
  fetchMessages.mockResolvedValue(refreshed);
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
  try {
    const id = await result.current('conv', 'assistant', 'Assistant');
    expect(id).not.toBeNull();
    const chat = activeChatsStore.getSnapshot()[id!];
    expect(fetchMessages).toHaveBeenCalledOnce();
    expect(chat.messages).toEqual([
      expect.objectContaining({ content: 'refetched transcript' }),
    ]);
    expect(chat.conversationActivity?.openTurn?.turnId).toBe('running-turn');
    expect(chat.conversationActivity?.asOfSequence).toBe(10);
  } finally {
    unmount();
    queryClient.clear();
  }
});
