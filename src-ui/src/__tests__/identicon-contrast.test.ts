import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrastRatio } from '../lib/accent-contrast';

/**
 * Gates the identicon swatch's actual CSS tokens against WCAG AA (station
 * archive#1424 3) — reads `BrandIcon.css` itself rather than
 * duplicating its numbers here, so a future edit to those tokens is caught
 * by THIS test instead of silently reintroducing the low-contrast defect
 * (archive#1125/archive#1167 precedent: nothing previously gated this class of bug).
 *
 * Only h=0/60/120/180/240/300 are possible local extrema of relative
 * luminance over the hue wheel at a fixed saturation/lightness (RGB moves
 * linearly with hue within each 60° sector, so luminance — a linear
 * combination of RGB — can only extremize at the sector boundaries); h=60
 * is analytically the worst case for a white-text-on-swatch pairing (see
 * BrandIcon.css's doc comment). The review asked for 60/120/180
 * specifically — covered here, with 60 carrying the real risk.
 */

/** `[h, s, l]` in degrees/0-1 -> `[r, g, b]` in 0-255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hPrime = (((h % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    hPrime < 1
      ? [c, x, 0]
      : hPrime < 2
        ? [x, c, 0]
        : hPrime < 3
          ? [0, c, x]
          : hPrime < 4
            ? [0, x, c]
            : hPrime < 5
              ? [x, 0, c]
              : [c, 0, x];
  const channel = (v: number) => Math.round((v + m) * 255);
  return [channel(r1), channel(g1), channel(b1)];
}

/** WCAG ratio of white text on an HSL swatch, through the product's own math. */
function whiteOnHslContrast(h: number, s: number, l: number): number {
  const hex = `#${hslToRgb(h, s, l)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
  const ratio = contrastRatio('#ffffff', hex);
  if (ratio === null) throw new Error(`not a hex color: ${hex}`);
  return ratio;
}

const cssPath = path.resolve(__dirname, '../components/icons/BrandIcon.css');
const css = readFileSync(cssPath, 'utf-8');

function extractTokens(blockPattern: RegExp): {
  saturation: number;
  lightness: number;
} {
  const blockMatch = css.match(blockPattern);
  if (!blockMatch) {
    throw new Error(
      `identicon-contrast.test.ts: could not locate a CSS block matching ${blockPattern} in BrandIcon.css — has the theme-token block been renamed/restructured?`,
    );
  }
  const body = blockMatch[1];
  const saturationMatch = body.match(/--identicon-saturation:\s*([\d.]+)%/);
  const lightnessMatch = body.match(/--identicon-lightness:\s*([\d.]+)%/);
  if (!saturationMatch || !lightnessMatch) {
    throw new Error(
      'identicon-contrast.test.ts: located the theme block but could not find --identicon-saturation/--identicon-lightness inside it.',
    );
  }
  return {
    saturation: Number(saturationMatch[1]) / 100,
    lightness: Number(lightnessMatch[1]) / 100,
  };
}

const darkTokens = extractTokens(
  /:root,\s*\[data-theme="dark"\]\s*\{([^}]*)\}/,
);
const lightTokens = extractTokens(/\[data-theme="light"\]\s*\{([^}]*)\}/);

const WORST_CASE_HUES = [60, 120, 180] as const;
const WCAG_AA_NORMAL_TEXT = 4.5;

describe('identicon swatch contrast gate (station#1424 review round 3, NEW-3)', () => {
  test('sanity: the CSS parse actually found non-zero tokens for both themes (a silently-empty match would make every ratio below vacuously pass)', () => {
    expect(darkTokens.saturation).toBeGreaterThan(0);
    expect(darkTokens.lightness).toBeGreaterThan(0);
    expect(lightTokens.saturation).toBeGreaterThan(0);
    expect(lightTokens.lightness).toBeGreaterThan(0);
  });

  test('the HSL conversion resolves known primaries', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hslToRgb(120, 1, 0.5)).toEqual([0, 255, 0]);
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]);
    expect(hslToRgb(0, 0, 1)).toEqual([255, 255, 255]);
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]);
  });

  test("the gate can go red: the light theme's ORIGINAL 50%/42% pair fails AA at hue 60 (round 3)", () => {
    // The exact defect the review reported, the pre-fix BrandIcon.css
    // light-theme pair. If the ratio math stopped discriminating, the AA
    // rows below would pass vacuously.
    expect(whiteOnHslContrast(60, 0.5, 0.42)).toBeLessThan(WCAG_AA_NORMAL_TEXT);
  });

  test.each(WORST_CASE_HUES)(
    'dark theme: white initials stay >= 4.5:1 (WCAG AA) at hue %i',
    (hue) => {
      const ratio = whiteOnHslContrast(
        hue,
        darkTokens.saturation,
        darkTokens.lightness,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );

  test.each(WORST_CASE_HUES)(
    'light theme: white initials stay >= 4.5:1 (WCAG AA) at hue %i',
    (hue) => {
      const ratio = whiteOnHslContrast(
        hue,
        lightTokens.saturation,
        lightTokens.lightness,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );
});
