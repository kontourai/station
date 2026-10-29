/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
import { useChatBackgroundTasks } from '../useBackgroundTasks';

const eventBase = {
  provider: 'codex' as const,
  createdAt: '2026-10-20T00:00:00.000Z',
};

function startTool(chatThreadId: string, toolCallId: string) {
  backgroundTasksStore.ingest({
    ...eventBase,
    threadId: chatThreadId,
    method: 'tool.started',
    itemId: toolCallId,
    toolCallId,
    toolName: 'bash',
  });
}

beforeEach(() => {
  backgroundTasksStore.reset();
  for (const chat of ['chat-a', 'chat-b']) {
    activeChatsStore.initChat(chat, {
      agentSlug: 'agent',
      agentName: 'Agent',
      title: chat,
    });
  }
});

afterEach(() => {
  cleanup();
  backgroundTasksStore.reset();
  activeChatsStore.removeChat('chat-a');
  activeChatsStore.removeChat('chat-b');
});

test('switching the mounted hook selects the new chat when both provider registries are undefined', () => {
  startTool('chat-a', 'tool-a');
  startTool('chat-b', 'tool-b');
  expect(
    activeChatsStore.getSnapshot()['chat-a'].backgroundTasks,
  ).toBeUndefined();
  expect(
    activeChatsStore.getSnapshot()['chat-b'].backgroundTasks,
  ).toBeUndefined();
  const { result, rerender } = renderHook(
    (chat: string | null) => useChatBackgroundTasks(chat),
    { initialProps: 'chat-a' as string | null },
  );
  expect(result.current.running.map((entry) => entry.id)).toEqual(['tool-a']);

  rerender('chat-b');
  expect(result.current.running.map((entry) => entry.id)).toEqual(['tool-b']);
  rerender(null);
  expect(result.current).toEqual({ running: [], finished: [] });
  rerender('chat-a');
  expect(result.current.running.map((entry) => entry.id)).toEqual(['tool-a']);
});

test('unrelated chat events preserve the selected view and avoid subscriber renders, while selected updates arrive', () => {
  startTool('chat-a', 'tool-a');
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useChatBackgroundTasks('chat-a');
  });
  const selected = result.current;
  const selectedRenders = renders;

  act(() => startTool('chat-b', 'tool-b'));
  expect(result.current).toBe(selected);
  expect(renders).toBe(selectedRenders);
  act(() =>
    activeChatsStore.updateChat('chat-b', {
      backgroundTasks: [{ taskId: 'provider-b' }],
    }),
  );
  expect(result.current).toBe(selected);
  expect(renders).toBe(selectedRenders);

  act(() =>
    backgroundTasksStore.ingest({
      ...eventBase,
      threadId: 'chat-a',
      method: 'tool.progress',
      itemId: 'tool-a',
      toolCallId: 'tool-a',
      message: 'Building',
    }),
  );
  expect(result.current).not.toBe(selected);
  expect(result.current.running[0].detail).toBe('Building');
});

test('provider cards retain their view on unrelated events and refresh the spawning tool and provider updates', () => {
  activeChatsStore.updateChat('chat-a', {
    backgroundTasks: [
      { taskId: 'provider-a', toolCallId: 'tool-a', description: 'Inspect' },
    ],
  });
  const { result } = renderHook(() => useChatBackgroundTasks('chat-a'));
  const selected = result.current;
  expect(selected.running).toMatchObject([
    { id: 'provider-a', title: 'Inspect' },
  ]);
  expect(selected.running[0].startedAt).toBeUndefined();

  act(() => startTool('chat-b', 'tool-b'));
  expect(result.current).toBe(selected);
  act(() => startTool('chat-a', 'tool-a'));
  expect(result.current.running).toMatchObject([
    { id: 'provider-a', startedAt: Date.parse(eventBase.createdAt) },
  ]);
  expect(result.current.running).toHaveLength(1);
  act(() =>
    activeChatsStore.updateChat('chat-a', {
      backgroundTasks: [
        { taskId: 'provider-a', toolCallId: 'tool-a', description: 'Review' },
      ],
    }),
  );
  expect(result.current.running[0].title).toBe('Review');
});

test('switching away preserves delegate bindings and observes completion on return', () => {
  backgroundTasksStore.ingest({
    ...eventBase,
    threadId: 'delegate-a',
    method: 'session.started',
    sessionId: 'delegate-a',
    metadata: { taskId: 'delegate-a', parentTaskId: 'chat-a' },
  });
  const { result, rerender } = renderHook(
    (chat: string) => useChatBackgroundTasks(chat),
    { initialProps: 'chat-a' },
  );
  expect(result.current.running).toMatchObject([
    { id: 'delegate-a', state: 'running' },
  ]);
  rerender('chat-b');
  expect(result.current).toEqual({ running: [], finished: [] });
  rerender('chat-a');
  expect(result.current.running).toMatchObject([
    { id: 'delegate-a', state: 'running' },
  ]);
  rerender('chat-b');
  act(() =>
    backgroundTasksStore.ingest({
      ...eventBase,
      threadId: 'delegate-a',
      method: 'turn.completed',
      turnId: 'delegate-turn',
    }),
  );
  rerender('chat-a');
  expect(result.current.running).toEqual([]);
  expect(result.current.finished).toMatchObject([
    { id: 'delegate-a', state: 'completed' },
  ]);
  expect(backgroundTasksStore.getSnapshot().delegateParents['delegate-a']).toBe(
    'chat-a',
  );
});
