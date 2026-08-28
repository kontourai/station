/**
 * @vitest-environment jsdom
 *
 * archive#3352 — end-to-end proof that text which streamed while the client
 * was disconnected actually becomes VISIBLE again after the reconnect, rather
 * than merely that some counter moved.
 *
 * Everything between the reconnect frame and the rendered transcript is the
 * real thing: the real `activeChatsStore`, the real live-event handlers that
 * build the pre-drop streaming shell, the real `applyOrchestrationSnapshot`,
 * the real `useDerivedSessions` derivation the dock reads through, and the
 * real `useActiveChatTranscript` projection. Only the SDK's window fetch (the
 * server) and `rehydrateChatSession` (a /messages read this path never
 * performs for a Station-owned thread) are stubbed.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchCapability = vi.fn();
const fetchWindow = vi.fn();
const fetchLegacyWindow = vi.fn();

/**
 * archive#3967. `fetchWindow` used to stand for the ONE window read. #3843's
 * conversation handoff made `fetchOrchestrationConversationEventWindow` the
 * primary route and demoted the session window to a 404-only fallback for a
 * channel server too old to advertise it (`useSessionEventWindow.ts:55-78`).
 *
 * This factory mock listed only the fallback, and a factory mock makes every
 * unlisted export a hard throw — so the hook threw before reading anything,
 * `fetchWindow` was called zero times, and all three cases failed with an
 * empty DOM. Fifth instance of that hazard in this repo (b6388fa56,
 * ProjectSidebar in fbbdf6738, then three more in archive#3895).
 *
 * `fetchWindow` now drives the CURRENT primary route, so these cases keep
 * testing what they were written for — a reconnect gap ends with the missed text on
 * screen — against the path production actually takes.
 */
vi.mock('@kontourai/station-sdk', () => ({
  fetchSessionEventWindowCapability: (...args: unknown[]) =>
    fetchCapability(...args),
  claimSessionEventWindowCapabilityRecovery: () => false,
  fetchOrchestrationConversationEventWindow: (...args: unknown[]) =>
    fetchWindow(...args),
  // The legacy fallback. Reached only when the conversation route 404s, which
  // no case here provokes; wired so an accidental fallback is visible as a
  // call on this spy rather than as an unlisted-export throw.
  fetchOrchestrationSessionEventWindow: (...args: unknown[]) =>
    fetchLegacyWindow(...args),
  resetSessionEventWindowCapabilityRecovery: vi.fn(),
  resetSessionEventWindowCapabilityCache: vi.fn(),
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS: 30_000,
  SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS: 60_000,
}));

const STABLE_AGENTS = [{ slug: 'agent-one', name: 'Agent One' }];
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => STABLE_AGENTS,
}));

