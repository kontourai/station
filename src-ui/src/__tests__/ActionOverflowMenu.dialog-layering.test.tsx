/**
 * @vitest-environment jsdom
 *
 * #3045 review M2 — an overflow menu opened from INSIDE a dialog, proved in a
 * real engine.
 *
 * The menu portals to the body at `--layer-navigation` (9350), which is right
 * for the dock and for a page: it beats the dock and yields to a dialog. It
 * is wrong for a trigger that sits IN a dialog (`--layer-dialog`, 10000): the
 * menu opened behind the surface holding its own trigger — nothing appeared,
 * and its rows hit-tested to the dialog. A z-index is a cascade outcome and
 * "is it clickable" is a hit test, so neither can be answered by reading the
 * declaration; jsdom's `elementsFromPoint` returns nothing useful.
 *
 * Shape follows ChatDockHeaderMoreMenu.layering.test.tsx: the REAL `Dialog`
 * and `ActionRow` are rendered here with the menu open, and that markup is
 * laid out by the real stylesheets in Chromium.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { ActionRow } from '../components/ActionRow';
import { Dialog } from '../components/Dialog';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const SHEETS = [
  '../index.css',
  '../components/ActionRow.css',
  '../components/ActionOverflowMenu.css',
].map((sheet) => resolve(HERE, sheet));

const ITEMS = [
  { key: 'a', label: 'Duplicate', onSelect: () => {} },
  { key: 'b', label: 'Export', onSelect: () => {} },
  { key: 'c', label: 'Remove', tone: 'danger' as const, onSelect: () => {} },
];

/** The real components, menu open, with the trigger in or out of a dialog. */
function markupWithOpenMenu(inDialog: boolean): string {
  // One case measures both arrangements, so start from an empty document.
  cleanup();
  document.body.innerHTML = '';
  const row = (
    <ActionRow
      overflowLabel="More skill actions"
      primary={<button type="button">Save</button>}
      overflow={ITEMS}
    />
  );
  render(
    inDialog ? (
      <Dialog title="Edit skill" closeLabel="Close" onClose={() => {}}>
        {row}
      </Dialog>
    ) : (
      row
    ),
  );
  const trigger = screen.getByRole('button', { name: 'More skill actions' });
  // The middle of a 1200x800 viewport, where the centred dialog panel is, so
  // the menu opens over the panel rather than beside it.
  trigger.getBoundingClientRect = () =>
    ({ top: 380, bottom: 412, left: 668, right: 700 }) as DOMRect;
  fireEvent.click(trigger);
  return document.body.innerHTML;
}

function fixtureHtml(bodyMarkup: string): string {
  const seen = new Set<string>();
  const css = SHEETS.map((sheet) => resolveCssImports(sheet, seen)).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">${bodyMarkup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'overflow menu reachability from inside a dialog (#3045)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => {
      cleanup();
      document.body.innerHTML = '';
    });

    async function measure(inDialog: boolean) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      });
      try {
        await page.setContent(fixtureHtml(markupWithOpenMenu(inDialog)));
        return await page.evaluate(() => {
          const menu = document.querySelector<HTMLElement>('[role="menu"]');
          if (!menu) throw new Error('no menu rendered');
          const rows = [
            ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
          ];
          const overlay = document.querySelector('.responsive-surface-overlay');
          const panel = document.querySelector('.responsive-surface-panel');
          const layer = (element: Element | null) =>
            element ? Number(getComputedStyle(element).zIndex) : Number.NaN;
          const overlaps = (a?: DOMRect, b?: DOMRect) =>
            Boolean(
              a &&
                b &&
                a.top < b.bottom &&
                a.bottom > b.top &&
                a.left < b.right &&
                a.right > b.left,
            );
          const describe = (element: Element | null) =>
            element
              ? `${element.tagName.toLowerCase()}.${element.className || '(no class)'}`
              : 'null';
          const backdrop = document.querySelector('.chat-dock__more-backdrop');
          const backdropRect = backdrop?.getBoundingClientRect();
          return {
            menuOverPanel: overlaps(
              menu.getBoundingClientRect(),
              panel?.getBoundingClientRect(),
            ),
            layers: {
              menu: layer(menu),
              backdrop: layer(backdrop),
              dialog: layer(overlay),
            },
            rows: rows.map((row) => {
              const rect = row.getBoundingClientRect();
              const top = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
              return {
                label: row.textContent ?? '',
                height: Math.round(rect.height),
                hitsRow: top === row || row.contains(top),
                topmost: describe(top),
              };
            }),
            // A press OUTSIDE the menu must reach the menu's own backdrop
            // (which dismisses it), not the dialog underneath.
            outsideHits: describe(
              document.elementFromPoint(
                (backdropRect?.left ?? 0) + 20,
                (backdropRect?.top ?? 0) + 20,
              ),
            ),
          };
        });
      } finally {
        await page.close();
      }
    }

    test('every row of a menu opened inside a dialog can be clicked', async () => {
      const result = await measure(true);

      // The premise: a menu beside the dialog would hit-test fine whatever
      // its layer.
      expect(
        result.menuOverPanel,
        'fixture must open the menu over the dialog panel',
      ).toBe(true);
      expect(result.rows.map((row) => row.label)).toEqual([
        'Duplicate',
        'Export',
        'Remove',
      ]);
      for (const row of result.rows) {
        expect(row.height).toBeGreaterThan(0);
        expect(
          row.hitsRow,
          `a click at the centre of "${row.label}" landed on ${row.topmost}`,
        ).toBe(true);
      }
    });

    test('the menu and its backdrop are above the dialog, one step apart', async () => {
      const { layers, outsideHits } = await measure(true);

      expect(layers.dialog).toBeGreaterThan(0);
      expect(layers.menu).toBeGreaterThan(layers.dialog);
      expect(layers.backdrop).toBeGreaterThan(layers.dialog);
      expect(layers.backdrop).toBe(layers.menu - 1);
      expect(outsideHits).toContain('chat-dock__more-backdrop');
    });

    test('outside a dialog the menu stays on the navigation layer, below dialogs', async () => {
      const inside = await measure(true);
      const { layers, rows } = await measure(false);

      // Raising EVERY menu above dialogs would put a page's menu over a
      // confirm it did not open.
      expect(layers.menu).toBeLessThan(inside.layers.dialog);
      expect(layers.backdrop).toBe(layers.menu - 1);
      expect(rows.every((row) => row.hitsRow)).toBe(true);
    });
  },
);

test.skipIf(chromiumAvailable)(
  'overflow menu in a dialog — Chromium not installed, cannot verify (#3045)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the menu’s ' +
        'reachability over a dialog could not be measured — this is a missing ' +
        'precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
