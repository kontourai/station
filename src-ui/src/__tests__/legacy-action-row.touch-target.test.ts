import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../tests/helpers/touch-target';

/**
 * index.css carries a mobile baseline for legacy action rows that have not
 * moved to a named primitive: any element whose class names an actions,
 * footer, or toolbar row (the vocabulary responsive-surface-ratchet.mjs
 * discovers) wraps instead of overflowing, and its direct controls get a
 * 44px floor. Measured in Chromium against the real cascade, because CSS text
 * cannot show which rule wins or whether a row actually wraps.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

const ROW_CLASSES = [
  'probe__actions',
  'probe__footer',
  'probe__toolbar',
  'probe-actions',
  'probe-footer',
  'probe-toolbar',
];

// Small enough that nothing but the action-row floor can lift it to 44px.
const TINY_BUTTON =
  '<button type="button" style="padding:0;border:0;font-size:8px;line-height:1">x</button>';

function fixtureHtml(css: string): string {
  const rows = ROW_CLASSES.map(
    (rowClass) =>
      // Six 44px controls cannot fit a 200px row on one line.
      `<div style="width:200px"><div data-row="${rowClass}" class="${rowClass}" style="display:flex">${TINY_BUTTON.repeat(6)}</div></div>`,
  ).join('');
  return `<!doctype html><html><head><style>${css}</style></head><body>${rows}<div data-row="control">${TINY_BUTTON}</div></body></html>`;
}

describe.skipIf(!chromiumAvailable)(
  'legacy action rows at a phone viewport',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test('wrap their controls and lift each to the touch-target floor', async () => {
      const css = resolveCssImports(
        resolve(import.meta.dirname, '../index.css'),
      );
      assertNoImportsSurvive(css);
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.setContent(fixtureHtml(css));
        const measured = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-row]')].map(
            (row) => {
              const boxes = [...row.querySelectorAll('button')].map((button) =>
                button.getBoundingClientRect(),
              );
              return {
                row: row.dataset.row,
                minWidth: Math.min(...boxes.map((box) => box.width)),
                minHeight: Math.min(...boxes.map((box) => box.height)),
                overflows: row.scrollWidth > row.clientWidth,
                lines: new Set(boxes.map((box) => Math.round(box.top))).size,
              };
            },
          ),
        );
        const control = measured.find(({ row }) => row === 'control');
        // Negative control: the same button outside an action row stays
        // small, so the floor below comes from the action-row rule.
        expect(control?.minHeight).toBeLessThan(MIN_TOUCH_TARGET_PX);

        const rows = measured.filter(({ row }) => row !== 'control');
        expect(rows.map(({ row }) => row)).toEqual(ROW_CLASSES);
        for (const row of rows) {
          expect(row.minWidth, row.row).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );
          expect(row.minHeight, row.row).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );
          expect(row.overflows, row.row).toBe(false);
          expect(row.lines, row.row).toBeGreaterThan(1);
        }
      } finally {
        await page.close();
      }
    }, 120_000);
  },
);

test.skipIf(chromiumAvailable)(
  'legacy action rows — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the legacy ' +
        'action-row touch-target floor could not be checked. This is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
