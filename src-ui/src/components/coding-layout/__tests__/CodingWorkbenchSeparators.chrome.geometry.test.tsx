/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tooltip } from '@kontourai/ui/react';
import { chromium } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';

/**
 * The Chat column's edges with the app's real cascade: the panels'
 * splitters and the folded inbox's strip (delta review item 11). Each is a
 * <button>, and the app's base button rule gives buttons padding, a border,
 * a radius and a hover fill; on the 8px strips that drew an 18px band
 * between Chat and the side panel and a small outlined box at Chat's
 * bottom-left over the Terminal.
 *
 * The wrapper is the kit's real `Tooltip` (its tip span included), rendered
 * here; the buttons repeat `PanelSeparator`'s and the inbox edge's classes,
 * label and ARIA attributes as static markup, without their handlers.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const WORKBENCH_CSS_PATH = resolve(HERE, '../CodingWorkbench.css');
const VIEWPORT = { width: 1440, height: 900 };

function separator(orientation: 'vertical' | 'horizontal', label: string) {
  return renderToStaticMarkup(
    <Tooltip
      label={label}
      placement={orientation === 'vertical' ? 'left' : 'top'}
      className={`coding-workbench__separator-slot coding-workbench__separator-slot--${orientation}`}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the component's splitter is a focusable button. */}
      <button
        type="button"
        role="separator"
        className={`coding-workbench__separator coding-workbench__separator--${orientation}`}
        aria-label={label}
        aria-orientation={orientation}
        aria-valuenow={360}
        aria-valuemin={240}
        aria-valuemax={720}
      />
    </Tooltip>,
  );
}

/** The folded inbox's strip on the Chat column, with or without a count. */
function inboxEdgeMarkup(needsYou: number) {
  const name = needsYou > 0 ? `Show inbox, ${needsYou} need you` : 'Show inbox';
  const strip = renderToStaticMarkup(
    <Tooltip
      label={name}
      placement="right"
      className="coding-workbench__inbox-edge-slot"
    >
      <button
        type="button"
        className={`coding-workbench__inbox-edge${needsYou > 0 ? ' coding-workbench__inbox-edge--needs-you' : ''}`}
        aria-hidden="true"
        tabIndex={-1}
      >
        <span className="coding-workbench__inbox-edge-glyph" aria-hidden="true">
          ›
        </span>
        {needsYou > 0 ? (
          <span
            className="coding-workbench__inbox-edge-count"
            aria-hidden="true"
          >
            {needsYou}
          </span>
        ) : null}
      </button>
    </Tooltip>,
  );
  return `<div class="coding-workbench" data-mode="panels" style="height:${VIEWPORT.height}px">
  <div class="coding-workbench__main"><div class="coding-workbench__pages"><div class="coding-workbench__row">
    <section class="coding-workbench__page coding-workbench__page--chat" data-active="true" aria-label="Chat">${strip}</section>
  </div></div></div>
</div>`;
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
  'The Coding Chat column’s edges: splitters and the folded inbox strip (real cascade)',
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

    test('the folded inbox strip is square; its rule is the neutral border at rest, a 60% accent mix for a Needs-you count, and the full accent on hover', async () => {
      const css =
        resolveCssImports(INDEX_CSS_PATH) +
        '\n' +
        readFileSync(WORKBENCH_CSS_PATH, 'utf8');
      assertNoImportsSurvive(css);
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        const load = (needsYou: number) =>
          page.setContent(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css} html,body{height:100%;margin:0}</style>
  </head>
  <body>${inboxEdgeMarkup(needsYou)}</body>
</html>`);
        // The rule's colour, and the colours it may be, resolved by the same
        // cascade on a probe beside the strip.
        const measure = () =>
          page.evaluate(() => {
            const strip = document.querySelector<HTMLElement>(
              '.coding-workbench__inbox-edge',
            )!;
            const resolve = (value: string) => {
              const probe = document.createElement('span');
              probe.style.color = value;
              strip.parentElement!.append(probe);
              const colour = getComputedStyle(probe).color;
              probe.remove();
              return colour;
            };
            const s = getComputedStyle(strip);
            return {
              rule: s.borderRightColor,
              ruleWidth: s.borderRightWidth,
              radius: `${s.borderTopLeftRadius} ${s.borderTopRightRadius} ${s.borderBottomRightRadius} ${s.borderBottomLeftRadius}`,
              neutral: resolve('var(--border-primary)'),
              accent: resolve('var(--accent-primary)'),
              needsYou: resolve(
                'color-mix(in srgb, var(--accent-primary) 60%, transparent)',
              ),
            };
          });

        await load(0);
        const rest = await measure();
        expect(rest.radius).toBe('0px 0px 0px 0px');
        expect(rest.ruleWidth).toBe('3px');
        expect(new Set([rest.neutral, rest.accent, rest.needsYou]).size).toBe(
          3,
        );
        expect(rest.rule).toBe(rest.neutral);

        await load(3);
        const asked = await measure();
        expect(asked.radius).toBe('0px 0px 0px 0px');
        expect(asked.rule).toBe(asked.needsYou);

        await page.locator('.coding-workbench__inbox-edge').hover();
        await expect
          .poll(async () => (await measure()).rule)
          .toBe(asked.accent);
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
