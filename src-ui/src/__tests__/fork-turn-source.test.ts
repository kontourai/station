import { describe, expect, test } from 'vitest';
import {
  forkTurnSource,
  precedingForkSource,
} from '../components/chat/fork-turn-source';
import type { ChatMessage } from '../types';

function user(content: string): ChatMessage {
  return { role: 'user', content } as ChatMessage;
}

function assistant(
  content: string,
  options: { turnId?: string; eligible?: boolean; agentSlug?: string } = {},
): ChatMessage {
  return {
    role: 'assistant',
    content,
    turnId: options.turnId,
    answerEligible: options.eligible,
    agentSlug: options.agentSlug ?? 'claude',
  } as ChatMessage;
}

describe('precedingForkSource', () => {
  test('returns the nearest preceding answer-eligible assistant turn', () => {
    const messages = [
      user('hello'),
      assistant('hi', { turnId: 'turn-1', eligible: true }),
      user('do it'),
      assistant('failed', { turnId: 'turn-2', eligible: false }),
    ];
    expect(precedingForkSource(messages, 2)).toEqual({
      turnId: 'turn-1',
      agentSlug: 'claude',
      sessionId: undefined,
      provider: undefined,
      model: undefined,
    });
  });

  test('is null when every preceding assistant turn failed', () => {
    const messages = [
      user('hello'),
      assistant('failed', { turnId: 'turn-1', eligible: false }),
    ];
    expect(precedingForkSource(messages, 0)).toBeNull();
    expect(forkTurnSource(messages[1]!)).toBeNull();
  });
});
