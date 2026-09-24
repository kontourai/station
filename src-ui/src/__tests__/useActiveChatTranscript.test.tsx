/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatSession } from '../types';

const fetchCapability = vi.fn();
const fetchWindow = vi.fn();
const fetchConversationWindow = vi.fn();
// Models the SDK budget contract the production module owns: three automatic
// recoveries per host/session, replenished only by an explicit reset. An
// always-true mock here silently disables the cap the recovery tests assert.
const recoveryBudget = new Map<string, number>();
const claimRecovery = vi.fn((apiBase: string, sessionId: string) => {
  const key = `${apiBase}\u0000${sessionId}`;
  const used = recoveryBudget.get(key) ?? 0;
  if (used >= 3) return false;
  recoveryBudget.set(key, used + 1);
  return true;
});
const resetRecovery = vi.fn((apiBase: string, sessionId: string) => {
  recoveryBudget.delete(`${apiBase}\u0000${sessionId}`);
});

vi.mock('@kontourai/station-sdk', async () => ({
  extractUIBlocks: (
    await import('../../../packages/sdk/src/query-domains/uiBlocks')
  ).extractUIBlocks,
  // station#2236: the checkpoints fetch rides the SDK authenticated
  // transport. The mock delegates to the test's stubbed global fetch with
  // the SDK's call shape so these tests keep asserting behavior, not the
  // transport's internals. Async like the real getJson: a stub fetch that
  // returns undefined must reject (caught -> empty), not throw
  // synchronously out of the effect.
  getJson: async (url: string, opts?: { signal?: AbortSignal }) =>
    (globalThis.fetch as typeof fetch)(
      url,
      opts?.signal ? { method: 'GET', signal: opts.signal } : { method: 'GET' },
    ),
  readEnvelopeOrThrow: (await import('../../../packages/sdk/src/client/http'))
    .readEnvelopeOrThrow,
  fetchSessionEventWindowCapability: (...args: unknown[]) =>
    fetchCapability(...args),
  claimSessionEventWindowCapabilityRecovery: (...args: unknown[]) =>
    claimRecovery(...(args as [string, string])),
  fetchOrchestrationSessionEventWindow: (...args: unknown[]) =>
    fetchWindow(...args),
  fetchOrchestrationConversationEventWindow: (...args: unknown[]) =>
    fetchConversationWindow(...args),
  resetSessionEventWindowCapabilityRecovery: (...args: unknown[]) =>
    resetRecovery(...(args as [string, string])),
  resetSessionEventWindowCapabilityCache: vi.fn(),
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS: 30_000,
  SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS: 60_000,
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import {
  recordSequencedLiveEvent,
  resetSequencedLiveEventsForTests,
} from '../hooks/orchestration/sequencedLiveEvents';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import { buildOutgoingUserMessage } from '../hooks/useActiveChatSessions.helpers';

const baseSession = {
  id: 'thread-1',
  messages: [],
  orchestrationSessionStarted: true,
  orchestrationHistoryRevision: 0,
} as unknown as ChatSession;

const event = (eventId: string, method: string, fields = {}) => ({
  sequence: Number(eventId.replace(/\D/gu, '')) || 1,
  event: {
    eventId,
    method,
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: `2026-08-09T00:00:${eventId.replace(/\D/gu, '').padStart(2, '0')}.000Z`,
    ...fields,
  },
});

describe('useActiveChatTranscript', () => {
  test('a fresh mid-turn mount stitches the window with a later live delta', async () => {
    const id = 'fresh-mid-turn';
    const apiBase = 'http://fresh-mid-turn.test';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Fresh mount',
      conversationId: id,
      orchestrationSessionStarted: true,
    });
    activeChatsStore.updateChat(id, {
      conversationActivity: {
        conversationId: id,
        asOfSequence: 2,
        openTurn: {
          turnId: 'turn-fresh',
          threadId: id,
          startedAt: '2026-09-24T00:00:00.000Z',
        },
      },
      orchestrationTurnOpen: true,
    });
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        {
          ...event('e1', 'turn.started', {
            threadId: id,
            turnId: 'turn-fresh',
            prompt: 'Question',
          }),
          sequence: 1,
        },
        {
          ...event('e2', 'content.text-delta', {
            threadId: id,
            turnId: 'turn-fresh',
            itemId: 'answer',
            delta: 'A',
          }),
          sequence: 2,
        },
      ],
    });
    recordSequencedLiveEvent(
      apiBase,
      {
        ...event('e3', 'content.text-delta', {
          threadId: id,
          turnId: 'turn-fresh',
          itemId: 'answer',
          delta: 'B',
        }).event,
      } as Parameters<typeof recordSequencedLiveEvent>[1],
      3,
    );
    const session = {
      ...baseSession,
      ...activeChatsStore.getSnapshot()[id],
      id,
    } as ChatSession;
    const view = renderHook(() => useActiveChatTranscript(apiBase, session));
    try {
      await waitFor(() => expect(view.result.current.settled).toBe(true));
      expect(view.result.current.openTurnProjected).toBe(true);
      expect(
        view.result.current.messages
          .filter((row) => row.role === 'assistant')
          .map((row) => row.content)
          .join(''),
      ).toBe('AB');
    } finally {
      view.unmount();
      activeChatsStore.removeChat(id);
    }
  });
  test('evicted live frames keep the transcript catching up until a newer window loads', async () => {
    const id = 'overflow-window';
    const apiBase = 'http://station-overflow.test';
    for (let sequence = 1; sequence <= 2049; sequence++) {
      recordSequencedLiveEvent(
        apiBase,
        {
          eventId: `overflow-${sequence}`,
          provider: 'codex',
          threadId: id,
          createdAt: '2026-09-24T00:00:00.000Z',
          method: 'content.text-delta',
          itemId: 'answer',
          delta: 'x',
        },
        sequence,
      );
    }
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 0,
      hasMore: false,
      events: [],
    });
    let resolveReload: ((value: unknown) => void) | undefined;
    fetchWindow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        }),
    );
    const session = {
      ...baseSession,
      id,
      orchestrationSessionStarted: true,
    } as ChatSession;
    const view = renderHook(() => useActiveChatTranscript(apiBase, session));
    try {
      await waitFor(() => expect(resolveReload).toBeDefined());
      expect(view.result.current.catchingUp).toBe(true);
      expect(view.result.current.messages).toEqual([]);
      await act(async () =>
        resolveReload?.({
          protocolVersion: 1,
          watermark: 2049,
          hasMore: false,
          events: [
            event('e2049', 'turn.completed', {
              threadId: id,
              turnId: 'overflow-turn',
              outputText: 'Done',
            }),
          ],
        }),
      );
      await waitFor(() => expect(view.result.current.catchingUp).toBe(false));
    } finally {
      view.unmount();
    }
  });
  test('a fallback revision hides stale transcript until its new window settles', async () => {
    const id = 'catching-up-turn';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Catch up',
      orchestrationSessionStarted: true,
    });
    const firstPage = {
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        {
          ...event('e1', 'turn.started', {
            threadId: id,
            turnId: 'old',
            prompt: 'Old question',
          }),
          sequence: 1,
        },
        {
          ...event('e2', 'turn.completed', {
            threadId: id,
            turnId: 'old',
            outputText: 'Old answer',
          }),
          sequence: 2,
        },
      ],
    };
    fetchWindow.mockResolvedValueOnce(firstPage);
    const session = () =>
      ({
        ...baseSession,
        ...activeChatsStore.getSnapshot()[id],
        id,
      }) as ChatSession;
    const view = renderHook(
      ({ chat }) => useActiveChatTranscript('http://station.test', chat),
      {
        initialProps: { chat: session() },
      },
    );
    try {
      await waitFor(() => expect(view.result.current.settled).toBe(true));
      expect(
        view.result.current.messages.map((message) => message.content),
      ).toContain('Old answer');
      let resolveReload: ((value: typeof firstPage) => void) | undefined;
      fetchWindow.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReload = resolve;
          }),
      );
      act(() =>
        activeChatsStore.updateChat(id, { orchestrationHistoryRevision: 1 }),
      );
      view.rerender({ chat: session() });
      expect(view.result.current.catchingUp).toBe(true);
      expect(view.result.current.messages).toEqual([]);
      await waitFor(() => expect(resolveReload).toBeDefined());
      await act(async () =>
        resolveReload?.({
          ...firstPage,
          watermark: 3,
          events: [
            ...firstPage.events,
            {
              ...event('e3', 'turn.started', {
                threadId: id,
                turnId: 'new',
                prompt: 'New question',
              }),
              sequence: 3,
            },
          ],
        }),
      );
      await waitFor(() => expect(view.result.current.catchingUp).toBe(false));
      expect(
        view.result.current.messages.map((message) => message.content),
      ).toContain('New question');
    } finally {
      view.unmount();
      activeChatsStore.removeChat(id);
    }
  });
  test('stitches a live delta after the window watermark into one projected open turn', async () => {
    const id = 'stitch-open-turn';
    const apiBase = 'http://station-stitch.test';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Stitch',
      orchestrationSessionStarted: true,
    });
    activeChatsStore.updateChat(id, {
      orchestrationTurnOpen: true,
      openTurnId: 'turn-stitch',
      openTurnShellSuperseded: true,
    });
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        {
          ...event('e1', 'turn.started', {
            threadId: id,
            turnId: 'turn-stitch',
            prompt: 'Question',
          }),
          sequence: 1,
        },
        {
          ...event('e2', 'content.text-delta', {
            threadId: id,
            turnId: 'turn-stitch',
            itemId: 'text',
            delta: 'A',
          }),
          sequence: 2,
        },
      ],
    });
    const session = () =>
      ({
        ...baseSession,
        ...activeChatsStore.getSnapshot()[id],
        id,
      }) as ChatSession;
    const view = renderHook(
      ({ chat }) => useActiveChatTranscript(apiBase, chat),
      {
        initialProps: { chat: session() },
      },
    );
    try {
      await waitFor(() => expect(view.result.current.settled).toBe(true));
      act(() => {
        handleOrchestrationEvent(
          apiBase,
          {
            ...event('e3', 'content.text-delta', {
              threadId: id,
              turnId: 'turn-stitch',
              itemId: 'text',
              delta: 'B',
            }).event,
          } as Parameters<typeof handleOrchestrationEvent>[1],
          undefined,
          undefined,
          3,
        );
      });
      view.rerender({ chat: session() });
      await waitFor(() =>
        expect(
          view.result.current.messages
            .filter((row) => row.role === 'assistant')
            .map((row) => row.content)
            .join(''),
        ).toBe('AB'),
      );
      expect(view.result.current.openTurnProjected).toBe(true);
      fetchWindow.mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 3,
        hasMore: false,
        events: [
          {
            ...event('e1', 'turn.started', {
              threadId: id,
              turnId: 'turn-stitch',
              prompt: 'Question',
            }),
            sequence: 1,
          },
          {
            ...event('e2', 'content.text-delta', {
              threadId: id,
              turnId: 'turn-stitch',
              itemId: 'text',
              delta: 'A',
            }),
            sequence: 2,
          },
          {
            ...event('e3', 'content.text-delta', {
              threadId: id,
              turnId: 'turn-stitch',
              itemId: 'text',
              delta: 'B',
            }),
            sequence: 3,
          },
        ],
      });
      act(() =>
        activeChatsStore.updateChat(id, { orchestrationHistoryRevision: 1 }),
      );
      view.rerender({ chat: session() });
      await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
      expect(
        view.result.current.messages
          .filter((row) => row.role === 'assistant')
          .map((row) => row.content)
          .join(''),
      ).toBe('AB');
      view.unmount();
      fetchWindow.mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 3,
        hasMore: false,
        events: [
          {
            ...event('e1', 'turn.started', {
              threadId: id,
              turnId: 'turn-stitch',
              prompt: 'Question',
            }),
            sequence: 1,
          },
          {
            ...event('e2', 'content.text-delta', {
              threadId: id,
              turnId: 'turn-stitch',
              itemId: 'text',
              delta: 'A',
            }),
            sequence: 2,
          },
          {
            ...event('e3', 'content.text-delta', {
              threadId: id,
              turnId: 'turn-stitch',
              itemId: 'text',
              delta: 'B',
            }),
            sequence: 3,
          },
        ],
      });
      const remounted = renderHook(() =>
        useActiveChatTranscript(apiBase, session()),
      );
      try {
        await waitFor(() =>
          expect(remounted.result.current.settled).toBe(true),
        );
        expect(
          remounted.result.current.messages
            .filter((row) => row.role === 'assistant')
            .map((row) => row.content)
            .join(''),
        ).toBe('AB');
      } finally {
        remounted.unmount();
      }
    } finally {
      view.unmount();
      activeChatsStore.removeChat(id);
    }
  });
  test('mounted replay retains settled rows without history or checkpoint requests', async () => {
    const { registerReplayThread, unregisterReplayThread } = await import(
      '../hooks/orchestration/replay/replay-registry'
    );
    const { SessionTapePlayer } = await import(
      '../hooks/orchestration/replay/player'
    );
    const { tapeFromSessionEvents } = await import(
      '../hooks/orchestration/replay/tape'
    );
    const replayId = registerReplayThread();
    activeChatsStore.initChat(replayId, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Replay',
      orchestrationSessionStarted: true,
      replay: { sourceThreadId: 'thread-1', tapeEventCount: 2 },
    });
    const tape = tapeFromSessionEvents(
      { threadId: 'thread-1', agentSlug: 'codex' },
      [
        event('evt1', 'turn.started', { turnId: 'turn-1', prompt: 'Hello' })
          .event,
        event('evt2', 'turn.completed', {
          turnId: 'turn-1',
          outputText: 'Recorded reply',
        }).event,
      ] as Parameters<typeof tapeFromSessionEvents>[1],
    );
    const player = new SessionTapePlayer(tape, replayId);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const session = () =>
      ({
        ...baseSession,
        ...activeChatsStore.getSnapshot()[replayId],
        id: replayId,
      }) as ChatSession;
    const view = renderHook(({ chat }) => useActiveChatTranscript('', chat), {
      initialProps: { chat: session() },
    });
    try {
      act(() => {
        player.step();
        player.step();
      });
      view.rerender({ chat: session() });
      expect(
        view.result.current.messages.some(
          (row) => row.content === 'Recorded reply',
        ),
      ).toBe(true);
      expect(view.result.current.enabled).toBe(false);
      expect(fetchCapability).not.toHaveBeenCalled();
      expect(fetchConversationWindow).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      act(() => {
        player.back();
      });
      view.rerender({ chat: session() });
      expect(
        view.result.current.messages.some(
          (row) => row.content === 'Recorded reply',
        ),
      ).toBe(false);
    } finally {
      view.unmount();
      activeChatsStore.removeChat(replayId);
      unregisterReplayThread(replayId);
      vi.unstubAllGlobals();
    }
  });

  test('an incomplete history prefix cannot erase the completed live answer', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 9314,
      hasMore: true,
      nextCursor: 'within-turn',
      events: [
        event('evt1', 'turn.started', {
          turnId: 'large-turn',
          prompt: 'Question',
        }),
        event('evt2', 'content.text-delta', {
          turnId: 'large-turn',
          itemId: 'commentary',
          delta: 'I will investigate.',
        }),
      ],
    });
    const answer = {
      id: 'live-final',
      role: 'assistant' as const,
      turnId: 'large-turn',
      answerEligible: true,
      content: 'The complete answer is saved.',
      timestamp: 1786233603000,
    };
    const view = renderHook(() =>
      useActiveChatTranscript('', { ...baseSession, messages: [answer] }),
    );
    await waitFor(() => expect(view.result.current.settled).toBe(true));
    expect(
      view.result.current.messages.filter((row) => row.role === 'assistant'),
    ).toEqual([answer]);
    view.unmount();
  });

  test('switching conversations never assigns the previous reader child to the new chat', async () => {
    const parentId = 'reader-parent-tab';
    const childId = 'reader-fork-tab';
    for (const id of [parentId, childId])
      activeChatsStore.initChat(id, {
        agentSlug: 'claude',
        agentName: 'Claude',
        title: id,
      });
    activeChatsStore.updateChat(parentId, {
      conversationId: 'parent-conversation',
      currentSessionId: 'parent-execution',
    });
    activeChatsStore.updateChat(childId, {
      conversationId: 'fork-conversation',
      requestedModel: 'chosen-model',
    });
    let resolveFork!: (value: unknown) => void;
    fetchWindow.mockImplementation((conversationId: string) =>
      conversationId === 'parent-conversation'
        ? Promise.resolve({
            protocolVersion: 1,
            currentSessionId: 'parent-execution',
            watermark: 1,
            hasMore: false,
            events: [],
          })
        : new Promise((resolve) => {
            resolveFork = resolve;
          }),
    );
    const { result, rerender, unmount } = renderHook(
      ({ session }) => useActiveChatTranscript('http://station.test', session),
      {
        initialProps: {
          session: {
            ...baseSession,
            id: parentId,
            conversationId: 'parent-conversation',
            currentSessionId: 'parent-execution',
          } as ChatSession,
        },
      },
    );
    try {
      await waitFor(() =>
        expect(result.current.currentSessionId).toBe('parent-execution'),
      );
      rerender({
        session: {
          ...baseSession,
          id: childId,
          conversationId: 'fork-conversation',
          orchestrationSessionStarted: false,
        } as ChatSession,
      });
      expect(
        activeChatsStore.getSnapshot()[childId].currentSessionId,
      ).toBeUndefined();
      expect(activeChatsStore.getSnapshot()[childId].requestedModel).toBe(
        'chosen-model',
      );
      rerender({
        session: {
          ...baseSession,
          id: childId,
          conversationId: 'fork-conversation',
        } as ChatSession,
      });
      await waitFor(() => expect(resolveFork).toBeDefined());
      await act(async () =>
        resolveFork({
          protocolVersion: 1,
          currentSessionId: 'fork-execution',
          watermark: 1,
          hasMore: false,
          events: [],
        }),
      );
      expect(activeChatsStore.getSnapshot()[childId].currentSessionId).toBe(
        'fork-execution',
      );
    } finally {
      unmount();
      activeChatsStore.removeChat(parentId);
      activeChatsStore.removeChat(childId);
    }
  });

  test('observing a new child schedules authoritative open once without clearing the draft', async () => {
    const id = 'live-boundary-conversation';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Boundary',
    });
    activeChatsStore.updateChat(id, {
      conversationId: id,
      currentSessionId: 'old-child',
      input: 'keep my draft',
    });
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [],
      currentSessionId: 'new-child',
    });
    const session: ChatSession = {
      ...baseSession,
      id,
      conversationId: id,
      currentSessionId: 'old-child',
    };
    const { rerender, unmount } = renderHook(
      ({ session }) => useActiveChatTranscript('http://station.test', session),
      { initialProps: { session } },
    );
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[id]).toMatchObject({
        currentSessionId: 'new-child',
        conversationOpenPending: true,
        input: 'keep my draft',
      }),
    );
    activeChatsStore.updateChat(id, { conversationOpenPending: false });
    rerender({ session: { ...session, currentSessionId: 'new-child' } });
    expect(activeChatsStore.getSnapshot()[id].conversationOpenPending).toBe(
      false,
    );
    unmount();
    activeChatsStore.removeChat(id);
  });

  test('stale hook props cannot clear an already-adopted child stream', async () => {
    const id = 'already-adopted-child';
    activeChatsStore.initChat(id, {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Live',
    });
    activeChatsStore.updateChat(id, {
      conversationId: id,
      currentSessionId: 'new-child',
      orchestrationTurnOpen: true,
      openTurnId: 'new-turn',
      streamingMessage: { role: 'assistant', content: 'new live answer' },
    });
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [],
      currentSessionId: 'new-child',
    });
    const { unmount } = renderHook(() =>
      useActiveChatTranscript('http://station.test', {
        ...baseSession,
        id,
        conversationId: id,
        currentSessionId: 'old-child',
      }),
    );
    await waitFor(() => expect(fetchWindow).toHaveBeenCalled());
    expect(activeChatsStore.getSnapshot()[id]).toMatchObject({
      currentSessionId: 'new-child',
      openTurnId: 'new-turn',
      streamingMessage: { content: 'new live answer' },
    });
    unmount();
    activeChatsStore.removeChat(id);
  });

  beforeEach(() => {
    resetSequencedLiveEventsForTests();
    vi.clearAllMocks();
    fetchWindow.mockReset();
    recoveryBudget.clear();
    fetchCapability.mockResolvedValue(true);
    fetchConversationWindow.mockImplementation((...args: unknown[]) =>
      fetchWindow(...args),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * #1582 E3/B6. The reader's `settled` is what lets a consumer tell "this
   * conversation is empty" from "nobody has looked yet"; `loading` cannot,
   * because it is false on both sides of the request. The chat dock reads it
   * to decide whether "Start a conversation" is a claim it is entitled to
   * make, so the PRODUCER needs its own coverage — a consumer test given
   * `settled: false` proves the fold, never that anything ever sets it.
   */
  test('does not settle while the read is in flight', async () => {
    // Never resolves: the reader has asked and has no answer, which is the
    // exact state the empty "Start a conversation" placeholder used to render
    // over.
    fetchWindow.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.settled).toBe(false);
    expect(result.current.messages).toEqual([]);
  });

  test('settles on an empty page — "no turns" is then a reading', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [],
    });

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );

    await waitFor(() => expect(result.current.settled).toBe(true));
    // Still empty — but now that is a reading, not an absence of one.
    expect(result.current.messages).toEqual([]);
  });

  test('a failed read is still a reading', async () => {
    fetchWindow.mockRejectedValue(new Error('transport down'));

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );

    await waitFor(() => expect(result.current.error).toBeTruthy());
    // The consumer must stop waiting: an error is an answer, and leaving
    // `settled` false here would hold the loading state forever.
    expect(result.current.settled).toBe(true);
  });

  test('reads bounded REST pages only, keeps stable rows, and filters the global live leaf', async () => {
    fetchWindow
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 9,
        hasMore: true,
        nextCursor: 'older',
        events: [
          event('e3', 'turn.started', {
            turnId: 'open-turn',
            prompt: 'current question',
          }),
          event('e4', 'content.text-delta', {
            turnId: 'open-turn',
            itemId: 'text',
            delta: 'live answer',
          }),
        ],
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 9,
        hasMore: false,
        events: [
          event('e1', 'turn.started', {
            turnId: 'settled-turn',
            prompt: 'older question',
          }),
          event('e2', 'turn.completed', {
            turnId: 'settled-turn',
            outputText: 'older answer',
          }),
        ],
      });

    const session: ChatSession = {
      ...baseSession,
      orchestrationTurnOpen: true,
      openTurnId: 'open-turn',
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    expect(result.current.messages.map((message) => message.content)).toEqual([
      'current question',
      'live answer',
    ]);
    expect(result.current.messages[0]?.id).toBe('e3:user');
    expect(result.current.openTurnProjected).toBe(true);

    await act(async () => result.current.loadOlder());
    expect(result.current.messages.map((message) => message.content)).toEqual([
      'older question',
      'older answer',
      'current question',
      'live answer',
    ]);
    expect(fetchWindow).toHaveBeenNthCalledWith(
      2,
      'thread-1',
      'http://station.test',
      { cursor: 'older', turnLimit: 20, direction: 'newest' },
      { signal: expect.any(AbortSignal) },
    );
  });

  test('keeps each restored handoff answer bound to its producing Session Agent', async () => {
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 4,
      hasMore: false,
      sessionLineage: [
        {
          sessionId: 'codex-session',
          agentSlug: 'codex',
          agentDisplayName: 'Historical Codex',
          agentIcon: 'terminal',
        },
        {
          sessionId: 'claude-session',
          agentSlug: 'claude',
          agentDisplayName: 'Historical Claude',
          agentIcon: 'sparkles',
        },
      ],
      events: [
        event('e1', 'turn.started', {
          threadId: 'codex-session',
          turnId: 'codex-turn',
          prompt: 'First question',
        }),
        event('e2', 'turn.completed', {
          threadId: 'codex-session',
          turnId: 'codex-turn',
          outputText: 'Codex answer',
        }),
        event('e3', 'turn.started', {
          threadId: 'claude-session',
          turnId: 'claude-turn',
          prompt: 'Second question',
        }),
        event('e4', 'turn.completed', {
          threadId: 'claude-session',
          turnId: 'claude-turn',
          outputText: 'Claude answer',
        }),
      ],
    });

    const session: ChatSession = {
      ...baseSession,
      id: 'claude-session',
      conversationId: 'durable-conversation',
      agentSlug: 'claude' as never,
      agentName: 'Claude Agent',
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(fetchWindow).toHaveBeenCalledTimes(1);
    expect(result.current.events.map((item) => item.event.eventId)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
    ]);
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    expect(
      result.current.messages.map((message) => [
        message.content,
        message.sessionId,
        message.agentSlug,
        message.agentDisplayName,
        message.agentIcon,
      ]),
    ).toEqual([
      [
        'First question',
        'codex-session',
        'codex',
        'Historical Codex',
        'terminal',
      ],
      [
        'Codex answer',
        'codex-session',
        'codex',
        'Historical Codex',
        'terminal',
      ],
      [
        'Second question',
        'claude-session',
        'claude',
        'Historical Claude',
        'sparkles',
      ],
      [
        'Claude answer',
        'claude-session',
        'claude',
        'Historical Claude',
        'sparkles',
      ],
    ]);
  });

  test('falls back once to a legacy single-session endpoint when an older channel lacks conversation reads', async () => {
    fetchConversationWindow.mockRejectedValueOnce({ status: 404 });
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [
        event('legacy-1', 'turn.started', {
          turnId: 'legacy-turn',
          prompt: 'legacy question',
        }),
      ],
    });

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );

    await waitFor(() =>
      expect(
        result.current.messages.map((message) => message.content),
      ).toContain('legacy question'),
    );
    expect(fetchConversationWindow).toHaveBeenCalledTimes(1);
    expect(fetchWindow).toHaveBeenCalledTimes(1);
  });

  test('carries an attachment reference through to the rendered part (#3385)', async () => {
    // The exact shape a byte-budgeted window returns after archive#3374: the
    // attachment's identity plus a content reference, and no bytes. If the
    // reference is dropped anywhere along this mapping, the chip can never
    // become a picture again and nothing else in the suite notices.
    const blobRef = `sha256-${'a'.repeat(64)}`;
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [
        event('e1', 'turn.started', {
          turnId: 'turn-1',
          prompt: 'what is in this screenshot?',
          attachments: [
            {
              kind: 'image',
              name: 'screen.png',
              mimeType: 'image/png',
              size: 79,
              blobRef,
            },
          ],
        }),
      ],
    });

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    const filePart = result.current.messages[0]?.contentParts?.find(
      (part) => part.type === 'file',
    );
    expect(filePart).toMatchObject({
      type: 'file',
      blobRef,
      mediaType: 'image/png',
      name: 'screen.png',
    });
    // No bytes came down this path; the reference is the only way back to them.
    expect(filePart?.url).toBeUndefined();
  });

  test('preserves durable tool-result event identity through replay mapping', async () => {
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 3,
      hasMore: false,
      events: [
        event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'run' }),
        event('e2', 'tool.completed', {
          turnId: 'turn-1',
          itemId: 'item',
          toolCallId: 'same-call',
          toolName: 'shell',
          status: 'success',
          output: {
            uiBlock: {
              type: 'card',
              title: 'Replay card',
              body: 'Kept result',
            },
          },
        }),
        event('e3', 'turn.completed', {
          turnId: 'turn-1',
          finishReason: 'stop',
        }),
      ],
    });
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[1]?.contentParts).toContainEqual(
      expect.objectContaining({ type: 'tool-invocation', sourceEventId: 'e2' }),
    );
    expect(result.current.messages[1]?.contentParts).toContainEqual(
      expect.objectContaining({
        type: 'ui-block',
        toolCallId: 'same-call',
        sourceEventId: 'e2',
        uiBlock: expect.objectContaining({
          id: 'e2-block-0',
          title: 'Replay card',
        }),
      }),
    );
  });

  test('reports a capability transport failure without claiming Station needs an upgrade', async () => {
    fetchCapability.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );

    await waitFor(() =>
      expect(result.current.error?.message).toBe(
        'Session history transport failed.',
      ),
    );
    expect(result.current.upgradeRequired).toBe(false);
    expect(fetchWindow).not.toHaveBeenCalled();
  });

  test('reports a responding host without the capability as requiring an upgrade', async () => {
    fetchCapability.mockResolvedValueOnce(false);

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );

    await waitFor(() => expect(result.current.upgradeRequired).toBe(true));
    expect(result.current.error?.message).toBe(
      'Session history requires a Station upgrade',
    );
  });

  test('re-probes once after the capability cooldown and recovers a mounted transcript', async () => {
    vi.useFakeTimers();
    fetchCapability
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true);
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 0,
      hasMore: false,
      events: [],
    });

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error?.message).toBe(
      'Session history transport failed.',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchCapability).toHaveBeenCalledTimes(2);
    expect(fetchWindow).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeUndefined();
  });

  test('caps automatic mounted-transcript recovery probes', async () => {
    vi.useFakeTimers();
    fetchCapability.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(fetchCapability).toHaveBeenCalledTimes(4);
    expect(result.current.upgradeRequired).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(fetchCapability).toHaveBeenCalledTimes(4);
  });

  test('retains only explicit live flow and provider-notice rows beside the bounded projection', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'Q1' }),
        event('e2', 'turn.completed', {
          turnId: 'turn-1',
          outputText: 'A1',
        }),
      ],
    });
    const session: ChatSession = {
      ...baseSession,
      messages: [
        { role: 'user', content: 'must not bypass the window' },
        {
          role: 'system',
          content: 'Flow attached',
          contentParts: [
            {
              type: 'flow-run-attached',
              flowRunAttached: {
                runId: 'run-1',
                definitionId: 'delivery',
                cwd: '/tmp/project',
                resumed: false,
              },
            },
          ],
        },
        { role: 'system', content: 'Sign in', ephemeral: true },
      ],
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );

    await waitFor(() =>
      expect(result.current.messages.map((message) => message.content)).toEqual(
        ['Q1', 'A1', 'Flow attached', 'Sign in'],
      ),
    );
  });

  test('orders a live flow marker before a later bounded REST turn', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        event('e1', 'turn.started', {
          turnId: 'turn-1',
          prompt: 'Later question',
          createdAt: '2026-08-09T00:00:03.000Z',
        }),
        event('e2', 'turn.completed', {
          turnId: 'turn-1',
          outputText: 'Later answer',
          createdAt: '2026-08-09T00:00:04.000Z',
        }),
      ],
    });
    const session: ChatSession = {
      ...baseSession,
      messages: [
        {
          id: 'flow-1',
          role: 'system',
          content: 'Flow attached',
          timestamp: Date.parse('2026-08-09T00:00:01.000Z'),
          contentParts: [
            {
              type: 'flow-run-attached',
              flowRunAttached: {
                runId: 'run-1',
                definitionId: 'delivery',
                cwd: '/tmp/project',
                resumed: false,
              },
            },
          ],
        },
      ],
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );

    await waitFor(() =>
      expect(result.current.messages.map((message) => message.content)).toEqual(
        ['Flow attached', 'Later question', 'Later answer'],
      ),
    );
    expect(result.current.messages.map((message) => message.id)).toEqual([
      'flow-1',
      'e1:user',
      'e1:assistant',
    ]);
  });

  test('keeps one stable optimistic prompt through live canonical arrival, then reconciles on settlement', async () => {
    let resolveWindow: ((page: Record<string, unknown>) => void) | undefined;
    fetchWindow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWindow = resolve;
        }),
    );
    const session = {
      ...baseSession,
      orchestrationTurnOpen: true,
      openTurnId: 'turn-pending',
      messages: [
        {
          role: 'user' as const,
          content: 'pending prompt',
          clientId: 'client-prompt-1',
        },
      ],
    };
    const { result, rerender } = renderHook(
      ({ current }) => useActiveChatTranscript('http://station.test', current),
      { initialProps: { current: session } },
    );
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.content)).toEqual(
        ['pending prompt'],
      ),
    );
    expect(result.current.messages[0]?.id).toBe('client-prompt-1');

    resolveWindow?.({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [
        event('e1', 'turn.started', {
          turnId: 'turn-pending',
          prompt: 'pending prompt',
        }),
      ],
    });
    await waitFor(() =>
      expect(result.current.messages[0]?.id).toBe('client-prompt-1'),
    );
    expect(
      result.current.messages.filter(
        (message) => message.content === 'pending prompt',
      ),
    ).toHaveLength(1);

    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [
        event('e1', 'turn.started', {
          turnId: 'turn-pending',
          prompt: 'pending prompt',
        }),
      ],
    });
    rerender({
      current: {
        ...session,
        orchestrationTurnOpen: false,
        orchestrationHistoryRevision: 1,
      },
    });
    await waitFor(() => expect(result.current.messages[0]?.id).toBe('e1:user'));
    expect(
      result.current.messages.filter(
        (message) => message.content === 'pending prompt',
      ),
    ).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      sourceEventId: 'e1',
      sessionId: 'thread-1',
      turnId: 'turn-pending',
    });
  });

  test('never copies a canonical input identity onto an optimistic row by matching content', async () => {
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [
        event('durable-event', 'turn.started', {
          turnId: 'durable-turn',
          prompt: 'same text',
        }),
      ],
    });
    const session: ChatSession = {
      ...baseSession,
      orchestrationTurnOpen: true,
      openTurnId: 'other-open-turn',
      messages: [
        { role: 'user', content: 'same text', clientId: 'optimistic-row' },
      ],
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]).toMatchObject({
      id: 'optimistic-row',
      clientId: 'optimistic-row',
    });
    expect(result.current.messages[0]?.sourceEventId).toBeUndefined();
    expect(result.current.messages[0]?.sessionId).toBeUndefined();
    expect(result.current.messages[0]?.turnId).toBeUndefined();
  });

  test('recovers child events that arrive before the handoff HTTP receipt and renders the prompt, answer, and marker once', async () => {
    fetchWindow
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({
        protocolVersion: 1,
        conversationId: 'thread-1',
        currentSessionId: 'thread-1:session:child',
        watermark: 2,
        hasMore: false,
        handoffs: [
          {
            predecessorSessionId: 'thread-1',
            sessionId: 'thread-1:session:child',
            idempotencyKey: 'handoff-fast',
            targetAgentId: 'codex',
            targetConnectionId: 'codex',
            createdAt: '2026-08-09T00:00:01.500Z',
            carried: [
              'authorizedTranscript',
              'ownerTenantWorkspace',
              'targetAgentModel',
            ],
            reset: ['providerNativeCursor', 'toolState'],
          },
        ],
        contextBoundaries: [
          {
            boundaryId: 'boundary-consumed',
            successorSessionId: 'thread-1:session:child',
            policy: 'empty-next-cold-start',
            priorTranscriptInjected: false,
            consumedAt: '2026-08-09T00:00:01.750Z',
          },
        ],
        events: [
          event('e1', 'turn.started', {
            threadId: 'thread-1:session:child',
            turnId: 'handoff-turn',
            prompt: 'fast follow up',
            createdAt: '2026-08-09T00:00:02.000Z',
          }),
          event('e2', 'turn.completed', {
            threadId: 'thread-1:session:child',
            turnId: 'handoff-turn',
            outputText: 'fast answer',
            createdAt: '2026-08-09T00:00:03.000Z',
          }),
        ],
      });
    const pending: ChatSession = {
      ...baseSession,
      status: 'sending',
      messages: [
        {
          role: 'user',
          content: 'fast follow up',
          clientId: 'handoff:fast-key',
        },
      ],
    };
    const { result, rerender } = renderHook(
      ({ session }) => useActiveChatTranscript('http://station.test', session),
      { initialProps: { session: pending } },
    );
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
    expect(result.current.messages.map((message) => message.content)).toEqual([
      'fast follow up',
    ]);

    rerender({
      session: {
        ...pending,
        status: 'idle',
        currentSessionId: 'thread-1:session:child',
        orchestrationHistoryRevision: 1,
      },
    });

    await waitFor(() =>
      expect(fetchWindow.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(
        result.current.messages.filter(
          (message) => message.content === 'fast answer',
        ),
      ).toHaveLength(1),
    );
    expect(
      result.current.messages.filter(
        (message) => message.content === 'fast follow up',
      ),
    ).toHaveLength(1);
    expect(
      result.current.messages.filter((message) =>
        message.contentParts?.some(
          (part) => part.type === 'conversation-handoff',
        ),
      ),
    ).toHaveLength(1);
    expect(
      result.current.messages.filter((message) =>
        message.contentParts?.some(
          (part) => part.type === 'conversation-context-boundary',
        ),
      ),
    ).toHaveLength(1);
  });

  /**
   * #2304: while a turn is open, the prompt row restored by `turn.started`
   * (the local `event-input:` row other clients and replay get) owns the
   * prompt. The projection stamps a whole turn with that ONE `turn.started`
   * time, so the same turn's projected activity row carries the identical
   * millisecond — and the merge's tie-break by input order used to put the
   * live prompt, appended after the projection, BELOW its own activity.
   * The local row is built by the real turn handler, and its timestamp is
   * the same `createdAt` the projection stamps, so the tie is the real one.
   */
  test('an open turn renders its prompt above the activity the same turn produced', async () => {
    const id = 'thread-1';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Open turn order',
      orchestrationSessionStarted: true,
    });
    try {
      const started = event('e3', 'turn.started', {
        turnId: 'turn-2',
        prompt: 'why did you stop?',
      });
      handleTurnStartedEvent(
        started.event as Parameters<typeof handleTurnStartedEvent>[0],
      );
      // A reconnect the server could not replay hands the open turn's
      // rendering to the projection (archive#3352) — the path on which the
      // projected activity row and the live prompt row are both admitted.
      activeChatsStore.updateChat(id, { openTurnShellSuperseded: true });
      const chat = activeChatsStore.getSnapshot()[id];
      const localPrompt = chat.messages?.find(
        (message) => message.role === 'user',
      );
      expect(localPrompt).toMatchObject({
        clientId: 'event-input:e3',
        timestamp: Date.parse(started.event.createdAt),
      });
      fetchWindow.mockResolvedValue({
        protocolVersion: 1,
        watermark: 4,
        hasMore: false,
        events: [
          event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'Q1' }),
          event('e2', 'turn.completed', { turnId: 'turn-1', outputText: 'A1' }),
          started,
          event('e4', 'content.text-delta', {
            turnId: 'turn-2',
            delta: 'Reading files',
          }),
        ],
      });
      const session = {
        ...baseSession,
        ...chat,
        id,
      } as unknown as ChatSession;
      const { result } = renderHook(() =>
        useActiveChatTranscript('http://station.test', session),
      );
      await waitFor(() =>
        expect(
          result.current.messages.some(
            (message) => message.content === 'Reading files',
          ),
        ).toBe(true),
      );
      const rows = result.current.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      }));
      const activity = result.current.messages.find(
        (message) => message.content === 'Reading files',
      );
      // The tie this test exists for: same turn, same millisecond.
      expect(activity?.timestamp).toBe(localPrompt?.timestamp);
      expect(rows).toEqual([
        { id: 'e1:user', role: 'user', content: 'Q1' },
        { id: 'e1:assistant', role: 'assistant', content: 'A1' },
        { id: 'event-input:e3', role: 'user', content: 'why did you stop?' },
        { id: activity?.id, role: 'assistant', content: 'Reading files' },
      ]);
    } finally {
      activeChatsStore.removeChat(id);
    }
  });

  /**
   * #2304: a client that attached to a turn already running never saw its
   * `turn.started` live, so the bounded window is the only place the turn's
   * server start exists. The window's start is from 2026-08-09, far from this
   * test's clock, so a seed from the local clock cannot pass.
   */
  test("seeds the open turn's server start from the window when no live turn.started stamped it", async () => {
    const id = 'thread-1';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Attached mid-turn',
      orchestrationSessionStarted: true,
    });
    try {
      activeChatsStore.updateChat(id, { orchestrationTurnOpen: true });
      const started = event('e3', 'turn.started', {
        turnId: 'turn-2',
        prompt: 'still running',
      });
      fetchWindow.mockResolvedValue({
        protocolVersion: 1,
        watermark: 4,
        hasMore: false,
        events: [
          event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'Q1' }),
          event('e2', 'turn.completed', { turnId: 'turn-1', outputText: 'A1' }),
          started,
          event('e4', 'content.text-delta', { turnId: 'turn-2', delta: 'x' }),
        ],
      });
      const session = {
        ...baseSession,
        ...activeChatsStore.getSnapshot()[id],
        id,
      } as unknown as ChatSession;
      const view = renderHook(() =>
        useActiveChatTranscript('http://station.test', session),
      );
      await waitFor(() =>
        expect(activeChatsStore.getSnapshot()[id]?.openTurnStartedAt).toBe(
          Date.parse(started.event.createdAt),
        ),
      );
      view.unmount();
    } finally {
      activeChatsStore.removeChat(id);
    }
  });

  test('does not seed a start from a window whose newest turn already ended', async () => {
    const id = 'thread-1';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Stale fold',
      orchestrationSessionStarted: true,
    });
    try {
      activeChatsStore.updateChat(id, { orchestrationTurnOpen: true });
      fetchWindow.mockResolvedValue({
        protocolVersion: 1,
        watermark: 2,
        hasMore: false,
        events: [
          event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'Q1' }),
          event('e2', 'turn.completed', { turnId: 'turn-1', outputText: 'A1' }),
        ],
      });
      const session = {
        ...baseSession,
        ...activeChatsStore.getSnapshot()[id],
        id,
      } as unknown as ChatSession;
      const view = renderHook(() =>
        useActiveChatTranscript('http://station.test', session),
      );
      await waitFor(() => expect(view.result.current.settled).toBe(true));
      expect(
        activeChatsStore.getSnapshot()[id]?.openTurnStartedAt,
      ).toBeUndefined();
      view.unmount();
    } finally {
      activeChatsStore.removeChat(id);
    }
  });

  /**
   * #2304 M1: the SENDER's prompt is the composer's optimistic row, stamped by
   * `buildOutgoingUserMessage` from this client's clock. With that clock 5s
   * ahead of the server, keeping its own timestamp sorted the prompt below
   * the activity its own turn produced, even in the canonical row's slot.
   */
  test("the sender's optimistic prompt stays above its activity when this clock runs ahead of the server", async () => {
    const id = 'thread-1';
    const serverStart = '2026-08-09T00:00:03.000Z';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Skewed sender',
      orchestrationSessionStarted: true,
    });
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(serverStart) + 5_000);
    const outgoing = buildOutgoingUserMessage([], 'why did you stop?');
    now.mockRestore();
    try {
      expect(outgoing.messages[0]?.timestamp).toBe(
        Date.parse(serverStart) + 5_000,
      );
      activeChatsStore.updateChat(id, {
        messages: outgoing.messages,
        pendingClientTurnId: 'client-turn',
        status: 'sending',
      });
      const started = event('e3', 'turn.started', {
        turnId: 'turn-2',
        prompt: 'why did you stop?',
      });
      handleTurnStartedEvent(
        started.event as Parameters<typeof handleTurnStartedEvent>[0],
      );
      activeChatsStore.updateChat(id, { openTurnShellSuperseded: true });
      fetchWindow.mockResolvedValue({
        protocolVersion: 1,
        watermark: 4,
        hasMore: false,
        events: [
          event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'Q1' }),
          event('e2', 'turn.completed', { turnId: 'turn-1', outputText: 'A1' }),
          started,
          event('e4', 'content.text-delta', {
            turnId: 'turn-2',
            delta: 'Reading files',
          }),
        ],
      });
      const session = {
        ...baseSession,
        ...activeChatsStore.getSnapshot()[id],
        id,
      } as unknown as ChatSession;
      const { result } = renderHook(() =>
        useActiveChatTranscript('http://station.test', session),
      );
      await waitFor(() =>
        expect(
          result.current.messages.some(
            (message) => message.content === 'Reading files',
          ),
        ).toBe(true),
      );
      expect(
        result.current.messages.map((message) => [message.id, message.content]),
      ).toEqual([
        ['e1:user', 'Q1'],
        ['e1:assistant', 'A1'],
        [outgoing.clientId, 'why did you stop?'],
        ['e3:assistant', 'Reading files'],
      ]);
    } finally {
      activeChatsStore.removeChat(id);
    }
  });

  /**
   * #2304 delta MEDIUM. Before `turn.started` the pending prompt is matched
   * to a projected row by CONTENT, which can be an older turn that sent the
   * same text. That row's time is not this prompt's: taking it rendered a
   * fresh "continue" at the top of the transcript.
   */
  test("a pending prompt matched only by content keeps its own time, not an older identical prompt's", async () => {
    const id = 'thread-1';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Repeat prompt',
      orchestrationSessionStarted: true,
    });
    const sendAt = Date.parse('2026-08-09T01:00:00.000Z');
    try {
      activeChatsStore.updateChat(id, {
        messages: [
          {
            role: 'user',
            content: 'continue',
            clientId: 'pending-continue',
            timestamp: sendAt,
          },
        ],
        pendingClientTurnId: 'client-turn-2',
        status: 'sending',
      });
      fetchWindow.mockResolvedValue({
        protocolVersion: 1,
        watermark: 5,
        hasMore: false,
        events: [
          event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'continue' }),
          event('e3', 'turn.completed', {
            turnId: 'turn-1',
            outputText: 'Old answer',
          }),
          event('e4', 'turn.started', { turnId: 'turn-x', prompt: 'other' }),
          event('e5', 'turn.completed', {
            turnId: 'turn-x',
            outputText: 'Other answer',
          }),
        ],
      });
      const session = {
        ...baseSession,
        ...activeChatsStore.getSnapshot()[id],
        id,
      } as unknown as ChatSession;
      const { result } = renderHook(() =>
        useActiveChatTranscript('http://station.test', session),
      );
      await waitFor(() =>
        expect(
          result.current.messages.some(
            (message) => message.content === 'Other answer',
          ),
        ).toBe(true),
      );
      const last = result.current.messages.at(-1);
      expect(last).toMatchObject({
        id: 'pending-continue',
        content: 'continue',
        timestamp: sendAt,
      });
    } finally {
      activeChatsStore.removeChat(id);
    }
  });

  /**
   * #2304 round 4, MEDIUM 2. Two local unstamped "continue" sends (both
   * `turn.started` lost in gaps): only the CURRENT one may claim the open
   * turn's prompt row. An older one used to take it, hiding its own older
   * prompt and leaving the current send below its activity.
   */
  test("only the current pending send claims the open turn's prompt row", async () => {
    const id = 'thread-1';
    activeChatsStore.initChat(id, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Two continues',
      orchestrationSessionStarted: true,
    });
    try {
      activeChatsStore.updateChat(id, {
        messages: [
          {
            role: 'user',
            content: 'continue',
            clientId: 'older-continue',
            timestamp: Date.parse('2026-08-09T00:00:03.500Z'),
          },
          {
            role: 'assistant',
            content: 'A2',
            timestamp: Date.parse('2026-08-09T00:00:04.000Z'),
          },
          {
            role: 'user',
            content: 'continue',
            clientId: 'current-continue',
            timestamp: Date.parse('2026-08-09T00:00:09.000Z'),
          },
        ],
        status: 'sending',
        orchestrationTurnOpen: true,
        openTurnShellSuperseded: true,
      });
      fetchWindow.mockResolvedValue({
        protocolVersion: 1,
        watermark: 6,
        hasMore: false,
        events: [
          event('e3', 'turn.started', { turnId: 'turn-2', prompt: 'continue' }),
          event('e4', 'turn.completed', { turnId: 'turn-2', outputText: 'A2' }),
          event('e5', 'turn.started', { turnId: 'turn-3', prompt: 'continue' }),
          event('e6', 'content.text-delta', {
            turnId: 'turn-3',
            delta: 'turn3 work',
          }),
        ],
      });
      const session = {
        ...baseSession,
        ...activeChatsStore.getSnapshot()[id],
        id,
      } as unknown as ChatSession;
      const { result } = renderHook(() =>
        useActiveChatTranscript('http://station.test', session),
      );
      await waitFor(() =>
        expect(
          result.current.messages.some(
            (message) => message.content === 'turn3 work',
          ),
        ).toBe(true),
      );
      expect(
        result.current.messages.map((message) => [message.id, message.content]),
      ).toEqual([
        ['e3:user', 'continue'],
        ['e3:assistant', 'A2'],
        ['current-continue', 'continue'],
        ['e5:assistant', 'turn3 work'],
      ]);
    } finally {
      activeChatsStore.removeChat(id);
    }
  });

  describe('#2304 seeding guards', () => {
    const id = 'thread-1';
    const started = (turnId: string, fields = {}) =>
      event('e3', 'turn.started', { turnId, prompt: 'running', ...fields });

    async function seedFrom(
      events: unknown[],
      chatPatch: Record<string, unknown> = {},
      sessionPatch: Record<string, unknown> = {},
    ) {
      activeChatsStore.initChat(id, {
        agentSlug: 'codex',
        agentName: 'Codex',
        title: 'Seed guard',
        orchestrationSessionStarted: true,
      });
      activeChatsStore.updateChat(id, {
        orchestrationTurnOpen: true,
        ...chatPatch,
      });
      fetchWindow.mockResolvedValue({
        protocolVersion: 1,
        watermark: 9,
        hasMore: false,
        events,
      });
      const session = {
        ...baseSession,
        ...activeChatsStore.getSnapshot()[id],
        id,
        ...sessionPatch,
      } as unknown as ChatSession;
      const view = renderHook(() =>
        useActiveChatTranscript('http://station.test', session),
      );
      await waitFor(() => expect(view.result.current.settled).toBe(true));
      await waitFor(() => expect(fetchWindow).toHaveBeenCalled());
      const value = activeChatsStore.getSnapshot()[id]?.openTurnStartedAt;
      view.unmount();
      activeChatsStore.removeChat(id);
      return value;
    }

    test('baseline: an open turn in the window seeds its start', async () => {
      expect(await seedFrom([started('turn-2')])).toBe(
        Date.parse(started('turn-2').event.createdAt),
      );
    });

    test("a window whose open turn is not the fold's openTurnId does not seed", async () => {
      expect(
        await seedFrom([started('turn-2')], { openTurnId: 'turn-9' }),
      ).toBeUndefined();
    });

    test('a turn.started for another execution session does not seed', async () => {
      expect(
        await seedFrom([started('turn-2', { threadId: 'other-thread' })]),
      ).toBeUndefined();
    });

    test('a steer is more input on the open turn, not its start', async () => {
      const steer = event('e5', 'turn.started', {
        turnId: 'turn-2',
        inputKind: 'steer',
        prompt: 'also this',
      });
      expect(await seedFrom([started('turn-2'), steer])).toBe(
        Date.parse(started('turn-2').event.createdAt),
      );
      expect(await seedFrom([steer])).toBeUndefined();
    });

    test('an interrupted-turn boundary ends the open turn', async () => {
      expect(
        await seedFrom([
          started('turn-2'),
          event('e6', 'session.state-changed', {
            interruptedTurnBoundary: { boundaryId: 'boundary-1' },
          }),
        ]),
      ).toBeUndefined();
    });

    test("a live stamp that landed after this render's props wins over the window", async () => {
      const live = Date.parse('2026-09-22T12:00:00.000Z');
      // The store already holds the live `turn.started` stamp; the props this
      // render was given predate it.
      expect(
        await seedFrom(
          [started('turn-2')],
          { openTurnStartedAt: live },
          { openTurnStartedAt: undefined },
        ),
      ).toBe(live);
    });

    test("a replay never seeds: its clock is the tape's elapsed time", async () => {
      const { registerReplayThread, unregisterReplayThread } = await import(
        '../hooks/orchestration/replay/replay-registry'
      );
      const { EMPTY_REPLAY_HISTORY, setReplayHistory } = await import(
        '../hooks/orchestration/replay/history'
      );
      const replayId = registerReplayThread();
      activeChatsStore.initChat(replayId, {
        agentSlug: 'codex',
        agentName: 'Codex',
        title: 'Replay',
        orchestrationSessionStarted: true,
        replay: { sourceThreadId: 'thread-1', tapeEventCount: 1 },
      });
      activeChatsStore.updateChat(replayId, { orchestrationTurnOpen: true });
      // The replay's history, as the player publishes it: the tape's events
      // re-addressed to the replay thread. It shows an open turn, exactly
      // what a live reader would seed from.
      const replayStart = started('turn-2', { threadId: replayId });
      setReplayHistory(replayId, {
        ...EMPTY_REPLAY_HISTORY,
        settled: true,
        events: [replayStart] as typeof EMPTY_REPLAY_HISTORY.events,
      });
      try {
        const view = renderHook(() =>
          useActiveChatTranscript('', {
            ...baseSession,
            ...activeChatsStore.getSnapshot()[replayId],
            id: replayId,
          } as unknown as ChatSession),
        );
        // The replay reader is live (it projects the replay history) ...
        await waitFor(() =>
          expect(
            view.result.current.messages.some(
              (message) => message.content === 'running',
            ),
          ).toBe(true),
        );
        expect(view.result.current.enabled).toBe(true);
        // ... and still does not seed a start.
        expect(
          activeChatsStore.getSnapshot()[replayId]?.openTurnStartedAt,
        ).toBeUndefined();
        view.unmount();
      } finally {
        setReplayHistory(replayId, null);
        activeChatsStore.removeChat(replayId);
        unregisterReplayThread(replayId);
      }
    });

    test('a turn.started for this turn stamps from the server; a steer does not move it', () => {
      activeChatsStore.initChat(id, {
        agentSlug: 'codex',
        agentName: 'Codex',
        title: 'Steer',
      });
      try {
        handleTurnStartedEvent(
          started('turn-2').event as Parameters<
            typeof handleTurnStartedEvent
          >[0],
        );
        handleTurnStartedEvent(
          event('e5', 'turn.started', {
            turnId: 'turn-2',
            inputKind: 'steer',
            prompt: 'also this',
          }).event as Parameters<typeof handleTurnStartedEvent>[0],
        );
        expect(activeChatsStore.getSnapshot()[id]?.openTurnStartedAt).toBe(
          Date.parse(started('turn-2').event.createdAt),
        );
      } finally {
        activeChatsStore.removeChat(id);
      }
    });
  });

  test('keeps historical canonical users in place while only the current optimistic prompt owns the live row', async () => {
    fetchWindow
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 2,
        hasMore: false,
        events: [
          event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'Q1' }),
          event('e2', 'turn.completed', {
            turnId: 'turn-1',
            outputText: 'A1',
          }),
        ],
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 4,
        hasMore: false,
        events: [
          event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'Q1' }),
          event('e2', 'turn.completed', {
            turnId: 'turn-1',
            outputText: 'A1',
          }),
          event('e3', 'turn.started', { turnId: 'turn-2', prompt: 'Q2' }),
          event('e4', 'turn.completed', {
            turnId: 'turn-2',
            outputText: 'A2',
          }),
        ],
      });
    const activeSession: ChatSession = {
      ...baseSession,
      status: 'sending',
      orchestrationTurnOpen: true,
      openTurnId: 'turn-2',
      messages: [
        { role: 'user', content: 'Q1', clientId: 'client-1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2', clientId: 'client-2' },
      ],
    };
    const { result, rerender } = renderHook(
      ({ session }) => useActiveChatTranscript('http://station.test', session),
      { initialProps: { session: activeSession } },
    );

    await waitFor(() =>
      expect(result.current.messages.map((message) => message.content)).toEqual(
        ['Q1', 'A1', 'Q2'],
      ),
    );
    expect(result.current.messages.map((message) => message.id)).toEqual([
      'e1:user',
      'e1:assistant',
      'client-2',
    ]);

    rerender({
      session: {
        ...activeSession,
        status: 'idle',
        orchestrationTurnOpen: false,
        orchestrationHistoryRevision: 1,
      },
    });
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.content)).toEqual(
        ['Q1', 'A1', 'Q2', 'A2'],
      ),
    );
    expect(result.current.messages.map((message) => message.id)).toEqual([
      'e1:user',
      'e1:assistant',
      'e3:user',
      'e3:assistant',
    ]);
  });

  test('retains the event displaced from a sliding newest window after older pages were loaded', async () => {
    const turns = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, offset) => {
        const turn = from + offset;
        return event(`e${turn}`, 'turn.started', {
          turnId: `turn-${turn}`,
          prompt: `Q${turn}`,
        });
      });
    fetchWindow
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 101,
        hasMore: true,
        nextCursor: 'older-90',
        events: turns(91, 100),
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 101,
        hasMore: false,
        events: turns(71, 90),
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 102,
        hasMore: true,
        nextCursor: 'ignored-newest-cursor',
        events: turns(92, 101),
      });
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useActiveChatTranscript('http://station.test', {
          ...baseSession,
          orchestrationHistoryRevision: revision,
        }),
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => result.current.loadOlder());
    expect(result.current.messages).toHaveLength(30);

    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.messages).toHaveLength(31));
    expect(result.current.messages.map((message) => message.content)).toEqual(
      Array.from({ length: 31 }, (_, index) => `Q${index + 71}`),
    );
    expect(
      new Set(result.current.messages.map((message) => message.id)).size,
    ).toBe(31);
    expect(result.current.hasMore).toBe(false);
  });

  test('retains loaded older pages and ignores a stale terminal refresh', async () => {
    let resolveStale: ((page: Record<string, unknown>) => void) | undefined;
    let resolveLatest: ((page: Record<string, unknown>) => void) | undefined;
    fetchWindow
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 6,
        hasMore: true,
        nextCursor: 'older',
        events: [event('e5', 'turn.started', { turnId: 'new', prompt: 'new' })],
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 6,
        hasMore: false,
        events: [event('e1', 'turn.started', { turnId: 'old', prompt: 'old' })],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLatest = resolve;
          }),
      );
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useActiveChatTranscript('http://station.test', {
          ...baseSession,
          orchestrationHistoryRevision: revision,
        }),
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => result.current.loadOlder());
    expect(result.current.messages.map((message) => message.content)).toEqual([
      'old',
      'new',
    ]);

    rerender({ revision: 1 });
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(3));
    rerender({ revision: 2 });
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(4));
    resolveLatest?.({
      protocolVersion: 1,
      watermark: 8,
      hasMore: true,
      nextCursor: 'ignored-newest-cursor',
      events: [
        event('e7', 'turn.started', { turnId: 'latest', prompt: 'latest' }),
      ],
    });
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.content)).toEqual(
        ['old', 'new', 'latest'],
      ),
    );
    resolveStale?.({
      protocolVersion: 1,
      watermark: 7,
      hasMore: false,
      events: [
        event('e6', 'turn.started', { turnId: 'stale', prompt: 'stale' }),
      ],
    });
    await act(async () => Promise.resolve());
    expect(result.current.messages.map((message) => message.content)).toEqual([
      'old',
      'new',
      'latest',
    ]);
    expect(result.current.hasMore).toBe(false);
  });

  test('projects same-timestamp high-fanout events in authoritative sequence order', async () => {
    const createdAt = '2026-08-09T00:00:00.000Z';
    const sequenced = [
      event('anchor', 'turn.started', {
        turnId: 'fanout',
        prompt: 'fanout prompt',
        createdAt,
      }),
      ...Array.from({ length: 150 }, (_, index) => ({
        sequence: index + 2,
        event: {
          eventId: `delta-${index}`,
          method: 'content.text-delta',
          provider: 'codex',
          threadId: 'thread-1',
          turnId: 'fanout',
          itemId: 'text',
          createdAt,
          delta: String.fromCharCode(65 + (index % 26)),
        },
      })),
      {
        sequence: 152,
        event: {
          eventId: 'terminal',
          method: 'turn.completed',
          provider: 'codex',
          threadId: 'thread-1',
          turnId: 'fanout',
          createdAt,
        },
      },
    ];
    sequenced[0]!.sequence = 1;
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 152,
      hasMore: false,
      events: [...sequenced].reverse(),
    });
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', baseSession),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    expect(result.current.messages[0]?.id).toBe('anchor:user');
    expect(result.current.messages[1]?.id).toBe('anchor:assistant');
    expect(result.current.messages[1]?.content).toBe(
      Array.from({ length: 150 }, (_, index) =>
        String.fromCharCode(65 + (index % 26)),
      ).join(''),
    );
  });

  test('reconciles the newest page once when an authoritative revision changes', async () => {
    fetchWindow
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 1,
        hasMore: false,
        events: [],
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 2,
        hasMore: false,
        events: [],
      });
    const { rerender } = renderHook(
      ({ revision }) =>
        useActiveChatTranscript('http://station.test', {
          ...baseSession,
          orchestrationHistoryRevision: revision,
        }),
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));

    rerender({ revision: 1 });
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
    rerender({ revision: 1 });
    await act(async () => Promise.resolve());
    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  test('does not expose the prior session checkpoint summary during a session switch', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        event('e1', 'turn.started', { turnId: 'shared-turn', prompt: 'Q' }),
        event('e2', 'turn.completed', {
          turnId: 'shared-turn',
          outputText: 'A',
        }),
      ],
    });
    let resolveSecond: ((value: Response) => void) | undefined;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                turnId: 'shared-turn',
                changedFiles: {
                  status: 'available',
                  files: [{ status: 'modified', path: 'from-a.ts' }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(
      ({ session }) => useActiveChatTranscript('http://station.test', session),
      { initialProps: { session: baseSession } },
    );
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.changedFiles).toMatchObject({
        status: 'available',
      }),
    );

    rerender({ session: { ...baseSession, id: 'thread-2' } });
    expect(result.current.messages.at(-1)?.changedFiles).toBeUndefined();
    await act(async () => {
      resolveSecond?.(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });
    vi.unstubAllGlobals();
  });

  test('decorates a retained live answer after transcript merging', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        event('e1', 'turn.started', { turnId: 'retained-turn', prompt: 'Q' }),
        event('e2', 'turn.completed', {
          turnId: 'retained-turn',
          outputText: 'A',
        }),
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                turnId: 'retained-turn',
                changedFiles: {
                  status: 'available',
                  files: [{ status: 'modified', path: 'src/app.ts' }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', {
        ...baseSession,
        messages: [
          {
            id: 'retained-answer',
            role: 'assistant',
            content: 'A',
            turnId: 'retained-turn',
          },
        ],
      } as ChatSession),
    );

    await waitFor(() =>
      expect(result.current.messages.at(-1)?.changedFiles).toMatchObject({
        files: [{ path: 'src/app.ts' }],
      }),
    );
  });
});

