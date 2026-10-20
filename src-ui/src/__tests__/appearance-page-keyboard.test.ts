import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromiumIsInstalled } from '../../../tests/helpers/css-cascade-fixture';

/**
 * The Appearance page's keyboard contract in Chromium, which jsdom cannot
 * stand in for: arrow keys inside a native radio group move the selection, and
 * the browser — not this page — decides that. What the page owns is giving
 * each group one name, keeping its radios focusable while visually clipped,
 * applying a choice on `change`, and drawing the focus ring on the visible
 * card. The real page, real settings store and real applier are bundled from
 * source; the root attributes are what the stylesheet keys on.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const ORIGIN = 'http://station.test';
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);
const PUBLIC_DIR = resolve(REPO_ROOT, 'src-ui/public');
const NORD_DARK_BACKGROUND = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../lib/color-theme-index.generated.json'),
      'utf8',
    ),
  ) as { families: { nord: { dark: { background: string }[] } } }
).families.nord.dark[0]!.background.toLowerCase();

const HARNESS = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { KeyboardShortcutsProvider } from './src-ui/src/contexts/KeyboardShortcutsContext';
import { bindColorThemeToSettings } from './src-ui/src/lib/color-theme-apply';
import { deviceSettingsStore } from './src-ui/src/lib/device-settings-store';
import { AppearancePage } from './src-ui/src/pages/AppearancePage';
bindColorThemeToSettings(document.documentElement, deviceSettingsStore);
window.store = deviceSettingsStore;
createRoot(document.getElementById('root')).render(
  createElement(KeyboardShortcutsProvider, null, createElement(AppearancePage)),
);
`;

describe.skipIf(!chromiumAvailable)('Appearance page keyboard', () => {
  let browser: Browser;
  let script: string;
  let styles: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    const bundled = await build({
      stdin: { contents: HARNESS, resolveDir: REPO_ROOT, loader: 'tsx' },
      bundle: true,
      write: false,
      outdir: 'out',
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      loader: { '.svg': 'dataurl', '.png': 'dataurl' },
      define: {
        'import.meta.env': JSON.stringify({ DEV: false, PROD: true }),
        'process.env.NODE_ENV': '"production"',
      },
      logLevel: 'silent',
    });
    script = bundled.outputFiles.find((file) =>
      file.path.endsWith('.js'),
    )!.text;
    styles =
      bundled.outputFiles.find((file) => file.path.endsWith('.css'))?.text ??
      '';
    // The page's own rules must be in the sheet, or the focus assertion below
    // would be measuring nothing.
    expect(styles).toContain('.appearance-theme');
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * The real family sheets from `public/color-themes/`, each held back by
   * `delays[family]` ms, so a test can make an earlier choice's sheet arrive
   * after a later one's — the order a slow network produces.
   */
  async function open(
    delays: Readonly<Record<string, number>> = {},
  ): Promise<Page> {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/harness.js')
        return route.fulfill({ contentType: 'text/javascript', body: script });
      const sheet = /^\/color-themes\/([a-z-]+)\.css$/.exec(path);
      if (sheet) {
        const body = readFileSync(resolve(PUBLIC_DIR, `.${path}`), 'utf8');
        return new Promise<void>((done) =>
          setTimeout(
            () => done(route.fulfill({ contentType: 'text/css', body })),
            delays[sheet[1]!] ?? 0,
          ),
        );
      }
      return route.fulfill({
        contentType: 'text/html',
        // `--accent-primary` is defined so the focus ring has a colour to
        // resolve; without it the declaration is invalid and draws nothing.
        body: `<!doctype html><html data-theme="dark"><head><style>:root{--accent-primary:#ff0000}${styles}</style></head><body><div id="root"></div><script src="/harness.js"></script></body></html>`,
      });
    });
    await page.goto(`${ORIGIN}/`);
    await page.getByRole('radiogroup', { name: 'Color theme' }).waitFor();
    expect(errors).toEqual([]);
    return page;
  }

  const rootAttribute = (page: Page, name: string) =>
    page.evaluate((n) => document.documentElement.getAttribute(n), name);

  /** Waits for the root to name `expected` (the sheet loads first). */
  async function untilTheme(page: Page, expected: string | null) {
    await page.waitForFunction(
      (want) =>
        document.documentElement.getAttribute('data-color-theme') === want,
      expected,
      { timeout: 10_000 },
    );
  }

  test('arrow keys move through the theme gallery and apply each theme', async () => {
    const page = await open();
    const station = page.getByRole('radio', { name: /^Station/ });
    await station.focus();
    await page.keyboard.press('ArrowRight');
    await untilTheme(page, 'catppuccin');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('value')),
    ).toBe('catppuccin');
    // The ring is drawn on the visible card, not on the clipped input.
    const focusedOutline = await page.evaluate(() => {
      const label = document.activeElement!.closest('label')!;
      return getComputedStyle(label).outlineStyle;
    });
    expect(focusedOutline).toBe('solid');

    await page.keyboard.press('ArrowRight');
    await untilTheme(page, 'rose-pine');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await untilTheme(page, null);
    await page.close();
  });

  test('the gallery is one tab stop, and arrows in the accent group clear a custom accent', async () => {
    const page = await open();
    await page.evaluate(() => {
      (
        window as unknown as {
          store: { merge: (v: Record<string, unknown>) => void };
        }
      ).store.merge({ colorTheme: 'catppuccin', accentColor: '#22c55e' });
    });
    await page.getByRole('radiogroup', { name: 'Accent' }).waitFor();
    await untilTheme(page, 'catppuccin');
    await page.getByRole('radio', { name: /^Catppuccin/ }).focus();
    // Tab leaves the whole gallery for the next group rather than visiting
    // each theme in turn.
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('name')),
    ).toBe('appearance-flavor');
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('name')),
    ).toBe('appearance-accent');
    // No accent is checked while the custom one is in force, so the arrow
    // moves from the first radio and chooses the next one.
    await page.keyboard.press('ArrowRight');
    const settings = await page.evaluate(() => {
      const snapshot = (
        window as unknown as {
          store: { getSnapshot: () => Record<string, unknown> };
        }
      ).store.getSnapshot();
      return {
        accentColor: snapshot.accentColor,
        colorThemeAccent: snapshot.colorThemeAccent,
      };
    });
    expect(settings.accentColor).toBeNull();
    expect(typeof settings.colorThemeAccent).toBe('string');
    await page.waitForFunction(
      (want) =>
        document.documentElement.getAttribute('data-color-theme-accent') ===
        want,
      settings.colorThemeAccent,
    );
    await page.close();
  });

  // A real browser and real sheets, with the FIRST choice's sheet arriving
  // last: the page must end on the last choice, with one sheet in the head,
  // and the gallery must not show a tick until that sheet is in.
  test('rapid theme choices end on the last one when an earlier sheet arrives later', async () => {
    const page = await open({ catppuccin: 1200, 'rose-pine': 600, nord: 50 });
    const card = (name: RegExp) =>
      page.getByRole('radio', { name }).locator('xpath=ancestor::label[1]');
    await card(/^Catppuccin/).click();
    await card(/^Rosé Pine/).click();
    await card(/^Nord/).click();
    // Chosen at once, applied only once Nord's sheet is in.
    expect(await card(/^Nord/).getAttribute('aria-busy')).toBe('true');
    await untilTheme(page, 'nord');
    await page.waitForFunction(
      () =>
        !document
          .querySelector('.appearance-theme.is-selected')
          ?.hasAttribute('aria-busy'),
    );
    expect(
      await card(/^Nord/).locator('.appearance-theme__check').count(),
    ).toBe(1);
    // Outlast both superseded sheets; neither may take over.
    await page.waitForTimeout(1500);
    expect(await rootAttribute(page, 'data-color-theme')).toBe('nord');
    const sheets = await page.evaluate(() =>
      [...document.head.querySelectorAll('link[rel="stylesheet"]')].map(
        (link) => new URL((link as HTMLLinkElement).href).pathname,
      ),
    );
    expect(sheets).toEqual(['/color-themes/nord.css']);
    // The sheet's rules really apply: Nord's canvas, not Station's.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--k-bg')
          .trim()
          .toLowerCase(),
      ),
    ).toBe(NORD_DARK_BACKGROUND);
    await page.close();
  });

  test('the theme shortcut toggles mode on this page', async () => {
    const page = await open();
    const theme = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              store: { getSnapshot: () => { theme: string } };
            }
          ).store.getSnapshot().theme,
      );
    expect(await theme()).toBe('dark');
    await page.locator('body').click();
    await page.keyboard.press('ControlOrMeta+h');
    expect(await theme()).toBe('light');
    expect(
      await page
        .getByRole('radiogroup', { name: 'Mode' })
        .getByRole('radio', { name: 'Light' })
        .isChecked(),
    ).toBe(true);
    await page.close();
  });
});
