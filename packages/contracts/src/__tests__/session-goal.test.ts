import { describe, expect, test } from 'vitest';
import {
  parseSessionGoal,
  parseSessionGoalControlResult,
  parseSessionGoalRead,
} from '../session-goal.js';

const capability = {
  implementation: 'engine',
  operations: ['read', 'pause', 'clear'],
  maxObjectiveChars: 4000,
  tokenBudget: 'unsupported',
  completion: 'implementation-reported',
  saveState: 'paused',
} as const;

describe('session goal accounting figures', () => {
  test('a goal whose implementation reports no figures keeps them absent, never zero', () => {
    const goal = parseSessionGoal({ objective: 'Ship it', status: 'active' });
    expect(goal).toEqual({ objective: 'Ship it', status: 'active' });
    expect(goal).not.toHaveProperty('tokensUsed');
    expect(goal).not.toHaveProperty('timeUsedSeconds');
    expect(goal).not.toHaveProperty('tokenBudget');
  });

  test('reported figures, and a null budget (no budget), pass through', () => {
    expect(
      parseSessionGoal({
        objective: 'Ship it',
        status: 'paused',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 3,
      }),
    ).toEqual({
      objective: 'Ship it',
      status: 'paused',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 3,
    });
  });

  test('a present figure must still be a count', () => {
    for (const bad of [
      { tokensUsed: -1 },
      { timeUsedSeconds: 1.5 },
      { tokenBudget: 0 },
      { tokensUsed: '5' },
    ])
      expect(
        parseSessionGoal({ objective: 'Ship it', status: 'active', ...bad }),
      ).toBeNull();
  });

  test('a read and an applied result carry a figure-less goal, with an unsupported token budget', () => {
    const goal = { objective: 'Ship it', status: 'active' };
    expect(
      parseSessionGoalRead({ state: 'available', capability, goal }),
    ).toEqual({ state: 'available', capability, goal });
    expect(parseSessionGoalControlResult({ state: 'applied', goal })).toEqual({
      state: 'applied',
      goal,
    });
    expect(
      parseSessionGoalRead({
        state: 'available',
        capability: { ...capability, tokenBudget: 'ignored' },
        goal,
      }),
    ).toBeNull();
  });
});
