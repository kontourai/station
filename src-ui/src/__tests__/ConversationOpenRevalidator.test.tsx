/** @vitest-environment jsdom */

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const resolveOpen = vi.fn();
const openPatch = vi.fn();

vi.mock('../components/chat-dock/conversationOpenController', () => ({
  resolveConversationOpenAuthoritatively: (...args: unknown[]) =>
    resolveOpen(...args),
  conversationOpenPatch: (...args: unknown[]) => openPatch(...args),
}));

import { ConversationOpenRevalidator } from '../components/chat-dock/ConversationOpenRevalidator';

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
});
