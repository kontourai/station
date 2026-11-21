/** @vitest-environment jsdom */

import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const resolveOpen = vi.fn();
const openPatch = vi.fn();

vi.mock('../components/chat-dock/conversationOpenController', () => ({
  conversationExecutionChanged: () => false,
  resolveConversationOpenAuthoritatively: (...args: unknown[]) =>
    resolveOpen(...args),
  conversationOpenPatch: (...args: unknown[]) => openPatch(...args),
}));

import { ConversationOpenRevalidator } from '../components/chat-dock/ConversationOpenRevalidator';
import { activeChatsStore } from '../contexts/active-chats-store';

describe('#749 persisted conversation revalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('binds only the controller-derived current child patch', async () => {
    const resolution = { status: 'resolved' };
    const patch = {
      currentSessionId: 'conversation-749:child:2',
      orchestrationSessionStarted: true,
      conversationOpenPending: false,
    };
    resolveOpen.mockResolvedValue(resolution);
    openPatch.mockReturnValue(patch);
    const updateChat = vi.fn();

    render(
      <ConversationOpenRevalidator
        sessionId="conversation-tab"
        conversationId="conversation-749"
        apiBase="http://127.0.0.1:43210"
        updateChat={updateChat}
      />,
    );

    await waitFor(() =>
      expect(updateChat).toHaveBeenCalledWith('conversation-tab', patch),
    );
    expect(resolveOpen).toHaveBeenCalledWith(
      'conversation-749',
      'http://127.0.0.1:43210',
      undefined,
      expect.any(Function),
    );
  });

  test('transport failure clears stale child facts and remains fail-closed', async () => {
    resolveOpen.mockRejectedValue(new Error('offline'));
    const updateChat = vi.fn();

    render(
      <ConversationOpenRevalidator
        sessionId="conversation-tab"
        conversationId="conversation-749"
        apiBase="http://127.0.0.1:43210"
        updateChat={updateChat}
      />,
    );

    await waitFor(() =>
      expect(updateChat).toHaveBeenCalledWith('conversation-tab', {
        conversationOpenPending: false,
        conversationOpenFailed: true,
        currentSessionId: undefined,
        orchestrationSessionStarted: false,
      }),
    );
  });

  test('an open that lands while models load binds once and reconciles the saved model without re-reading', async () => {
    activeChatsStore.initChat('model-tab', {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Saved model',
    });
    activeChatsStore.updateChat('model-tab', {
      conversationId: 'model-conversation',
      requestedModel: 'saved-model',
    });
    resolveOpen.mockResolvedValue({ status: 'resolved' });
    // The real patch keeps a choice pending exactly when its catalog is unknown.
    openPatch.mockImplementation(
      (
        _resolution: unknown,
        _previous: unknown,
        choice: { validModelIds?: string[] },
      ) => ({
        conversationOpenPending: choice.validModelIds === undefined,
        currentSessionId: 'model-child',
      }),
    );
    const updateChat = vi.fn();
    const props = {
      sessionId: 'model-tab',
      conversationId: 'model-conversation',
      apiBase: 'http://127.0.0.1:43210',
      updateChat,
      canModelSelect: true,
    };
    const view = render(
      <ConversationOpenRevalidator
        {...props}
        modelsLoading
        availableModels={[]}
      />,
    );
    // The child binds as soon as `/open` lands; only the choice stays pending.
    await waitFor(() =>
      expect(updateChat).toHaveBeenCalledWith('model-tab', {
        conversationOpenPending: true,
        currentSessionId: 'model-child',
      }),
    );
    // A catalog that changes identity while still loading is not a new open.
    view.rerender(
      <ConversationOpenRevalidator
        {...props}
        modelsLoading
        availableModels={[]}
      />,
    );
    const models = [{ id: 'saved-model', name: 'Saved' }] as never[];
    await act(async () => {
      view.rerender(
        <ConversationOpenRevalidator
          {...props}
          modelsLoading={false}
          availableModels={models}
        />,
      );
    });
    await waitFor(() =>
      expect(updateChat).toHaveBeenLastCalledWith('model-tab', {
        conversationOpenPending: false,
        currentSessionId: 'model-child',
      }),
    );
    expect(openPatch).toHaveBeenLastCalledWith(
      { status: 'resolved' },
      expect.anything(),
      expect.objectContaining({ validModelIds: ['saved-model'] }),
    );
    expect(updateChat).toHaveBeenCalledTimes(2);
    expect(resolveOpen).toHaveBeenCalledTimes(1);
    view.unmount();
    activeChatsStore.removeChat('model-tab');
  });
});
