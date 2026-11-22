import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionLadderWord } from '@kontourai/station-contracts/session-attention';
import { describe, expect, test } from 'vitest';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * A turn the engine ended at its output limit completed, but its reply is
 * incomplete. The summary records that, and the status ladder words the
 * Session Cut off instead of Done.
 */
const THREAD = 'thread-cut-off';

function started(sequence: number): CanonicalRuntimeEvent {
  return {
    eventId: `evt-${sequence}`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: `2026-11-10T10:00:0${sequence}.000Z`,
    method: 'turn.started',
    turnId: `turn-${sequence}`,
    prompt: 'Write a long reply.',
  } as CanonicalRuntimeEvent;
}

function completed(
  sequence: number,
  turn: number,
  finishReason: 'stop' | 'max-tokens' | undefined,
): CanonicalRuntimeEvent {
  return {
    eventId: `evt-${sequence}`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: `2026-11-10T10:00:0${sequence}.000Z`,
    method: 'turn.completed',
    turnId: `turn-${turn}`,
    ...(finishReason ? { finishReason } : {}),
    outputText: 'This reply runs out of room before it can',
  } as CanonicalRuntimeEvent;
}

function summarize(events: CanonicalRuntimeEvent[]) {
  const persisted: ProviderSession = {
    provider: 'claude',
    threadId: THREAD,
    status: 'ready',
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
  };
  return buildOrchestrationSessionSummary({
    persisted,
    answerability: {
      threadAttachment: 'detached',
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-11-10T10:00:00.000Z',
    },
    events,
  });
}

describe('lastTurnCutOff on the session summary', () => {
  test('a turn that completed at the output limit reads Cut off, not Done', () => {
    const summary = summarize([started(1), completed(2, 1, 'max-tokens')]);
    expect(summary.lastTurnCutOff).toBe('max-tokens');
    expect(sessionLadderWord(summary)).toBe('Cut off');
  });

  test('an ordinary or unreported finish reads Done', () => {
    for (const reason of ['stop', undefined] as const) {
      const summary = summarize([started(1), completed(2, 1, reason)]);
      expect(summary).not.toHaveProperty('lastTurnCutOff');
      expect(sessionLadderWord(summary)).toBe('Done');
    }
  });

  test('a later turn clears it, whether running or finished normally', () => {
    const running = summarize([
      started(1),
      completed(2, 1, 'max-tokens'),
      started(3),
    ]);
    expect(running).not.toHaveProperty('lastTurnCutOff');
    const finished = summarize([
      started(1),
      completed(2, 1, 'max-tokens'),
      started(3),
      completed(4, 3, 'stop'),
    ]);
    expect(finished).not.toHaveProperty('lastTurnCutOff');
    expect(sessionLadderWord(finished)).toBe('Done');
  });
});
