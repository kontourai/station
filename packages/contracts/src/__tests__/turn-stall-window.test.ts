import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TURN_STALL_WINDOW_MS,
  resolveTurnStallWindowMs,
} from '../turn-stall-window.js';

describe('resolveTurnStallWindowMs', () => {
  test('resolves the declared default when no execution config is given', () => {
    expect(resolveTurnStallWindowMs()).toBe(DEFAULT_TURN_STALL_WINDOW_MS);
  });

  test('resolves the declared default when the agent authors no override', () => {
    expect(resolveTurnStallWindowMs({})).toBe(DEFAULT_TURN_STALL_WINDOW_MS);
  });

  test('resolves a real per-agent AgentExecutionConfig override', () => {
    expect(
      resolveTurnStallWindowMs({
        turnStallWindowMs: 45_000,
      }),
    ).toBe(45_000);
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'treats a %s override as unauthored rather than disabling detection',
    (_label, value) => {
      expect(resolveTurnStallWindowMs({ turnStallWindowMs: value })).toBe(
        DEFAULT_TURN_STALL_WINDOW_MS,
      );
    },
  );
});
