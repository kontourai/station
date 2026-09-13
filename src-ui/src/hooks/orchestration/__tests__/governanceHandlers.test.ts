// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handleOrchestrationEvent: typeof import('../eventHandlers').handleOrchestrationEvent;

const threadId = 'thread-gov-1';

describe('canonical governance fold', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    vi.resetModules();
    vi.doMock('../../../contexts/active-chats-store', async () => {
      const actual = await vi.importActual<
        typeof import('../../../contexts/active-chats-store')
      >('../../../contexts/active-chats-store');
      const store = new actual.ActiveChatsStore({
        storage: { getItem: () => null, setItem: () => {} },
      });
      return { ...actual, activeChatsStore: store };
    });
    ({ activeChatsStore } = await import(
      '../../../contexts/active-chats-store'
    ));
    ({ handleOrchestrationEvent } = await import('../eventHandlers'));
    activeChatsStore.initChat(threadId, {
      agentSlug: 'dev-agent',
      agentName: 'Dev',
      title: 'Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('policy.stop-verdict block becomes a system row; pass does not', () => {
    handleOrchestrationEvent('http://api', {
      eventId: 'p1',
      provider: 'claude',
      threadId,
      createdAt: '2026-09-11T00:00:00.000Z',
      method: 'policy.hooks-attached',
      cwd: '/workspace',
      profile: 'strict',
      engine: 'native',
    });
    expect(activeChatsStore.getSnapshot()[threadId].messages ?? []).toEqual([]);

    handleOrchestrationEvent('http://api', {
      eventId: 'p2',
      provider: 'claude',
      threadId,
      createdAt: '2026-09-11T00:00:01.000Z',
      method: 'policy.stop-verdict',
      policy: 'stop-goal-fit',
      verdict: 'block',
      warnings: ['missing receipt'],
      strict: true,
    });
    expect(
      activeChatsStore.getSnapshot()[threadId].messages?.at(-1)?.content,
    ).toContain('Policy blocked completion.');
  });

  test('platform.mutation allowed is silent; blocked is visible', () => {
    const base = {
      provider: 'station-agent' as const,
      threadId,
      createdAt: '2026-09-11T00:00:00.000Z',
      method: 'platform.mutation' as const,
      tool: 'create_agent',
      argsSummary: '{}',
      decision: 'allow' as const,
      profile: 'standard' as const,
      cwd: '/workspace',
    };
    handleOrchestrationEvent('http://api', {
      ...base,
      eventId: 'm1',
      outcome: 'allowed',
    });
    expect(activeChatsStore.getSnapshot()[threadId].messages ?? []).toEqual([]);
    handleOrchestrationEvent('http://api', {
      ...base,
      eventId: 'm2',
      outcome: 'blocked',
      decision: 'block',
      reason: 'policy',
    });
    expect(
      activeChatsStore.getSnapshot()[threadId].messages?.at(-1)?.content,
    ).toContain('Blocked platform change: create_agent');
  });
});
