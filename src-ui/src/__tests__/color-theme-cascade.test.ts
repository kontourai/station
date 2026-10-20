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
  type ColorThemeFamily,
  type ColorThemeFlavor,
} from '../lib/color-theme-catalog';

/**
 * The color theme end to end in Chromium, against the real stylesheets:
 *
 * - the real `public/startup-theme.js`, executed from a real origin with the
 *   real device-settings envelope in storage, stamps the attributes and
 *   `theme-color` before anything below it in `<head>` parses, requests only
 *   the selected family's sheet, and the splash stylesheet paints the theme;
 * - the first render waits for that sheet, so the app is never shown in
 *   Station's colours after a themed splash;
 * - the real settings store and applier (bundled from source) keep the root
 *   attributes and sheet live as a device setting changes, and the real
 *   `index.css` resolves every family and flavor through Station's aliases;
 * - Station renders exactly what it did before, even with a family sheet
 *   loaded;
 * - precedence against channel builds, white-label branding and a custom
 *   accent; islands keep Station's tokens.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const PUBLIC_DIR = resolve(REPO_ROOT, 'src-ui/public');
const ORIGIN = 'http://station.test';
const INDEX_CSS = resolve(import.meta.dirname, '../index.css');
const STARTUP_CSS = resolve(
  import.meta.dirname,
  '../components/startup-screen.css',
);
const STARTUP_SCRIPT = readFileSync(
  resolve(PUBLIC_DIR, 'startup-theme.js'),
  'utf8',
);
const ENVELOPE_KEY = 'station-device-settings-v1';

const familySheet = (id: string) =>
  readFileSync(resolve(PUBLIC_DIR, `color-themes/${id}.css`), 'utf8');
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
import {
  bindColorThemeToSettings,
  whenColorThemeStylesheetSettled,
} from './src-ui/src/lib/color-theme-apply';
import { applyBrandingTheme } from './src-ui/src/lib/branding-theme';
import { applyAccentColor } from './src-ui/src/lib/accent-contrast';
window.harness = {
  store: deviceSettingsStore,
  applyBrandingTheme,
  applyAccentColor,
  whenColorThemeStylesheetSettled,
  // What main.tsx does, plus the mode writers (AccountPreferencesProvider,
  // ThemeToggle), for a page that boots the live path.
  boot() {
    const root = document.documentElement;
    const mode = () =>
      root.setAttribute('data-theme', deviceSettingsStore.getSnapshot().theme);
    mode();
    deviceSettingsStore.subscribe(mode);
    bindColorThemeToSettings(root, deviceSettingsStore);
  },
};
`;

describe('color theme cascade', () => {
  let browser: Browser;
  let appCss: string;
  let startupCss: string;
  let harness: string;

  beforeAll(async () => {
    // Required, not skipped: without Chromium nothing here would be measured.
    if (!chromiumIsInstalled(REPO_ROOT))
      throw new Error(
        'Playwright Chromium is not installed in this worktree, so the color ' +
          'theme cascade could not be measured. Install it with ' +
          '`npm run install:playwright` and re-run.',
      );
    browser = await chromium.launch();
    appCss = resolveCssImports(INDEX_CSS);
    startupCss = resolveCssImports(STARTUP_CSS);
    for (const css of [appCss, startupCss]) assertNoImportsSurvive(css);
    // The entry stylesheet carries no theme: default users download none.
    expect(appCss).not.toContain('data-color-theme');
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

  interface OpenOptions {
    body?: string;
    values?: Record<string, unknown> | string;
    init?: string;
    /** Delay before a family sheet is served, in ms. */
    sheetDelay?: number;
    /** The last-applied appearance cache (lib/appearance-cache.ts). */
    cache?: Record<string, unknown>;
  }

  /**
   * A page at a real origin (so storage works), with `values` already in the
   * device-settings envelope when the startup script runs, and the real
   * public files served.
   */
  async function open(head: string, options: OpenOptions = {}) {
    const page = await browser.newPage();
    const requested: string[] = [];
    if (options.init) await page.addInitScript(options.init);
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/startup-theme.js')
        return route.fulfill({
          contentType: 'text/javascript',
          body: STARTUP_SCRIPT,
        });
      if (url.pathname === '/harness.js')
        return route.fulfill({ contentType: 'text/javascript', body: harness });
      if (url.pathname.startsWith('/color-themes/')) {
        requested.push(`${url.pathname}${url.search}`);
        if (options.sheetDelay)
          await new Promise((r) => setTimeout(r, options.sheetDelay));
        return route.fulfill({
          contentType: 'text/css',
          body: readFileSync(
            resolve(PUBLIC_DIR, url.pathname.slice(1)),
            'utf8',
          ),
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head>${head}</head><body>${options.body ?? ''}</body></html>`,
      });
    });
    if (options.values !== undefined)
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
            typeof options.values === 'string'
              ? options.values
              : JSON.stringify({ version: 1, values: options.values }),
        },
      );
    if (options.cache)
      await page.addInitScript((raw) => {
        if (!sessionStorage.getItem('cached')) {
          localStorage.setItem('station-appearance-v1', raw);
          sessionStorage.setItem('cached', '1');
        }
      }, JSON.stringify(options.cache));
    await page.goto(`${ORIGIN}/`);
    return Object.assign(page, { requested });
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
      `<script src="/startup-theme.js"></script><script>window.atParse = { attrs: [...document.documentElement.attributes].map(a => a.name + '=' + a.value).sort(), themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? null, sheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')) };</script><style>${css}</style>`;
    const SPLASH = '<div class="station-startup" id="splash"></div>';

    test('a saved family, flavor and accent are stamped, its sheet requested, and the splash painted', async () => {
      const page = await open(HEAD(startupCss), {
        body: SPLASH,
        values: {
          theme: 'dark',
          colorTheme: 'catppuccin',
          colorThemeFlavor: 'macchiato',
          colorThemeAccent: 'pink',
        },
        // The splash must not depend on the family sheet having arrived.
        sheetDelay: 5_000,
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
          sheets: [
            expect.stringMatching(/^\/color-themes\/catppuccin\.css\?v=/),
          ],
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
      const page = await open(HEAD(startupCss), {
        body: SPLASH,
        values: {
          theme: 'light',
          colorTheme: 'catppuccin',
          colorThemeFlavor: 'frappe',
        },
      });
      try {
        expect(await attributes(page)).toMatchObject({
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
    ])(
      '%s renders Station: no attributes, theme-color or sheet',
      async (_label, values) => {
        const page = await open(HEAD(startupCss), { body: SPLASH, values });
        try {
          expect(await attributes(page)).toEqual({
            theme: 'dark',
            colorTheme: null,
            flavor: null,
            accent: null,
            themeColor: null,
          });
          expect(page.requested).toEqual([]);
        } finally {
          await page.close();
        }
      },
    );

    const accountCache = {
      version: 1,
      source: 'account',
      theme: 'light',
      colorTheme: 'rose-pine',
      colorThemeFlavor: 'moon',
      colorThemeAccent: 'foam',
    };

    test("a signed-in person's last rendered appearance is in force before first paint, over the device envelope", async () => {
      const page = await open(HEAD(startupCss), {
        body: SPLASH,
        values: { theme: 'dark', colorTheme: 'gruvbox' },
        cache: accountCache,
      });
      try {
        const dawn = family('rose-pine').light;
        expect(await attributes(page)).toEqual({
          theme: 'light',
          colorTheme: 'rose-pine',
          flavor: 'moon',
          accent: 'foam',
          themeColor: dawn.roles['--k-bg'],
        });
        const bg = await page.evaluate(
          () =>
            getComputedStyle(document.getElementById('splash')!)
              .backgroundColor,
        );
        expect(toHex(bg)).toBe(dawn.roles['--k-bg']);
      } finally {
        await page.close();
      }
    });

    test.each([
      ['a device-sourced cache', { ...accountCache, source: 'device' }],
      ['an unknown cache version', { ...accountCache, version: 2 }],
    ])('%s is ignored: the device envelope paints', async (_label, cache) => {
      const page = await open(HEAD(startupCss), {
        body: SPLASH,
        values: { theme: 'dark', colorTheme: 'gruvbox' },
        cache,
      });
      try {
        expect(await attributes(page)).toMatchObject({
          theme: 'dark',
          colorTheme: 'gruvbox',
        });
      } finally {
        await page.close();
      }
    });

    test('the startup script needs no Object.hasOwn (Android WebView before Chrome 93)', async () => {
      const page = await open(HEAD(startupCss), {
        body: SPLASH,
        values: { colorTheme: 'gruvbox' },
        init: 'delete Object.hasOwn;',
      });
      try {
        expect(await page.evaluate(() => 'hasOwn' in Object)).toBe(false);
        expect(await attributes(page)).toMatchObject({
          colorTheme: 'gruvbox',
          flavor: 'dark',
          accent: 'orange',
        });
      } finally {
        await page.close();
      }
    });

    test('a malformed envelope keeps the legacy mode and Station', async () => {
      const page = await open(HEAD(startupCss), {
        body: SPLASH,
        values: '{not json',
      });
      try {
        expect(await attributes(page)).toMatchObject({
          theme: 'dark',
          colorTheme: null,
          themeColor: null,
        });
      } finally {
        await page.close();
      }
    });

    test('an unknown flavor or accent falls back to the family default', async () => {
      const page = await open(HEAD(startupCss), {
        body: SPLASH,
        values: {
          colorTheme: 'catppuccin',
          colorThemeFlavor: 'latte',
          colorThemeAccent: 'chartreuse',
        },
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

    test('the first render waits for a slow family sheet instead of showing Station colours', async () => {
      // What main.tsx does before renderApp, with the sheet held back: the
      // app's scripts run while the sheet is still in flight.
      const page = await open(
        `<script src="/startup-theme.js"></script><style>${appCss}</style><script src="/harness.js"></script><script>
          (() => {
            const h = window.harness;
            const action = () =>
              getComputedStyle(document.documentElement)
                .getPropertyValue('--k-action')
                .trim();
            const before = action();
            const wait = h.whenColorThemeStylesheetSettled(document);
            Promise.resolve(wait).then(() => {
              window.seen = { waited: wait !== null, before, atRender: action() };
            });
          })();
        </script>`,
        {
          values: { colorTheme: 'tokyo-night', colorThemeFlavor: 'storm' },
          sheetDelay: 800,
        },
      );
      try {
        const storm = family('tokyo-night').dark.find((f) => f.id === 'storm')!;
        await page.waitForFunction(() => 'seen' in window);
        const seen = await page.evaluate(
          () =>
            (
              window as unknown as {
                seen: { waited: boolean; before: string; atRender: string };
              }
            ).seen,
        );
        expect(seen.waited).toBe(true);
        // Without the wait the app would have rendered with Station's action...
        expect(seen.before).toBe('#5ce0c6');
        // ...with it, the first render already has the theme.
        expect(seen.atRender).toBe(storm.accents.blue.brand);
      } finally {
        await page.close();
      }
    });
  });

  describe('live (settings store → applier → index.css)', () => {
    const appHead = () =>
      `<style>${appCss}</style><script src="/harness.js"></script>`;

    const stamped = (page: Page, colorTheme: string | null) =>
      page.waitForFunction(
        (expected) =>
          document.documentElement.getAttribute('data-color-theme') ===
          expected,
        colorTheme,
      );

    test('setting the device setting loads the family sheet, stamps the root, and resolves the theme through Station aliases', async () => {
      const page = await open(appHead(), { values: {} });
      try {
        await page.evaluate(() =>
          (window as unknown as { harness: any }).harness.boot(),
        );
        expect(await attributes(page)).toMatchObject({ colorTheme: null });
        await page.evaluate(() => {
          (window as unknown as { harness: any }).harness.store.set(
            'colorTheme',
            'catppuccin',
          );
        });
        await stamped(page, 'catppuccin');
        expect(await attributes(page)).toEqual({
          theme: 'dark',
          colorTheme: 'catppuccin',
          flavor: 'mocha',
          accent: 'mauve',
          themeColor: mocha.roles['--k-bg'],
        });
        expect(page.requested).toEqual([
          expect.stringMatching(/^\/color-themes\/catppuccin\.css\?v=/),
        ]);
        const dark = await read(page);
        expect(dark['--k-bg']).toBe(mocha.roles['--k-bg']);
        expect(dark['--bg-primary']).toBe(mocha.roles['--k-bg']);
        expect(dark['--text-primary']).toBe(mocha.roles['--k-text']);
        expect(dark['--k-brand']).toBe(mocha.accents.mauve.brand);
        expect(dark['--accent-primary']).toBe(mocha.accents.mauve.brand);
        expect(dark['--text-on-accent']).toBe(mocha.accents.mauve.contrast);
        expect(dark['--k-focus-ring']).toBe(mocha.accents.mauve.brand);
        expect(dark['--error-text']).toBe(mocha.variables['--error-text']);
        expect(dark['color-scheme']).toBe('dark');

        await page.evaluate(() => {
          const { store } = (window as unknown as { harness: any }).harness;
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
        expect(light['--k-action']).toBe(latte.accents.peach.brand);
        expect(light['color-scheme']).toBe('light');

        await page.evaluate(() => {
          (window as unknown as { harness: any }).harness.store.set(
            'colorTheme',
            'station',
          );
        });
        expect(await attributes(page)).toEqual({
          theme: 'light',
          colorTheme: null,
          flavor: null,
          accent: null,
          themeColor: null,
        });
        expect(
          await page.evaluate(
            () => document.querySelectorAll('link[rel="stylesheet"]').length,
          ),
        ).toBe(0);
      } finally {
        await page.close();
      }
    });

    test('an unknown family from the account or another client renders Station', async () => {
      const page = await open(appHead(), { values: {} });
      try {
        await page.evaluate(() => {
          const h = (window as unknown as { harness: any }).harness;
          h.boot();
          h.store.bindAccountPreferences(
            { colorTheme: 'some-future-family', colorThemeFlavor: 'neon' },
            () => {},
          );
        });
        expect(await attributes(page)).toMatchObject({
          colorTheme: null,
          themeColor: null,
        });
        expect(page.requested).toEqual([]);
      } finally {
        await page.close();
      }
    });
  });

  /** A page with the theme stamped and its family sheet before the entry CSS, as in production. */
  function themed(
    id: string,
    mode: 'dark' | 'light',
    stamp: { flavor: string; accent: string },
    setup = '',
    body = '',
  ) {
    return open(
      `<script>const r = document.documentElement; r.dataset.theme = '${mode}'; r.dataset.colorTheme = '${id}'; r.dataset.colorThemeFlavor = '${stamp.flavor}'; r.dataset.colorThemeAccent = '${stamp.accent}'; ${setup}</script><style>${familySheet(id)}</style><style>${appCss}</style>`,
      { body },
    );
  }

  describe('every family and flavor resolves through index.css', () => {
    const cases = COLOR_THEME_FAMILIES.flatMap((f: ColorThemeFamily) =>
      [f.light, ...f.dark].map(
        (fl: ColorThemeFlavor) => [`${f.id}/${fl.id}`, f, fl] as const,
      ),
    );
    test.each(cases)('%s', async (_label, f, fl) => {
      const nonDefault = f.accents.find((a) => a.id !== f.defaultAccent)!.id;
      for (const accent of [f.defaultAccent, nonDefault]) {
        const page = await themed(f.id, fl.mode, {
          // Light mode ignores the dark flavor; any dark id must still work.
          flavor: fl.mode === 'dark' ? fl.id : f.defaultDarkFlavor,
          accent,
        });
        try {
          const v = await read(page);
          expect(v['--k-bg']).toBe(fl.roles['--k-bg']);
          expect(v['--bg-primary']).toBe(fl.roles['--k-bg']);
          expect(v['--text-primary']).toBe(fl.roles['--k-text']);
          expect(v['--k-action']).toBe(fl.accents[accent]!.brand);
          expect(v['--k-brand']).toBe(fl.accents[accent]!.brand);
          expect(v['--syntax-keyword']).toBe(fl.variables['--syntax-keyword']);
          expect(v['--error-text']).toBe(fl.variables['--error-text']);
          expect(v['color-scheme']).toBe(fl.mode);
        } finally {
          await page.close();
        }
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
      'with every family sheet loaded but no color theme, %s mode %s resolves exactly as without them',
      async (mode, channel) => {
        const setup = `document.documentElement.dataset.theme = ${JSON.stringify(mode)};${
          channel === 'dev'
            ? "document.documentElement.classList.add('is-dev-build');"
            : channel
              ? `document.documentElement.dataset.appChannel = ${JSON.stringify(channel)};`
              : ''
        }`;
        const sheets = COLOR_THEME_FAMILIES.map(
          (f) => `<style>${familySheet(f.id)}</style>`,
        ).join('');
        const before = await open(
          `<script>${setup}</script><style>${appCss}</style>`,
        );
        const after = await open(
          `<script>${setup}</script>${sheets}<style>${appCss}</style>`,
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
    const mauve = { flavor: 'mocha', accent: 'mauve' };

    test.each([
      ['beta', 'dark', "r.dataset.appChannel = 'beta';"],
      ['nightly', 'light', "r.dataset.appChannel = 'nightly';"],
      ['dev', 'dark', "r.classList.add('is-dev-build');"],
      ['dev', 'light', "r.classList.add('is-dev-build');"],
    ] as const)(
      'a %s build in %s mode keeps its identity on the brand while the theme owns action and focus',
      async (channel, mode, setup) => {
        const page = await themed('catppuccin', mode, mauve, setup);
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

    test('inline white-label values win on every brand slot', async () => {
      const page = await themed(
        'catppuccin',
        'dark',
        mauve,
        "r.dataset.appChannel = 'beta';",
      );
      try {
        await page.evaluate(() => {
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
        expect(v['--k-bg']).toBe(mocha.roles['--k-bg']);
      } finally {
        await page.close();
      }
    });

    test('a white-label brand that fails on a theme surface yields that slot to the theme, and is re-rated on switch', async () => {
      // #0e7c64 passes on Station's light page (4.7:1) but not on Latte's
      // (4.23:1) or Tokyo Night Day's (3.50:1); the focus ring (3:1) passes.
      const brand = '#0e7c64';
      const page = await open(
        `<script>const r = document.documentElement; r.dataset.theme = 'light'; r.dataset.colorTheme = 'catppuccin'; r.dataset.colorThemeFlavor = 'mocha'; r.dataset.colorThemeAccent = 'mauve';</script>${COLOR_THEME_FAMILIES.map((f) => `<style>${familySheet(f.id)}</style>`).join('')}<style>${appCss}</style><script src="/harness.js"></script>`,
      );
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      try {
        await page.evaluate((value) => {
          (window as unknown as { harness: any }).harness.applyBrandingTheme(
            document.documentElement,
            {
              light: {
                '--k-brand': value,
                '--k-brand-contrast': '#ffffff',
                '--k-action': value,
                '--k-action-contrast': '#ffffff',
                '--k-focus': value,
              },
            },
          );
        }, brand);
        let v = await read(page);
        expect(v['--k-brand']).toBe(latte.accents.mauve.brand);
        expect(v['--k-action']).toBe(latte.accents.mauve.brand);
        expect(v['--k-focus']).toBe(brand);
        expect(warnings.join('\n')).toContain(
          '--k-brand #0e7c64 on catppuccin/latte --k-bg #e6e9ef = 4.23:1',
        );
        // Back to Station: the brand passes there, so all of it applies.
        await page.evaluate(() => {
          const r = document.documentElement;
          r.removeAttribute('data-color-theme');
          r.removeAttribute('data-color-theme-flavor');
          r.removeAttribute('data-color-theme-accent');
        });
        v = await read(page);
        expect(v['--k-brand']).toBe(brand);
        expect(v['--k-action']).toBe(brand);
        // Tokyo Night Day: rejected again on its own page.
        await page.evaluate(() => {
          const r = document.documentElement;
          r.dataset.colorTheme = 'tokyo-night';
          r.dataset.colorThemeFlavor = 'night';
          r.dataset.colorThemeAccent = 'blue';
        });
        const day = family('tokyo-night').light;
        v = await read(page);
        expect(v['--k-brand']).toBe(day.accents.blue.brand);
        expect(v['--k-action']).toBe(day.accents.blue.brand);
        expect(warnings.join('\n')).toContain('on tokyo-night/day --k-bg');
        // Dark mode: Station's dark override is absent, so nothing is inline.
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'dark';
        });
        v = await read(page);
        expect(v['--k-brand']).toBe(
          family('tokyo-night').dark[0]!.accents.blue.brand,
        );
      } finally {
        await page.close();
      }
    });

    test('a custom accent colour still wins on Station accent', async () => {
      const page = await themed('catppuccin', 'dark', mauve);
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

    test('an island with its own data-theme keeps Station tokens (documented: islands are not themed)', async () => {
      const page = await themed(
        'catppuccin',
        'light',
        { flavor: 'macchiato', accent: 'mauve' },
        '',
        '<div data-theme="dark"><div id="inside"></div></div>',
      );
      try {
        expect((await read(page))['--k-bg']).toBe(latte.roles['--k-bg']);
        const island = await read(page, '#inside');
        expect(island['--k-bg']).toBe('#0a0e13');
        expect(island['--k-bg']).not.toBe(macchiato.roles['--k-bg']);
      } finally {
        await page.close();
      }
    });
  });
});
