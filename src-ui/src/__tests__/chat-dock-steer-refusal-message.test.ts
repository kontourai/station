// @vitest-environment jsdom

import type { SteerTurnResult } from '@kontourai/station-contracts/orchestration';
import { describe, expect, it } from 'vitest';
import { steerRefusalMessage } from '../utils/steerTurn';

/**
 * archive#4075: `onSteer`'s outcome→message mapping
 * had no test coverage for ANY outcome before this — a two-way ternary's
 * catch-all silently absorbed the new `'concurrent-steer'` outcome and told
 * the user the turn had ENDED, which is false (the turn is still live;
 * another steer won the race). This exercises every non-`'steered'`
 * `SteerTurnResult` outcome against its exact copy.
 */
describe('steerRefusalMessage (station#4075 stage 2 review round 2)', () => {
  it('indeterminate preserves uncertainty without inviting duplicate delivery', () => {
    const message = steerRefusalMessage({
      outcome: 'indeterminate',
      threadId: 'thread-1',
      clientInputId: 'input-1',
    });
    expect(message).toBe(
      'Steering delivery is unconfirmed. Your message is retained for review and will not be sent again automatically.',
    );
  });

  it('unsupported-engine names the engine', () => {
    const result: Exclude<SteerTurnResult, { outcome: 'steered' }> = {
      outcome: 'unsupported-engine',
      threadId: 'thread-1',
      engineId: 'muse' as never,
      engineName: 'Muse',
    };
    expect(steerRefusalMessage(result)).toBe(
      'Muse does not support mid-turn steering.',
    );
  });

  it('no-active-turn reports the turn as ended', () => {
    const result: Exclude<SteerTurnResult, { outcome: 'steered' }> = {
      outcome: 'no-active-turn',
      threadId: 'thread-1',
    };
    expect(steerRefusalMessage(result)).toBe(
      'The turn ended before the steer could be sent.',
    );
  });

  // The exact defect this round fixed: 'concurrent-steer' must NOT read as
  // "the turn ended" — the turn is live, a different steer won the race.
  it('concurrent-steer reports contention, never "the turn ended"', () => {
    const result: Exclude<SteerTurnResult, { outcome: 'steered' }> = {
      outcome: 'concurrent-steer',
      threadId: 'thread-1',
    };
    const message = steerRefusalMessage(result);
    expect(message).toBe(
      'Another steer is in progress — try again in a moment.',
    );
    expect(message).not.toMatch(/ended/i);
  });

  // #2898: a revoked grant keeps the running turn from being extended.
  it('confinement-changed says nothing was added and the message waits for a confined turn', () => {
    const result: Exclude<SteerTurnResult, { outcome: 'steered' }> = {
      outcome: 'confinement-changed',
      threadId: 'thread-1',
    };
    expect(steerRefusalMessage(result)).toBe(
      'Access to this conversation changed, so the running turn can’t take new instructions. Your message was not added to it and is kept for the next turn, which runs confined.',
    );
  });
});

// #2898 review: a newer server's outcome this build does not know must still
// render as a sentence, never as the result object.
describe('steerRefusalMessage for an outcome this build does not know', () => {
  it('returns a plain string', () => {
    const unknown = {
      outcome: 'a-future-outcome',
      threadId: 'thread-1',
    } as unknown as Exclude<SteerTurnResult, { outcome: 'steered' }>;
    expect(steerRefusalMessage(unknown)).toBe(
      'The steer was not sent. Your message is kept.',
    );
  });
});
