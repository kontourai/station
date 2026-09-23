/**
 * @vitest-environment jsdom
 *
 * #2309 Phase B: the client reads liveness from the server's
 * `ConversationTurnActivity`, delivered by every carrier, keyed by
 * conversation and kept at the newest `asOfSequence`.
 *
 * Every case drives the real carrier seams (`applyOrchestrationSnapshot`,
 * `handleOrchestrationEvent` with its stream binding) into the real store and
 * reads the real predicates the composer, the Stop control and the streaming
 * row use. Fixtures are the exact wire shapes Phase A emits, typed against
 * the contracts rather than cast.
 */

import type {
  ConversationTurnActivity,
  OrchestrationConversationStreamBinding,
} from '@kontourai/station-contracts/orchestration';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OrchestrationSnapshotPayload } from '../hooks/orchestration/types';

const API = 'http://station.test';
const CONVERSATION = 'claude:conv-2309';
const CHILD = `${CONVERSATION}:session:child-2`;
const TURN = 'turn-child-7';
const STARTED_AT = '2026-09-22T18:55:25.000Z';

function openActivity(
  asOfSequence: number,
  extra: Partial<ConversationTurnActivity> = {},
): ConversationTurnActivity {
  return {
    conversationId: CONVERSATION,
    asOfSequence,
    openTurn: { turnId: TURN, threadId: CHILD, startedAt: STARTED_AT },
    lastActivityAt: STARTED_AT,
    ...extra,
  };
}

function closedActivity(asOfSequence: number): ConversationTurnActivity {
  return {
    conversationId: CONVERSATION,
    asOfSequence,
    lastActivityAt: '2026-09-22T18:57:44.000Z',
  };
}

/**
 * A reload's connect-time snapshot: the ROOT row (the chat's own key) is
 * idle, and the lineage child running the turn is a different row. Both carry
 * the same conversation activity, as Phase A serializes them.
 */
function reloadSnapshot(
  activity: ConversationTurnActivity | undefined,
): OrchestrationSnapshotPayload {
  return {
    sessions: [
      {
        provider: 'claude',
        threadId: CONVERSATION,
        status: 'running',
        hasActiveTurn: false,
        ...(activity ? { conversationActivity: activity } : {}),
      },
      {
        provider: 'claude',
        threadId: CHILD,
        status: 'running',
        hasActiveTurn: activity?.openTurn !== undefined,
        ...(activity ? { conversationActivity: activity } : {}),
      },
    ],
  };
}

type Client = {
  store: typeof import('../contexts/active-chats-store').activeChatsStore;
  isTurnInFlight: typeof import('../contexts/active-chats-state').isTurnInFlight;
  isTurnStreamLive: typeof import('../utils/execution').isTurnStreamLive;
  liveTurnTarget: typeof import('../utils/conversation-activity').liveTurnTarget;
  applyOrchestrationSnapshot: typeof import('../hooks/orchestration/snapshotHandlers').applyOrchestrationSnapshot;
  handleOrchestrationEvent: typeof import('../hooks/orchestration/eventHandlers').handleOrchestrationEvent;
};

/** A fresh module graph is a fresh client: its own store, its own handlers. */
async function loadClient(): Promise<Client> {
  vi.resetModules();
  const [store, state, execution, activity, snapshot, events] =
    await Promise.all([
      import('../contexts/active-chats-store'),
      import('../contexts/active-chats-state'),
      import('../utils/execution'),
      import('../utils/conversation-activity'),
      import('../hooks/orchestration/snapshotHandlers'),
      import('../hooks/orchestration/eventHandlers'),
    ]);
  const client: Client = {
    store: store.activeChatsStore,
    isTurnInFlight: state.isTurnInFlight,
    isTurnStreamLive: execution.isTurnStreamLive,
    liveTurnTarget: activity.liveTurnTarget,
    applyOrchestrationSnapshot: snapshot.applyOrchestrationSnapshot,
    handleOrchestrationEvent: events.handleOrchestrationEvent,
  };
  // The tab a reload restores: keyed by its conversation, still pointing at
  // the root as its current session (it has not yet learned of the child).
  client.store.initChat(CONVERSATION, {
    agentSlug: 'dev-agent',
    agentName: 'Dev Agent',
    title: 'Lineage',
    conversationId: CONVERSATION,
  });
  client.store.updateChat(CONVERSATION, {
    currentSessionId: CONVERSATION,
    orchestrationSessionStarted: true,
  });
  return client;
}

function binding(
  activity: ConversationTurnActivity,
): OrchestrationConversationStreamBinding {
  return { conversationId: CONVERSATION, currentSessionId: CHILD, activity };
}

