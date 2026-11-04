/**
 * @vitest-environment jsdom
 *
 * #4162: a successor Session can start on a different engine connection than
 * its predecessor (the Agent was repointed). The chat must take the
 * successor's connection from that Session's own `session.started`, and record
 * which Session it was observed for, instead of keeping the connection it
 * learned when the conversation was opened.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const chatKey = 'conversation-engine';

describe('handleSessionLifecycleEvent — started Session connection', () => {
  let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
  let handleSessionLifecycleEvent: typeof import('../sessionHandlers').handleSessionLifecycleEvent;

  beforeEach(async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
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
    ({ handleSessionLifecycleEvent } = await import('../sessionHandlers'));
    activeChatsStore.initChat(chatKey, {
      agentSlug: 'station',
      agentName: 'Station',
      title: 'Continue',
    });
    // The conversation was opened on its Codex Session, then the Agent was
    // repointed and the next send started a successor.
    activeChatsStore.updateChat(chatKey, {
      conversationId: chatKey,
      currentSessionId: 'session-2',
      orchestrationProvider: 'codex',
      agentConnectionId: 'codex',
      agentConnectionObservedFor: 'session-1',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  const started = (provider: string, metadata: Record<string, unknown>) =>
    handleSessionLifecycleEvent({
      eventId: 'evt-started',
      provider,
      threadId: 'session-2',
      createdAt: '2026-10-25T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'session-2',
      metadata,
    } as Parameters<typeof handleSessionLifecycleEvent>[0]);

  test("a successor's session.started records its own connection", () => {
    started('acp', { connectionId: 'opencode', agentSlug: 'station' });
    const chat = activeChatsStore.getSnapshot()[chatKey];
    expect(chat?.orchestrationProvider).toBe('acp');
    expect(chat?.agentConnectionId).toBe('opencode');
    expect(chat?.agentConnectionObservedFor).toBe('session-2');
  });

  test("a successor on Station's own engine runs on no connection", () => {
    started('station-agent', { agentSlug: 'station' });
    const chat = activeChatsStore.getSnapshot()[chatKey];
    expect(chat?.agentConnectionId).toBeUndefined();
    expect(chat?.agentConnectionObservedFor).toBe('session-2');
  });

  test('session.configured leaves the observation alone', () => {
    handleSessionLifecycleEvent({
      eventId: 'evt-configured',
      provider: 'acp',
      threadId: 'session-2',
      createdAt: '2026-10-25T00:00:00.000Z',
      method: 'session.configured',
      sessionId: 'session-2',
      metadata: { connectionId: 'opencode' },
    } as Parameters<typeof handleSessionLifecycleEvent>[0]);
    const chat = activeChatsStore.getSnapshot()[chatKey];
    expect(chat?.agentConnectionId).toBe('codex');
    expect(chat?.agentConnectionObservedFor).toBe('session-1');
  });
});
