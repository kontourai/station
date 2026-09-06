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

vi.mock('@kontourai/station-sdk', () => ({
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

import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';

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
  beforeEach(() => {
    vi.clearAllMocks();
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
    ]);
    expect(result.current.messages[0]?.id).toBe('e3:user');

    await act(async () => result.current.loadOlder());
    expect(result.current.messages.map((message) => message.content)).toEqual([
      'older question',
      'older answer',
      'current question',
    ]);
    expect(fetchWindow).toHaveBeenNthCalledWith(
      2,
      'thread-1',
      'http://station.test',
      { cursor: 'older', turnLimit: 20 },
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
          output: 'done',
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
});

// the live failure card is an ordinary
// `role: 'user'` row with no clientId, so the bounded projection dropped it —
// and the streaming shell it was written beside is suppressed by the same
// `status: 'error'` update. A session killed mid-turn therefore rendered its
// prompt and nothing else.
describe('useActiveChatTranscript live failure marker (UX audit V3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
