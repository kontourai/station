// @vitest-environment jsdom

import type { SteerTurnResult } from '@kontourai/station-contracts/orchestration';
import { describe, expect, it } from 'vitest';
import { steerRefusalMessage } from '../components/chat-dock/ChatDockBody';

/**
* archive#4075: `onSteer`'s outcome→message mapping
 * had no test coverage for ANY outcome before this — a two-way ternary's
 * catch-all silently absorbed the new `'concurrent-steer'` outcome and told
 * the user the turn had ENDED, which is false (the turn is still live;
 * another steer won the race). This exercises every non-`'steered'`
 * `SteerTurnResult` outcome against its exact copy.
 */
describe('steerRefusalMessage (station#4075 stage 2 review round 2)', () => {
  it('unsupported-engine names the engine', () => {
    const result: Exclude<SteerTurnResult, { outcome: 'steered' }> = {
      outcome: 'unsupported-engine',
      threadId: 'thread-1',
      engineId: 'codex' as never,
      engineName: 'Codex',
    };
    expect(steerRefusalMessage(result)).toBe(
      'Codex does not support mid-turn steering.',
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
});
