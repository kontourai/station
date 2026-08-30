/**
 * @vitest-environment jsdom
 *
 * archive#1294: `useChatInput`'s send-failure
 * `onError` callback used to suppress its generic toast whenever the
 * session merely EXISTED in the store — but store existence isn't
 * visibility. A send failing while the owning dock/tab is collapsed or in
 * a background tab left the failure with NO surface at all: the transcript
 * notice renders nowhere on screen, and the toast — the only other signal —
 * was suppressed too. These pin both branches of the fixed
 * `noticeHasVisibleSurface` check (session exists AND is visible).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgent: () => null,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

const showToastMock = vi.fn();
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const { interruptOrchestrationTurnMock } = vi.hoisted(() => ({
  interruptOrchestrationTurnMock: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    useSkillsQuery: () => ({ data: [] }),
    useProviderCommandsQuery: () => ({ data: [] }),
    useRunSkill: () => ({ mutateAsync: vi.fn() }),
    useSkillDetailReader: () => vi.fn(),
    interruptOrchestrationTurn: (...args: unknown[]) =>
      interruptOrchestrationTurnMock(...args),
  };
});

// archive#1294: forwards into the REAL activeChatsStore singleton (imported
// below) so the hook's own direct `activeChatsStore.getSnapshot[sessionId]`
// read (the hasSessionContext check under test) and these context-hook
// forwards stay consistent — mirrors the established pattern in
// useActiveChatSessionMessaging.test.ts.
vi.mock('../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  const { chatDraftsStore } = await import('../contexts/chat-drafts-store');
  const actions = {
    updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
    clearInput: activeChatsStore.clearInput.bind(activeChatsStore),
    addEphemeralMessage:
      activeChatsStore.addEphemeralMessage.bind(activeChatsStore),
    addToInputHistory:
      activeChatsStore.addToInputHistory.bind(activeChatsStore),
    navigateHistoryUp:
      activeChatsStore.navigateHistoryUp.bind(activeChatsStore),
    navigateHistoryDown:
      activeChatsStore.navigateHistoryDown.bind(activeChatsStore),
    setDraft: chatDraftsStore.set.bind(chatDraftsStore),
    getDraft: chatDraftsStore.get.bind(chatDraftsStore),
    clearDraft: chatDraftsStore.clear.bind(chatDraftsStore),
  };
  return {
    useActiveChatActions: () => actions,
    useActiveChatSelector: (sessionId: string, selector: (s: any) => any) =>
      selector(activeChatsStore.getSnapshot()[sessionId] || null),
  };
});

let capturedOnError: ((error: Error) => void) | undefined;
const { sendMessageMock, cancelMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn().mockResolvedValue(true),
  cancelMessageMock: vi.fn(),
}));
// `useCancelMessage` is the REAL hook (its argument is the activeChatsStore
// KEY — the tab id — from which it resolves the receipted child session
// itself; see useActiveChatSessionMessaging.ts). The wrapper records the
// caller's argument so tests can pin what `useChatInput` passes, which is
// exactly the contract the #887 review defect violated.
vi.mock('../hooks/useActiveChatSessions', async () => {
  const messaging = await import('../hooks/useActiveChatSessionMessaging');
  return {
    useSendMessage: (
      _apiBase: string,
      _onMigrate: unknown,
      onError: (error: Error) => void,
    ) => {
      capturedOnError = onError;
      return sendMessageMock;
    },
    useCancelMessage: (apiBase?: string) => {
      const real = messaging.useCancelMessage(apiBase);
      return (id: string) => {
        cancelMessageMock(id);
        return real(id);
      };
    },
  };
});

import { activeChatsStore } from '../contexts/active-chats-store';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import { useChatInput } from '../hooks/useChatInput';

const SESSION_ID = 'chat-input-visibility-session';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useChatInput send-failure toast visibility (station#1294 review SHOULD-FIX-4)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    showToastMock.mockClear();
    sendMessageMock.mockClear();
    cancelMessageMock.mockClear();
    interruptOrchestrationTurnMock.mockReset();
    capturedOnError = undefined;
    activeChatsStore.removeChat(SESSION_ID);
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: 'dev-agent',
      agentName: 'Dev Agent',
      title: 'Dev chat',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    activeChatsStore.removeChat(SESSION_ID);
  });

  test('does not send Stop to a legacy root while a durable conversation is still restoring its child session', async () => {
    activeChatsStore.updateChat(SESSION_ID, {
      conversationId: 'conversation-root',
      currentSessionId: undefined,
    });
    const hook = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    await act(() => hook.result.current.handleCancel());

    expect(cancelMessageMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(
      'Restoring this conversation before Stop is available.',
      'info',
    );
  });

  // #887 review prescription — the discriminating drift case: the store is
  // keyed by the TAB id while `currentSessionId` has advanced to a different
  // continuation child. `useCancelMessage` keys its store snapshot by its
  // argument and resolves the child itself, so `useChatInput` must pass the
  // tab id. Passing `currentSessionId` (the pre-fix code) makes the snapshot
  // lookup miss, Stop silently answers not-running, and the child turn is
  // never interrupted.
  test('Stop interrupts the continuation child when currentSessionId drifted from the tab id', async () => {
    interruptOrchestrationTurnMock.mockResolvedValueOnce({
      outcome: 'cooperative',
      threadId: 'conversation-root:session:child-2',
      turnId: 'turn-1',
    });
    activeChatsStore.updateChat(SESSION_ID, {
      conversationId: 'conversation-root',
      currentSessionId: 'conversation-root:session:child-2',
      status: 'sending',
    });
    const hook = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    await act(() => hook.result.current.handleCancel());

    // The child — not the root, not the tab id — is what gets stopped.
    // Pre-fix this reads 0 calls: the hook's store lookup missed and Stop
    // silently answered not-running.
    expect(interruptOrchestrationTurnMock).toHaveBeenCalledTimes(1);
    expect(interruptOrchestrationTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'conversation-root:session:child-2',
      }),
    );
    // And the caller must hand the hook the store key, not the resolved child.
    expect(cancelMessageMock).toHaveBeenCalledWith(SESSION_ID);
  });

  test('debounces draft writes by 500ms and restores the draft on remount', () => {
    vi.useFakeTimers();
    const first = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    act(() => first.result.current.handleInputChange('survive switching'));
    expect(chatDraftsStore.get(SESSION_ID)).toBe('');
    act(() => vi.advanceTimersByTime(499));
    expect(chatDraftsStore.get(SESSION_ID)).toBe('');
    act(() => vi.advanceTimersByTime(1));
    expect(chatDraftsStore.get(SESSION_ID)).toBe('survive switching');

    activeChatsStore.clearInput(SESSION_ID);
    first.unmount();
    renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );
    expect(activeChatsStore.getSnapshot()[SESSION_ID]?.input).toBe(
      'survive switching',
    );
  });

  test('clears the persisted draft only after a successful send', async () => {
    chatDraftsStore.set(SESSION_ID, 'ready to send');
    activeChatsStore.updateChat(SESSION_ID, { input: 'ready to send' });
    const { result } = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    await act(() => result.current.handleSend());

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(chatDraftsStore.get(SESSION_ID)).toBe('');
  });

  // #765 A2: a send during a running turn is ENQUEUED
  // (`useActiveChatSessionMessaging` pushes it into `chat.queuedMessages`
  // and returns undefined). The queue owns the text from that point — it
  // renders as "N messages queued" with its own retry/steer controls — so
  // the debounce-persisted draft must clear exactly as it does for a
  // successful send. Before this fix it survived forever and every queued
  // message ALSO surfaced as a global "Unsent draft" row in the sidebar.
  test('clears the persisted draft when the send was enqueued behind a running turn', async () => {
    chatDraftsStore.set(SESSION_ID, 'queued while running');
    activeChatsStore.updateChat(SESSION_ID, { input: 'queued while running' });
    sendMessageMock.mockImplementationOnce(async () => {
      // The real enqueue branch's observable effects: the text moves into
      // `queuedMessages`, the chat stays 'sending', nothing is returned.
      activeChatsStore.updateChat(SESSION_ID, {
        status: 'sending',
        queuedMessages: ['queued while running'],
      });
      return undefined;
    });
    const { result } = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    await act(() => result.current.handleSend());

    expect(chatDraftsStore.get(SESSION_ID)).toBe('');
  });

  // The discriminating control: a send that failed outright (returned
  // undefined WITHOUT queueing) keeps its draft — the draft is still the
  // only copy of the user's words.
  test('keeps the persisted draft when the send failed without being enqueued', async () => {
    chatDraftsStore.set(SESSION_ID, 'failed outright');
    activeChatsStore.updateChat(SESSION_ID, { input: 'failed outright' });
    sendMessageMock.mockImplementationOnce(async () => undefined);
    const { result } = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    await act(() => result.current.handleSend());

    expect(chatDraftsStore.get(SESSION_ID)).toBe('failed outright');
  });

  test('clearing the composer removes its sidebar-visible persisted draft', () => {
    chatDraftsStore.set(SESSION_ID, 'discard me');
    activeChatsStore.updateChat(SESSION_ID, { input: 'discard me' });
    const { result } = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    act(() => result.current.handleClearInput());
    expect(chatDraftsStore.get(SESSION_ID)).toBe('');
    expect(activeChatsStore.getSnapshot()[SESSION_ID]?.input).toBe('');
  });

  test('suppresses the toast when the session exists AND the chat is visible (existing behavior)', () => {
    renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
          isChatVisible: true,
        }),
      { wrapper },
    );

    expect(capturedOnError).toBeDefined();
    capturedOnError?.(new Error('Agent not found'));

    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('does NOT suppress the toast when the chat exists but is not visible (collapsed dock / background tab)', () => {
    renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
          isChatVisible: false,
        }),
      { wrapper },
    );

    expect(capturedOnError).toBeDefined();
    capturedOnError?.(new Error('Agent not found'));

    expect(showToastMock).toHaveBeenCalledWith(
      'Error: Agent not found',
      'error',
    );
  });

  test('does not suppress the toast when there is no session context at all, regardless of visibility', () => {
    activeChatsStore.removeChat(SESSION_ID);

    renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
          isChatVisible: true,
        }),
      { wrapper },
    );

    expect(capturedOnError).toBeDefined();
    capturedOnError?.(new Error('Agent not found'));

    expect(showToastMock).toHaveBeenCalledWith(
      'Error: Agent not found',
      'error',
    );
  });

  test('defaulting isChatVisible (omitted) preserves the pre-existing suppression behavior for single-tab callers', () => {
    renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    expect(capturedOnError).toBeDefined();
    capturedOnError?.(new Error('Agent not found'));

    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('401 errors always route to onAuthError, regardless of visibility', () => {
    const onAuthError = vi.fn();
    renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
          isChatVisible: false,
          onAuthError,
        }),
      { wrapper },
    );

    expect(capturedOnError).toBeDefined();
    capturedOnError?.(new Error('401 Unauthorized'));

    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('switches the exact provider instance with a model in Station-managed chats', () => {
    activeChatsStore.updateChat(SESSION_ID, {
      executionMode: 'station',
      providerId: 'codex-work',
      provider: 'codex',
      model: 'gpt-5.6',
      providerOptions: { effort: 'high', approvalMode: 'ask' },
    });
    const { result, rerender } = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          agentDefaultModel: 'gpt-5.6',
          defaultModelSource: 'project default',
          availableModels: [
            {
              id: 'gpt-5.6',
              name: 'GPT-5.6',
              providerId: 'codex-work',
              providerType: 'codex',
            },
            {
              id: 'claude-sonnet',
              name: 'Claude Sonnet',
              providerId: 'bedrock-prod',
              providerType: 'bedrock',
            },
          ],
        }),
      { wrapper },
    );

    act(() => {
      result.current.handleModelSelect({
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        providerId: 'bedrock-prod',
        providerName: 'Bedrock · Prod',
        providerType: 'bedrock',
      });
    });

    expect(activeChatsStore.getSnapshot()[SESSION_ID]).toMatchObject({
      providerId: 'bedrock-prod',
      defaultProviderId: 'codex-work',
      provider: 'bedrock',
      model: 'gpt-5.6',
      requestedModel: 'claude-sonnet',
      requestedModelSource: 'session override',
      providerOptions: { approvalMode: 'ask' },
      requestedProviderOptions: { approvalMode: 'ask' },
    });

    rerender();
    act(() => result.current.handleModelReset());
    expect(activeChatsStore.getSnapshot()[SESSION_ID]).toMatchObject({
      providerId: 'codex-work',
      provider: 'codex',
      model: 'gpt-5.6',
      requestedModel: null,
      requestedModelSource: 'project default',
    });
  });

  test('does not rebind an externally managed chat from picker metadata', () => {
    activeChatsStore.updateChat(SESSION_ID, {
      executionMode: 'external',
      providerId: 'codex-runtime',
      provider: 'codex',
      model: 'gpt-5.6',
    });
    const { result } = renderHook(
      () =>
        useChatInput({
          apiBase: 'http://station.test',
          sessionId: SESSION_ID,
          agentSlug: 'dev-agent',
          availableModels: [],
        }),
      { wrapper },
    );

    act(() => {
      result.current.handleModelSelect({
        id: 'other-model',
        name: 'Other model',
        providerId: 'another-runtime',
        providerType: 'claude',
      });
    });

    expect(activeChatsStore.getSnapshot()[SESSION_ID]).toMatchObject({
      providerId: 'codex-runtime',
      provider: 'codex',
      model: 'gpt-5.6',
      requestedModel: 'other-model',
      requestedModelSource: 'session override',
    });
  });
});