function chatOf(client: Client) {
  const chat = client.store.getSnapshot()[CONVERSATION];
  if (!chat) throw new Error('chat missing');
  return chat;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('#2309 reload mid-turn with the turn in a lineage child', () => {
  test('the snapshot alone makes the turn live and names the child as the Stop target', async () => {
    const client = await loadClient();
    // Premise: before any activity the chat reads idle.
    expect(client.isTurnInFlight(chatOf(client))).toBe(false);

    client.applyOrchestrationSnapshot(reloadSnapshot(openActivity(120)));

    const chat = chatOf(client);
    expect(client.isTurnInFlight(chat)).toBe(true);
    expect(client.isTurnStreamLive(chat)).toBe(true);
    expect(client.liveTurnTarget(chat, CONVERSATION)).toEqual({
      threadId: CHILD,
      turnId: TURN,
    });
  });

  test('a client that watched the turn live and one that reloaded agree', async () => {
    // Client A was connected throughout: it saw the binding on turn.started
    // and on tool.started for the child.
    const clientA = await loadClient();
    clientA.handleOrchestrationEvent(
      API,
      {
        eventId: 'evt-turn-started',
        provider: 'claude',
        threadId: CHILD,
        createdAt: STARTED_AT,
        method: 'turn.started',
        turnId: TURN,
      },
      undefined,
      binding(openActivity(118)),
    );
    const withTool = openActivity(119, {
      runningTools: [
        {
          name: 'bash',
          callId: 'call-1',
          startedAt: '2026-09-22T18:56:00.000Z',
        },
      ],
    });
    clientA.handleOrchestrationEvent(
      API,
      {
        eventId: 'evt-tool-started',
        provider: 'claude',
        threadId: CHILD,
        createdAt: '2026-09-22T18:56:00.000Z',
        method: 'tool.started',
        turnId: TURN,
        itemId: 'item-1',
        toolCallId: 'call-1',
        toolName: 'bash',
      },
      undefined,
      binding(withTool),
    );

    // Client B reloads after both: it has only the snapshot.
    const clientB = await loadClient();
    clientB.applyOrchestrationSnapshot(reloadSnapshot(withTool));

    const chatA = chatOf(clientA);
    const chatB = chatOf(clientB);
    expect(chatA.conversationActivity).toEqual(chatB.conversationActivity);
    expect(clientA.isTurnInFlight(chatA)).toBe(true);
    expect(clientB.isTurnInFlight(chatB)).toBe(true);
    expect(clientA.liveTurnTarget(chatA, CONVERSATION)).toEqual(
      clientB.liveTurnTarget(chatB, CONVERSATION),
    );
    expect(chatB.conversationActivity?.runningTools?.[0]?.name).toBe('bash');
  });
});

describe('#2309 keep the newest record', () => {
  test('an older binding frame after a newer snapshot does not regress state', async () => {
    const client = await loadClient();
    // The snapshot says the turn has ENDED (sequence 140)...
    client.applyOrchestrationSnapshot(reloadSnapshot(closedActivity(140)));
    expect(client.isTurnInFlight(chatOf(client))).toBe(false);

    // ...then a buffered frame from before that arrives, carrying the turn
    // open at sequence 120. It must not bring the finished turn back.
    client.handleOrchestrationEvent(
      API,
      {
        eventId: 'evt-late',
        provider: 'claude',
        threadId: CHILD,
        createdAt: '2026-09-22T18:56:00.000Z',
        method: 'tool.progress',
        turnId: TURN,
        itemId: 'item-1',
        toolCallId: 'call-1',
        message: 'still going',
      },
      undefined,
      binding(openActivity(120)),
    );

    const chat = chatOf(client);
    expect(chat.conversationActivity?.asOfSequence).toBe(140);
    expect(chat.conversationActivity?.openTurn).toBeUndefined();
    expect(client.isTurnInFlight(chat)).toBe(false);
    expect(client.isTurnStreamLive(chat)).toBe(false);
  });
});

describe('#2309 deltas never mint liveness', () => {
  test('a turn-less delta with no open turn never makes the turn in flight or the stream live', async () => {
    vi.useFakeTimers();
    const client = await loadClient();
    client.applyOrchestrationSnapshot(reloadSnapshot(closedActivity(200)));
    const revisionBefore = chatOf(client).orchestrationHistoryRevision ?? 0;

    // The evidence shape (claude:1790098279239): provider output after the
    // turn closed, no turn id, no binding activity on a coalesced delta.
    for (const [index, delta] of [
      'Background ',
      'work ',
      'finished.',
    ].entries()) {
      client.handleOrchestrationEvent(API, {
        eventId: `evt-no-turn-${index}`,
        provider: 'claude',
        threadId: CONVERSATION,
        createdAt: '2026-09-22T19:12:41.000Z',
        method: 'content.text-delta',
        itemId: `${CONVERSATION}:no-turn:msg_1`,
        delta,
      });
    }

    const chat = chatOf(client);
    expect(client.isTurnInFlight(chat)).toBe(false);
    expect(client.isTurnStreamLive(chat)).toBe(false);
    expect(chat.status).not.toBe('sending');
    expect(chat.streamingMessage).toBeUndefined();

    // The output is durable: the bounded window is asked to re-read it.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(chatOf(client).orchestrationHistoryRevision).toBe(
      revisionBefore + 1,
    );
  });

  test('an in-turn delta builds the shell without setting status: sending', async () => {
    const client = await loadClient();
    client.applyOrchestrationSnapshot(reloadSnapshot(openActivity(300)));
    client.store.updateChat(CONVERSATION, { status: 'idle' });

    client.handleOrchestrationEvent(API, {
      eventId: 'evt-delta',
      provider: 'claude',
      threadId: CONVERSATION,
      createdAt: '2026-09-22T18:56:10.000Z',
      method: 'content.text-delta',
      turnId: TURN,
      itemId: 'item-text',
      delta: 'hello',
    });

    const chat = chatOf(client);
    expect(chat.streamingMessage?.content).toBe('hello');
    expect(chat.status).toBe('idle');
  });

  test('old server: a delta does not set status: sending, and an explicitly closed fold refuses the shell', async () => {
    const client = await loadClient();
    client.store.updateChat(CONVERSATION, {
      orchestrationTurnOpen: false,
      status: 'idle',
    });
    client.handleOrchestrationEvent(API, {
      eventId: 'evt-legacy-delta',
      provider: 'claude',
      threadId: CONVERSATION,
      createdAt: '2026-09-22T19:12:41.000Z',
      method: 'content.text-delta',
      itemId: 'item-legacy',
      delta: 'late',
    });
    const chat = chatOf(client);
    expect(chat.conversationActivity).toBeUndefined();
    expect(chat.status).toBe('idle');
    expect(chat.streamingMessage).toBeUndefined();
    expect(client.isTurnStreamLive(chat)).toBe(false);
  });
});

