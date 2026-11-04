/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { workObservation } from '../contexts/work-observation';

const resolveOpen = vi.fn();
const openPatch = vi.fn();

vi.mock('../components/chat-dock/conversationOpenController', () => ({
  conversationExecutionChanged: () => false,
  resolveConversationOpenAuthoritatively: (...args: unknown[]) =>
    resolveOpen(...args),
  conversationOpenPatch: (...args: unknown[]) => openPatch(...args),
}));

import { ConversationOpenRevalidator } from '../components/chat-dock/ConversationOpenRevalidator';

describe('#749 persisted conversation revalidation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

  test('restarts a pending binding read after the stream epoch changes and discards the old reply', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observation = workObservation(client);
    let stale!: (value: unknown) => void;
    let fresh!: (value: unknown) => void;
    resolveOpen
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            stale = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            fresh = resolve;
          }),
      );
    const patch = {
      currentSessionId: 'conversation-749:child:current',
      orchestrationSessionStarted: true,
      conversationOpenPending: false,
    };
    openPatch.mockReturnValue(patch);
    const updateChat = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <ConversationOpenRevalidator
          sessionId="conversation-tab"
          conversationId="conversation-749"
          apiBase="http://127.0.0.1:43210"
          updateChat={updateChat}
        />
      </QueryClientProvider>,
    );
    try {
      await waitFor(() => expect(resolveOpen).toHaveBeenCalledTimes(1));
      act(() => observation.resetStreamEpoch());
      await act(async () => {
        stale({ status: 'resolved', currentSessionId: 'retired-child' });
      });
      expect(updateChat).not.toHaveBeenCalled();
      await waitFor(() => expect(resolveOpen).toHaveBeenCalledTimes(2));
      // An ordinary observation update is not a new epoch and must not restart this read.
      act(() => observation.read('conversation-749', 'history')?.failed());
      expect(resolveOpen).toHaveBeenCalledTimes(2);
      await act(async () => {
        fresh({
          status: 'resolved',
          currentSessionId: 'conversation-749:child:current',
        });
      });
      await waitFor(() =>
        expect(updateChat).toHaveBeenCalledWith('conversation-tab', patch),
      );
      expect(updateChat).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      client.clear();
    }
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
