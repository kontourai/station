/** @vitest-environment jsdom */

import { describe, expect, test } from 'vitest';
import { ACCENT_PRESETS } from '../../views/settings/AccentColorPicker';
import {
  ACCENT_CONTRAST_DARK,
  ACCENT_CONTRAST_LIGHT,
  accentContrastColor,
  accentHoverFill,
  applyAccentColor,
  contrastRatio,
  relativeLuminance,
} from '../accent-contrast';

/**
 * archive#3305 finding: `--text-on-accent` named a derivation nothing
 * computed. These pin the derivation itself (both ends of the luminance
 * range), the AA outcome for every shipped preset, and the fact that the two
 * custom properties are applied and cleared together.
 */

describe('accentContrastColor', () => {
  test('gives a dark accent light text and a light accent dark text', () => {
    expect(accentContrastColor('#000000')).toBe(ACCENT_CONTRAST_LIGHT);
    expect(accentContrastColor('#101014')).toBe(ACCENT_CONTRAST_LIGHT);
    expect(accentContrastColor('#ffffff')).toBe(ACCENT_CONTRAST_DARK);
    expect(accentContrastColor('#eab308')).toBe(ACCENT_CONTRAST_DARK);
  });

  test('flips the indigo preset that was the reported AA failure', () => {
// 4.47:1 against the static white token; 4.70:1 once derived.
    expect(contrastRatio('#6366f1', ACCENT_CONTRAST_LIGHT)!).toBeLessThan(4.5);
    expect(accentContrastColor('#6366f1')).toBe(ACCENT_CONTRAST_DARK);
  });

  test('clears AA (4.5:1) for every shipped preset', () => {
    for (const preset of ACCENT_PRESETS) {
      const contrast = accentContrastColor(preset)!;
      expect(
        contrastRatio(preset, contrast)!,
        `${preset} on ${contrast} must clear 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('returns null rather than guessing for a non-hex accent', () => {
    expect(accentContrastColor('rebeccapurple')).toBeNull();
    expect(accentContrastColor('var(--k-brand)')).toBeNull();
  });
});

describe('accentHoverFill', () => {
  test('shifts away from the accent foreground, in both directions', () => {
// Dark foreground (a light-ish accent) -> a LIGHTER hover; light
// foreground (a dark accent) -> a darker one. Toward the foreground the
// pairing would lose contrast, which is what the fill has to preserve.
    expect(accentContrastColor('#6366f1')).toBe(ACCENT_CONTRAST_DARK);
    expect(relativeLuminance(accentHoverFill('#6366f1')!)!).toBeGreaterThan(
      relativeLuminance('#6366f1')!,
    );

    expect(accentContrastColor('#101014')).toBe(ACCENT_CONTRAST_LIGHT);
    expect(relativeLuminance(accentHoverFill('#101014')!)!).toBeLessThan(
      relativeLuminance('#101014')!,
    );
  });

  test('moves enough to be a visible hover', () => {
    expect(accentHoverFill('#6366f1')).not.toBe('#6366f1');
  });

  test('returns null rather than guessing for a non-hex accent', () => {
    expect(accentHoverFill('rebeccapurple')).toBeNull();
  });

  test('clears AA (4.5:1) in the HOVER state for every shipped preset', () => {
// The delta this pins: hover used to swap the fill to --accent-darker
// (var(--k-brand)), which applyAccentColor never touched — every preset
// hovered at 4.09:1 against the shipped light brand (#0e7c64), under AA
// and under the 5.14:1 the built-in brand had. (Shipped @kontourai/ui
// tokens; index.css retints --k-brand only under :root.is-dev-build.)
    for (const preset of ACCENT_PRESETS) {
      const foreground = accentContrastColor(preset)!;
      const hover = accentHoverFill(preset)!;
      expect(
        contrastRatio(hover, foreground)!,
        `${preset} hovering to ${hover} on ${foreground} must clear 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('applyAccentColor', () => {
  test('sets the accent and its contrast partner together', () => {
    const root = document.createElement('div');
    applyAccentColor(root, '#6366f1');
    expect(root.style.getPropertyValue('--accent-primary')).toBe('#6366f1');
    expect(root.style.getPropertyValue('--text-on-accent')).toBe(
      ACCENT_CONTRAST_DARK,
    );
    expect(root.style.getPropertyValue('--accent-hover-fill')).toBe(
      accentHoverFill('#6366f1'),
    );

    applyAccentColor(root, '#101014');
    expect(root.style.getPropertyValue('--text-on-accent')).toBe(
      ACCENT_CONTRAST_LIGHT,
    );
  });

  test('clearing the accent restores the theme token by removing both', () => {
    const root = document.createElement('div');
    applyAccentColor(root, '#6366f1');
    applyAccentColor(root, null);
    expect(root.style.getPropertyValue('--accent-primary')).toBe('');
    expect(root.style.getPropertyValue('--text-on-accent')).toBe('');
    expect(root.style.getPropertyValue('--accent-hover-fill')).toBe('');
  });

  test('the applied rest AND hover fills both pair legibly with the applied foreground', () => {
// Reads what the DOM actually carries rather than recomputing, so a call
// site that stops stamping one of the three (or freezes it at a theme
// value) fails here rather than passing on arithmetic.
    const root = document.createElement('div');
    for (const preset of ACCENT_PRESETS) {
      applyAccentColor(root, preset);
      const foreground = root.style.getPropertyValue('--text-on-accent');
      const rest = root.style.getPropertyValue('--accent-primary');
      const hover = root.style.getPropertyValue('--accent-hover-fill');
      for (const [label, fill] of [
        ['rest', rest],
        ['hover', hover],
      ] as const) {
        const ratio = contrastRatio(fill, foreground);
        expect(
          ratio,
          `${preset}: the applied ${label} fill (${fill}) and foreground (${foreground}) must both be resolvable hex colors`,
        ).not.toBeNull();
        expect(
          ratio!,
          `${preset}: ${label} fill ${fill} on ${foreground} must clear 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('leaves the theme foreground alone when the accent is unusable', () => {
    const root = document.createElement('div');
    applyAccentColor(root, 'not-a-color');
    expect(root.style.getPropertyValue('--text-on-accent')).toBe('');
  });
});
