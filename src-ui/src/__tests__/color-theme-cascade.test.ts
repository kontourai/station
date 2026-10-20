import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import {
  COLOR_THEME_FAMILIES,
  COLOR_THEME_ROLE_PROPERTIES,
  COLOR_THEME_VARIABLE_PROPERTIES,
} from '../lib/color-theme-catalog';

/**
 * The color theme end to end in Chromium, against the real stylesheets:
 *
 * - the real `public/startup-theme.js`, executed from a real origin with the
 *   real device-settings envelope in storage, stamps the attributes and
 *   `theme-color` before anything below it in `<head>` parses, and the splash
 *   stylesheet paints the theme;
 * - the real settings store and applier (bundled from source) keep the root
 *   attributes live as a device setting changes, and the real `index.css`
 *   resolves the theme's values through Station's own aliases;
 * - `station` renders exactly what the app rendered before color themes;
 * - precedence against channel builds, white-label branding, a custom
 *   accent, and islands with their own `data-theme`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const ORIGIN = 'http://station.test';
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);
const INDEX_CSS = resolve(import.meta.dirname, '../index.css');
const GENERATED_CSS = resolve(
  import.meta.dirname,
  '../color-themes.generated.css',
);
const STARTUP_CSS = resolve(
  import.meta.dirname,
  '../components/startup-screen.css',
);
const STARTUP_SCRIPT = readFileSync(
  resolve(import.meta.dirname, '../../public/startup-theme.js'),
  'utf8',
);
const ENVELOPE_KEY = 'station-device-settings-v1';

const family = (id: string) => COLOR_THEME_FAMILIES.find((f) => f.id === id)!;
const catppuccin = family('catppuccin');
const flavor = (id: string) =>
  [catppuccin.light, ...catppuccin.dark].find((f) => f.id === id)!;
const mocha = flavor('mocha');
const macchiato = flavor('macchiato');
const latte = flavor('latte');

/** Every property a theme can move, plus Station aliases that derive from them. */
const OBSERVED = [
  ...COLOR_THEME_ROLE_PROPERTIES,
  ...COLOR_THEME_VARIABLE_PROPERTIES,
  '--k-brand',
  '--k-brand-contrast',
  '--k-action',
  '--k-action-contrast',
  '--k-focus',
  '--k-focus-ring',
  '--bg-primary',
  '--bg-secondary',
  '--bg-selected',
  '--text-primary',
  '--text-muted',
  '--accent-primary',
  '--text-on-accent',
  '--error-fill',
  'color-scheme',
];

function toHex(value: string): string {
  const v = value.trim().toLowerCase();
  const match = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*1)?\)$/);
  if (!match) return v;
  return `#${match
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')}`;
}

const HARNESS = `
import { deviceSettingsStore } from './src-ui/src/lib/device-settings-store';
import { bindColorThemeToSettings } from './src-ui/src/lib/color-theme-apply';
import { applyBrandingTheme } from './src-ui/src/lib/branding-theme';
import { applyAccentColor } from './src-ui/src/lib/accent-contrast';
// What AccountPreferencesProvider and ThemeToggle do with the mode.
const root = document.documentElement;
const mode = () => root.setAttribute('data-theme', deviceSettingsStore.getSnapshot().theme);
mode();
deviceSettingsStore.subscribe(mode);
bindColorThemeToSettings(root, deviceSettingsStore);
window.harness = { store: deviceSettingsStore, applyBrandingTheme, applyAccentColor };
`;