// the live failure card is an ordinary
// `role: 'user'` row with no clientId, so the bounded projection dropped it —
// and the streaming shell it was written beside is suppressed by the same
// `status: 'error'` update. A session killed mid-turn therefore rendered its
// prompt and nothing else.
describe('useActiveChatTranscript live failure marker (UX audit V3)', () => {
  beforeEach(() => {
    resetSequencedLiveEventsForTests();
    vi.clearAllMocks();
    fetchWindow.mockReset();
    recoveryBudget.clear();
    fetchCapability.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const marker = {
    role: 'user' as const,
    content:
      '[SYSTEM_EVENT] [CHAT_ERROR] Claude Code process terminated by signal SIGKILL',
    timestamp: 5,
  };

  test('retains the live [CHAT_ERROR] marker the bounded projection cannot recreate', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 9,
      hasMore: false,
      events: [
        event('e1', 'turn.started', {
          turnId: 'killed-turn',
          prompt: 'print every integer',
        }),
      ],
    });

    const session: ChatSession = {
      ...baseSession,
      messages: [marker] as ChatSession['messages'],
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );
    await waitFor(() => expect(result.current.messages.length).toBe(2));

    expect(
      result.current.messages.some((message) =>
        (message.content ?? '').includes('SIGKILL'),
      ),
    ).toBe(true);
  });

  // dedupe was global text matching, so a
  // second turn failing the same way had its card suppressed by the FIRST
  // turn's projected row. Turn identity is what decides.
  test('keeps a second turn failure the projection renders only for the first turn', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 9,
      hasMore: false,
      events: [
        event('e1', 'turn.started', { turnId: 'turn-1', prompt: 'first' }),
        event('e2', 'runtime.error', {
          turnId: 'turn-1',
          severity: 'error',
          message: 'Claude Code process terminated by signal SIGKILL',
        }),
        event('e3', 'turn.started', { turnId: 'turn-2', prompt: 'second' }),
      ],
    });

    const session: ChatSession = {
      ...baseSession,
      messages: [
        {
          role: 'user' as const,
          content:
            '[SYSTEM_EVENT] [CHAT_ERROR] Claude Code process terminated by signal SIGKILL',
          timestamp: 9,
          turnId: 'turn-2',
        },
      ] as ChatSession['messages'],
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );
    await waitFor(() =>
      expect(result.current.messages.length).toBeGreaterThan(1),
    );

    expect(
      result.current.messages.some(
        (message) =>
          (message.content ?? '').startsWith('[SYSTEM_EVENT] [CHAT_ERROR') &&
          message.turnId === 'turn-2',
      ),
    ).toBe(true);
  });

  test('does not double a failure the projection already renders', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 9,
      hasMore: false,
      events: [
        event('e1', 'turn.started', {
          turnId: 'killed-turn',
          prompt: 'print every integer',
        }),
        event('e2', 'runtime.error', {
          turnId: 'killed-turn',
          severity: 'error',
          message: 'Claude Code process terminated by signal SIGKILL',
        }),
      ],
    });

    const session: ChatSession = {
      ...baseSession,
      messages: [marker] as ChatSession['messages'],
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );
    await waitFor(() =>
      expect(result.current.messages.length).toBeGreaterThan(0),
    );

    const carriers = result.current.messages.filter((message) =>
      [
        message.content ?? '',
        ...(message.contentParts ?? []).map((part) => part.content ?? ''),
      ]
        .join('\n')
        .includes('SIGKILL'),
    );
    expect(carriers).toHaveLength(1);
  });

  // #765 A1: when BOTH copies of the same turn's failure exist, the element
  // with the affordance wins. The local `[CHAT_ERROR:code]` marker renders
  // as the translated card with a Send again/New chat action
  // (`ChatDockBody.renderOverride`); the projected `runtimeError` part is
  // untranslatable prose. The pre-#765 arbitration kept the projected part
  // and hid the marker — the audit's raw
  // "No conversation found with session ID: <uuid>" with no retry.
  test('the actionable marker wins over the projected failure part for the same turn', async () => {
    const rawError =
      'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab';
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 9,
      hasMore: false,
      events: [
        event('e1', 'turn.started', {
          turnId: 'dead-turn',
          prompt: 'second turn please',
        }),
        event('e2', 'content.text-delta', {
          turnId: 'dead-turn',
          delta: 'partial words before dying',
        }),
        event('e3', 'runtime.error', {
          turnId: 'dead-turn',
          severity: 'error',
          code: 'engine-session-binding-dead',
          message: rawError,
        }),
      ],
    });

    const session: ChatSession = {
      ...baseSession,
      messages: [
        {
          role: 'user' as const,
          content: `[SYSTEM_EVENT] [CHAT_ERROR:engine-session-binding-dead] ${rawError}`,
          timestamp: 9,
          turnId: 'dead-turn',
        },
      ] as ChatSession['messages'],
    };
    const { result } = renderHook(() =>
      useActiveChatTranscript('http://station.test', session),
    );
    await waitFor(() =>
      expect(result.current.messages.length).toBeGreaterThan(1),
    );

    // Exactly one element carries the failure, and it is the marker card.
    const carriers = result.current.messages.filter((message) =>
      [
        message.content ?? '',
        ...(message.contentParts ?? []).map((part) => part.content ?? ''),
      ]
        .join('\n')
        .includes('No conversation found'),
    );
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.content ?? '').toContain(
      '[CHAT_ERROR:engine-session-binding-dead]',
    );
    // The projected assistant row keeps its REAL streamed content — only the
    // failure part was stripped, not the turn's words.
    expect(
      result.current.messages.some((message) =>
        (message.contentParts ?? []).some(
          (part) => part.content === 'partial words before dying',
        ),
      ),
    ).toBe(true);
  });
});
