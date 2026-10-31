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
