import { describe, expect, test } from 'vitest';
import {
  contrastRatio,
  hslToRgb,
  relativeLuminance,
  whiteOnHslContrast,
} from '../utils/color-contrast';

describe('color-contrast primitives (station#1424 review round 3, NEW-3)', () => {
  test('hslToRgb resolves known primaries', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]); // red
    expect(hslToRgb(120, 1, 0.5)).toEqual([0, 255, 0]); // green
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]); // blue
    expect(hslToRgb(0, 0, 1)).toEqual([255, 255, 255]); // white
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]); // black
  });

  test('relativeLuminance is 1 for white and 0 for black', () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 5);
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 5);
  });

  test('contrastRatio(white, black) is the maximum, 21:1', () => {
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 1);
  });

  test('contrastRatio is order-independent (max/min, not first/second)', () => {
    expect(contrastRatio(0.2, 0.8)).toBeCloseTo(contrastRatio(0.8, 0.2), 10);
  });

  test('whiteOnHslContrast: white text on a white swatch is 1:1 (no contrast)', () => {
    expect(whiteOnHslContrast(0, 0, 1)).toBeCloseTo(1, 1);
  });

  test('whiteOnHslContrast: white text on a black swatch is ~21:1', () => {
    expect(whiteOnHslContrast(0, 0, 0)).toBeCloseTo(21, 1);
  });

  test("whiteOnHslContrast: reproduces the reported round-3 regression — light theme's ORIGINAL 50%/42% pair fails AA at hue 60", () => {
    // This is the exact defect the review reported (NEW-3): the pre-fix
    // BrandIcon.css light-theme token pair, checked directly here so the
    // regression is provably real and not just asserted by the fix.
    const ratio = whiteOnHslContrast(60, 0.5, 0.42);
    expect(ratio).toBeLessThan(4.5);
  });
});
