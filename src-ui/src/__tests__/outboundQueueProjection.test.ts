// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { isTurnInFlight } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { projectOutboundQueueEntries } from '../hooks/outboundQueueProjection';
import type {
  OutboundStationIdentity,
  QueuedOutboundTurn,
} from '../lib/outboundQueue';
import { reportOutboundQueueUnavailable } from '../lib/outboundQueueReporting';

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
  const remote: OutboundStationIdentity = {
    apiBase: 'https://source.test/relay/b',
    environmentId: 'b',
    authorityNamespace: 'source:principal-b',
    binding: {
      version: 1,
      environmentId: 'b',
      stationName: 'B',
      affinity: {
        kind: 'peer',
        sourceEnvironmentId: 'source',
        sourceConnectionId: 'profile',
        principalNamespace: 'principal-b',
      },
    },
  };
  beforeEach(() => {
    for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
      activeChatsStore.removeChat(sessionId);
    }
  });

  it('retains readable peer delivery while unavailable without changing a host chat or inventing a running turn', () => {
    activeChatsStore.initChat('host', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Host',
    });
    activeChatsStore.updateChat('host', {
      status: 'sending',
      orchestrationTurnOpen: true,
    });
    projectOutboundQueueEntries(
      [
        {
          ...turn('same', 'peer', 'retained text'),
          station: remote,
          conversationId: 'same-conversation',
          status: 'invoking',
        },
      ],
      undefined,
      undefined,
      remote,
    );
    expect(activeChatsStore.getSnapshot().peer).toMatchObject({
      stationBinding: remote.binding,
      outboundQueuedTurns: [
        { content: 'retained text', waitingForStation: remote.apiBase },
      ],
    });
    expect(isTurnInFlight(activeChatsStore.getSnapshot().peer)).toBe(false);
    expect(activeChatsStore.getSnapshot().host).toMatchObject({
      status: 'sending',
      orchestrationTurnOpen: true,
    });
  });

  it('settles retired bubbles only in the owning conversation and Station', () => {
    for (const [id, conversationId] of [
      ['one', 'one'],
      ['two', 'two'],
      ['host', 'one'],
    ]) {
      activeChatsStore.initChat(id, {
        agentSlug: 'assistant',
        agentName: 'Assistant',
        title: id,
        conversationId,
        ...(id !== 'host' ? { stationBinding: remote.binding } : {}),
      });
      activeChatsStore.updateChat(id, {
        messages: [
          { id: 'bubble', role: 'user', content: id, clientId: 'same' },
        ],
      });
    }
    projectOutboundQueueEntries(
      [],
      {
        accepted: ['same'],
        discarded: [],
        byConversation: { one: { accepted: ['same'], discarded: [] } },
      },
      undefined,
      remote,
    );
    expect(activeChatsStore.getSnapshot().one?.deliveryChecks?.same).toBe(
      'started',
    );
    expect(
      activeChatsStore.getSnapshot().two?.deliveryChecks?.same,
    ).toBeUndefined();
    expect(
      activeChatsStore.getSnapshot().host?.deliveryChecks?.same,
    ).toBeUndefined();
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

  it('does not call a chat queued when Station accepted every message left in its outbox', () => {
    activeChatsStore.initChat('session-1', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
    projectOutboundQueueEntries([turn('turn-1', 'session-1', 'replayed')]);
    expect(activeChatsStore.getSnapshot()['session-1']?.status).toBe('queued');

    // Station accepted it: the row only waits for its turn to end.
    const accepted = {
      ...turn('turn-1', 'session-1', 'replayed'),
      status: 'accepted' as const,
      providerTurnId: 'provider-turn-1',
    };
    projectOutboundQueueEntries([accepted]);
    expect(activeChatsStore.getSnapshot()['session-1']).toMatchObject({
      status: 'idle',
      outboundQueuedTurns: [{ clientTurnId: 'turn-1', status: 'accepted' }],
    });

    // The turn it started is running: a later projection leaves that alone.
    activeChatsStore.updateChat('session-1', { status: 'sending' });
    projectOutboundQueueEntries([accepted]);
    expect(activeChatsStore.getSnapshot()['session-1']?.status).toBe('sending');

    // A message still waiting behind it keeps the chat queued.
    projectOutboundQueueEntries([
      accepted,
      turn('turn-2', 'session-1', 'waiting'),
    ]);
    expect(activeChatsStore.getSnapshot()['session-1']?.status).toBe('queued');
  });

  it('reports an outbox outage only on a chat that holds an outbox message and has no turn in flight', () => {
    for (const id of ['holder', 'streaming', 'bystander', 'failed-elsewhere'])
      activeChatsStore.initChat(id, {
        agentSlug: 'assistant',
        agentName: 'Assistant',
        title: id,
      });
    projectOutboundQueueEntries([
      turn('turn-1', 'holder', 'waiting'),
      turn('turn-2', 'streaming', 'waiting'),
    ]);
    activeChatsStore.updateChat('streaming', {
      status: 'sending',
      orchestrationTurnOpen: true,
    });
    activeChatsStore.updateChat('failed-elsewhere', {
      status: 'error',
      error: 'The engine stopped.',
    });

    reportOutboundQueueUnavailable('IndexedDB is unavailable');

    expect(activeChatsStore.getSnapshot().holder).toMatchObject({
      status: 'error',
      error: expect.stringContaining('delivery status is unavailable'),
    });
    expect(activeChatsStore.getSnapshot().streaming).toMatchObject({
      status: 'sending',
    });
    expect(activeChatsStore.getSnapshot().streaming?.error ?? null).toBeNull();
    expect(activeChatsStore.getSnapshot().bystander?.status).not.toBe('error');
    expect(activeChatsStore.getSnapshot().bystander?.error ?? null).toBeNull();
    expect(activeChatsStore.getSnapshot()['failed-elsewhere']).toMatchObject({
      status: 'error',
      error: 'The engine stopped.',
    });
  });

  it("clears an outbox outage report at the next successful read, and never a chat's own error", () => {
    for (const id of ['holder', 'drained', 'failed-elsewhere'])
      activeChatsStore.initChat(id, {
        agentSlug: 'assistant',
        agentName: 'Assistant',
        title: id,
      });
    const rows = [
      turn('turn-1', 'holder', 'waiting'),
      turn('turn-2', 'drained', 'waiting'),
      turn('turn-3', 'failed-elsewhere', 'waiting'),
    ];
    projectOutboundQueueEntries(rows);
    reportOutboundQueueUnavailable('IndexedDB is unavailable');
    activeChatsStore.updateChat('failed-elsewhere', {
      status: 'error',
      error: 'The engine stopped.',
    });

    // The queue reads again: one chat still holds its message, the others'
    // messages have gone.
    projectOutboundQueueEntries([rows[0]!]);

    expect(activeChatsStore.getSnapshot().holder?.status).toBe('queued');
    expect(activeChatsStore.getSnapshot().holder?.error ?? null).toBeNull();
    expect(activeChatsStore.getSnapshot().drained?.status).toBe('idle');
    expect(activeChatsStore.getSnapshot().drained?.error ?? null).toBeNull();
    expect(activeChatsStore.getSnapshot()['failed-elsewhere']).toMatchObject({
      status: 'error',
      error: 'The engine stopped.',
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
      status: 'queued',
      ephemeralMessages: [
        {
          id: 'retry',
          role: 'system',
          content: 'Queued to retry automatically',
          timestamp: 1,
          queuedRetry: true,
        },
        {
          id: 'interrupted',
          role: 'system',
          content: 'Turn interrupted',
          timestamp: 1,
        },
      ],
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
    expect(chat?.ephemeralMessages?.map((message) => message.id)).toEqual([
      'interrupted',
    ]);
    expect(chat?.status).toBe('idle');
  });
});
