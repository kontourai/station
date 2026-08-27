import { describe, expect, test } from 'vitest';
import { DEFAULT_MAX_STEPS, resolveMaxSteps } from '../constants.js';

describe('resolveMaxSteps', () => {
  test('falls back to the no-artificial-limit default when nothing is set', () => {
    // VoltAgent's own default is a stingy 10; Station imposes no artificial limit.
    expect(resolveMaxSteps({})).toBe(DEFAULT_MAX_STEPS);
    expect(DEFAULT_MAX_STEPS).toBeGreaterThanOrEqual(200);
  });

  test('honors precedence: guardrails > spec > app config', () => {
    expect(
      resolveMaxSteps({
        guardrailsMaxSteps: 3,
        specMaxSteps: 5,
        defaultMaxTurns: 7,
      }),
    ).toBe(3);
    expect(resolveMaxSteps({ specMaxSteps: 5, defaultMaxTurns: 7 })).toBe(5);
    expect(resolveMaxSteps({ defaultMaxTurns: 7 })).toBe(7);
  });

  test('treats 0 / undefined at any level as "not set" and falls through', () => {
    // maxSteps is a positive cap, so 0 never means "unlimited" — it falls through.
    expect(resolveMaxSteps({ guardrailsMaxSteps: 0, specMaxSteps: 0 })).toBe(
      DEFAULT_MAX_STEPS,
    );
    expect(resolveMaxSteps({ guardrailsMaxSteps: 0, defaultMaxTurns: 9 })).toBe(
      9,
    );
  });
});
