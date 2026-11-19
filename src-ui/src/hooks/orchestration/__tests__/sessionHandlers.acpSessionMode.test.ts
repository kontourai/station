/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const threadId = 'thread-acp-mode';

describe('handleSessionLifecycleEvent — advertised ACP session mode', () => {
  let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
  let handleSessionLifecycleEvent: typeof import('../sessionHandlers').handleSessionLifecycleEvent;
  let handleSessionEngineModeObservedEvent: typeof import('../sessionHandlers').handleSessionEngineModeObservedEvent;

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
    ({ handleSessionEngineModeObservedEvent, handleSessionLifecycleEvent } =
      await import('../sessionHandlers'));
    activeChatsStore.initChat(threadId, {
      agentSlug: 'kiro',
      agentName: 'Kiro',
      title: 'Kiro Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.resetModules();
  });

  test('session.configured confirms the requested mode and keeps other pending options', () => {
    activeChatsStore.updateChat(threadId, {
      requestedProviderOptions: { mode: 'plan', effort: 'high' },
    });
    handleSessionLifecycleEvent({
      eventId: 'evt-mode',
      provider: 'acp',
      threadId,
      createdAt: '2026-09-11T00:00:00.000Z',
      method: 'session.configured',
      sessionId: threadId,
      metadata: {
        acpSessionMode: 'plan',
        acpSessionModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    });

    expect(activeChatsStore.getSnapshot()[threadId]?.currentModeId).toBe(
      'plan',
    );
    expect(
      activeChatsStore.getSnapshot()[threadId]?.requestedProviderOptions,
    ).toEqual({
      effort: 'high',
    });
  });

  test('a delayed model acknowledgement keeps the newer mode pending', () => {
    activeChatsStore.updateChat(threadId, {
      requestedModel: 'next-model',
      providerOptions: { effort: 'low' },
      requestedProviderOptions: { effort: 'high', mode: 'plan' },
      currentModeId: 'build',
    });
    handleSessionLifecycleEvent({
      eventId: 'evt-earlier-model',
      provider: 'acp',
      threadId,
      createdAt: '2026-09-11T00:00:00.000Z',
      method: 'session.configured',
      sessionId: threadId,
      metadata: {
        effectiveModel: 'next-model',
        effectiveModelOptions: { effort: 'high' },
        acpSessionMode: 'build',
      },
    });

    expect(activeChatsStore.getSnapshot()[threadId]).toMatchObject({
      currentModeId: 'build',
      requestedProviderOptions: { mode: 'plan' },
      providerOptions: { effort: 'high' },
    });
    handleSessionEngineModeObservedEvent({
      eventId: 'evt-next-mode',
      provider: 'acp',
      threadId,
      createdAt: '2026-09-11T00:00:01.000Z',
      method: 'session.engine-mode-observed',
      modeId: 'plan',
    });
    const chat = activeChatsStore.getSnapshot()[threadId];
    expect(chat?.currentModeId).toBe('plan');
    expect(chat?.requestedProviderOptions).toBeUndefined();
    expect(chat?.providerOptions).toEqual({ effort: 'high' });
  });

  test('session.started does not invent a current mode', () => {
    handleSessionLifecycleEvent({
      eventId: 'evt-start',
      provider: 'acp',
      threadId,
      createdAt: '2026-09-11T00:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      metadata: { acpSessionMode: 'plan' },
    });

    expect(
      activeChatsStore.getSnapshot()[threadId]?.currentModeId,
    ).toBeUndefined();
  });
});
