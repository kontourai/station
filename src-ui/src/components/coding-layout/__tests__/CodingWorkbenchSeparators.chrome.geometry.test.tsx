/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';

/**
 * The panels' splitters with the app's real cascade (delta review item 11).
 * A splitter is a <button>, and the app's base button rule gives buttons
 * padding, a border and a hover fill; on the 8px strips that drew an 18px
 * band between Chat and the side panel and a small outlined box at Chat's
 * bottom-left over the Terminal. The markup is the component's
 * (`PanelSeparator` inside the kit's Tooltip wrapper).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const WORKBENCH_CSS_PATH = resolve(HERE, '../CodingWorkbench.css');
const VIEWPORT = { width: 1440, height: 900 };

function separator(orientation: 'vertical' | 'horizontal', label: string) {
  return `<span class="tooltip-wrapper coding-workbench__separator-slot coding-workbench__separator-slot--${orientation}"><button type="button" role="separator" aria-label="${label}" aria-orientation="${orientation}" class="coding-workbench__separator coding-workbench__separator--${orientation}"></button></span>`;
}

const MARKUP = `<div class="coding-workbench" data-mode="panels" style="height:${VIEWPORT.height}px">
  <div class="coding-workbench__main">
    <div class="coding-workbench__pages">
      <div class="coding-workbench__row" data-side="open">
        <section class="coding-workbench__page coding-workbench__page--chat" data-active="true" aria-label="Chat"></section>
        ${separator('vertical', 'Resize side panel')}
        <section class="coding-workbench__page coding-workbench__page--drill-in" data-active="true" aria-label="Side"></section>
      </div>
      ${separator('horizontal', 'Resize lower panel')}
      <section class="coding-workbench__lower" data-active="true" aria-label="Lower"></section>
    </div>
  </div>
</div>`;

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'The Coding panels’ splitters (real cascade)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test('each splitter is an 8px borderless strip: no band between Chat and the side panel, and the lower one spans the edge it moves', async () => {
      const css =
        resolveCssImports(INDEX_CSS_PATH) +
        '\n' +
        readFileSync(WORKBENCH_CSS_PATH, 'utf8');
      assertNoImportsSurvive(css);
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.setContent(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css} html,body{height:100%;margin:0}</style>
  </head>
  <body>${MARKUP}</body>
</html>`);
        const measure = () =>
          page.evaluate(() => {
            const box = (selector: string) => {
              const r = document
                .querySelector(selector)!
                .getBoundingClientRect();
              return { x: r.left, y: r.top, w: r.width, h: r.height };
            };
            const style = (selector: string) => {
              const s = getComputedStyle(document.querySelector(selector)!);
              return {
                border: `${s.borderTopWidth} ${s.borderRightWidth} ${s.borderBottomWidth} ${s.borderLeftWidth}`,
                background: s.backgroundColor,
              };
            };
            return {
              chat: box('.coding-workbench__page--chat'),
              side: box('.coding-workbench__page--drill-in'),
              pages: box('.coding-workbench__pages'),
              row: box('.coding-workbench__row'),
              lower: box('.coding-workbench__lower'),
              vertical: box('.coding-workbench__separator--vertical'),
              horizontal: box('.coding-workbench__separator--horizontal'),
              verticalStyle: style('.coding-workbench__separator--vertical'),
              horizontalStyle: style(
                '.coding-workbench__separator--horizontal',
              ),
            };
          });
        const g = await measure();
        // The vertical strip: 8px, straddling the seam, adding no width.
        expect(g.vertical.w).toBe(8);
        expect(Math.abs(g.side.x - (g.chat.x + g.chat.w))).toBeLessThanOrEqual(
          1,
        );
        expect(g.vertical.x).toBeLessThan(g.side.x);
        expect(g.vertical.x + g.vertical.w).toBeGreaterThan(g.side.x);
        expect(g.verticalStyle.border).toBe('0px 0px 0px 0px');
        expect(g.verticalStyle.background).toBe('rgba(0, 0, 0, 0)');
        // The horizontal strip: 8px tall, the full width, no outline.
        expect(g.horizontal.h).toBe(8);
        expect(g.horizontal.x).toBe(g.pages.x);
        expect(g.horizontal.w).toBe(g.pages.w);
        expect(g.horizontalStyle.border).toBe('0px 0px 0px 0px');
        expect(Math.abs(g.lower.y - (g.row.y + g.row.h))).toBeLessThanOrEqual(
          1,
        );

        // Hovered, only the strip's line lights; the button gets no fill.
        await page
          .getByRole('separator', { name: 'Resize side panel' })
          .hover();
        const hovered = await measure();
        expect(hovered.verticalStyle.background).toBe('rgba(0, 0, 0, 0)');
        expect(hovered.verticalStyle.border).toBe('0px 0px 0px 0px');
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'Coding splitter geometry — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'splitters could not be measured — a missing precondition, not a ' +
        'passing check. Install it with `npm run install:playwright`.',
    );
  },
);
