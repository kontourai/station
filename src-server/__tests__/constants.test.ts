import { describe, expect, test } from 'vitest';
import { DEFAULT_MAX_STEPS, resolveMaxSteps } from '../constants.js';

describe('resolveMaxSteps', () => {
  test('uses the finite VoltAgent fallback when no cap is configured', () => {
    expect(resolveMaxSteps({})).toBe(DEFAULT_MAX_STEPS);
    expect(DEFAULT_MAX_STEPS).toBe(200);
  });

  test('an authored cap takes precedence over the Station fallback', () => {
    expect(resolveMaxSteps({ specMaxSteps: 5, defaultMaxTurns: 7 })).toBe(5);
    expect(resolveMaxSteps({ defaultMaxTurns: 7 })).toBe(7);
  });

  test('null and historical zero values fall through', () => {
    expect(resolveMaxSteps({ specMaxSteps: null, defaultMaxTurns: 9 })).toBe(9);
    expect(resolveMaxSteps({ specMaxSteps: 0, defaultMaxTurns: 0 })).toBe(
      DEFAULT_MAX_STEPS,
    );
  });
});