describe.skipIf(!chromiumAvailable)('color theme cascade', () => {
  let browser: Browser;
  let appCss: string;
  let baselineCss: string;
  let startupCss: string;
  let harness: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    appCss = resolveCssImports(INDEX_CSS);
    // index.css without the generated sheet: what Station rendered before.
    baselineCss = resolveCssImports(INDEX_CSS, new Set([GENERATED_CSS]));
    startupCss = resolveCssImports(STARTUP_CSS);
    for (const css of [appCss, baselineCss, startupCss])
      assertNoImportsSurvive(css);
    expect(appCss.length).toBeGreaterThan(baselineCss.length);
    const bundled = await build({
      stdin: { contents: HARNESS, resolveDir: REPO_ROOT, loader: 'ts' },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      logLevel: 'silent',
    });
    harness = bundled.outputFiles[0]!.text;
  });
  afterAll(async () => {
    await browser?.close();
  });

  /**
   * A page at a real origin (so storage works), with `values` already in the
   * device-settings envelope when the startup script runs.
   */
  async function open(
    head: string,
    body = '',
    values?: Record<string, unknown> | string,
  ): Promise<Page> {
    const page = await browser.newPage();
    await page.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/startup-theme.js')
        return route.fulfill({
          contentType: 'text/javascript',
          body: STARTUP_SCRIPT,
        });
      if (path === '/harness.js')
        return route.fulfill({ contentType: 'text/javascript', body: harness });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
      });
    });
    if (values !== undefined)
      await page.addInitScript(
        ({ key, raw }) => {
          if (!sessionStorage.getItem('seeded')) {
            localStorage.setItem(key, raw);
            sessionStorage.setItem('seeded', '1');
          }
        },
        {
          key: ENVELOPE_KEY,
          raw:
            typeof values === 'string'
              ? values
              : JSON.stringify({ version: 1, values }),
        },
      );
    await page.goto(`${ORIGIN}/`);
    return page;
  }

  async function read(
    page: Page,
    selector = ':root',
  ): Promise<Record<string, string>> {
    const values = await page.evaluate(
      ({ selector, names }) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return Object.fromEntries(
          names.map((name) => [name, style.getPropertyValue(name).trim()]),
        );
      },
      { selector, names: OBSERVED },
    );
    return Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, toHex(v)]),
    );
  }

  const attributes = (page: Page) =>
    page.evaluate(() => {
      const root = document.documentElement;
      return {
        theme: root.getAttribute('data-theme'),
        colorTheme: root.getAttribute('data-color-theme'),
        flavor: root.getAttribute('data-color-theme-flavor'),
        accent: root.getAttribute('data-color-theme-accent'),
        themeColor:
          document
            .querySelector('meta[name="theme-color"]')
            ?.getAttribute('content') ?? null,
      };
    });

  describe('before first paint (startup-theme.js)', () => {
    // An inline script right after the startup script records what is in
    // force before the rest of <head>, the body and every stylesheet parse.
    const HEAD = (css: string) =>
      `<script src="/startup-theme.js"></script><script>window.atParse = { attrs: [...document.documentElement.attributes].map(a => a.name + '=' + a.value).sort(), themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? null };</script><style>${css}</style>`;
    const SPLASH = '<div class="station-startup" id="splash"></div>';

    test('a saved family, flavor and accent are stamped and painted by the splash', async () => {
      const page = await open(HEAD(startupCss), SPLASH, {
        theme: 'dark',
        colorTheme: 'catppuccin',
        colorThemeFlavor: 'macchiato',
        colorThemeAccent: 'pink',
      });
      try {
        expect(
          await page.evaluate(
            () => (window as unknown as { atParse: unknown }).atParse,
          ),
        ).toEqual({
          attrs: [
            'data-color-theme-accent=pink',
            'data-color-theme-flavor=macchiato',
            'data-color-theme=catppuccin',
            'data-theme=dark',
          ],
          themeColor: macchiato.roles['--k-bg'],
        });
        const splash = await page.evaluate(() => {
          const style = getComputedStyle(document.getElementById('splash')!);
          return { bg: style.backgroundColor, color: style.color };
        });
        expect(toHex(splash.bg)).toBe(macchiato.roles['--k-bg']);
        expect(toHex(splash.color)).toBe(macchiato.roles['--k-text']);
      } finally {
        await page.close();
      }
    });

    test('light mode uses the light flavor whatever dark flavor is saved', async () => {
      const page = await open(HEAD(startupCss), SPLASH, {
        theme: 'light',
        colorTheme: 'catppuccin',
        colorThemeFlavor: 'frappe',
      });
      try {
        const at = await attributes(page);
        expect(at).toMatchObject({
          theme: 'light',
          colorTheme: 'catppuccin',
          flavor: 'frappe',
          accent: 'mauve',
          themeColor: latte.roles['--k-bg'],
        });
        const bg = await page.evaluate(
          () =>
            getComputedStyle(document.getElementById('splash')!)
              .backgroundColor,
        );
        expect(toHex(bg)).toBe(latte.roles['--k-bg']);
      } finally {
        await page.close();
      }
    });

    test.each([
      [
        'an unknown family',
        { colorTheme: 'some-future-family', colorThemeFlavor: 'mocha' },
      ],
      ['a non-string family', { colorTheme: 7 }],
      ['a prototype key', { colorTheme: '__proto__' }],
      ['Station', { colorTheme: 'station' }],
    ])('%s renders Station with no attributes', async (_label, values) => {
      const page = await open(HEAD(startupCss), SPLASH, values);
      try {
        expect(await attributes(page)).toEqual({
          theme: 'dark',
          colorTheme: null,
          flavor: null,
          accent: null,
          themeColor: '#0a0e13',
        });
      } finally {
        await page.close();
      }
    });

    test('a malformed envelope keeps the legacy mode and Station', async () => {
      const page = await open(HEAD(startupCss), SPLASH, '{not json');
      try {
        expect(await attributes(page)).toMatchObject({
          theme: 'dark',
          colorTheme: null,
          themeColor: '#0a0e13',
        });
      } finally {
        await page.close();
      }
    });

    test('an unknown flavor or accent falls back to the family default', async () => {
      const page = await open(HEAD(startupCss), SPLASH, {
        colorTheme: 'catppuccin',
        colorThemeFlavor: 'latte',
        colorThemeAccent: 'chartreuse',
      });
      try {
        expect(await attributes(page)).toMatchObject({
          colorTheme: 'catppuccin',
          flavor: 'mocha',
          accent: 'mauve',
          themeColor: mocha.roles['--k-bg'],
        });
      } finally {
        await page.close();
      }
    });
  });

  describe('live (settings store → applier → index.css)', () => {
    const appHead = () =>
      `<style>${appCss}</style><script src="/harness.js"></script>`;

    test('setting the device setting stamps the root and resolves the theme through Station aliases', async () => {
      const page = await open(appHead(), '', {});
      try {
        expect(await attributes(page)).toMatchObject({ colorTheme: null });
        await page.evaluate(() => {
          (window as never as { harness: any }).harness.store.set(
            'colorTheme',
            'catppuccin',
          );
        });
        expect(await attributes(page)).toEqual({
          theme: 'dark',
          colorTheme: 'catppuccin',
          flavor: 'mocha',
          accent: 'mauve',
          themeColor: mocha.roles['--k-bg'],
        });
        const dark = await read(page);
        expect(dark['--k-bg']).toBe(mocha.roles['--k-bg']);
        expect(dark['--bg-primary']).toBe(mocha.roles['--k-bg']);
        expect(dark['--text-primary']).toBe(mocha.roles['--k-text']);
        expect(dark['--k-brand']).toBe(mocha.accents.mauve.brand);
        expect(dark['--accent-primary']).toBe(mocha.accents.mauve.brand);
        expect(dark['--text-on-accent']).toBe(mocha.accents.mauve.contrast);
        expect(dark['--k-focus-ring']).toBe(mocha.accents.mauve.brand);
        expect(dark['--error-text']).toBe(mocha.variables['--error-text']);
        expect(dark['--syntax-keyword']).toBe(
          mocha.variables['--syntax-keyword'],
        );
        expect(dark['color-scheme']).toBe('dark');

        await page.evaluate(() => {
          const { store } = (window as never as { harness: any }).harness;
          store.set('colorThemeAccent', 'peach');
          store.set('theme', 'light');
        });
        expect(await attributes(page)).toMatchObject({
          theme: 'light',
          accent: 'peach',
          themeColor: latte.roles['--k-bg'],
        });
        const light = await read(page);
        expect(light['--k-bg']).toBe(latte.roles['--k-bg']);
        expect(light['--bg-secondary']).toBe(latte.roles['--k-panel']);
        expect(light['--k-action']).toBe(latte.accents.peach.brand);
        expect(light['--k-brand']).toBe(latte.accents.peach.brand);
        expect(light['--warning-text']).toBe(latte.variables['--warning-text']);
        expect(light['color-scheme']).toBe('light');

        await page.evaluate(() => {
          (window as never as { harness: any }).harness.store.set(
            'colorTheme',
            'station',
          );
        });
        expect(await attributes(page)).toEqual({
          theme: 'light',
          colorTheme: null,
          flavor: null,
          accent: null,
          themeColor: '#f5f4ef',
        });
      } finally {
        await page.close();
      }
    });

    test('an unknown family from the account or another client renders Station', async () => {
      const page = await open(appHead(), '', {});
      try {
        await page.evaluate(() => {
          (
            window as never as { harness: any }
          ).harness.store.bindAccountPreferences(
            { colorTheme: 'some-future-family', colorThemeFlavor: 'neon' },
            () => {},
          );
        });
        expect(await attributes(page)).toMatchObject({
          colorTheme: null,
          themeColor: '#0a0e13',
        });
      } finally {
        await page.close();
      }
    });
  });

  describe('Station is unchanged', () => {
    test.each([
      ['dark', ''],
      ['light', ''],
      ['dark', 'beta'],
      ['light', 'nightly'],
      ['dark', 'dev'],
    ] as const)(
      'with no color theme, %s mode %s resolves exactly what it did before',
      async (mode, channel) => {
        const setup = `document.documentElement.dataset.theme = ${JSON.stringify(mode)};${
          channel === 'dev'
            ? "document.documentElement.classList.add('is-dev-build');"
            : channel
              ? `document.documentElement.dataset.appChannel = ${JSON.stringify(channel)};`
              : ''
        }`;
        const before = await open(
          `<script>${setup}</script><style>${baselineCss}</style>`,
        );
        const after = await open(
          `<script>${setup}</script><style>${appCss}</style>`,
        );
        try {
          expect(await read(after)).toEqual(await read(before));
        } finally {
          await before.close();
          await after.close();
        }
      },
    );
  });

  describe('precedence', () => {
    async function themed(
      mode: 'dark' | 'light',
      setup = '',
      body = '',
    ): Promise<Page> {
      return open(
        `<script>const r = document.documentElement; r.dataset.theme = '${mode}'; r.dataset.colorTheme = 'catppuccin'; r.dataset.colorThemeFlavor = 'mocha'; r.dataset.colorThemeAccent = 'mauve'; ${setup}</script><style>${appCss}</style>`,
        body,
      );
    }

    test.each([
      ['beta', 'dark', "r.dataset.appChannel = 'beta';"],
      ['nightly', 'light', "r.dataset.appChannel = 'nightly';"],
      ['dev', 'dark', "r.classList.add('is-dev-build');"],
      ['dev', 'light', "r.classList.add('is-dev-build');"],
    ] as const)(
      'a %s build in %s mode keeps its identity on the brand while the theme owns action and focus',
      async (channel, mode, setup) => {
        const page = await themed(mode, setup);
        const current = mode === 'dark' ? mocha : latte;
        try {
          const v = await read(page);
          expect(v['--k-brand']).toBe(current.channels[channel].brand);
          expect(v['--k-brand-contrast']).toBe(
            current.channels[channel].contrast,
          );
          expect(v['--k-action']).toBe(current.accents.mauve.brand);
          expect(v['--k-focus']).toBe(current.accents.mauve.brand);
          expect(v['--accent-primary']).toBe(current.accents.mauve.brand);
          expect(v['--k-bg']).toBe(current.roles['--k-bg']);
        } finally {
          await page.close();
        }
      },
    );

    test('a white-label branding theme wins on every brand slot', async () => {
      const page = await themed('dark', "r.dataset.appChannel = 'beta';");
      try {
        await page.evaluate(() => {
          // What applyBrandingTheme writes for an accepted theme.
          const s = document.documentElement.style;
          s.setProperty('--k-brand', '#60a5fa');
          s.setProperty('--k-brand-contrast', '#06080b');
          s.setProperty('--k-action', '#60a5fa');
          s.setProperty('--k-action-contrast', '#06080b');
          s.setProperty('--k-focus', '#60a5fa');
        });
        const v = await read(page);
        expect(v['--k-brand']).toBe('#60a5fa');
        expect(v['--k-action']).toBe('#60a5fa');
        expect(v['--k-focus']).toBe('#60a5fa');
        // Surfaces stay the theme's.
        expect(v['--k-bg']).toBe(mocha.roles['--k-bg']);
      } finally {
        await page.close();
      }
    });

    test('a custom accent colour still wins on Station accent', async () => {
      const page = await themed('dark');
      try {
        await page.evaluate(() => {
          document.documentElement.style.setProperty(
            '--accent-primary',
            '#d946ef',
          );
        });
        const v = await read(page);
        expect(v['--accent-primary']).toBe('#d946ef');
        expect(v['--k-action']).toBe(mocha.accents.mauve.brand);
      } finally {
        await page.close();
      }
    });

    test('a named accent replaces the default on brand, action and focus', async () => {
      const page = await themed('dark', "r.dataset.colorThemeAccent = 'teal';");
      try {
        const v = await read(page);
        expect(v['--k-brand']).toBe(mocha.accents.teal.brand);
        expect(v['--k-action']).toBe(mocha.accents.teal.brand);
        expect(v['--k-action-contrast']).toBe(mocha.accents.teal.contrast);
        expect(v['--k-focus']).toBe(mocha.accents.teal.brand);
      } finally {
        await page.close();
      }
    });

    test('a dark island below a light root resolves the dark flavor, and a light island the light one', async () => {
      const page = await themed(
        'light',
        "r.dataset.colorThemeFlavor = 'macchiato';",
        '<div id="dark" data-theme="dark"><div id="inside"></div></div>',
      );
      try {
        const island = await read(page, '#inside');
        expect(island['--k-bg']).toBe(macchiato.roles['--k-bg']);
        expect(island['--bg-primary']).toBe(macchiato.roles['--k-bg']);
        expect(island['--k-brand']).toBe(macchiato.accents.mauve.brand);
        expect(island['--k-action']).toBe(macchiato.accents.mauve.brand);
        expect(island['--error-text']).toBe(
          macchiato.variables['--error-text'],
        );
        expect(island['color-scheme']).toBe('dark');
        expect((await read(page))['--k-bg']).toBe(latte.roles['--k-bg']);
      } finally {
        await page.close();
      }
      const inverse = await themed(
        'dark',
        '',
        '<div data-theme="light"><div id="inside"></div></div>',
      );
      try {
        const island = await read(inverse, '#inside');
        expect(island['--k-bg']).toBe(latte.roles['--k-bg']);
        expect(island['--text-primary']).toBe(latte.roles['--k-text']);
        expect(island['--k-brand']).toBe(latte.accents.mauve.brand);
        expect(island['--syntax-string']).toBe(
          latte.variables['--syntax-string'],
        );
      } finally {
        await inverse.close();
      }
    });
  });
});
