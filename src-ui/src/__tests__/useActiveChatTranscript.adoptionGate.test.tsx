/**
 * @vitest-environment jsdom
 *
 * The adoption gate on its own: a window still revalidating a cached paint
 * never names the conversation's current child, even if it carries one. The
 * reader no longer seeds a cached child at all (pinned in
 * useActiveChatTranscript.test.tsx); this pins the second layer by feeding
 * the real transcript hook a window that does name one.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const windowState = vi.hoisted(() => ({
  revalidating: true,
  currentSessionId: 'child-1' as string | undefined,
}));
vi.mock('../hooks/orchestration/useSessionEventWindow', () => ({
  useSessionEventWindow: () => ({
    events: [],
    handoffs: [],
    contextBoundaries: [],
    hasMore: false,
    loadOlder: () => undefined,
    loadTurn: async () => false,
    reload: () => undefined,
    upgradeRequired: false,
    loading: windowState.revalidating,
    settled: true,
    revalidating: windowState.revalidating,
    watermark: 1,
    partialTurnStartEventIds: new Set<string>(),
    catchingUp: false,
    error: undefined,
    ...(windowState.currentSessionId
      ? {
          currentSessionId: windowState.currentSessionId,
          executionRead: {
            sessionId: windowState.currentSessionId,
            priorSessionId: 'child-2',
          },
        }
      : {}),
  }),
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import type { ChatSession } from '../types';

const TAB = 'gate-tab';

function session(): ChatSession {
  return {
    ...activeChatsStore.getSnapshot()[TAB],
    id: TAB,
    messages: [],
    orchestrationSessionStarted: true,
    orchestrationHistoryRevision: 0,
  } as unknown as ChatSession;
}

describe('adoption from a revalidating window', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, data: [] })),
    );
    windowState.revalidating = true;
    windowState.currentSessionId = 'child-1';
    activeChatsStore.initChat(TAB, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Gate',
    });
    activeChatsStore.updateChat(TAB, {
      conversationId: 'gate-conversation',
      currentSessionId: 'child-2',
      conversationOpenPending: false,
      orchestrationTurnOpen: true,
      openTurnId: 'live-turn',
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    activeChatsStore.removeChat(TAB);
  });

  test('a child named while revalidating is not adopted; the settled read is', async () => {
    const view = renderHook(
      ({ chat }) => useActiveChatTranscript('http://station.test', chat),
      { initialProps: { chat: session() } },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(activeChatsStore.getSnapshot()[TAB]).toMatchObject({
      currentSessionId: 'child-2',
      conversationOpenPending: false,
      orchestrationTurnOpen: true,
      openTurnId: 'live-turn',
    });

    // The read that revalidates is a conversation read: its child is adopted.
    windowState.revalidating = false;
    windowState.currentSessionId = 'child-3';
    view.rerender({ chat: session() });
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[TAB]).toMatchObject({
        currentSessionId: 'child-3',
        conversationOpenPending: true,
      }),
    );
  });
});
