/**
 * @vitest-environment jsdom
 *
 * archive#1294: one failed turn used to be able to render the SAME failure
 * text twice — once via the `[SYSTEM_EVENT] [CHAT_ERROR]` marker
 * `handleRuntimeErrorEvent` appends to `chat.messages`, and again as a
 * normally-invisible assistant bubble if a later `turn.completed` for the
 * same thread committed the streaming shell's error text (appended purely so
 * the shell doesn't render blank in error state) via `finalizeAssistantTurn`.
 * These pin the guard that drops that duplicate commit.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { finalizeAssistantTurn } from '../hooks/orchestration/assistantTurn';
import {
  handleRuntimeErrorEvent,
  handleTurnCompletedEvent,
} from '../hooks/orchestration/turnHandlers';

const THREAD_ID = 'duplicate-error-text-thread';

describe('finalizeAssistantTurn (station#1294)', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Claude Chat',
    });
  });

  test('drops a turn.completed commit whose only content is the error text runtime.error already surfaced', () => {
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      message: 'Station agent did not accept the task turn.',
    } as any);

    // Sanity: the runtime.error handler did its own job — durable-style
    // client marker present, error state set.
    const afterError = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(afterError.status).toBe('error');
    expect(afterError.messages).toHaveLength(1);
    expect(afterError.messages?.[0].content).toContain('[CHAT_ERROR]');

    // Some adapters still emit a terminal turn.completed after the error.
    // Without the guard this would append a SECOND rendering of the exact
    // same failure text as a plain assistant bubble.
    handleTurnCompletedEvent('http://localhost', {
      threadId: THREAD_ID,
      method: 'turn.completed',
    } as any);

    const after = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(after.messages).toHaveLength(1);
    expect(after.messages?.some((m) => m.role === 'assistant')).toBe(false);
    expect(after.streamingMessage).toBeUndefined();
    expect(after.status).toBe('idle');
  });

  test('still commits a genuine assistant reply on an ordinary (non-error) turn', () => {
    activeChatsStore.updateChat(THREAD_ID, {
      streamingMessage: {
        role: 'assistant',
        content: '',
        contentParts: [{ type: 'text', content: 'Here is the answer.' }],
      },
    });

    finalizeAssistantTurn(THREAD_ID);

    const after = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(after.messages).toHaveLength(1);
    expect(after.messages?.[0]).toMatchObject({
      role: 'assistant',
      content: 'Here is the answer.',
    });
  });

  // archive#1294: `content` only ever joins text/reasoning
  // parts, so a turn that made a tool call but narrated no text before
  // erroring also reduces `content` to exactly `chat.error` — the guard must
  // not discard the whole message (and its tool-invocation record) in that
  // case, only the duplicated error text.
  test('a tool-invocation part survives even when the turn narrated no text (content reduces to exactly chat.error)', () => {
    activeChatsStore.updateChat(THREAD_ID, {
      status: 'error',
      error: 'Station agent did not accept the task turn.',
      streamingMessage: {
        role: 'assistant',
        content: '',
        contentParts: [
          {
            type: 'tool-invocation',
            toolCallId: 'tool-1',
            toolName: 'search',
            args: { query: 'weather' },
            state: 'result',
          },
          {
            type: 'text',
            content: 'Station agent did not accept the task turn.',
          },
        ],
      },
    });

    finalizeAssistantTurn(THREAD_ID);

    const after = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(after.messages).toHaveLength(1);
    const committed = after.messages?.[0];
    expect(committed?.role).toBe('assistant');
    // The tool-invocation record survives...
    expect(committed?.contentParts).toEqual([
      {
        type: 'tool-invocation',
        toolCallId: 'tool-1',
        toolName: 'search',
        args: { query: 'weather' },
        state: 'result',
      },
    ]);
    //.but the duplicated error text does not render a second time.
    expect(committed?.content).toBe('');
    expect(committed?.contentParts?.some((part) => part.type === 'text')).toBe(
      false,
    );
  });

  test('still commits assistant content that happens to follow an error state but is not identical to the recorded error text', () => {
    activeChatsStore.updateChat(THREAD_ID, {
      status: 'error',
      error: 'Station agent did not accept the task turn.',
      streamingMessage: {
        role: 'assistant',
        content: '',
        contentParts: [
          { type: 'text', content: 'Partial output before the failure.' },
        ],
      },
    });

    finalizeAssistantTurn(THREAD_ID);

    const after = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(after.messages).toHaveLength(1);
    expect(after.messages?.[0]).toMatchObject({
      role: 'assistant',
      content: 'Partial output before the failure.',
    });
  });
});
