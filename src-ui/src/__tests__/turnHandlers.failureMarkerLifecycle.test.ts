/**
 * @vitest-environment jsdom
 *
 * a `[CHAT_ERROR]` marker is a statement
 * about ONE turn, and nothing ever removed it. A later successful turn
 * appended its answer beside the stale failure card, and a second failure left
 * two cards with different wording claiming the same conversation.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { finalizeAssistantTurn } from '../hooks/orchestration/assistantTurn';
import {
  handleRuntimeErrorEvent,
  handleTurnAbortedEvent,
} from '../hooks/orchestration/turnHandlers';

const THREAD_ID = 'failure-marker-lifecycle';

function markers() {
  return (activeChatsStore.getSnapshot()[THREAD_ID]?.messages ?? []).filter(
    (message) =>
      (message.content ?? '').startsWith('[SYSTEM_EVENT] [CHAT_ERROR'),
  );
}

describe('failure marker lifecycle', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Claude Chat',
    });
  });

  test('a failure card is tagged with the turn it is about', () => {
    activeChatsStore.updateChat(THREAD_ID, { openTurnId: 'turn-1' });
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      message: 'engine died',
    } as never);

    expect(markers()).toHaveLength(1);
    expect(markers()[0]?.turnId).toBe('turn-1');
  });

  test('failure then success leaves no stale card', () => {
    activeChatsStore.updateChat(THREAD_ID, { openTurnId: 'turn-1' });
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      message: 'engine died',
    } as never);
    expect(markers()).toHaveLength(1);

    activeChatsStore.updateChat(THREAD_ID, {
      openTurnId: 'turn-2',
      streamingMessage: {
        role: 'assistant',
        content: '',
        contentParts: [{ type: 'text', content: 'here is your answer' }],
      } as never,
    });
    finalizeAssistantTurn(THREAD_ID, { turnId: 'turn-2' } as never);

    expect(markers()).toHaveLength(0);
    const messages = activeChatsStore.getSnapshot()[THREAD_ID]?.messages ?? [];
    expect(messages.at(-1)?.content).toContain('here is your answer');
  });

  test('an old failure is replaced by a new one — one card, the newer', () => {
    activeChatsStore.updateChat(THREAD_ID, { openTurnId: 'turn-1' });
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      message: 'first failure',
    } as never);

    activeChatsStore.updateChat(THREAD_ID, { openTurnId: 'turn-2' });
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      message: 'second, differently worded failure',
    } as never);

    const current = markers();
    expect(current).toHaveLength(1);
    expect(current[0]?.content).toContain('second, differently worded failure');
    expect(current[0]?.turnId).toBe('turn-2');
  });

  test('an attributed failure keeps its own turn id over the open one', () => {
    activeChatsStore.updateChat(THREAD_ID, { openTurnId: 'turn-open' });
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      turnId: 'turn-named',
      message: 'a turn-scoped failure',
    } as never);

    expect(markers()[0]?.turnId).toBe('turn-named');
  });

  test('a failure with no turn context at all is left unscoped and never pruned', () => {
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      message: 'no turn context',
    } as never);
    expect(markers()[0]?.turnId).toBeUndefined();

    activeChatsStore.updateChat(THREAD_ID, {
      openTurnId: 'turn-later',
      streamingMessage: {
        role: 'assistant',
        content: '',
        contentParts: [{ type: 'text', content: 'later answer' }],
      } as never,
    });
    finalizeAssistantTurn(THREAD_ID, { turnId: 'turn-later' } as never);

    expect(markers()).toHaveLength(1);
  });

  test('a child Session abort cannot revoke a predecessor answer with the same turn id', () => {
    activeChatsStore.updateChat(THREAD_ID, {
      messages: [
        {
          role: 'assistant',
          content: 'predecessor answer',
          turnId: 'shared-turn',
          sessionId: 'predecessor-session',
          answerEligible: true,
        },
        {
          role: 'assistant',
          content: 'child answer',
          turnId: 'shared-turn',
          sessionId: THREAD_ID,
          answerEligible: true,
        },
      ],
    });
    handleTurnAbortedEvent({
      threadId: THREAD_ID,
      turnId: 'shared-turn',
      method: 'turn.aborted',
      reason: 'child cancelled',
    } as never);
    const messages = activeChatsStore.getSnapshot()[THREAD_ID]?.messages ?? [];
    expect(messages).toContainEqual(
      expect.objectContaining({
        content: 'predecessor answer',
        sessionId: 'predecessor-session',
        answerEligible: true,
      }),
    );
    const child = messages.find(
      (message) => message.content === 'child answer',
    );
    expect(child?.sessionId).toBe(THREAD_ID);
    expect(child?.answerEligible).toBeUndefined();
  });
});
