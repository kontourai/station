// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../../contexts/background-tasks-store';
import { handleOrchestrationEvent } from '../../../hooks/orchestration/eventHandlers';
import { useSessionInventoryLive } from '../useSessionInventoryLive';

const chat = 'inventory-live-parent';
beforeEach(() => {
  backgroundTasksStore.reset();
  activeChatsStore.initChat(chat, {
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Parent',
  });
});
afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(chat);
  backgroundTasksStore.reset();
});

test('the live inventory reads the captured Station partition', () => {
  const stationA = 'http://inventory-a.test';
  const stationB = 'http://inventory-b.test';
  const scopeA = {
    apiBase: stationA,
    authorityKey: 'a',
    isCurrent: () => true,
  };
  const scopeB = {
    apiBase: stationB,
    authorityKey: 'b',
    isCurrent: () => true,
  };
  const { result, rerender } = renderHook(
    ({ scope }) => useSessionInventoryLive(scope, chat, chat),
    { initialProps: { scope: scopeA } },
  );
  act(() => {
    for (const [origin, id] of [
      [stationA, 'a-tool'],
      [stationB, 'b-tool'],
    ] as const)
      handleOrchestrationEvent(origin, {
        provider: 'claude',
        threadId: chat,
        createdAt: new Date(Date.now() + 1000).toISOString(),
        method: 'tool.started',
        itemId: id,
        toolCallId: id,
        toolName: 'bash',
      });
  });
  expect(result.current.running.map((entry) => entry.id)).toEqual(['a-tool']);
  rerender({ scope: scopeB });
  expect(result.current.running.map((entry) => entry.id)).toEqual(['b-tool']);
});

test('switching Station authority replaces a colliding inventory row and its kind', () => {
  const scopeA = {
    apiBase: 'http://inventory-a.test',
    authorityKey: 'a',
    isCurrent: () => true,
  };
  const scopeB = {
    apiBase: 'http://inventory-b.test',
    authorityKey: 'b',
    isCurrent: () => true,
  };
  const { result, rerender } = renderHook(
    ({ scope }) => useSessionInventoryLive(scope, chat, chat),
    { initialProps: { scope: scopeA } },
  );
  act(() => {
    handleOrchestrationEvent(scopeA.apiBase, {
      provider: 'claude',
      threadId: chat,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      method: 'tool.started',
      itemId: 'shared',
      toolCallId: 'shared',
      toolName: 'bash',
    });
    handleOrchestrationEvent(scopeB.apiBase, {
      provider: 'claude',
      threadId: 'shared',
      sessionId: 'shared',
      createdAt: new Date(Date.now() + 1000).toISOString(),
      method: 'session.started',
      metadata: { taskId: 'shared', parentTaskId: chat },
    });
  });
  expect(result.current.running[0]?.kind).toBe('tool');
  rerender({ scope: scopeB });
  expect(result.current.running).toHaveLength(1);
  expect(result.current.running[0]).toMatchObject({
    id: 'shared',
    kind: 'agent',
    source: 'delegate-session',
  });
});
