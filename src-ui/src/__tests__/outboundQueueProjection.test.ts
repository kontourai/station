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
});
