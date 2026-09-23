/**
 * @vitest-environment jsdom
 *
 * #2309: when a queued follow-up is sent.
 *
 * Only a turn's terminal EVENT drains the queue (as on main), so a Stop
 * (`turn.aborted`) never auto-sends (archive#3451), and a replayed frame's
 * as-of-delivery record can never fire a send ahead of the turn it replays.
 * The activity record is used for liveness and for OFFERING "Send now" when
 * the automatic drain will not come; the send itself is the user's.
 *
 * These cases drive the real app-wide stream (`ensureOrchestrationEventStream`,
 * with only the SSE transport and the dispatch network call mocked).
 */

import type {
  ConversationTurnActivity,
  OrchestrationConversationStreamBinding,
} from '@kontourai/station-contracts/orchestration';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
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
vi.mock('../contexts/ActiveChatsContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/ActiveChatsContext')>();
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    ...actual,
    useActiveChatActions: () => ({
      updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
      removeQueuedMessage:
        activeChatsStore.removeQueuedMessage.bind(activeChatsStore),
      editQueuedMessage:
        activeChatsStore.editQueuedMessage.bind(activeChatsStore),
      reorderQueuedMessage:
        activeChatsStore.reorderQueuedMessage.bind(activeChatsStore),
    }),
  };
});

import { QueuedMessages } from '../components/chat/QueuedMessages';
import { activeChatsStore } from '../contexts/active-chats-store';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import { drainQueuedMessageOnTurnCompleted } from '../hooks/orchestration/queueDrain';
import { queueSendNowOffered } from '../utils/conversation-activity';

let index = 0;
let API = '';
let CONVERSATION = '';
let CHILD = '';
let TURN = '';
let sequence = 0;

function open(
  asOfSequence: number,
  extra: Partial<ConversationTurnActivity> = {},
): ConversationTurnActivity {
  return {
    conversationId: CONVERSATION,
    asOfSequence,
    openTurn: {
      turnId: TURN,
      threadId: CHILD,
      startedAt: '2026-09-22T18:55:25.000Z',
    },
    ...extra,
  };
}

function closed(asOfSequence: number): ConversationTurnActivity {
  return {
    conversationId: CONVERSATION,
    asOfSequence,
    lastActivityAt: '2026-09-22T18:57:44.000Z',
  };
}

function deliver(apiBase: string, raw: { event: string; data: string }) {
  const onMessage = mocks.onMessage.get(`${apiBase}/api/orchestration/events`);
  if (!onMessage) throw new Error(`stream not started for ${apiBase}`);
  sequence += 1;
  onMessage({ ...raw, id: String(sequence) });
}

function deliverSnapshot(
  apiBase: string,
  payload: OrchestrationSnapshotPayload,
) {
  deliver(apiBase, {
    event: 'orchestration:snapshot',
    data: JSON.stringify(payload),
  });
}

function deliverEvent(
  apiBase: string,
  event: OrchestrationEvent,
  activity: ConversationTurnActivity,
) {
  const conversation: OrchestrationConversationStreamBinding = {
    conversationId: CONVERSATION,
    currentSessionId: CHILD,
    activity,
  };
  deliver(apiBase, {
    event: SERVER_EVENTS.ORCHESTRATION_EVENT,
    data: JSON.stringify({ event, conversation }),
  });
}

function turnCompleted(): OrchestrationEvent {
  return {
    eventId: `evt-done-${index}`,
    provider: 'claude',
    threadId: CHILD,
    createdAt: '2026-09-22T18:57:44.000Z',
    method: 'turn.completed',
    turnId: TURN,
    outputText: 'Answer to the running turn.',
  };
}

function turnAborted(): OrchestrationEvent {
  return {
    eventId: `evt-aborted-${index}`,
    provider: 'claude',
    threadId: CHILD,
    createdAt: '2026-09-22T18:57:44.000Z',
    method: 'turn.aborted',
    turnId: TURN,
    reason: 'Stopped by the user',
  };
}

