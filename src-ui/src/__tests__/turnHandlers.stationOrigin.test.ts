// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';

const threadId = 'task:delegated-child';
const internalOrigin = {
  version: 1,
  actor: { kind: 'internal' },
  reported: { version: 1, surface: 'unknown', build: null },
};

function liveUserRow(fields: Record<string, unknown>) {
  handleTurnStartedEvent({
    eventId: `turn-${String(fields.turnId)}`,
    provider: 'claude',
    threadId,
    createdAt: '2026-11-25T00:00:00.000Z',
    method: 'turn.started',
    prompt: '# Task brief: fix the flaky login test',
    ...fields,
  } as any);
  return activeChatsStore
    .getChatForExecutionSession(threadId)
    ?.messages?.find(
      (message) => message.role === 'user' && message.turnId === fields.turnId,
    );
}

describe('a live turn a Station flow sent names that flow', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(threadId);
    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Delegated child',
      agentConnectionId: 'claude',
      provider: 'claude',
    });
  });

  test('the delegated brief arriving live is marked as the delegation’s', () => {
    expect(
      liveUserRow({
        turnId: 'brief',
        clientOrigin: internalOrigin,
        dispatchOrigin: 'delegation',
      })?.stationOrigin,
    ).toBe('delegation');
  });

  test('a person’s live turn is not marked', () => {
    expect(
      liveUserRow({
        turnId: 'person',
        clientOrigin: { ...internalOrigin, actor: { kind: 'device' } },
        dispatchOrigin: 'interactive',
        authoredBy: 'person',
      })?.stationOrigin,
    ).toBeUndefined();
  });
});
