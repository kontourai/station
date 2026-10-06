/**
 * #3045 review M2/M3 — an overflow menu opened from inside an overlay, proved
 * in a real engine with the real components running.
 *
 * The menu portals to the body at `--layer-navigation` (9350), which is right
 * for the dock and for a page: it beats the dock and yields to a dialog. It
 * is wrong for a trigger hosted by anything higher: the menu opened BEHIND
 * the surface holding its own trigger — nothing appeared, and its rows
 * hit-tested to that surface.
 *
 * The first fix asked "is there a dialog among the trigger's DOM ancestors".
 * That missed two cases, both here: a surface portalled out of a dialog (the
 * dialog is not a DOM ancestor) and a dialog on the system layer (above
 * `dialog + 2`). The menu now reads its host's actual layer from computed
 * style and from the overlay context, and neither is something jsdom
 * computes — so this bundles a small entry with esbuild and runs React in
 * Chromium: real clicks, real layout, real `elementFromPoint`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const SHEETS = [
  '../index.css',
  '../components/ActionRow.css',
  '../components/ActionOverflowMenu.css',
].map((sheet) => resolve(HERE, sheet));

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'overflow menu reachability from inside an overlay (#3045)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let html: (scenario: string) => string;

    beforeAll(async () => {
      const bundle = await build({
        entryPoints: [resolve(HERE, 'fixtures/overflow-menu-harness.tsx')],
        bundle: true,
        format: 'iife',
        write: false,
        jsx: 'automatic',
        platform: 'browser',
        loader: { '.css': 'empty' },
        define: {
          'process.env.NODE_ENV': '"production"',
          'import.meta.env': '{}',
        },
        logLevel: 'silent',
      });
      const script = bundle.outputFiles[0]!.text.replaceAll(
        '</script',
        '<\\/script',
      );
      const seen = new Set<string>();
      const css = SHEETS.map((sheet) => resolveCssImports(sheet, seen)).join(
        '\n',
      );
      assertNoImportsSurvive(css);
      html = (scenario) => `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">
    <script>window.__scenario = ${JSON.stringify(scenario)};</script>
    <script>${script}</script>
  </body>
</html>`;
      browser = await chromium.launch();
    }, 120_000);
    afterAll(async () => {
      await browser?.close();
    });

    async function withMenuOpen<T>(
      scenario: string,
      run: (page: Page) => Promise<T>,
    ): Promise<T> {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      });
      try {
        await page.setContent(html(scenario));
        const trigger = page.getByRole('button', {
          name: 'More skill actions',
        });
        await trigger.waitFor();
        if (scenario === 'popover-in-dialog') {
          // The popover layer sits BELOW the dialog layer in this app, so the
          // trigger is covered and an ordinary click cannot reach it. What is
          // under test is where the MENU lands once it is open, so open it
          // through the DOM. Every other scenario uses a real click.
          await trigger.evaluate((element: HTMLElement) => element.click());
        } else {
          await trigger.click();
        }
        await page.getByRole('menu').waitFor();
        return await run(page);
      } finally {
        await page.close();
      }
    }

    const measure = (page: Page) =>
      page.evaluate(() => {
        const menu = document.querySelector<HTMLElement>('[role="menu"]');
        if (!menu) throw new Error('no menu rendered');
        const layer = (element: Element | null) =>
          element ? Number(getComputedStyle(element).zIndex) : Number.NaN;
        const describe = (element: Element | null) =>
          element
            ? `${element.tagName.toLowerCase()}.${element.className || '(no class)'}`
            : 'null';
        const overlays = [
          ...document.querySelectorAll('.responsive-surface-overlay'),
        ];
        const box = menu.getBoundingClientRect();
        return {
          layers: {
            menu: layer(menu),
            backdrop: layer(
              document.querySelector('.chat-dock__more-backdrop'),
            ),
            overlays: overlays.map(layer),
          },
          menuOverAnOverlayPanel: [
            ...document.querySelectorAll('.responsive-surface-panel'),
          ].some((panel) => {
            const other = panel.getBoundingClientRect();
            return (
              box.top < other.bottom &&
              box.bottom > other.top &&
              box.left < other.right &&
              box.right > other.left
            );
          }),
          rows: [
            ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
          ].map((row) => {
            const rect = row.getBoundingClientRect();
            const top = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return {
              label: row.textContent ?? '',
              hitsRow: top === row || row.contains(top),
              topmost: describe(top),
            };
          }),
          outsideHits: describe(document.elementFromPoint(5, 5)),
        };
      });

    test.each([
      ['dialog', 'a dialog'],
      ['system', 'a dialog on the system layer'],
      ['dialog-in-dialog', 'a dialog opened from a dialog'],
      ['popover-in-dialog', 'a popover surface opened from a dialog'],
    ])(
      '%s: every row of a menu opened inside %s can be hit',
      async (scenario) => {
        const result = await withMenuOpen(scenario, measure);

        // The premise: a menu that misses every overlay would hit-test fine
        // whatever its layer.
        expect(
          result.menuOverAnOverlayPanel,
          'fixture must open the menu over an overlay panel',
        ).toBe(true);
        expect(result.rows.map((row) => row.label)).toEqual([
          'Duplicate',
          'Export',
          'Remove',
        ]);
        for (const row of result.rows) {
          expect(
            row.hitsRow,
            `a click at the centre of "${row.label}" landed on ${row.topmost}`,
          ).toBe(true);
        }
        // Above EVERY overlay on the page, with its backdrop one step below it
        // and still above them — so a press outside reaches the backdrop.
        const host = Math.max(...result.layers.overlays);
        expect(result.layers.menu).toBeGreaterThan(host);
        expect(result.layers.backdrop).toBeGreaterThan(host);
        expect(result.layers.backdrop).toBe(result.layers.menu - 1);
        expect(result.outsideHits).toContain('chat-dock__more-backdrop');
      },
    );

    test('a real click on a row inside a dialog runs its action', async () => {
      const selected = await withMenuOpen('dialog', async (page) => {
        await page.getByRole('menuitem', { name: 'Export' }).click();
        await page.getByRole('menu').waitFor({ state: 'detached' });
        return page.evaluate(() => window.__selected);
      });
      expect(selected).toEqual(['Export']);
    });

    test('outside any overlay the menu stays on the navigation layer, below dialogs', async () => {
      const dialog = await withMenuOpen('dialog', measure);
      const page = await withMenuOpen('page', measure);

      // Raising EVERY menu above dialogs would put a page's menu over a
      // confirm it did not open.
      expect(page.layers.menu).toBeLessThan(
        Math.max(...dialog.layers.overlays),
      );
      expect(page.layers.backdrop).toBe(page.layers.menu - 1);
      expect(page.rows.every((row) => row.hitsRow)).toBe(true);
    });
  },
);

test.skipIf(chromiumAvailable)(
  'overflow menu in an overlay — Chromium not installed, cannot verify (#3045)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the menu’s ' +
        'reachability over a dialog could not be measured — this is a missing ' +
        'precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
