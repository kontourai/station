import { describe, expect, test } from 'vitest';
import { identiconHue } from '../utils/identicon';

describe('identiconHue (station#1424)', () => {
  test('is deterministic — the same seed always yields the same hue', () => {
    expect(identiconHue('claude-code')).toBe(identiconHue('claude-code'));
    expect(identiconHue('my-agent-slug')).toBe(identiconHue('my-agent-slug'));
  });

  test('different seeds typically yield different hues', () => {
    expect(identiconHue('agent-one')).not.toBe(identiconHue('agent-two'));
  });

  test('always returns a value in [0, 360)', () => {
    for (const seed of ['a', 'agent-slug', '__agent:conn-1', '', 'ünïcode']) {
      const hue = identiconHue(seed);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  test('an empty seed still resolves deterministically rather than throwing', () => {
    expect(() => identiconHue('')).not.toThrow();
    expect(identiconHue('')).toBe(identiconHue(''));
  });
});
