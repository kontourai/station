/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const {
  createChatSession,
  lastDockMaximized,
  openConversationAction,
  removeChat,
  setActiveChat,
  setDockState,
  updateChat,
} = vi.hoisted(() => ({
  createChatSession: vi.fn(() => 'new-session'),
  openConversationAction: vi.fn(async () => 'reopened-session'),
  removeChat: vi.fn(),
  lastDockMaximized: { value: false },
  setActiveChat: vi.fn(),
  setDockState: vi.fn(),
  updateChat: vi.fn(),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    lastDockMaximized: lastDockMaximized.value,
    setDockState,
    setActiveChat,
  }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat, removeChat }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => createChatSession,
  useOpenConversation: () => openConversationAction,
}));
vi.mock('../utils/execution', () => ({
  // Carries a model, so a test can tell "seeded the agent default" from
  // "seeded nothing" — the mock previously returned no model at all, which
  // made the station#3165 defect undetectable here.
  resolveAgentExecution: () => ({
    providerOptions: {},
    model: 'opencode/deepseek-v4-flash-free',
    modelSource: 'agent default',
  }),
}));

import { useChatDockActions } from '../hooks/useChatDockActions';

describe('useChatDockActions placement-aware actions', () => {
  beforeEach(() => {
    lastDockMaximized.value = false;
    createChatSession.mockClear();
    openConversationAction.mockClear();
    removeChat.mockClear();
    setActiveChat.mockClear();
    setDockState.mockClear();
    updateChat.mockClear();
  });

  test('keeps the ambient full dock selected while recovery creates a fresh draft', () => {
    lastDockMaximized.value = true;
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [{ id: 'refused-session', agentSlug: 'agent-a' }],
        agents: [],
        activeSessionId: 'refused-session',
        setActiveSessionId,
      }),
    );

    act(() =>
      result.current.openChatForAgent(
        { slug: 'agent-a', name: 'Agent A' } as never,
        undefined,
        undefined,
        'move this message',
      ),
    );

    expect(setActiveSessionId).toHaveBeenCalledWith('new-session');
    expect(setActiveChat).toHaveBeenCalledWith('new-session');
    expect(setDockState).toHaveBeenCalledWith(true, true);
    expect(updateChat).toHaveBeenCalledWith('new-session', {
      input: 'move this message',
    });
  });

  test('focuses a full-screen selection without opening the ambient dock', () => {
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [
          { id: 'chat-a', conversationId: 'conversation-a', agentSlug: 'a' },
        ],
        agents: [],
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    act(() => result.current.focusSession('chat-a', false));

    expect(setActiveSessionId).toHaveBeenCalledWith('chat-a');
    expect(setActiveChat).toHaveBeenCalledWith('conversation-a');
    expect(updateChat).toHaveBeenCalledWith('chat-a', { hasUnread: false });
    expect(setDockState).not.toHaveBeenCalled();
  });

  /**
   * station#3782: focusing a chat that has not taken its first successful turn
   * yet must still leave `?chat=` pointing at something the dock can resolve.
   * This used to write `conversationId ?? null`, which cleared the URL pointer
   * for a chat that is live in the tab strip in front of the user.
   */
  test('stamps the session id when the focused chat has no conversation yet', () => {
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [{ id: 'claude:1787505679249', agentSlug: 'claude' }],
        agents: [],
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    act(() => result.current.focusSession('claude:1787505679249', false));

    expect(setActiveChat).toHaveBeenCalledWith('claude:1787505679249');
    expect(setActiveChat).not.toHaveBeenCalledWith(null);
  });

  test('creates a full-screen fast-path chat in its Project without opening the ambient dock', () => {
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [],
        agents: [],
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    act(() =>
      result.current.openChatForAgent(
        { slug: 'agent-a', name: 'Agent A' } as never,
        'project-a',
        'Project A',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      ),
    );

    expect(createChatSession).toHaveBeenCalledWith(
      'agent-a',
      'Agent A',
      undefined,
      'project-a',
      'Project A',
      {
        model: 'opencode/deepseek-v4-flash-free',
        modelSource: 'agent default',
        providerOptions: {},
      },
    );
    expect(setActiveSessionId).toHaveBeenCalledWith('new-session');
    expect(setDockState).not.toHaveBeenCalled();
  });

  test('seeds an attachment-only recovered draft without opening the ambient dock', () => {
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [],
        agents: [],
        activeSessionId: null,
        setActiveSessionId: vi.fn(),
      }),
    );
    const attachment = {
      id: 'attachment-1',
      name: 'context.txt',
      type: 'text/plain',
      size: 7,
      data: 'data:text/plain;base64,Y29udGV4dA==',
    };

    act(() =>
      result.current.openChatForAgent(
        { slug: 'agent-a', name: 'Agent A' } as never,
        'project-a',
        'Project A',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        [attachment],
      ),
    );

    expect(updateChat).toHaveBeenCalledWith('new-session', {
      attachments: [attachment],
    });
  });

  test('reopening a conversation seeds no model, rather than the agent default', async () => {
    // THE caller assertion. The extracted decision has its own tests, but
    // nothing proved this hook uses it — reverting the call site to
    // `: agentExecution` kept every one of those green (station#3165 review).
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [],
        agents: [{ slug: 'agent-a', name: 'Agent A' }] as never,
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    await act(async () => {
      await result.current.openConversation(
        'conversation-a',
        'agent-a' as never,
        {},
      );
    });

    const call = openConversationAction.mock.calls[0] as unknown[] | undefined;
    const execution = call?.[5] as
      | { model?: string; modelSource?: string }
      | undefined;
    // The agent default must NOT be seeded: a send before the orchestration
    // snapshot lands would dispatch it as an override the user never chose.
    expect(execution?.model).toBeUndefined();
    expect(execution?.modelSource).toBe('unknown');
  });

  test('reopening restores the server-projected accepted conversation model', async () => {
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [],
        agents: [{ slug: 'agent-a', name: 'Agent A' }] as never,
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    await act(async () => {
      await result.current.openConversation(
        'conversation-a',
        'agent-a' as never,
        {
          model: 'engine-reported-default',
          acceptedModel: 'claude-sonnet',
        },
      );
    });

    const call = openConversationAction.mock.calls[0] as unknown[] | undefined;
    expect(call?.[5]).toMatchObject({
      model: 'claude-sonnet',
      modelSource: 'session override',
    });
  });

  test('opening a fork preserves the selected provider and model for its first divergent turn', async () => {
    const setActiveSessionId = vi.fn();
    const beforeFocus = vi.fn(() => true);
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [],
        agents: [{ slug: 'agent-a', name: 'Agent A' }] as never,
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    await act(async () => {
      await result.current.openConversation('fork-child', 'agent-a' as never, {
        model: 'source-model',
        modelSource: 'runtime',
        defaultModel: 'source-default',
        defaultModelSource: 'agent default',
        providerId: 'source-provider',
        providerType: 'claude',
        providerOptions: { effort: 'high' },
        hydrateMessages: true,
        beforeFocus,
      });
    });

    const call = openConversationAction.mock.calls[0] as unknown[] | undefined;
    const execution = call?.[5];
    expect(execution).toMatchObject({
      model: 'source-model',
      modelSource: 'runtime',
      defaultModel: 'source-default',
      defaultModelSource: 'agent default',
      providerId: 'source-provider',
      provider: 'claude',
      providerOptions: { effort: 'high' },
    });
    expect(setActiveChat).toHaveBeenCalledWith('fork-child');
    expect(beforeFocus).toHaveBeenCalledTimes(1);
    expect(setActiveSessionId).toHaveBeenCalledTimes(1);
    expect(call?.[7]).toBe(true);
  });

  test('opening an idempotently returned fork focuses the existing child without duplicating a session', async () => {
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [
          {
            id: 'fork-child-session',
            conversationId: 'fork-child',
            agentSlug: 'agent-a',
          },
        ],
        agents: [{ slug: 'agent-a', name: 'Agent A' }] as never,
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    await act(async () => {
      await result.current.openConversation('fork-child', 'agent-a' as never);
    });

    expect(openConversationAction).not.toHaveBeenCalled();
    expect(setActiveSessionId).toHaveBeenCalledWith('fork-child-session');
    expect(setActiveChat).toHaveBeenCalledWith('fork-child');
  });

  test('cancel during replay hydration tears down the child without focusing it', async () => {
    let finishHydration: (value: string) => void = () => {};
    openConversationAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHydration = resolve;
        }),
    );
    const controller = new AbortController();
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [],
        agents: [{ slug: 'agent-a', name: 'Agent A' }] as never,
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    let opened: boolean | undefined;
    await act(async () => {
      const pending = result.current.openConversation(
        'fork-child',
        'agent-a' as never,
        { hydrateMessages: true, signal: controller.signal },
      );
      controller.abort();
      finishHydration('hydrated-child');
      opened = await pending;
    });

    expect(opened).toBe(false);
    expect(removeChat).toHaveBeenCalledWith('hydrated-child');
    expect(setActiveSessionId).not.toHaveBeenCalled();
    expect(setActiveChat).not.toHaveBeenCalledWith('fork-child');
  });

  test('cancel before an idempotent existing-child reentry performs no focus', async () => {
    const controller = new AbortController();
    controller.abort();
    const setActiveSessionId = vi.fn();
    const { result } = renderHook(() =>
      useChatDockActions({
        sessions: [
          {
            id: 'existing-child-session',
            conversationId: 'existing-child',
            agentSlug: 'agent-a',
          },
        ],
        agents: [{ slug: 'agent-a', name: 'Agent A' }] as never,
        activeSessionId: null,
        setActiveSessionId,
      }),
    );

    let opened: boolean | undefined;
    await act(async () => {
      opened = await result.current.openConversation(
        'existing-child',
        'agent-a' as never,
        { signal: controller.signal },
      );
    });

    expect(opened).toBe(false);
    expect(openConversationAction).not.toHaveBeenCalled();
    expect(setActiveSessionId).not.toHaveBeenCalled();
    expect(setActiveChat).not.toHaveBeenCalledWith('existing-child');
  });
});
