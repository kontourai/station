/** @vitest-environment jsdom */

/**
 * The revalidator against the real chat store, the real open patch and the
 * real work observation; only the `/open` wire read is stubbed. A saved model
 * choice whose catalog is still loading keeps the chat pending under the
 * real patch, and the answer held for it is never applied once it no longer
 * describes now: the chat moved to another child, or the read's stream epoch
 * ended. Either way the conversation is read again.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const resolveConversationOpen = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/conversation-open', () => ({
  resolveConversationOpen: (...args: unknown[]) =>
    resolveConversationOpen(...args),
}));

import { ConversationOpenRevalidator } from '../components/chat-dock/ConversationOpenRevalidator';
import { activeChatsStore } from '../contexts/active-chats-store';
import { workObservation } from '../contexts/work-observation';

const TAB = 'held-tab';
const CONVERSATION = 'held-conversation';

function resolved(child: string) {
  return {
    status: 'resolved',
    conversation: {
      id: CONVERSATION,
      source: 'runtime',
      agentSlug: 'codex',
      title: 'Held answer',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      messageCount: 2,
      mutable: false,
      answerability: { answerable: true },
    },
    currentSessionId: child,
    execution: {
      sessionId: child,
      agentId: 'codex',
      provider: 'codex',
      engineConnectionId: 'codex-connection',
    },
    transcript: { available: true, owner: 'runtime', messageCount: 2 },
    canContinue: true,
    answerability: { answerable: true },
    recoveryActions: [],
  };
}

const models = [{ id: 'saved-model', name: 'Saved' }] as never[];
// Stable, as the dock's store action is: a new function would re-run the read.
const updateChat: Parameters<
  typeof ConversationOpenRevalidator
>[0]['updateChat'] = (id, patch) => activeChatsStore.updateChat(id, patch);

describe('a held open answer under the real patch', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient();
    resolveConversationOpen.mockReset();
    activeChatsStore.initChat(TAB, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Held answer',
    });
    activeChatsStore.updateChat(TAB, {
      conversationId: CONVERSATION,
      currentSessionId: 'child-1',
      orchestrationProvider: 'codex',
      agentConnectionId: 'codex-connection',
      provider: 'codex',
      requestedModel: 'saved-model',
      requestedModelSource: 'session override',
      conversationOpenPending: true,
    });
  });
  afterEach(() => activeChatsStore.removeChat(TAB));

  function renderRevalidator(modelsLoading: boolean) {
    const wrap = (node: ReactNode) => (
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    );
    const element = (loading: boolean, catalog = models) => (
      <ConversationOpenRevalidator
        sessionId={TAB}
        conversationId={CONVERSATION}
        apiBase="http://station.test"
        updateChat={updateChat}
        modelsLoading={loading}
        availableModels={loading ? [] : catalog}
        canModelSelect
        catalogProvider="codex"
        catalogConnectionId="codex-connection"
      />
    );
    const view = render(wrap(element(modelsLoading)));
    return {
      catalogArrives: () =>
        act(async () => view.rerender(wrap(element(false)))),
      /** The same catalog, refetched: a new array of the same models. */
      catalogRefetched: () =>
        act(async () => view.rerender(wrap(element(false, [...models])))),
    };
  }

  async function bindWhileCatalogLoads() {
    resolveConversationOpen.mockResolvedValueOnce(resolved('child-1'));
    const view = renderRevalidator(true);
    await waitFor(() =>
      expect(
        activeChatsStore.getSnapshot()[TAB]?.conversationOpenState,
      ).toMatchObject({ currentSessionId: 'child-1' }),
    );
    // The real patch keeps the saved choice, and the composer, pending.
    expect(activeChatsStore.getSnapshot()[TAB]).toMatchObject({
      conversationOpenPending: true,
      requestedModel: 'saved-model',
      currentSessionId: 'child-1',
    });
    expect(resolveConversationOpen).toHaveBeenCalledTimes(1);
    return view;
  }

  test('the catalog arriving reconciles the held answer without another open', async () => {
    const view = await bindWhileCatalogLoads();
    await view.catalogArrives();
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[TAB]?.conversationOpenPending).toBe(
        false,
      ),
    );
    expect(activeChatsStore.getSnapshot()[TAB]?.requestedModel).toBe(
      'saved-model',
    );
    expect(resolveConversationOpen).toHaveBeenCalledTimes(1);
  });

  test('a child change while the catalog loads re-reads instead of applying the held answer', async () => {
    const view = await bindWhileCatalogLoads();
    const seen: Array<string | undefined> = [];
    const unsubscribe = activeChatsStore.subscribe(() =>
      seen.push(activeChatsStore.getSnapshot()[TAB]?.currentSessionId),
    );
    activeChatsStore.updateChat(TAB, { currentSessionId: 'child-2' });
    let answer: (value: unknown) => void = () => {};
    resolveConversationOpen.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    await view.catalogArrives();
    await waitFor(() =>
      expect(resolveConversationOpen).toHaveBeenCalledTimes(2),
    );
    // The held child-1 answer was not applied over child-2.
    expect(activeChatsStore.getSnapshot()[TAB]?.currentSessionId).toBe(
      'child-2',
    );
    expect(activeChatsStore.getSnapshot()[TAB]?.conversationOpenPending).toBe(
      true,
    );
    await act(async () => answer(resolved('child-2')));
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[TAB]?.conversationOpenPending).toBe(
        false,
      ),
    );
    unsubscribe();
    expect(seen.slice(1)).not.toContain('child-1');
    expect(activeChatsStore.getSnapshot()[TAB]?.currentSessionId).toBe(
      'child-2',
    );
  });

  test('a stream epoch change while the catalog loads re-reads instead of applying the held answer', async () => {
    const view = await bindWhileCatalogLoads();
    act(() => workObservation(client).resetStreamEpoch());
    resolveConversationOpen.mockResolvedValueOnce(resolved('child-1'));
    await view.catalogArrives();
    await waitFor(() =>
      expect(resolveConversationOpen).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[TAB]?.conversationOpenPending).toBe(
        false,
      ),
    );
  });

  test('an answer already applied is not re-read by a later epoch change and catalog refetch', async () => {
    activeChatsStore.updateChat(TAB, { requestedModel: null });
    resolveConversationOpen.mockResolvedValue(resolved('child-1'));
    const view = renderRevalidator(false);
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[TAB]?.conversationOpenPending).toBe(
        false,
      ),
    );
    act(() => workObservation(client).resetStreamEpoch());
    await view.catalogRefetched();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(resolveConversationOpen).toHaveBeenCalledTimes(1);
  });

  test('a chat marked pending again after its answer bound is read again', async () => {
    activeChatsStore.updateChat(TAB, { requestedModel: null });
    resolveConversationOpen.mockResolvedValueOnce(resolved('child-1'));
    renderRevalidator(false);
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[TAB]?.conversationOpenPending).toBe(
        false,
      ),
    );
    // A newer child adopted while the revalidator is still mounted.
    resolveConversationOpen.mockResolvedValueOnce(resolved('child-2'));
    act(() =>
      activeChatsStore.updateChat(TAB, {
        currentSessionId: 'child-2',
        conversationOpenPending: true,
      }),
    );
    await waitFor(() =>
      expect(resolveConversationOpen).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[TAB]).toMatchObject({
        conversationOpenPending: false,
        currentSessionId: 'child-2',
      }),
    );
  });
});
