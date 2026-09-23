/**
 * @vitest-environment jsdom
 *
 * #2309 review F1: a follow-up queued behind an open turn drains when the
 * SERVER record closes that turn, wherever it ran.
 *
 * After a reload the chat can still name the root session while a lineage
 * child runs the turn. That child's `turn.completed` then routes to no chat,
 * so the event-driven drain never fired and the queue was stranded. These
 * cases drive the real app-wide stream (`ensureOrchestrationEventStream`,
 * with only the SSE transport and the dispatch network call mocked) so the
 * listener wiring is under test, not a hand-registered copy of it.
 */

import type {
  ConversationTurnActivity,
  OrchestrationConversationStreamBinding,
} from '@kontourai/station-contracts/orchestration';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../hooks/orchestration/types';

const mocks = vi.hoisted(() => ({
  onMessage: new Map<
    string,
    (raw: { event: string; data: string; id?: string }) => void
  >(),
  dispatchForeground: vi.fn(async (_input: Record<string, unknown>) => ({})),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  fetchSSE: (
    url: string,
    options: {
      onMessage: (raw: { event: string; data: string; id?: string }) => void;
    },
  ) => {
    mocks.onMessage.set(url, options.onMessage);
    return {
      close: vi.fn(),
      signal: new AbortController().signal,
      completed: Promise.resolve(),
      retry: vi.fn(),
    };
  },
}));
vi.mock('../lib/foregroundMessageDispatch', () => ({
  dispatchForeground: mocks.dispatchForeground,
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';

let index = 0;
let TURN = '';
let API = '';
let CONVERSATION = '';
let CHILD = '';
let sequence = 0;

function open(asOfSequence: number): ConversationTurnActivity {
  return {
    conversationId: CONVERSATION,
    asOfSequence,
    openTurn: {
      turnId: TURN,
      threadId: CHILD,
      startedAt: '2026-09-22T18:55:25.000Z',
    },
  };
}

function closed(asOfSequence: number): ConversationTurnActivity {
  return {
    conversationId: CONVERSATION,
    asOfSequence,
    lastActivityAt: '2026-09-22T18:57:44.000Z',
  };
}

function deliver(raw: { event: string; data: string }) {
  const onMessage = mocks.onMessage.get(`${API}/api/orchestration/events`);
  if (!onMessage) throw new Error('stream not started');
  sequence += 1;
  onMessage({ ...raw, id: String(sequence) });
}

function deliverSnapshot(payload: OrchestrationSnapshotPayload) {
  deliver({ event: 'orchestration:snapshot', data: JSON.stringify(payload) });
}

function deliverEvent(
  event: OrchestrationEvent,
  conversation: OrchestrationConversationStreamBinding,
) {
  deliver({
    event: SERVER_EVENTS.ORCHESTRATION_EVENT,
    data: JSON.stringify({ event, conversation }),
  });
}

function binding(
  activity: ConversationTurnActivity,
): OrchestrationConversationStreamBinding {
  return { conversationId: CONVERSATION, currentSessionId: CHILD, activity };
}

/** A reload mid-turn: the chat still names the root; the child runs the turn. */
function reloadWithQueuedFollowUp() {
  activeChatsStore.initChat(CONVERSATION, {
    agentSlug: 'dev-agent',
    agentName: 'Dev Agent',
    title: 'Queue behind a child turn',
    conversationId: CONVERSATION,
  });
  activeChatsStore.updateChat(CONVERSATION, {
    currentSessionId: CONVERSATION,
    orchestrationSessionStarted: true,
    conversationOpenPending: false,
    queuedMessages: ['and then summarize it'],
  });
  ensureOrchestrationEventStream(API);
  deliverSnapshot({
    sessions: [
      {
        provider: 'claude',
        threadId: CONVERSATION,
        status: 'running',
        hasActiveTurn: false,
        conversationActivity: open(10),
      },
      {
        provider: 'claude',
        threadId: CHILD,
        status: 'running',
        hasActiveTurn: true,
        conversationActivity: open(10),
      },
    ],
  });
}

beforeEach(() => {
  index += 1;
  API = `http://station-queue-${index}.test`;
  CONVERSATION = `claude:conv-queue-${index}`;
  CHILD = `${CONVERSATION}:session:child`;
  TURN = `turn-child-queue-${index}`;
  sequence = 0;
  mocks.dispatchForeground.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  activeChatsStore.removeChat(CONVERSATION);
});

describe('#2309 F1: the queue drains when the record closes the open turn', () => {
  test("a lineage child's turn completing drains the follow-up even though the chat names the root", async () => {
    reloadWithQueuedFollowUp();
    // Premise: the child's events route to no chat.
    expect(
      activeChatsStore.getChatKeyForExecutionSession(CHILD),
    ).toBeUndefined();

    deliverEvent(
      {
        eventId: 'evt-done',
        provider: 'claude',
        threadId: CHILD,
        createdAt: '2026-09-22T18:57:44.000Z',
        method: 'turn.completed',
        turnId: TURN,
      },
      binding(closed(11)),
    );
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.dispatchForeground).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchForeground.mock.calls[0]?.[0]).toMatchObject({
      message: 'and then summarize it',
      conversationId: CONVERSATION,
    });
    expect(
      activeChatsStore.getSnapshot()[CONVERSATION]?.queuedMessages,
    ).toEqual([]);
  });

  test('a turn Stopped from another device does not fire the follow-up (the archive#3451 exclusion holds)', async () => {
    reloadWithQueuedFollowUp();
    deliverEvent(
      {
        eventId: 'evt-aborted',
        provider: 'claude',
        threadId: CHILD,
        createdAt: '2026-09-22T18:57:44.000Z',
        method: 'turn.aborted',
        turnId: TURN,
        reason: 'Stopped by the user',
      },
      binding(closed(11)),
    );
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.dispatchForeground).not.toHaveBeenCalled();
    const chat = activeChatsStore.getSnapshot()[CONVERSATION];
    // Still held, visibly, and no longer behind a live turn.
    expect(chat?.queuedMessages).toEqual(['and then summarize it']);
  });

  test('the witnessed terminal and the record closing are one turn end: exactly one follow-up is sent', async () => {
    reloadWithQueuedFollowUp();
    activeChatsStore.updateChat(CONVERSATION, {
      currentSessionId: CHILD,
      queuedMessages: ['first follow-up', 'second follow-up'],
    });
    deliverEvent(
      {
        eventId: 'evt-done-2',
        provider: 'claude',
        threadId: CHILD,
        createdAt: '2026-09-22T18:57:44.000Z',
        method: 'turn.completed',
        turnId: TURN,
      },
      binding(closed(12)),
    );
    await vi.advanceTimersByTimeAsync(500);

    // Earlier cases in this file connected other Stations' streams; the one
    // follow-up goes through this (the newest) Station, and only once.
    expect(mocks.dispatchForeground).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchForeground.mock.calls[0]?.[0]).toMatchObject({
      apiBase: API,
    });
    expect(
      activeChatsStore.getSnapshot()[CONVERSATION]?.queuedMessages,
    ).toEqual(['second follow-up']);
  });
});