describe('#2309 fallback when the server sends no activity (older server)', () => {
  test('the legacy fold and the local send still decide, exactly as before', async () => {
    const client = await loadClient();
    client.applyOrchestrationSnapshot(reloadSnapshot(undefined));
    // The row for the chat's own key says idle; with no record there is
    // nothing better to read.
    expect(chatOf(client).conversationActivity).toBeUndefined();
    expect(client.isTurnInFlight(chatOf(client))).toBe(false);

    client.store.updateChat(CONVERSATION, { orchestrationTurnOpen: true });
    expect(client.isTurnInFlight(chatOf(client))).toBe(true);
    expect(client.isTurnStreamLive(chatOf(client))).toBe(true);

    client.store.updateChat(CONVERSATION, {
      orchestrationTurnOpen: false,
      status: 'sending',
    });
    expect(client.isTurnInFlight(chatOf(client))).toBe(true);
    expect(client.liveTurnTarget(chatOf(client), CONVERSATION)).toEqual({
      threadId: CONVERSATION,
    });
  });
});

describe('#2309 the optimistic send window', () => {
  test('is live until the server opens the turn, and a stale sending does not outlive it', async () => {
    const client = await loadClient();
    client.applyOrchestrationSnapshot(reloadSnapshot(closedActivity(400)));
    client.store.updateChat(CONVERSATION, {
      status: 'sending',
      sendAwaitingTurnStart: true,
    });
    expect(client.isTurnInFlight(chatOf(client))).toBe(true);

    // The server opens it: the window closes, liveness is the open turn.
    client.store.applyConversationActivity(openActivity(401));
    expect(chatOf(client).sendAwaitingTurnStart).toBeUndefined();
    expect(client.isTurnInFlight(chatOf(client))).toBe(true);

    // The turn ends. `status` still reads 'sending' (the terminal frame was
    // missed), and that must not keep the thread looking active.
    client.store.applyConversationActivity(closedActivity(460));
    expect(chatOf(client).status).toBe('sending');
    expect(client.isTurnInFlight(chatOf(client))).toBe(false);
    expect(client.isTurnStreamLive(chatOf(client))).toBe(false);
  });
});