vi.mock('../hooks/orchestration/rehydrateChatSession', () => ({
  rehydrateChatSession: vi.fn().mockResolvedValue(undefined),
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { applyOrchestrationSnapshot } from '../hooks/orchestration/snapshotHandlers';
import { handleTextDeltaEvent } from '../hooks/orchestration/streamHandlers';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import { useDerivedSessions } from '../hooks/useDerivedSessions';

const API = 'http://station.test';
const THREAD = 'thread-1';
const TURN = 'open-turn';

const event = (sequence: number, method: string, fields = {}) => ({
  sequence,
  event: {
    eventId: `e${sequence}`,
    method,
    provider: 'claude',
    threadId: THREAD,
    createdAt: `2026-08-19T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    ...fields,
  },
});

function clearChats() {
  for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(sessionId);
  }
}

/** The dock's own read path: derived session in, bounded transcript out. */
function useDockTranscript() {
  const sessions = useDerivedSessions('', null, null);
  const session = sessions.find((candidate) => candidate.id === THREAD)!;
  return useActiveChatTranscript(API, session);
}

/**
 * Brings the store to the state a client is in at the instant its stream
 * dies mid-turn: an orchestration session with an open turn whose streaming
 * shell holds only the tokens that arrived before the drop.
 */
function streamUntilTheDrop() {
  activeChatsStore.initChat(THREAD, {
    agentSlug: 'agent-one',
    agentName: 'Agent One',
    title: 'Session',
  });
  activeChatsStore.updateChat(THREAD, {
    provider: 'claude',
    orchestrationSessionStarted: true,
    orchestrationStatus: 'running',
  });
  handleTurnStartedEvent({
    method: 'turn.started',
    threadId: THREAD,
    turnId: TURN,
    createdAt: '2026-08-19T00:00:02.000Z',
  } as never);
  handleTextDeltaEvent({
    method: 'content.text-delta',
    threadId: THREAD,
    turnId: TURN,
    itemId: 'text',
    delta: 'Before the drop. ',
    createdAt: '2026-08-19T00:00:03.000Z',
  } as never);
}

function reconnectFallbackSnapshot(hasActiveTurn: boolean) {
  applyOrchestrationSnapshot(
    {
      sessions: [
        {
          provider: 'claude',
          threadId: THREAD,
          status: hasActiveTurn ? 'running' : 'idle',
          hasActiveTurn,
        },
      ],
    },
    { apiBase: API, isReconnectFallback: true },
  );
}

describe('station#3352: a reconnect gap ends with the missed text on screen', () => {
  beforeEach(() => {
    fetchCapability.mockReset().mockResolvedValue(true);
    fetchWindow.mockReset();
    clearChats();
  });

  afterEach(() => {
    cleanup();
    clearChats();
  });

  test('a turn still open at reconnect shows the text that streamed during the gap', async () => {
    // The window as the dock first read it: the turn had not started yet, so
    // the client's only copy of this turn is its local streaming shell.
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [],
    });
    // What the server holds after the gap — the pre-drop tokens the client
    // already has, plus the ones it never received.
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 5,
      hasMore: false,
      events: [
        event(2, 'turn.started', { turnId: TURN, prompt: 'Tell me a story' }),
        event(4, 'content.text-delta', {
          turnId: TURN,
          itemId: 'text',
          delta: 'Before the drop. AND DURING THE GAP.',
        }),
      ],
    });

    streamUntilTheDrop();
    const { result } = renderHook(() => useDockTranscript());
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
    expect(
      result.current.messages.map((message) => message.content),
    ).not.toContain('Before the drop. AND DURING THE GAP.');

    await act(async () => {
      reconnectFallbackSnapshot(true);
    });
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));

    const assistantContent = await waitFor(() => {
      const found = result.current.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(assistantContent[0]).toBe('Before the drop. AND DURING THE GAP.');

    // The other half of "shown once": the local shell that held the pre-drop
    // half is gone, so nothing renders that prefix a second time beside the
    // projected copy. The turn is still open, so the session keeps reporting
    // itself as streaming and the next delta rebuilds the shell.
    const chat = activeChatsStore.getSnapshot()[THREAD];
    expect(chat?.streamingMessage).toBeUndefined();
    expect(chat?.orchestrationTurnOpen).toBe(true);
    expect(chat?.status).toBe('sending');
  });

  // The handover is scoped to the turn that was mid-flight when the stream
  // died. The NEXT turn's shell holds every one of its tokens, so it must own
  // its own rendering again — otherwise the projection would render it
  // alongside the shell, which is the double-render the suppression exists to
  // prevent. (What a cleared flag then does to the transcript is covered by
  // useActiveChatTranscript.test.tsx's open-turn suppression test; only a
  // reload can put a turn's text in the window, and nothing reloads between
  // `turn.started` and that turn's terminal event, so this half is asserted
  // on the state the filter reads.)
  test('the next turn takes its rendering back from the projection', async () => {
    fetchWindow.mockResolvedValue({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [],
    });

    streamUntilTheDrop();
    renderHook(() => useDockTranscript());
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));

    await act(async () => {
      reconnectFallbackSnapshot(true);
    });
    expect(
      activeChatsStore.getSnapshot()[THREAD]?.openTurnShellSuperseded,
    ).toBe(true);

    await act(async () => {
      handleTurnStartedEvent({
        method: 'turn.started',
        threadId: THREAD,
        turnId: 'the-next-turn',
        createdAt: '2026-08-19T00:00:09.000Z',
      } as never);
    });

    expect(
      activeChatsStore.getSnapshot()[THREAD]?.openTurnShellSuperseded,
    ).toBe(false);
  });

  test('a turn that COMPLETED during the gap shows its answer instead of leaving the prompt unanswered', async () => {
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [],
    });
    // The turn ran to completion while the client was away. Nothing will ever
    // deliver its `turn.completed` — the snapshot branch of the events route
    // replays no events at all — so this REST page is the only route by which
    // the answer can reach the screen.
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 6,
      hasMore: false,
      events: [
        event(2, 'turn.started', { turnId: TURN, prompt: 'What is 2 + 2?' }),
        event(5, 'turn.completed', {
          turnId: TURN,
          outputText: 'THE ANSWER IS FOUR.',
        }),
      ],
    });

    streamUntilTheDrop();
    const { result } = renderHook(() => useDockTranscript());
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));

    await act(async () => {
      reconnectFallbackSnapshot(false);
    });
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));

    await waitFor(() =>
      expect(
        result.current.messages.map((message) => message.content),
      ).toContain('THE ANSWER IS FOUR.'),
    );
    expect(
      result.current.messages.filter(
        (message) => message.content === 'THE ANSWER IS FOUR.',
      ),
    ).toHaveLength(1);
  });
});
