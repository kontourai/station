import { describe, expect, it } from 'vitest';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import { latestTurnOutputText } from '../sessionFinalOutput';

function ev(partial: Record<string, unknown>): OrchestrationEvent {
  return {
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-08-29T00:00:00.000Z',
    ...partial,
  } as unknown as OrchestrationEvent;
}

describe('latestTurnOutputText', () => {
  it('returns the latest completed turn output text', () => {
    const events = [
      ev({ method: 'turn.started', turnId: 't1' }),
      ev({
        method: 'turn.completed',
        turnId: 't1',
        finishReason: 'stop',
        outputText: 'first answer',
      }),
      ev({ method: 'turn.started', turnId: 't2' }),
      ev({
        method: 'turn.completed',
        turnId: 't2',
        finishReason: 'stop',
        outputText: 'second answer',
      }),
    ];
    expect(latestTurnOutputText(events)).toBe('second answer');
  });

  it('returns null when no turn has completed', () => {
    expect(
      latestTurnOutputText([ev({ method: 'turn.started', turnId: 't1' })]),
    ).toBe(null);
    expect(latestTurnOutputText([])).toBe(null);
  });

  // A cancelled turn's outputText is the partial stream that had arrived
  // before the abort — it must never present as the final answer, and the
  // projection must not fall back to a superseded earlier answer either.
  it('does not present a cancelled turn partial text as the final answer', () => {
    const events = [
      ev({
        method: 'turn.completed',
        turnId: 't1',
        finishReason: 'stop',
        outputText: 'earlier full answer',
      }),
      ev({ method: 'turn.started', turnId: 't2' }),
      ev({
        method: 'turn.completed',
        turnId: 't2',
        finishReason: 'cancelled',
        outputText: 'partial text cut off mid-',
      }),
    ];
    expect(latestTurnOutputText(events)).toBe(null);
  });

  // Do not fall back past the LATEST terminal turn: when it reported no
  // presentable text, render nothing rather than a previous turn's answer.
  it('renders nothing when the latest terminal turn has no presentable text', () => {
    const events = [
      ev({
        method: 'turn.completed',
        turnId: 't1',
        finishReason: 'stop',
        outputText: 'earlier full answer',
      }),
      ev({
        method: 'turn.completed',
        turnId: 't2',
        finishReason: 'stop',
        outputText: '   ',
      }),
    ];
    expect(latestTurnOutputText(events)).toBe(null);
    const noText = [
      ev({
        method: 'turn.completed',
        turnId: 't1',
        finishReason: 'stop',
        outputText: 'earlier full answer',
      }),
      ev({ method: 'turn.completed', turnId: 't2', finishReason: 'stop' }),
    ];
    expect(latestTurnOutputText(noText)).toBe(null);
  });
});
