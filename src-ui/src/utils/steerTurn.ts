import type { SteerTurnResult } from '@kontourai/station-contracts/orchestration';

/**
 * The system-message copy for every `steerOrchestrationTurn` outcome OTHER
 * than `'steered'` (that one is a success — callers return without this).
 *
 * station#4075 stage 2 review round 2: this used to be a two-way ternary
 * (`unsupported-engine` vs. a catch-all "the turn ended before the steer
 * could be sent") — the additive-enum trap. Adding `'concurrent-steer'` to
 * `SteerTurnResult` fell into that catch-all and told the user the turn had
 * ENDED, which is false: the turn is still live, another steer just won the
 * race. Exhaustive `switch` with NO `default` case that returns a value —
 * the `never`-check in the (genuinely unreachable) fallback is what makes a
 * FUTURE outcome addition a compile error here instead of silent wrong copy.
 */
export function steerRefusalMessage(
  result: Exclude<SteerTurnResult, { outcome: 'steered' }>,
): string {
  switch (result.outcome) {
    case 'unsupported-engine':
      return `${result.engineName} does not support mid-turn steering.`;
    case 'no-active-turn':
      return 'The turn ended before the steer could be sent.';
    case 'concurrent-steer':
      return 'Another steer is in progress — try again in a moment.';
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
