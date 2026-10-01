/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { contrastRatio, SHIPPED_THEMES } from '@kontourai/ui/contrast';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../../tests/helpers/css-cascade-fixture';
import {
  applyBrandingTheme,
  BRANDING_BASE_THEME,
  BRANDING_THEME_PROPERTIES,
  type BrandingModeOverrides,
  type BrandingThemeOverrides,
  type BrandingThemeViolation,
  logBrandingThemeViolations,
  resolveBrandingTheme,
  resolveCachedBrandingTheme,
} from '../branding-theme';

const SHIPPED = SHIPPED_THEMES[BRANDING_BASE_THEME];

/** `kind:mode:property` for each violation, a stable handle for assertions. */
const handles = (violations: readonly BrandingThemeViolation[]) =>
  violations.map(
    (v) => `${v.kind}:${v.mode ?? ''}:${'property' in v ? v.property : ''}`,
  );

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function freshRoot(mode: 'dark' | 'light' = 'dark'): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-theme', mode);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validation base theme', () => {
  test('is the unthemed tokens Station actually loads', () => {
    // Station applies no `.theme-*` class, so overrides must be rated against
    // the package's unthemed tokens. Read them from the installed CSS, not
    // from the validator's table, so choosing the wrong base (or a CSS that
    // drifts from the table) fails here.
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
      const names = [
        '--k-bg',
        '--k-panel',
        '--k-panel-raised',
        '--k-brand',
        '--k-brand-contrast',
        '--k-action',
        '--k-action-contrast',
        '--k-focus',
      ] as const;
      expect(
        Object.fromEntries(names.map((name) => [name, value(text, name)])),
      ).toEqual(Object.fromEntries(names.map((n) => [n, SHIPPED[mode][n]])));
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
    const found = handles(violations);
    expect(found).toContain('disallowed-property:dark:--k-bg');
    expect(found).toContain('disallowed-property:light:background');
    expect(found).toContain('invalid-value:dark:--k-focus');
  });

  test('a __proto__ key is a logged violation, not a prototype write', () => {
    const { overrides, violations } = resolveBrandingTheme(
      JSON.parse(
        '{"__proto__": {"--k-focus": "#93c5fd"}, "dark": {"--k-focus": "#93c5fd"}}',
      ),
    );
    expect(overrides).toEqual({});
    expect(handles(violations)).toContain('disallowed-property:dark:__proto__');
    expect(Object.getPrototypeOf(overrides)).not.toHaveProperty('--k-focus');
  });

  test('flat keys expand into both modes before validation', () => {
    // #1d4ed8 passes on the light surfaces and fails on the dark ones, so a
    // flat value that is only valid in one mode rejects the whole theme.
    const { overrides, violations } = resolveBrandingTheme({
      '--k-focus': '#1d4ed8',
    });
    expect(overrides).toEqual({});
    // Both dark surfaces fail; the light mode passes.
    expect(handles(violations)).toEqual([
      'contrast:dark:--k-focus',
      'contrast:dark:--k-focus',
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
      handles(resolveBrandingTheme({ dark: '--k-focus: #fff' }).violations),
    ).toEqual(['invalid-shape:dark:']);
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
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unpaired-action',
          mode: 'dark',
          property: '--k-action-contrast',
        }),
        expect.objectContaining({
          kind: 'contrast',
          mode: 'light',
          pair: ['--k-action-contrast', '--k-action'],
          minimum: 4.5,
        }),
      ]),
    );
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
    // #3b6fd4 passes the shared rules (pair 4.5:1, action on panel 3:1) but
    // is under 4.5:1 as text on both dark surfaces.
    const action = '#3b6fd4';
    expect(contrastRatio(action, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(action, SHIPPED.dark['--k-panel'])).toBeGreaterThan(3);
    expect(contrastRatio(action, SHIPPED.dark['--k-bg'])).toBeLessThan(4.5);
    const { overrides, violations } = resolveBrandingTheme({
      dark: { '--k-action': action, '--k-action-contrast': '#ffffff' },
    });
    expect(overrides).toEqual({});
    expect(handles(violations)).toEqual([
      'station-surface-text:dark:--k-action',
      'station-surface-text:dark:--k-action',
    ]);
  });

  test('rejects a brand that passes its pair but not as text on the page', () => {
    // Station paints the brand as text on the page (the channel badge). The
    // shared validator rates that itself at 4.5:1, so the rejection is its
    // `contrast` record and Station adds no brand rule of its own.
    // #0e8270 is 4.29:1 on the light page and 4.72:1 on the panel.
    const brand = '#0e8270';
    expect(contrastRatio(brand, SHIPPED.light['--k-bg'])).toBeGreaterThan(3);
    expect(contrastRatio(brand, SHIPPED.light['--k-bg'])).toBeLessThan(4.5);
    expect(
      contrastRatio(brand, SHIPPED.light['--k-panel']),
    ).toBeGreaterThanOrEqual(4.5);
    // A readable action of its own, so the brand is not also expanded into
    // the action role and only the brand-on-page pair can reject this theme.
    const { overrides, violations } = resolveBrandingTheme({
      light: {
        '--k-brand': brand,
        '--k-brand-contrast': '#ffffff',
        '--k-action': '#1d4ed8',
        '--k-action-contrast': '#ffffff',
      },
    });
    expect(overrides).toEqual({});
    expect(violations).toEqual([
      expect.objectContaining({
        kind: 'contrast',
        mode: 'light',
        property: '--k-brand',
        pair: ['--k-brand', '--k-bg'],
        minimum: 4.5,
      }),
    ]);
  });

  test.each(['#9364ff', '#007efa'])(
    'rejects the dark brand %s, which is under 4.5:1 only on the raised panel',
    (brand) => {
      // @kontourai/ui 1.18 rates the brand as text on the raised panel too. A
      // dark brand that clears the page and the panel but not the raised panel
      // (relative luminance about 0.2155 to 0.2377) passed before and is now
      // rejected whole, so the defaults stay.
      expect(
        contrastRatio(brand, SHIPPED.dark['--k-bg']),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(brand, SHIPPED.dark['--k-panel']),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(brand, SHIPPED.dark['--k-panel-raised']),
      ).toBeLessThan(4.5);
      const { overrides, violations } = resolveBrandingTheme({
        dark: {
          '--k-brand': brand,
          '--k-brand-contrast': '#06080b',
          '--k-action': '#60a5fa',
          '--k-action-contrast': '#06080b',
        },
        light: { '--k-focus': '#1d4ed8' }, // valid on its own, still not applied
      });
      expect(overrides).toEqual({});
      expect(violations).toEqual([
        expect.objectContaining({
          kind: 'contrast',
          mode: 'dark',
          property: '--k-brand',
          pair: ['--k-brand', '--k-panel-raised'],
          minimum: 4.5,
        }),
      ]);
    },
  );

  test('a brand-only mode also becomes the action, with its contrast', () => {
    const { overrides, violations } = resolveBrandingTheme({
      dark: { '--k-brand': '#60a5fa', '--k-brand-contrast': '#06080b' },
      light: { '--k-brand': '#1d4ed8' },
    });
    expect(violations).toEqual([]);
    expect(overrides).toEqual({
      dark: {
        '--k-brand': '#60a5fa',
        '--k-brand-contrast': '#06080b',
        '--k-action': '#60a5fa',
        '--k-action-contrast': '#06080b',
      },
      // No brand contrast given: the shipped action contrast for the mode.
      light: {
        '--k-brand': '#1d4ed8',
        '--k-action': '#1d4ed8',
        '--k-action-contrast': SHIPPED.light['--k-action-contrast'],
      },
    });
  });

  test('a brand with only an action contrast stays an unpaired action', () => {
    // The author set the text colour for an action they did not supply. The
    // brand must not be expanded into the action over it (which would also
    // replace their contrast); the half pair is rejected as the package's
    // unpaired-action.
    const { overrides, violations } = resolveBrandingTheme({
      light: { '--k-brand': '#1d4ed8', '--k-action-contrast': '#fefefe' },
    });
    expect(overrides).toEqual({});
    // The package names the missing half of the pair.
    expect(violations).toEqual([
      expect.objectContaining({
        kind: 'unpaired-action',
        mode: 'light',
        property: '--k-action',
      }),
    ]);
  });

  test('a theme that sets its own action keeps it', () => {
    const { overrides, violations } = resolveBrandingTheme({
      light: {
        '--k-brand': '#1d4ed8',
        '--k-action': '#0e7c64',
        '--k-action-contrast': '#ffffff',
      },
    });
    expect(violations).toEqual([]);
    expect(overrides.light?.['--k-action']).toBe('#0e7c64');
  });

  test('the brand as action must pass the action rules too', () => {
    // #0e8270 fails Station's text rule on the light page as a brand; as the
    // expanded action it fails the same way, so nothing applies.
    const { overrides, violations } = resolveBrandingTheme({
      light: { '--k-brand': '#0e8270' },
    });
    expect(overrides).toEqual({});
    expect(violations).toContainEqual(
      expect.objectContaining({
        kind: 'station-surface-text',
        property: '--k-action',
      }),
    );
  });

  test('an invalid flat value rejects the theme even when every mode shadows it', () => {
    const { overrides, violations } = resolveBrandingTheme({
      '--k-focus': 'red',
      dark: { '--k-focus': '#fbbf24' },
      light: { '--k-focus': '#0e7c64' },
    });
    expect(overrides).toEqual({});
    expect(
      violations.map((v) => `${v.kind}:${'mode' in v ? v.mode : ''}`),
    ).toEqual(['invalid-value:dark', 'invalid-value:light']);
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

describe('shared thresholds through resolveBrandingTheme', () => {
  test('rates focus against both surfaces at the non-text threshold', () => {
    // #3a3f47 is under 3:1 on the dark page.
    expect(contrastRatio('#3a3f47', SHIPPED.dark['--k-bg'])).toBeLessThan(3);
    expect(
      resolveBrandingTheme({ dark: { '--k-focus': '#3a3f47' } }).overrides,
    ).toEqual({});
  });

  test('a brand-contrast alone is rated against the shipped brand', () => {
    // Dark text on the shipped light brand (#0e7c64) is far below 4.5:1.
    expect(
      resolveBrandingTheme({ light: { '--k-brand-contrast': '#000000' } })
        .overrides,
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
  test('a raised-panel rejection names the colour, the surface and the ratio it needs', () => {
    // What a provider has to go on after upgrading: the console line must say
    // which value failed, against what, by how much.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { violations } = resolveBrandingTheme({
      dark: {
        '--k-brand': '#9364ff',
        '--k-brand-contrast': '#06080b',
        '--k-action': '#60a5fa',
        '--k-action-contrast': '#06080b',
      },
    });
    logBrandingThemeViolations(violations);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      '[branding-theme] theme rejected; keeping the default theme. Nothing from it was applied.',
      '[branding-theme] rejected (contrast) dark: --k-brand #9364ff on --k-panel-raised #16202d = 4.31:1 (needs 4.5:1 — brand as text on raised panels).',
    ]);
  });

  test('caps what a hostile theme can write to the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const junk: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) junk[`--junk-${i}`] = 'x';
    const { violations } = resolveBrandingTheme({ dark: junk });
    expect(violations).toHaveLength(500);
    logBrandingThemeViolations(violations);
    // Header, 20 violations, and one "…and N more" line.
    expect(warn).toHaveBeenCalledTimes(22);
    expect(warn).toHaveBeenLastCalledWith(
      '[branding-theme] …and 480 more rejection(s)',
    );
  });
});

describe('the bundled example provider', () => {
  test("examples/custom-branding's theme is accepted whole", async () => {
    // The real provider module, not a copy of its values. It is CommonJS
    // under an ESM package root, so it is evaluated as CommonJS here, and
    // its answer crosses JSON as it does over /api/branding.
    const module = { exports: undefined as unknown };
    runInNewContext(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '../../../../examples/custom-branding/providers/branding.js',
        ),
        'utf8',
      ),
      { module },
    );
    const provider = (
      module.exports as () => { getTheme(): Promise<unknown> }
    )();
    const theme = JSON.parse(JSON.stringify(await provider.getTheme()));
    const { overrides, violations } = resolveBrandingTheme(theme);
    expect(violations).toEqual([]);
    expect(overrides).toEqual(theme);
    expect(Object.keys(theme.dark)).toHaveLength(5);
    expect(Object.keys(theme.light)).toHaveLength(5);
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
