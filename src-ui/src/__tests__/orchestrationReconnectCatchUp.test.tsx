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
 * real `useActiveChatTranscript` projection. Only the SDK transport/window
 * fetch (the server) and `rehydrateChatSession` (a /messages read this path
 * never performs for a Station-owned thread) are stubbed.
 */

import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchCapability = vi.fn();
const fetchWindow = vi.fn();
const fetchLegacyWindow = vi.fn();
const streamTransport = vi.hoisted(() => ({
  onMessage: undefined as
    | ((raw: { event: string; data: string; id?: string }) => void)
    | undefined,
  onError: undefined as ((error: unknown) => void) | undefined,
  onTerminal: undefined as (() => void) | undefined,
  close: vi.fn(),
}));
const fetchCheckpoints = vi.fn(
  async (..._args: unknown[]) =>
    new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);

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
vi.mock('@kontourai/station-sdk', async () => ({
  fetchSSE: (_url: string, options: Record<string, unknown>) => {
    streamTransport.onMessage =
      options.onMessage as typeof streamTransport.onMessage;
    streamTransport.onError = options.onError as typeof streamTransport.onError;
    streamTransport.onTerminal =
      options.onTerminal as typeof streamTransport.onTerminal;
    return {
      close: streamTransport.close,
      signal: new AbortController().signal,
      completed: Promise.resolve(),
      retry: vi.fn(),
    };
  },
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
  // station#2236: the checkpoints fetch rides the SDK authenticated
  // transport. These cases never provoke it; wired to an empty envelope
  // through the real reader so an accidental call is visible as data,
  // not as an unlisted-export throw.
  getJson: (...args: unknown[]) => fetchCheckpoints(...args),
  readEnvelopeOrThrow: (await import('../../../packages/sdk/src/client/http'))
    .readEnvelopeOrThrow,
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

import { StreamingMessage } from '../components/chat/StreamingMessage';
import { activeChatsStore } from '../contexts/active-chats-store';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import { settleSemanticDeliveryBuffer } from '../hooks/orchestration/eventHandlers';
import { applyOrchestrationSnapshot } from '../hooks/orchestration/snapshotHandlers';
import { handleTextDeltaEvent } from '../hooks/orchestration/streamHandlers';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import { buildOutgoingUserMessage } from '../hooks/useActiveChatSessions.helpers';
import { useDerivedSessions } from '../hooks/useDerivedSessions';
import { deviceSettingsStore } from '../lib/device-settings-store';

const API = 'http://station.test';
const BUFFERED_RECONNECT_API = 'http://station-buffered-reconnect.test';
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
 * #2304: the dock's working clock — the real derived session and transcript
 * reader (which seeds the turn start), feeding a mounted streaming row that
 * stays mounted across the reconnect, as `ChatMessageList`'s does while the
 * turn fold stays open.
 */
function DockClock({ statusLabel }: { statusLabel?: string }) {
  const sessions = useDerivedSessions('', null, null);
  const session = sessions.find((candidate) => candidate.id === THREAD)!;
  useActiveChatTranscript(API, session);
  return (
    <StreamingMessage
      // This harness tests the clock before answer text exists. The real
      // thread's buffered text now hydrates on mount and hides the generic
      // working label once an answer is visible.
      sessionId={`${THREAD}:clock-only`}
      agentIcon={null}
      agentIconStyle={{}}
      fontSize={14}
      turnStartedAt={session.openTurnStartedAt}
      statusLabel={statusLabel}
    />
  );
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
    streamTransport.onMessage = undefined;
    streamTransport.onError = undefined;
    streamTransport.onTerminal = undefined;
    streamTransport.close.mockClear();
    clearChats();
  });

  afterEach(() => {
    streamTransport.onTerminal?.();
    cleanup();
    clearChats();
    deviceSettingsStore.reset('featureSettings');
  });

  test('a held delta reconciles through the reconnect snapshot/history exactly once', async () => {
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [],
    });
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 4,
      hasMore: false,
      events: [
        event(2, 'turn.started', { turnId: TURN, prompt: 'Reconnect' }),
        event(3, 'content.text-delta', {
          turnId: TURN,
          itemId: 'text',
          delta: 'Delivered once.',
        }),
      ],
    });

    const featureSettings = deviceSettingsStore.get('featureSettings');
    deviceSettingsStore.set('featureSettings', {
      ...featureSettings,
      smoothReveal: false,
      bufferedDelivery: true,
    });
    activeChatsStore.initChat(THREAD, {
      agentSlug: 'agent-one',
      agentName: 'Agent One',
      title: 'Session',
    });
    ensureOrchestrationEventStream(BUFFERED_RECONNECT_API);
    const send = streamTransport.onMessage!;
    const snapshot = JSON.stringify({
      sessions: [
        {
          provider: 'claude',
          threadId: THREAD,
          status: 'running',
          hasActiveTurn: true,
        },
      ],
    });
    send({ event: 'orchestration:snapshot', data: snapshot, id: '1' });
    const { result } = renderHook(() => useDockTranscript());
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));

    send({
      event: 'orchestration:event',
      id: '2',
      data: JSON.stringify({
        event: {
          method: 'session.started',
          provider: 'claude',
          threadId: THREAD,
          createdAt: '2026-08-19T00:00:02.000Z',
        },
      }),
    });
    await vi.dynamicImportSettled();
    send({
      event: 'orchestration:event',
      id: '3',
      data: JSON.stringify({
        event: {
          method: 'content.text-delta',
          provider: 'claude',
          threadId: THREAD,
          turnId: TURN,
          itemId: 'text',
          delta: 'Delivered once.',
          createdAt: '2026-08-19T00:00:03.000Z',
        },
      }),
    });
    expect(
      activeChatsStore.getSnapshot()[THREAD]?.streamingMessage,
    ).toBeUndefined();

    await act(async () => {
      streamTransport.onError?.(new Error('transient disconnect'));
      send({ event: 'orchestration:snapshot', data: snapshot, id: '4' });
    });
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        result.current.messages.filter(
          (message) => message.content === 'Delivered once.',
        ),
      ).toHaveLength(1),
    );

    // The reconnect snapshot synchronously drained the presentation buffer
    // before replacing the local shell. A second drain is therefore inert.
    settleSemanticDeliveryBuffer(BUFFERED_RECONNECT_API);
    expect(
      activeChatsStore.getSnapshot()[THREAD]?.streamingMessage,
    ).toBeUndefined();
    expect(
      result.current.messages.filter(
        (message) => message.content === 'Delivered once.',
      ),
    ).toHaveLength(1);
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

  /**
   * #2304 H1. The turn the client saw start completes inside the gap and the
   * next one starts; the fallback snapshot reseeds the fold with
   * `hasActiveTurn: true` without it ever passing through `false`. The
   * finished turn's start must not stay on the "Working for" clock — not
   * from the stale stamp, and not re-derived from the page the dock read
   * BEFORE the gap (which still shows that turn open). The start comes from
   * the page read after it.
   */
  test("a turn that ended during the gap does not leave its start on the next turn's clock", async () => {
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        event(2, 'turn.started', { turnId: TURN, prompt: 'First question' }),
      ],
    });
    let deliverAfterGap: ((page: unknown) => void) | undefined;
    fetchWindow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliverAfterGap = resolve;
        }),
    );

    streamUntilTheDrop();
    expect(activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt).toBe(
      Date.parse('2026-08-19T00:00:02.000Z'),
    );
    renderHook(() => useDockTranscript());
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));

    await act(async () => {
      reconnectFallbackSnapshot(true);
    });
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
    // The refetch is still in flight: the pre-gap page is all the dock has,
    // and it must not be read as the open turn's start.
    expect(
      activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt,
    ).toBeUndefined();

    await act(async () => {
      deliverAfterGap?.({
        protocolVersion: 1,
        watermark: 8,
        hasMore: false,
        events: [
          event(2, 'turn.started', { turnId: TURN, prompt: 'First question' }),
          event(5, 'turn.completed', { turnId: TURN, outputText: 'Done.' }),
          event(7, 'turn.started', {
            turnId: 'turn-after-gap',
            prompt: 'Second question',
          }),
        ],
      });
    });
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt).toBe(
        Date.parse('2026-08-19T00:00:07.000Z'),
      ),
    );
  });

  /**
   * #2304 delta HIGH. The streaming row stays MOUNTED through a catch-up (the
   * fold is reseeded open, never closed), so its own mount time is the
   * previous turn's. The clock a user reads must restart for the turn that
   * started during the gap — rendered, not just the stored start. Only
   * `Date` is faked, so the row's 1s ticker and the fetch promises run on
   * real time while the wall clock jumps ten minutes.
   */
  test("the mounted working clock reads the turn that started during the gap, not the row's mount", async () => {
    const t0 = Date.parse('2026-08-19T00:00:02.000Z');
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    try {
      fetchWindow.mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 2,
        hasMore: false,
        events: [
          event(2, 'turn.started', { turnId: TURN, prompt: 'First question' }),
        ],
      });
      let deliverAfterGap: ((page: unknown) => void) | undefined;
      fetchWindow.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliverAfterGap = resolve;
          }),
      );
      streamUntilTheDrop();
      const view = render(<DockClock />);
      await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));

      vi.setSystemTime(t0 + 600_000);
      await waitFor(
        () => expect(view.container.textContent).toContain('Working for 10:00'),
        { timeout: 3_000 },
      );

      await act(async () => {
        reconnectFallbackSnapshot(true);
      });
      await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
      // Refetch in flight: no start is known, so no duration is stated.
      expect(view.container.textContent).toContain('Working…');
      expect(view.container.textContent).not.toMatch(/\d+:\d\d/u);
      await act(async () => {
        deliverAfterGap?.({
          protocolVersion: 1,
          watermark: 8,
          hasMore: false,
          events: [
            event(2, 'turn.started', {
              turnId: TURN,
              prompt: 'First question',
            }),
            event(5, 'turn.completed', {
              turnId: TURN,
              outputText: 'Done.',
              createdAt: new Date(t0 + 300_000).toISOString(),
            }),
            event(7, 'turn.started', {
              turnId: 'turn-after-gap',
              prompt: 'Second question',
              createdAt: new Date(t0 + 590_000).toISOString(),
            }),
          ],
        });
      });
      await waitFor(() =>
        expect(activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt).toBe(
          t0 + 590_000,
        ),
      );
      await waitFor(
        () => expect(view.container.textContent).toContain('Working for 0:10'),
        { timeout: 3_000 },
      );
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #2304 round 4. A catch-up clears the stamp on EVERY open-turn reconnect,
   * and the usual case is a short drop with the SAME turn still running.
   * While the refetch is in flight the working row cannot know that, so it
   * states no duration (never 0:00, never a guess), and the reseed restores
   * the true duration. The status-labelled wait counts from the row's mount,
   * exactly as main does, and a reconnect does not touch it.
   */
  for (const statusLabel of [undefined, 'Waiting for approval']) {
    test(`a short drop with the same turn running: ${statusLabel ? "the status-labelled wait keeps main's mount clock" : 'no working duration until the reseed, then the true one'}`, async () => {
      const t0 = Date.parse('2026-08-19T00:00:02.000Z');
      const label = statusLabel ? `${statusLabel} · ` : 'Working for ';
      vi.useFakeTimers({ toFake: ['Date'], now: t0 });
      try {
        const sameTurnPage = {
          protocolVersion: 1,
          watermark: 3,
          hasMore: false,
          events: [
            event(2, 'turn.started', { turnId: TURN, prompt: 'Long job' }),
          ],
        };
        fetchWindow.mockResolvedValueOnce(sameTurnPage);
        let deliverAfterDrop: ((page: unknown) => void) | undefined;
        fetchWindow.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              deliverAfterDrop = resolve;
            }),
        );
        streamUntilTheDrop();
        const view = render(<DockClock statusLabel={statusLabel} />);
        await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
        vi.setSystemTime(t0 + 300_000);
        await waitFor(
          () => expect(view.container.textContent).toContain(`${label}5:00`),
          { timeout: 3_000 },
        );

        await act(async () => {
          reconnectFallbackSnapshot(true);
        });
        await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
        expect(
          activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt,
        ).toBeUndefined();
        // Stamp cleared, refetch in flight (it may never land).
        vi.setSystemTime(t0 + 305_000);
        if (statusLabel) {
          await waitFor(
            () => expect(view.container.textContent).toContain(`${label}5:05`),
            { timeout: 3_000 },
          );
        } else {
          expect(view.container.textContent).toContain('Working…');
          expect(view.container.textContent).not.toMatch(/\d+:\d\d/u);
        }

        await act(async () => {
          deliverAfterDrop?.(sameTurnPage);
        });
        await waitFor(() =>
          expect(
            activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt,
          ).toBe(t0),
        );
        vi.setSystemTime(t0 + 310_000);
        await waitFor(
          () => expect(view.container.textContent).toContain(`${label}5:10`),
          { timeout: 3_000 },
        );
        view.unmount();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  /**
   * #2304 round 4, F2. The row mounted an hour into turn 1; the gap swallowed
   * turn 1's end AND turn 2's start, and the refetch fails, so no reseed ever
   * lands. The row must not assert a duration for a turn it cannot identify
   * (round 3 showed "61:30" thirty seconds into turn 2). When turn 2's start
   * does arrive, it reads turn 2's duration.
   */
  test('a catch-up whose refetch fails states no duration until a start arrives', async () => {
    const t0 = Date.parse('2026-08-19T01:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    try {
      fetchWindow.mockResolvedValueOnce({
        protocolVersion: 1,
        watermark: 1,
        hasMore: false,
        events: [],
      });
      fetchWindow.mockRejectedValueOnce(new Error('network unavailable'));
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
        createdAt: new Date(t0 - 3_600_000).toISOString(),
      } as never);
      const view = render(<DockClock />);
      await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
      await waitFor(
        () => expect(view.container.textContent).toContain('Working for 60:00'),
        { timeout: 3_000 },
      );
      vi.setSystemTime(t0 + 60_000);

      await act(async () => {
        reconnectFallbackSnapshot(true);
      });
      await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
      vi.setSystemTime(t0 + 90_000);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      });
      expect(view.container.textContent).toContain('Working…');
      expect(view.container.textContent).not.toMatch(/\d+:\d\d/u);

      await act(async () => {
        handleTurnStartedEvent({
          method: 'turn.started',
          threadId: THREAD,
          turnId: 'turn-two',
          createdAt: new Date(t0 + 55_000).toISOString(),
        } as never);
      });
      await waitFor(
        () => expect(view.container.textContent).toContain('Working for 0:35'),
        { timeout: 3_000 },
      );
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #2304 round 5, through the real store. The sender's row has no start
   * before `turn.started` and states no duration; once the real turn handler
   * stamps the server's start, it counts from there.
   */
  test("the sender's working clock states no duration before turn.started, then reads the server start", async () => {
    const t0 = Date.parse('2026-08-19T00:00:02.000Z');
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    try {
      fetchWindow.mockResolvedValue({
        protocolVersion: 1,
        watermark: 1,
        hasMore: false,
        events: [],
      });
      activeChatsStore.initChat(THREAD, {
        agentSlug: 'agent-one',
        agentName: 'Agent One',
        title: 'Session',
      });
      const outgoing = buildOutgoingUserMessage([], 'Long job');
      activeChatsStore.updateChat(THREAD, {
        provider: 'claude',
        orchestrationSessionStarted: true,
        messages: outgoing.messages,
        pendingClientTurnId: 'client-turn',
        status: 'sending',
      });
      const view = render(<DockClock />);
      await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
      vi.setSystemTime(t0 + 30_000);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      });
      expect(view.container.textContent).toContain('Working…');
      expect(view.container.textContent).not.toMatch(/\d+:\d\d/u);
      await act(async () => {
        handleTurnStartedEvent({
          method: 'turn.started',
          threadId: THREAD,
          turnId: TURN,
          createdAt: new Date(t0 + 30_000).toISOString(),
          prompt: 'Long job',
        } as never);
      });
      expect(view.container.textContent).toContain('Working for 0:00');
      vi.setSystemTime(t0 + 32_000);
      await waitFor(
        () => expect(view.container.textContent).toContain('Working for 0:02'),
        { timeout: 3_000 },
      );
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #2304 round 3, MEDIUM 3. The sender's `turn.started` fell in the gap, so
   * its prompt row never gained a turn id and can only match by content.
   * With this client's clock 5s ahead, keeping its own time sorted it below
   * its own turn's activity. The window also holds an OLDER turn that sent
   * the same text: the prompt must stand in for the open turn's copy, not
   * claim (and hide) the older one.
   */
  test('a sender whose turn.started fell in the gap keeps its prompt above its activity', async () => {
    const serverStart = '2026-08-19T00:00:05.000Z';
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
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(serverStart) + 5_000);
    const outgoing = buildOutgoingUserMessage(
      activeChatsStore.getSnapshot()[THREAD]?.messages,
      'why did you stop?',
    );
    now.mockRestore();
    activeChatsStore.updateChat(THREAD, {
      messages: outgoing.messages,
      pendingClientTurnId: 'client-turn',
      status: 'sending',
    });
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 2,
      hasMore: false,
      events: [
        event(1, 'turn.started', {
          turnId: 'turn-old',
          prompt: 'why did you stop?',
        }),
        event(2, 'turn.completed', {
          turnId: 'turn-old',
          outputText: 'Old answer',
        }),
      ],
    });
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 6,
      hasMore: false,
      events: [
        event(1, 'turn.started', {
          turnId: 'turn-old',
          prompt: 'why did you stop?',
        }),
        event(2, 'turn.completed', {
          turnId: 'turn-old',
          outputText: 'Old answer',
        }),
        event(5, 'turn.started', {
          turnId: 'turn-new',
          prompt: 'why did you stop?',
        }),
        event(6, 'content.text-delta', {
          turnId: 'turn-new',
          itemId: 'text',
          delta: 'Reading files',
        }),
      ],
    });
    const { result } = renderHook(() => useDockTranscript());
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
    await act(async () => {
      reconnectFallbackSnapshot(true);
    });
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
      ['e1:user', 'why did you stop?'],
      ['e1:assistant', 'Old answer'],
      [outgoing.clientId, 'why did you stop?'],
      ['e5:assistant', 'Reading files'],
    ]);
  });

  /**
   * #2304 delta LOW. No stamp existed when the catch-up landed — the live
   * `turn.started` had an unparseable time, and the pre-gap page's open turn
   * was a different one, which the `openTurnId` check refused. The catch-up
   * turns that check off; the pre-gap page must still not be read.
   */
  test('a catch-up with no stamp to clear still does not seed from the pre-gap page', async () => {
    fetchWindow.mockResolvedValueOnce({
      protocolVersion: 1,
      watermark: 1,
      hasMore: false,
      events: [
        event(1, 'turn.started', { turnId: 'turn-before', prompt: 'Earlier' }),
      ],
    });
    let deliverAfterGap: ((page: unknown) => void) | undefined;
    fetchWindow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliverAfterGap = resolve;
        }),
    );
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
      createdAt: 'not-a-time',
    } as never);
    expect(
      activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt,
    ).toBeUndefined();
    renderHook(() => useDockTranscript());
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));

    await act(async () => {
      reconnectFallbackSnapshot(true);
    });
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
    expect(
      activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt,
    ).toBeUndefined();

    await act(async () => {
      deliverAfterGap?.({
        protocolVersion: 1,
        watermark: 9,
        hasMore: false,
        events: [
          event(1, 'turn.started', {
            turnId: 'turn-before',
            prompt: 'Earlier',
          }),
          event(3, 'turn.completed', {
            turnId: 'turn-before',
            outputText: 'Earlier answer',
          }),
          event(8, 'turn.started', { turnId: TURN, prompt: 'Now' }),
        ],
      });
    });
    await waitFor(() =>
      expect(activeChatsStore.getSnapshot()[THREAD]?.openTurnStartedAt).toBe(
        Date.parse('2026-08-19T00:00:08.000Z'),
      ),
    );
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
