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
/**
 * The product-level :focus-visible rules from the real index.css (the plain
 * one and its channel/brand override), so the page is measured against the
 * outline every build actually draws, not an absent one.
 */
const PRODUCT_FOCUS_RULES = (() => {
  const css = readFileSync(resolve(REPO_ROOT, 'src-ui/src/index.css'), 'utf8');
  const rules = css.match(
    /(?:^|\n)(?::where\(|:is\(\n\s+:root\[data-brand-focus\])[^{]*\):focus-visible\s*\{[^}]*\}/g,
  );
  if (!rules || rules.length < 2)
    throw new Error('index.css focus-visible rules not found');
  return rules.join('\n');
})();
/**
 * The global `button:hover` rule from the real index.css. Its `background`
 * shorthand resets `background-clip`, so a page control that clips its paint
 * must survive it.
 */
const PRODUCT_BUTTON_HOVER_RULE = (() => {
  const css = readFileSync(resolve(REPO_ROOT, 'src-ui/src/index.css'), 'utf8');
  const rule = css.match(/(?:^|\n)button:hover\s*\{[^}]*\}/);
  if (!rule) throw new Error('index.css button:hover rule not found');
  return rule[0];
})();
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
    /** Families whose sheet answers 404 this many times before it serves. */
    failures: Record<string, number> = {},
    /** Filled with every family sheet request, in order. */
    requests: string[] = [],
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
        requests.push(sheet[1]!);
        if ((failures[sheet[1]!] ?? 0) > 0) {
          failures[sheet[1]!]! -= 1;
          return route.fulfill({ status: 404, body: 'not found' });
        }
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
        body: `<!doctype html><html data-theme="dark"><head><style>:root{--accent-primary:#ff0000;--k-text:#00ff00;--k-focus:#ff0000;--text-primary:#0000ff;--text-secondary:#888888}${PRODUCT_FOCUS_RULES}${PRODUCT_BUTTON_HOVER_RULE}${styles}</style></head><body><div id="root"></div><script src="/harness.js"></script></body></html>`,
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
    expect(await card(/^Nord/).getAttribute('class')).toContain('is-loading');
    await untilTheme(page, 'nord');
    await page.waitForFunction(
      () =>
        !document
          .querySelector('.appearance-theme.is-selected')
          ?.classList.contains('is-loading'),
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

  test('a theme whose sheet 404s says so instead of loading forever, and Try again applies it', async () => {
    const page = await open({}, { catppuccin: 1 });
    await page
      .getByRole('radio', { name: /^Catppuccin/ })
      .locator('xpath=ancestor::label[1]')
      .click();
    const alert = page.getByRole('region', { name: 'Theme not loaded' });
    await alert.waitFor({ timeout: 10_000 });
    expect(await alert.textContent()).toContain("Couldn't load Catppuccin.");
    expect(await rootAttribute(page, 'data-color-theme')).toBeNull();
    // The applier's own failure marker, not an inference of the page's.
    expect(await rootAttribute(page, 'data-color-theme-failed')).toBe(
      'catppuccin',
    );
    expect(
      await page
        .locator('.appearance-theme.is-selected .appearance-theme__detail')
        .textContent(),
    ).toBe('Not loaded');

    await page.getByRole('button', { name: 'Try again' }).click();
    await untilTheme(page, 'catppuccin');
    await alert.waitFor({ state: 'detached' });
    expect(await rootAttribute(page, 'data-color-theme-failed')).toBeNull();
    expect(
      await page
        .locator('.appearance-theme.is-selected .appearance-theme__detail')
        .textContent(),
    ).toBe('Mocha');
    await page.close();
  });

  test('after a 404, a mode toggle and a background save neither re-request the sheet nor leave "Not loaded"', async () => {
    const requests: string[] = [];
    const page = await open({}, { catppuccin: 1 }, requests);
    await page
      .getByRole('radio', { name: /^Catppuccin/ })
      .locator('xpath=ancestor::label[1]')
      .click();
    await page
      .getByRole('region', { name: 'Theme not loaded' })
      .waitFor({ timeout: 10_000 });
    const detail = page.locator(
      '.appearance-theme.is-selected .appearance-theme__detail',
    );
    // Record every text the card shows from here on, so a brief flicker to
    // "Loading…" is caught even if it settles back.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      const node = document.querySelector(
        '.appearance-theme.is-selected .appearance-theme__detail',
      )!;
      new MutationObserver(() => seen.push(node.textContent ?? '')).observe(
        node,
        { childList: true, characterData: true, subtree: true },
      );
    });
    await page
      .getByRole('radiogroup', { name: 'Mode' })
      .getByRole('radio', { name: 'Light' })
      .locator('xpath=ancestor::label[1]')
      .click();
    await page.evaluate(() =>
      (
        window as unknown as {
          store: { merge: (v: Record<string, unknown>) => void };
        }
      ).store.merge({ chatFontSize: 17 }),
    );
    await page.waitForTimeout(1000);
    expect(requests.filter((family) => family === 'catppuccin')).toHaveLength(
      1,
    );
    expect(await detail.textContent()).toBe('Not loaded');
    expect(
      await page.evaluate(() => (window as unknown as { seen: string[] }).seen),
    ).not.toContain('Loading…');
    expect(await rootAttribute(page, 'data-color-theme-failed')).toBe(
      'catppuccin',
    );
    await page.close();
  });

  // Try again lives in the notice that unmounts while the retry loads; the
  // keyboard user must not be dropped onto <body>.
  test('Try again keeps focus on the theme being retried through load and apply', async () => {
    const page = await open({ catppuccin: 600 }, { catppuccin: 1 });
    await page
      .getByRole('radio', { name: /^Catppuccin/ })
      .locator('xpath=ancestor::label[1]')
      .click();
    const tryAgain = page.getByRole('button', { name: 'Try again' });
    await tryAgain.waitFor({ timeout: 10_000 });
    await tryAgain.focus();
    await page.keyboard.press('Enter');
    const focused = () =>
      page.evaluate(() => {
        const active = document.activeElement as HTMLInputElement | null;
        return `${active?.tagName}:${active?.name ?? ''}:${active?.value ?? ''}`;
      });
    // Mid-load: the notice is gone, focus is on the retried choice.
    expect(await focused()).toBe('INPUT:appearance-color-theme:catppuccin');
    await untilTheme(page, 'catppuccin');
    expect(await focused()).toBe('INPUT:appearance-color-theme:catppuccin');
    await page.close();
  });

  // Focus and selection must read differently on a selected card: selection is
  // the accent border, focus a text-colored outline.
  // On Dev, Beta and Nightly builds (and under a theme sheet) `--k-focus`
  // equals the accent that rings a selected card, so the focus outline must
  // not follow it there either.
  test.each([
    ['a stable build', {}],
    ['a Nightly build', { channel: 'nightly' }],
    ['a Dev build', { devBuild: true }],
  ] as const)(
    'on %s a focused selected card shows a focus outline distinct from its selected border',
    async (_label, build: { channel?: string; devBuild?: boolean }) => {
      const page = await open();
      await page.evaluate((b) => {
        const root = document.documentElement;
        if (b.channel) root.setAttribute('data-app-channel', b.channel);
        if (b.devBuild) root.classList.add('is-dev-build');
      }, build);
      await page.getByRole('radio', { name: /^Station/ }).focus();
      await page.keyboard.press('ArrowRight');
      await untilTheme(page, 'catppuccin');
      const ring = await page.evaluate(() => {
        const label = document.activeElement!.closest('label')!;
        const style = getComputedStyle(label);
        const probe = (value: string) => {
          const span = document.createElement('span');
          span.style.color = value;
          document.body.append(span);
          const color = getComputedStyle(span).color;
          span.remove();
          return color;
        };
        return {
          selected: label.classList.contains('is-selected'),
          outlineStyle: style.outlineStyle,
          outlineColor: style.outlineColor,
          borderColor: style.borderColor,
          offset: style.outlineOffset,
          text: probe('var(--k-text)'),
          focus: probe('var(--k-focus)'),
        };
      });
      expect(ring.selected).toBe(true);
      expect(ring.outlineStyle).toBe('solid');
      // The theme's own text color (the sheet sets `--k-text`), not the
      // accent and not the build's focus color.
      expect(ring.outlineColor).toBe(ring.text);
      expect(ring.outlineColor).not.toBe(ring.borderColor);
      expect(ring.outlineColor).not.toBe(ring.focus);
      expect(ring.offset).toBe('3px');
      await page.close();
    },
  );

  // The product focus outline (index.css, !important) is drawn on whichever
  // swatch has focus; selection must still show inside it, so a focused
  // swatch reads differently chosen and not chosen, on every build.
  test.each([
    ['a stable build', undefined],
    ['a Nightly build', 'nightly'],
  ] as const)(
    'on %s a focused Station accent swatch still shows whether it is chosen',
    async (_label, channel) => {
      const page = await open();
      if (channel)
        await page.evaluate(
          (c) => document.documentElement.setAttribute('data-app-channel', c),
          channel,
        );
      await page.getByRole('button', { name: 'Accent color #ec4899' }).click();
      const read = (name: string) =>
        page.evaluate((n) => {
          const button = document.querySelector<HTMLElement>(
            `[aria-label="${n}"]`,
          )!;
          button.focus();
          const own = getComputedStyle(button);
          const ring = getComputedStyle(button, '::after');
          return {
            focusOutline: `${own.outlineStyle} ${own.outlineOffset}`,
            ring: ring.borderTopColor,
          };
        }, name);
      // Keyboard focus, so :focus-visible applies.
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const chosen = await read('Accent color #ec4899');
      const other = await read('Accent color #f43f5e');
      expect(chosen.focusOutline).toBe('solid 2px');
      expect(other.focusOutline).toBe('solid 2px');
      expect(chosen.ring).toBe('rgb(0, 0, 255)');
      expect(other.ring).toBe('rgba(0, 0, 0, 0)');
      await page.close();
    },
  );

  // Station's preset swatches and custom color are painted at 28px; each must
  // still take a 44px touch target at phone width, without overlapping its
  // neighbour.
  test("Station's accent swatches each take a 44px hit area at 390px", async () => {
    const page = await open();
    await page.setViewportSize({ width: 390, height: 844 });
    const hits = await page.evaluate(() => {
      const targets = [
        ...document.querySelectorAll<HTMLElement>(
          '.settings__accent-swatch, .settings__accent-custom-hit',
        ),
      ];
      return targets.map((target) => {
        target.scrollIntoView({ block: 'center' });
        const box = target.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const owns = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y);
          return hit === target || target.contains(hit);
        };
        const where = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y);
          return hit === target || target.contains(hit)
            ? 'ok'
            : `${hit?.tagName}.${hit?.className}`;
        };
        return {
          // Only the content box is painted (a `background` shorthand in an
          // inline style would reset this and paint the whole target).
          clip:
            target.querySelector('input') === null
              ? getComputedStyle(target).backgroundClip
              : 'content-box',
          // The painted circle: the swatch's content box, or the color input.
          drawn: Math.round(
            target.querySelector('input')?.getBoundingClientRect().width ??
              box.width -
                2 * Number.parseFloat(getComputedStyle(target).paddingLeft),
          ),
          debug: [
            where(cx, cy - 21),
            where(cx, cy + 21),
            where(cx - 21, cy),
            where(cx + 21, cy),
          ].join(','),
          ok:
            owns(cx, cy - 21) &&
            owns(cx, cy + 21) &&
            owns(cx - 21, cy) &&
            owns(cx + 21, cy),
        };
      });
    });
    expect(hits).toHaveLength(9);
    for (const hit of hits)
      expect(hit, hit.debug).toMatchObject({
        drawn: 28,
        clip: 'content-box',
        ok: true,
      });
    await page.close();
  });

  test("a hovered Station accent swatch still paints only its 28px circle", async () => {
    const page = await open();
    const swatch = page.getByRole('button', { name: 'Accent color #f43f5e' });
    await swatch.hover();
    const clip = await swatch.evaluate(
      (button) => getComputedStyle(button).backgroundClip,
    );
    expect(clip).toBe('content-box');
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
