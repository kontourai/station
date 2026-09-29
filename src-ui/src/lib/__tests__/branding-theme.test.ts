/** @vitest-environment jsdom */

import { createRequire } from 'node:module';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../../tests/helpers/css-cascade-fixture';
import {
  applyBrandingTheme,
  BRANDING_THEME_PROPERTIES,
  type BrandingModeOverrides,
  type BrandingThemeOverrides,
  checkModeOverrides,
  hexContrast,
  logBrandingThemeViolations,
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
    // Resolved through the package's own exports map, as the bundler does;
    // the shared cascade helper does the read.
    const css = resolveCssImports(
      createRequire(import.meta.url).resolve('@kontourai/ui/tokens.css'),
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
  test('rejects a non-allowlisted key and an injected value, and then applies nothing', () => {
    const { overrides, violations } = resolveBrandingTheme({
      '--k-bg': '#000000',
      background: 'red',
      '--k-focus': 'red; background:url(x)',
      light: { '--k-brand': '#0a6a55' },
    });
    // All or nothing: the valid light brand is not applied either.
    expect(overrides).toEqual({});
    const subjects = violations.map((v) => v.subject);
    expect(subjects).toContain('"--k-bg"');
    expect(subjects).toContain('"background"');
    expect(subjects).toContain('--k-focus');
  });

  test('a __proto__ key is a logged violation, not a prototype write', () => {
    const { overrides, violations } = resolveBrandingTheme(
      JSON.parse(
        '{"__proto__": {"--k-focus": "#93c5fd"}, "dark": {"--k-focus": "#93c5fd"}}',
      ),
    );
    expect(overrides).toEqual({});
    expect(violations.map((v) => v.subject)).toContain('"__proto__"');
  });

  test('flat keys expand into both modes before validation', () => {
    // #1d4ed8 passes on the light surfaces and fails on the dark ones, so a
    // flat value that is only valid in one mode rejects the whole theme.
    const { overrides, violations } = resolveBrandingTheme({
      '--k-focus': '#1d4ed8',
    });
    expect(overrides).toEqual({});
    expect(violations.map((v) => `${v.mode}:${v.subject}`)).toEqual([
      'dark:--k-focus',
    ]);
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

  test('a pale action pair is rejected, and nothing else in the theme applies', () => {
    const { overrides, violations } = resolveBrandingTheme({
      light: {
        '--k-action': '#a7f3d0',
        '--k-action-contrast': '#ffffff',
        '--k-focus': '#1d4ed8', // valid on its own
      },
      dark: { '--k-action': '#34d399' }, // fill without its text
    });
    expect(overrides).toEqual({});
    expect(violations.map((v) => `${v.mode}:${v.reason}`)).toEqual([
      'dark:the action pair must be overridden together',
      expect.stringMatching(/^light:pair contrast 1\.\d+:1 is below 4\.5:1$/),
    ]);
  });

  test('one failing mode rejects the valid other mode too', () => {
    const { overrides } = resolveBrandingTheme({
      light: { '--k-focus': '#1d4ed8' },
      dark: { '--k-focus': '#1d4ed8' },
    });
    expect(overrides).toEqual({});
  });

  test("rejects an action pair that passes as a pair but not as Station's accent text", () => {
    // Station paints --accent-primary (the action role) as link and accent
    // text, so the fill must also read on the page and panel.
    expect(hexContrast('#1e3a8a', '#ffffff')).toBeGreaterThan(4.5);
    const { overrides, violations } = resolveBrandingTheme({
      dark: { '--k-action': '#1e3a8a', '--k-action-contrast': '#ffffff' },
    });
    expect(overrides).toEqual({});
    expect(violations).toEqual([
      expect.objectContaining({
        mode: 'dark',
        subject: '--k-action/--k-action-contrast',
        reason: expect.stringMatching(/^--k-action on the page\/panel/),
      }),
    ]);
  });

  test('rejects a brand that passes its pair but not as text on page and panel', () => {
    const { overrides, violations } = resolveBrandingTheme({
      dark: { '--k-brand': '#1e3a8a', '--k-brand-contrast': '#ffffff' },
    });
    expect(overrides).toEqual({});
    expect(violations).toEqual([
      expect.objectContaining({
        mode: 'dark',
        subject: '--k-brand/--k-brand-contrast',
        reason: expect.stringMatching(/^--k-brand on the page\/panel/),
      }),
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

describe('applyBrandingTheme snapshot', () => {
  test('the mode-flip re-apply uses the validated snapshot, not a later mutation', async () => {
    const root = freshRoot('dark');
    const overrides: BrandingThemeOverrides = {
      dark: { '--k-focus': '#93c5fd' },
      light: { '--k-focus': '#1d4ed8' },
    };
    applyBrandingTheme(root, overrides);
    // The caller's object changes after validation.
    overrides.light = { '--k-focus': '#ffffff' };
    root.setAttribute('data-theme', 'light');
    await flush();
    expect(root.style.getPropertyValue('--k-focus')).toBe('#1d4ed8');
  });
});

describe('logBrandingThemeViolations', () => {
  test('caps what a hostile theme can write to the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const theme: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) theme[`--junk-${i}`] = 'x';
    const { violations } = resolveBrandingTheme(theme);
    expect(violations).toHaveLength(500);
    logBrandingThemeViolations(violations);
    // Header, 20 violations, and one "…and N more" line.
    expect(warn).toHaveBeenCalledTimes(22);
    expect(warn).toHaveBeenLastCalledWith(
      '[branding-theme] …and 480 more rejection(s)',
    );
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