/** A chat on the conversation with follow-ups queued behind the open turn. */
function chatWithQueue(
  queued: string[],
  currentSessionId: string = CONVERSATION,
) {
  activeChatsStore.initChat(CONVERSATION, {
    agentSlug: 'dev-agent',
    agentName: 'Dev Agent',
    title: 'Queue behind a turn',
    conversationId: CONVERSATION,
  });
  activeChatsStore.updateChat(CONVERSATION, {
    currentSessionId,
    orchestrationSessionStarted: true,
    conversationOpenPending: false,
    queuedMessages: queued,
  });
}

function connect(apiBase: string, activity: ConversationTurnActivity) {
  ensureOrchestrationEventStream(apiBase);
  deliverSnapshot(apiBase, {
    sessions: [
      {
        provider: 'claude',
        threadId: CONVERSATION,
        status: 'running',
        hasActiveTurn: false,
        conversationActivity: activity,
      },
      {
        provider: 'claude',
        threadId: CHILD,
        status: 'running',
        hasActiveTurn: activity.openTurn !== undefined,
        conversationActivity: activity,
      },
    ],
  });
}

function chat() {
  const current = activeChatsStore.getSnapshot()[CONVERSATION];
  if (!current) throw new Error('chat missing');
  return current;
}

/** The dock's queue, with the dock's own "Send now" wiring. */
function Queue({ apiBase }: { apiBase: string }) {
  const current = useSyncExternalStore(
    activeChatsStore.subscribe,
    () => activeChatsStore.getSnapshot()[CONVERSATION],
  );
  if (!current) return null;
  return (
    <QueuedMessages
      sessionId={CONVERSATION}
      messages={current.queuedMessages}
      onSendNow={
        queueSendNowOffered(current)
          ? () =>
              drainQueuedMessageOnTurnCompleted(
                apiBase,
                CONVERSATION,
                true,
                true,
              )
          : undefined
      }
    />
  );
}

beforeEach(() => {
  index += 1;
  API = `http://station-queue-${index}.test`;
  CONVERSATION = `claude:conv-queue-${index}`;
  CHILD = `${CONVERSATION}:session:child`;
  TURN = `turn-queue-${index}`;
  sequence = 0;
  mocks.dispatchForeground.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  activeChatsStore.removeChat(CONVERSATION);
});

describe('#2309 the queue drains on the turn END event, routed by the frame binding', () => {
  test("a lineage child's turn.completed drains the conversation's chat, though the chat names the root", async () => {
    chatWithQueue(['and then summarize it']);
    connect(API, open(10));
    // Premise: the child's events route to no chat.
    expect(
      activeChatsStore.getChatKeyForExecutionSession(CHILD),
    ).toBeUndefined();

    deliverEvent(API, turnCompleted(), closed(11));
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.dispatchForeground).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchForeground.mock.calls[0]?.[0]).toMatchObject({
      apiBase: API,
      message: 'and then summarize it',
      conversationId: CONVERSATION,
    });
  });

  test('Station A, then B, then A: the drain goes through the Station that delivered the turn end', async () => {
    const stationA = API;
    const stationB = `${API}-b`;
    chatWithQueue(['for station A'], CHILD);
    connect(stationA, open(20));
    ensureOrchestrationEventStream(stationB);
    ensureOrchestrationEventStream(stationA);

    deliverEvent(stationA, turnCompleted(), closed(21));
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.dispatchForeground).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchForeground.mock.calls[0]?.[0]).toMatchObject({
      apiBase: stationA,
    });
  });

  test('a reconnect replay: frames carrying the already-closed record send nothing; the replayed turn.completed sends exactly one, after the answer', async () => {
    chatWithQueue(['B1', 'B2'], CHILD);
    connect(API, open(30));
    act(() =>
      activeChatsStore.updateChat(CONVERSATION, {
        orchestrationTurnOpen: true,
        openTurnId: TURN,
      }),
    );

    // The server attaches its CURRENT record (the turn already ended) to
    // every replayed frame, starting with the turn's own content.
    deliverEvent(
      API,
      {
        eventId: `evt-delta-${index}`,
        provider: 'claude',
        threadId: CHILD,
        createdAt: '2026-09-22T18:56:00.000Z',
        method: 'content.text-delta',
        turnId: TURN,
        itemId: 'item-answer',
        delta: 'Answer to the running turn.',
      },
      closed(40),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.dispatchForeground).not.toHaveBeenCalled();
    expect(chat().queuedMessages).toEqual(['B1', 'B2']);

    deliverEvent(API, turnCompleted(), closed(40));
    await vi.advanceTimersByTimeAsync(500);

    expect(mocks.dispatchForeground).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchForeground.mock.calls[0]?.[0]).toMatchObject({
      message: 'B1',
    });
    expect(chat().queuedMessages).toEqual(['B2']);
    const messages = chat().messages ?? [];
    const answerAt = messages.findIndex(
      (message) =>
        message.role === 'assistant' &&
        message.content.includes('Answer to the running turn.'),
    );
    const b1At = messages.findIndex(
      (message) => message.role === 'user' && message.content === 'B1',
    );
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(b1At).toBeGreaterThan(answerAt);
  });
});

