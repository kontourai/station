/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  applyBrandingTheme,
  BRANDING_THEME_PROPERTIES,
  type BrandingModeOverrides,
  checkModeOverrides,
  hexContrast,
  resolveBrandingTheme,
  resolveCachedBrandingTheme,
  SHIPPED_MODE_TOKENS,
} from '../branding-theme';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function freshRoot(mode: 'dark' | 'light' = 'dark'): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-theme', mode);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shipped mode tokens', () => {
  test('match the installed @kontourai/ui tokens the overrides are rated against', () => {
    // Read from the package itself, not from this module, so a token bump
    // that moves the page or panel fails here instead of silently rating
    // overrides against stale surfaces.
    const require = createRequire(import.meta.url);
    const css = readFileSync(
      require.resolve('@kontourai/ui/tokens.css'),
      'utf-8',
    );
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start));
    };
    const value = (text: string, name: string) =>
      text.match(new RegExp(`${name}:\\s*(#[0-9a-f]{3,6})\\b`, 'i'))?.[1];
    for (const [mode, selector] of [
      ['dark', ':root'],
      ['light', '[data-theme="light"]'],
    ] as const) {
      const text = block(selector);
      expect({
        bg: value(text, '--k-bg'),
        panel: value(text, '--k-panel'),
        brand: value(text, '--k-brand'),
        brandContrast: value(text, '--k-brand-contrast'),
      }).toEqual(SHIPPED_MODE_TOKENS[mode]);
    }
  });
});

describe('resolveBrandingTheme', () => {
  test('rejects a non-allowlisted key and an injected value, keeping the valid ones', () => {
    const { overrides, violations } = resolveBrandingTheme({
      '--k-bg': '#000000',
      background: 'red',
      '--k-focus': 'red; background:url(x)',
      '--k-brand': '#0a6a55',
    });
    // Only the valid allowlisted property survives, in both modes.
    expect(overrides.light).toEqual({ '--k-brand': '#0a6a55' });
    expect(overrides.dark).toBeUndefined(); // #0a6a55 is unreadable on dark
    const subjects = violations.map((v) => v.subject);
    expect(subjects).toContain('"--k-bg"');
    expect(subjects).toContain('"background"');
    expect(subjects).toContain('--k-focus');
  });

  test.each([
    'red; background:url(x)',
    'var(--k-bg)',
    'url(x)',
    'red',
    'rgb(0 0 0)',
    'hsl(0 0% 0%)',
    '#00000080',
    '#12',
    ' #5ce0c6',
    'expression(alert(1))',
  ])('rejects %j as a colour value', (value) => {
    const { overrides } = resolveBrandingTheme({
      '--k-focus': value,
      dark: { '--k-focus': value },
    });
    expect(overrides).toEqual({});
  });

  test('rejects non-object themes and non-object mode entries', () => {
    expect(resolveBrandingTheme('--k-brand: red').overrides).toEqual({});
    expect(resolveBrandingTheme(['#fff']).overrides).toEqual({});
    expect(
      resolveBrandingTheme({ dark: '--k-focus: #fff' }).violations,
    ).toHaveLength(1);
  });

  test('per-mode entries win over flat keys for their own mode', () => {
    const { overrides } = resolveBrandingTheme({
      '--k-focus': '#888888',
      light: { '--k-focus': '#1d4ed8' },
    });
    expect(overrides.dark).toEqual({ '--k-focus': '#888888' });
    expect(overrides.light).toEqual({ '--k-focus': '#1d4ed8' });
  });

  test('a pale action pair is rejected in the mode it fails, and never half-applied', () => {
    const { overrides, violations } = resolveBrandingTheme({
      light: { '--k-action': '#a7f3d0', '--k-action-contrast': '#ffffff' },
      dark: { '--k-action': '#34d399' }, // fill without its text
    });
    expect(overrides).toEqual({});
    expect(violations.map((v) => `${v.mode}:${v.reason}`)).toEqual([
      'dark:the action pair must be overridden together',
      expect.stringMatching(/^light:pair contrast 1\.\d+:1 is below 4\.5:1$/),
    ]);
  });

  test('accepts a readable per-mode theme whole', () => {
    const theme = {
      dark: {
        '--k-brand': '#60a5fa',
        '--k-brand-contrast': '#06080b',
        '--k-action': '#60a5fa',
        '--k-action-contrast': '#06080b',
        '--k-focus': '#93c5fd',
      },
      light: {
        '--k-brand': '#1d4ed8',
        '--k-brand-contrast': '#ffffff',
        '--k-action': '#1d4ed8',
        '--k-action-contrast': '#ffffff',
        '--k-focus': '#1d4ed8',
      },
    };
    const { overrides, violations } = resolveBrandingTheme(theme);
    expect(violations).toEqual([]);
    expect(overrides).toEqual(theme);
  });
});

