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

function startTool(
  chatThreadId: string,
  toolCallId: string,
  createdAt = eventBase.createdAt,
) {
  backgroundTasksStore.ingest({
    ...eventBase,
    createdAt,
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

test('snapshot clearing only the omitted-history flag refreshes the mounted view', () => {
  for (let index = 0; index < 101; index++)
    startTool('chat-a', `tool-${index}`);
  const { result } = renderHook(() => useChatBackgroundTasks('chat-a'));
  expect(result.current.toolHistoryLimited).toBe(true);
  // Finish the retained rows; the omitted row still has no terminal evidence.
  act(() => {
    for (const entry of result.current.running) {
      backgroundTasksStore.ingest({
        ...eventBase,
        threadId: 'chat-a',
        method: 'tool.completed',
        itemId: entry.id,
        toolCallId: entry.id,
        toolName: 'bash',
        status: 'success',
      });
    }
  });
  const before = result.current;
  expect(before.toolHistoryLimited).toBe(true);
  act(() => backgroundTasksStore.reconcileSnapshot({ sessions: [] }));
  expect(result.current).not.toBe(before);
  expect(result.current.toolHistoryLimited).toBeUndefined();
  expect(result.current.finished).toEqual(before.finished);
});

test('repeated real chat closures bound retained live and uncertain history without changing an open chat', () => {
  startTool('chat-a', 'open-tool');
  const { result } = renderHook(() => useChatBackgroundTasks('chat-a'));
  const selected = result.current;
  act(() => {
    for (let i = 0; i < 240; i++) {
      const parent = `closed-${i}`;
      const child = `child-${i}`;
      activeChatsStore.initChat(parent, {
        agentSlug: 'agent',
        agentName: 'Agent',
        title: parent,
      });
      const createdAt = new Date(
        Date.parse(eventBase.createdAt) + i * 1000,
      ).toISOString();
      startTool(parent, `tool-${i}`, createdAt);
      if (i < 60)
        for (let j = 0; j < 100; j++)
          startTool(parent, `overflow-${i}-${j}`, createdAt);
      backgroundTasksStore.ingest({
        ...eventBase,
        threadId: child,
        method: 'session.started',
        createdAt,
        sessionId: child,
        metadata: { taskId: child, parentTaskId: parent },
      });
      activeChatsStore.removeChat(parent);
    }
    expect(result.current).toBe(selected);
    expect(
      Object.keys(backgroundTasksStore.getSnapshot().limitedToolChats ?? {}),
    ).toHaveLength(50);
    // Missing sessions are uncertainty, never a fabricated stop or success.
    backgroundTasksStore.reconcileSnapshot({ sessions: [] });
  });
  const state = backgroundTasksStore.getSnapshot();
  const closed = Object.values(state.entries).filter((entry) =>
    entry.chatThreadId.startsWith('closed-'),
  );
  expect(closed.length).toBeGreaterThan(0);
  expect(closed.length).toBeLessThanOrEqual(150);
  expect(
    Object.values(state.delegateParents).filter((parent) =>
      parent.startsWith('closed-'),
    ).length,
  ).toBeLessThanOrEqual(200);
  expect(closed.every((entry) => entry.state === 'unresolved')).toBe(true);
  expect(Object.keys(state.limitedToolChats ?? {}).length).toBeLessThanOrEqual(
    50,
  );
  // The open chat was demoted by the same real snapshot, rather than retired.
  expect(result.current.finished).toMatchObject([
    { id: 'open-tool', state: 'unresolved' },
  ]);
  expect(selected.running).toMatchObject([
    { id: 'open-tool', state: 'running' },
  ]);
  expect(state.entries['open-tool']).toBeDefined();
  expect(Object.keys(activeChatsStore.getSnapshot())).not.toContain(
    'closed-239',
  );
  expect(state.entries['child-239']).toBeDefined();
  expect(state.entries['child-0']).toBeUndefined();
  expect(state.delegateParents['child-0']).toBeUndefined();
  act(() => {
    activeChatsStore.initChat('closed-0', {
      agentSlug: 'agent',
      agentName: 'Agent',
      title: 'Reopened',
    });
    backgroundTasksStore.reconcileSnapshot({
      sessions: [
        {
          provider: 'claude',
          threadId: 'child-0',
          status: 'running',
          hasActiveTurn: true,
          delegation: { taskId: 'child-0', parentTaskId: 'closed-0' },
        },
      ],
    });
  });
  const reopened = renderHook(() => useChatBackgroundTasks('closed-0'));
  expect(reopened.result.current.running).toMatchObject([
    { id: 'child-0', state: 'running' },
  ]);
  act(() =>
    backgroundTasksStore.ingest({
      ...eventBase,
      threadId: 'child-0',
      method: 'turn.completed',
      turnId: 'recovered-turn',
    }),
  );
  expect(reopened.result.current.running).toEqual([]);
  expect(reopened.result.current.finished).toMatchObject([
    { id: 'child-0', state: 'completed' },
  ]);
  reopened.unmount();
  activeChatsStore.removeChat('closed-0');
});
