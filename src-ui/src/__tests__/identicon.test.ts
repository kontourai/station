import { describe, expect, test } from 'vitest';
import { identiconHue } from '../utils/identicon';

describe('identiconHue (station#1424)', () => {
  test('is stable across reloads and clients — pinned to the published FNV-1a vectors', () => {
    // FNV-1a 32-bit reference values ('a' -> 0xe40c292c, 'foobar' ->
    // 0xbf9cf968), reduced mod 360. A changed hash re-colours every agent on
    // every client, so the hue itself is the contract, not self-agreement.
    expect(identiconHue('a')).toBe(0xe40c292c % 360);
    expect(identiconHue('a')).toBe(340);
    expect(identiconHue('foobar')).toBe(0xbf9cf968 % 360);
    expect(identiconHue('foobar')).toBe(160);
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

  test('an empty seed takes the same hue as the fallback seed "agent"', () => {
    expect(identiconHue('')).toBe(identiconHue('agent'));
  });
});