describe('checkModeOverrides thresholds', () => {
  test('rates focus against both surfaces at the non-text threshold', () => {
    // #3a3f47 is under 3:1 on the dark page.
    expect(hexContrast('#3a3f47', SHIPPED_MODE_TOKENS.dark.bg)).toBeLessThan(3);
    expect(
      checkModeOverrides('dark', { '--k-focus': '#3a3f47' }).accepted,
    ).toEqual({});
  });

  test('a brand-contrast alone is rated against the shipped brand', () => {
    // Dark text on the shipped light brand (#0e7c64) is far below 4.5:1.
    expect(
      checkModeOverrides('light', { '--k-brand-contrast': '#000000' }).accepted,
    ).toEqual({});
  });
});

describe('applyBrandingTheme', () => {
  test('lands the allowlisted properties on the root for its mode', () => {
    const root = freshRoot('light');
    applyBrandingTheme(root, {
      light: { '--k-action': '#1d4ed8', '--k-action-contrast': '#ffffff' },
    });
    expect(root.style.getPropertyValue('--k-action')).toBe('#1d4ed8');
    expect(root.style.getPropertyValue('--k-action-contrast')).toBe('#ffffff');
  });

  test('follows the mode when data-theme flips, and clears on null', async () => {
    const root = freshRoot('dark');
    applyBrandingTheme(root, {
      dark: { '--k-focus': '#93c5fd' },
      light: { '--k-focus': '#1d4ed8' },
    });
    expect(root.style.getPropertyValue('--k-focus')).toBe('#93c5fd');
    root.setAttribute('data-theme', 'light');
    await flush();
    expect(root.style.getPropertyValue('--k-focus')).toBe('#1d4ed8');

    applyBrandingTheme(root, null);
    expect(root.style.getPropertyValue('--k-focus')).toBe('');
    root.setAttribute('data-theme', 'dark');
    await flush();
    expect(root.style.getPropertyValue('--k-focus')).toBe('');
  });

  test('a value valid for one mode does not survive into the other', async () => {
    const root = freshRoot('light');
    applyBrandingTheme(root, { light: { '--k-brand': '#0a6a55' } });
    expect(root.style.getPropertyValue('--k-brand')).toBe('#0a6a55');
    root.setAttribute('data-theme', 'dark');
    await flush();
    expect(root.style.getPropertyValue('--k-brand')).toBe('');
  });

  test('never calls setProperty with anything but an allowlisted hex value', () => {
    const root = freshRoot('dark');
    const setProperty = vi.spyOn(root.style, 'setProperty');
    // Bypass resolveBrandingTheme to prove the write itself re-checks.
    const hostile = {
      '--k-focus': 'red; background:url(x)',
      '--k-brand': '#5ce0c6',
      '--k-bg': '#000000',
    } as BrandingModeOverrides;
    applyBrandingTheme(root, { dark: hostile });
    const allowed = new Set<string>(BRANDING_THEME_PROPERTIES);
    for (const [property, value] of setProperty.mock.calls) {
      expect(allowed.has(property)).toBe(true);
      expect(value).toMatch(/^#[0-9a-f]{3,6}$/);
    }
    expect(root.style.getPropertyValue('--k-bg')).toBe('');
    expect(root.style.getPropertyValue('--k-focus')).toBe('');
  });
});

describe('resolveCachedBrandingTheme', () => {
  test('re-validates the cached copy instead of trusting storage', () => {
    expect(resolveCachedBrandingTheme(null)).toBeNull();
    expect(resolveCachedBrandingTheme('{not json')).toBeNull();
    expect(
      resolveCachedBrandingTheme(
        JSON.stringify({ dark: { '--k-focus': 'url(x)' } }),
      ),
    ).toBeNull();
    expect(
      resolveCachedBrandingTheme(
        JSON.stringify({ dark: { '--k-focus': '#93c5fd' } }),
      ),
    ).toEqual({ dark: { '--k-focus': '#93c5fd' } });
  });
});