describe('#2309 "Send now" when the automatic drain will not come', () => {
  test('a Stop on another device, seen after a reconnect: nothing is sent, "Send now" is offered, and one click sends exactly one', async () => {
    chatWithQueue(['after the stop', 'and this later'], CHILD);
    connect(API, open(50));
    render(<Queue apiBase={API} />);
    expect(
      screen.queryByRole('button', { name: /Send the next queued/ }),
    ).toBeNull();

    act(() => deliverEvent(API, turnAborted(), closed(51)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.dispatchForeground).not.toHaveBeenCalled();
    expect(chat().queuedMessages).toEqual(['after the stop', 'and this later']);

    const sendNow = screen.getByRole('button', {
      name: 'Send the next queued message now',
    });
    expect(sendNow.textContent).toBe('Send now');
    await act(async () => {
      fireEvent.click(sendNow);
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.dispatchForeground).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchForeground.mock.calls[0]?.[0]).toMatchObject({
      message: 'after the stop',
      apiBase: API,
    });
    expect(chat().queuedMessages).toEqual(['and this later']);
  });

  test('a turn that stays open is offered "Send now" only once the watchdog has observed it silent', () => {
    chatWithQueue(['waiting'], CHILD);
    connect(API, open(60));
    render(<Queue apiBase={API} />);
    expect(
      screen.queryByRole('button', { name: /Send the next queued/ }),
    ).toBeNull();

    act(() =>
      activeChatsStore.applyConversationActivity(
        open(60, {
          progressSilence: {
            detectedAt: '2026-09-22T19:10:00.000Z',
            windowMs: 600_000,
            silentSinceEventAt: '2026-09-22T19:00:00.000Z',
            provider: 'claude',
          },
        }),
      ),
    );
    expect(
      screen.getByRole('button', { name: 'Send the next queued message now' }),
    ).toBeTruthy();
  });
});

describe('#2309 explicit sends are never held back silently', () => {
  test('Retry sends while the record still shows a turn open', async () => {
    chatWithQueue(['retry me'], CHILD);
    connect(API, open(70));
    act(() =>
      activeChatsStore.updateChat(CONVERSATION, {
        queuedMessageFailure: { message: 'engine paused', at: 1 },
      }),
    );
    drainQueuedMessageOnTurnCompleted(API, CONVERSATION, true, true);
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.dispatchForeground).toHaveBeenCalledTimes(1);
  });

  test('an explicit send that cannot go says why in the chat', () => {
    chatWithQueue(['being edited'], CHILD);
    connect(API, closed(80));
    act(() =>
      activeChatsStore.updateChat(CONVERSATION, { isEditingQueue: true }),
    );
    drainQueuedMessageOnTurnCompleted(API, CONVERSATION, true, true);
    expect(mocks.dispatchForeground).not.toHaveBeenCalled();
    expect(
      (chat().ephemeralMessages ?? []).map((message) => message.content),
    ).toContain('Finish editing the queued message first, then send it.');
  });
});
