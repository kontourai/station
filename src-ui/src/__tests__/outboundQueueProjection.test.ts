// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { projectOutboundQueueEntries } from '../hooks/outboundQueueProjection';
import type { QueuedOutboundTurn } from '../lib/outboundQueue';

function turn(
  clientTurnId: string,
  sessionId: string,
  content: string,
): QueuedOutboundTurn {
  return {
    clientTurnId,
    sessionId,
    agentSlug: 'assistant',
    content,
    createdAt: Date.now(),
    attempts: 1,
    status: 'pending',
  };
}

describe('outboundQueueProjection (station#1224 restart hydration)', () => {
  beforeEach(() => {
    for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
      activeChatsStore.removeChat(sessionId);
    }
  });

  it('does not list a live send this renderer is still waiting on, nor call its chat queued', () => {
    activeChatsStore.initChat('session-live', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
    activeChatsStore.updateChat('session-live', { status: 'sending' });
    projectOutboundQueueEntries([
      {
        ...turn('live-1', 'session-live', 'on its way'),
        status: 'invoking',
        origin: 'live',
        liveInFlight: true,
      },
    ]);
    const chat = activeChatsStore.getSnapshot()['session-live'];
    expect(chat?.outboundQueuedTurns ?? []).toEqual([]);
    expect(chat?.status).toBe('sending');
  });

  it('lists a refused queued follow-up once: the chat already shows it as not sent', () => {
    activeChatsStore.initChat('session-unsent', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
    activeChatsStore.updateChat('session-unsent', {
      unsentMessages: [
        { id: 'refused-1', content: 'refused', reason: 'No.', at: 1 },
      ],
    });
    projectOutboundQueueEntries([
      { ...turn('refused-1', 'session-unsent', 'refused'), status: 'failed' },
      { ...turn('other-1', 'session-unsent', 'other'), status: 'failed' },
    ]);
    expect(
      activeChatsStore
        .getSnapshot()
        ['session-unsent']?.outboundQueuedTurns?.map((row) => row.clientTurnId),
    ).toEqual(['other-1']);
  });

  it("lists a follow-up held by another or a closed window (sent only on the user's Send), and not one this window's queue shows", () => {
    activeChatsStore.initChat('session-held', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
    projectOutboundQueueEntries([
      {
        ...turn('held-here', 'session-held', 'in my queue'),
        heldBy: { bootId: 'this-window', heldAt: 1 },
        heldHere: true,
      },
      {
        ...turn('held-away', 'session-held', 'held elsewhere'),
        heldBy: { bootId: 'closed-window', heldAt: 1 },
      },
    ]);
    expect(
      activeChatsStore.getSnapshot()['session-held']?.outboundQueuedTurns,
    ).toEqual([
      expect.objectContaining({
        clientTurnId: 'held-away',
        heldElsewhere: true,
      }),
    ]);
    // Listed first, ahead of messages written after it.
    projectOutboundQueueEntries([
      turn('later', 'session-held', 'written later'),
      {
        ...turn('held-away', 'session-held', 'held elsewhere'),
        heldBy: { bootId: 'closed-window', heldAt: 1 },
      },
    ]);
    expect(
      activeChatsStore
        .getSnapshot()
        ['session-held']?.outboundQueuedTurns?.map((row) => row.clientTurnId),
    ).toEqual(['held-away', 'later']);
  });

  it('marks a held copy whose window is proven closed, and only that one', () => {
    activeChatsStore.initChat('session-closed', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
    projectOutboundQueueEntries([
      {
        ...turn('open-window', 'session-closed', 'held by a running window'),
        heldBy: { bootId: 'running', heldAt: 1 },
      },
      {
        ...turn('closed-window', 'session-closed', 'held by a closed one'),
        heldBy: { bootId: 'closed', heldAt: 1 },
        holderGone: true,
      },
    ]);
    const rows =
      activeChatsStore.getSnapshot()['session-closed']?.outboundQueuedTurns;
    expect(rows?.find((row) => row.clientTurnId === 'open-window')).toEqual(
      expect.not.objectContaining({ heldByClosedWindow: true }),
    );
    expect(
      rows?.find((row) => row.clientTurnId === 'closed-window'),
    ).toMatchObject({ heldElsewhere: true, heldByClosedWindow: true });
  });

  it('restores the Project a chat was sending in when only its row survived', () => {
    projectOutboundQueueEntries([
      {
        ...turn('orphan-1', 'session-gone', 'from before the crash'),
        projectSlug: 'station',
        conversationId: 'session-gone',
      },
    ]);
    expect(activeChatsStore.getSnapshot()['session-gone']).toMatchObject({
      projectSlug: 'station',
      conversationId: 'session-gone',
    });
  });

  it('hydrates durable queued turns into visible chat state after restart', () => {
    activeChatsStore.initChat('session-1', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });

    projectOutboundQueueEntries([
      turn('turn-1', 'session-1', 'first queued turn'),
      turn('turn-2', 'session-1', 'second queued turn'),
    ]);

    expect(activeChatsStore.getSnapshot()['session-1']).toMatchObject({
      status: 'queued',
      outboundQueuedTurns: [
        {
          clientTurnId: 'turn-1',
          content: 'first queued turn',
          status: 'pending',
        },
        {
          clientTurnId: 'turn-2',
          content: 'second queued turn',
          status: 'pending',
        },
      ],
    });
  });

  it('clears the visible projection after the durable queue reconciles', () => {
    activeChatsStore.initChat('session-1', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
    projectOutboundQueueEntries([turn('turn-1', 'session-1', 'queued')]);

    projectOutboundQueueEntries([]);

    expect(activeChatsStore.getSnapshot()['session-1']).toMatchObject({
      status: 'idle',
      outboundQueuedTurns: [],
    });
  });

  it('preserves merge undo metadata across the durable-to-chat projection', () => {
    activeChatsStore.initChat('session-1', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
    const first = turn('first', 'session-1', 'first');
    const second = turn('second', 'session-1', 'second');
    const merged: QueuedOutboundTurn = {
      ...turn('merged', 'session-1', 'first\n\nsecond'),
      mergedTurns: [first, second],
    };

    projectOutboundQueueEntries([merged]);

    expect(
      activeChatsStore.getSnapshot()['session-1']!.outboundQueuedTurns![0]!
        .mergedTurns,
    ).toEqual([first, second]);
  });

  it('marks a pending row held back by an earlier not-sent row of its chat, and only those', () => {
    projectOutboundQueueEntries([
      { ...turn('first', 'session-order', 'refused'), status: 'failed' },
      turn('second', 'session-order', 'behind it'),
      turn('elsewhere', 'session-other', 'free to go'),
      {
        ...turn('unconfirmed', 'session-free', 'may have gone'),
        status: 'may-have-started',
      },
      turn('after-unconfirmed', 'session-free', 'not held back'),
    ]);
    const rows = Object.fromEntries(
      Object.values(activeChatsStore.getSnapshot()).flatMap(
        (chat) =>
          chat.outboundQueuedTurns?.map((row) => [
            row.clientTurnId,
            row.behindUnsent === true,
          ]) ?? [],
      ),
    );
    expect(rows).toEqual({
      first: false,
      second: true,
      elsewhere: false,
      unconfirmed: false,
      'after-unconfirmed': false,
    });
  });

  it('a message discarded in another window leaves this window too; a started one is recorded, not dropped', () => {
    activeChatsStore.initChat('session-b', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
    activeChatsStore.updateChat('session-b', {
      localSendKeys: ['gone', 'went'],
      messages: [
        {
          id: 'h',
          role: 'user',
          content: 'history',
          turnId: 't1',
          clientId: 'gone-but-started',
          timestamp: 1,
        },
        {
          id: 'gone',
          role: 'user',
          content: 'thrown away',
          clientId: 'gone',
          timestamp: 2,
        },
        {
          id: 'went',
          role: 'user',
          content: 'delivered',
          clientId: 'went',
          timestamp: 3,
        },
      ] as never,
    });
    projectOutboundQueueEntries([], {
      discarded: ['gone', 'gone-but-started'],
      accepted: ['went'],
    });
    const chat = activeChatsStore.getSnapshot()['session-b'];
    expect(chat?.messages?.map((message) => message.id)).toEqual(['h', 'went']);
    expect(chat?.deliveryChecks?.went).toBe('started');
    expect(chat?.localSendKeys).toEqual([]);
  });
});
