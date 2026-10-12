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
const DIFF_CSS_PATH = resolve(HERE, '../DiffPanel.css');
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

/**
 * The side panel's head with the Diff pane's counts and four tools portalled
 * into its slots, and the head's ⋯ and close: `CodingWorkbench`'s head and
 * `DiffPanel`'s `renderTools('head')` classes and names, as static markup.
 */
const DIFF_HEAD_TOOLS = [
  'Collapse all files',
  'Expand all files',
  'Split view',
  'Wrap lines',
];
const DIFF_HEAD_MARKUP = `<section class="coding-workbench__page coding-workbench__page--drill-in" data-active="true" aria-label="Diff" style="width:440px">
  <header class="coding-workbench__panel-head">
    <h2 class="coding-workbench__panel-title">Diff</h2>
    <div class="coding-workbench__head-slot coding-workbench__head-slot--leading"><span class="diff-stat"><span class="diff-stat__files">2 files</span><span class="diff-stat__additions">+2</span><span class="diff-stat__deletions">−1</span></span></div>
    <div class="coding-workbench__head-slot"><div class="diff-panel__tools diff-panel__tools--head">${DIFF_HEAD_TOOLS.map(
      (name, index) =>
        `<button type="button" class="diff-tool" aria-label="${name}" title="${name}"${index > 1 ? ' aria-pressed="false"' : ''}><svg width="16" height="16" aria-hidden="true"></svg></button>`,
    ).join('')}</div></div>
    <div class="coding-workbench__more"><button type="button" class="coding-workbench__rail-item coding-workbench__more-trigger" aria-label="More actions for Diff" aria-haspopup="menu">⋯</button></div>
    <button type="button" class="coding-workbench__rail-item coding-workbench__panel-close" aria-label="Close Diff">×</button>
  </header>
</section>`;

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

    test('the Diff tools in the side panel head are 32px on a hovering pointer and 44px boxes of their own on touch, overlapping neither each other nor the close', async () => {
      const css =
        resolveCssImports(INDEX_CSS_PATH) +
        '\n' +
        readFileSync(WORKBENCH_CSS_PATH, 'utf8') +
        '\n' +
        // DiffPanel.css is a lazy chunk: it lands after the entry sheet.
        readFileSync(DIFF_CSS_PATH, 'utf8');
      assertNoImportsSurvive(css);
      // A 1366px window is past the wide fold, so the side panel and its head
      // are drawn; a touch context is the tablet that cannot hover.
      const fineContext = await browser.newContext({
        viewport: { width: 1366, height: 1024 },
      });
      const touchContext = await browser.newContext({
        viewport: { width: 1366, height: 1024 },
        hasTouch: true,
      });
      const load = async (context: typeof fineContext) => {
        const page = await context.newPage();
        await page.setContent(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css} html,body{height:100%;margin:0}</style>
  </head>
  <body>${DIFF_HEAD_MARKUP}</body>
</html>`);
        return page;
      };
      try {
        // Every target's hit box: the element, or a larger ::after/::before.
        const measure = async (context: typeof fineContext) =>
          (await load(context)).evaluate((names) => {
            const hit = (el: Element) => {
              const r = el.getBoundingClientRect();
              let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
              for (const pseudo of ['::before', '::after']) {
                const s = getComputedStyle(el, pseudo);
                if (s.content === 'none' || s.position !== 'absolute') continue;
                const w = Number.parseFloat(s.width);
                const h = Number.parseFloat(s.height);
                if (!(w > r.width || h > r.height)) continue;
                const cx = (r.left + r.right) / 2;
                const cy = (r.top + r.bottom) / 2;
                box = {
                  l: cx - w / 2,
                  t: cy - h / 2,
                  r: cx + w / 2,
                  b: cy + h / 2,
                };
              }
              return box;
            };
            const tools = names.map(
              (name) => document.querySelector(`[aria-label="${name}"]`)!,
            );
            const close = document.querySelector('[aria-label="Close Diff"]')!;
            const more = document.querySelector(
              '[aria-label="More actions for Diff"]',
            )!;
            const head = document
              .querySelector('.coding-workbench__panel-head')!
              .getBoundingClientRect();
            return {
              tools: tools.map((el) => {
                const r = el.getBoundingClientRect();
                return { w: r.width, h: r.height, hit: hit(el) };
              }),
              close: hit(close),
              more: hit(more),
              headTop: head.top,
              headBottom: head.bottom,
              hoverNone: matchMedia('(hover: none)').matches,
            };
          }, DIFF_HEAD_TOOLS);
        const overlaps = (
          a: { l: number; t: number; r: number; b: number },
          b: { l: number; t: number; r: number; b: number },
        ) =>
          a.l < b.r - 0.5 &&
          b.l < a.r - 0.5 &&
          a.t < b.b - 0.5 &&
          b.t < a.b - 0.5;
        const assertApart = (g: Awaited<ReturnType<typeof measure>>) => {
          const boxes = [...g.tools.map((tool) => tool.hit), g.more, g.close];
          for (let i = 0; i < boxes.length; i += 1)
            for (let j = i + 1; j < boxes.length; j += 1)
              expect(overlaps(boxes[i]!, boxes[j]!), `${i} vs ${j}`).toBe(
                false,
              );
          for (const tool of g.tools) {
            expect(tool.hit.t).toBeGreaterThanOrEqual(g.headTop - 0.5);
            expect(tool.hit.b).toBeLessThanOrEqual(g.headBottom + 0.5);
          }
        };

        const fine = await measure(fineContext);
        expect(fine.hoverNone).toBe(false);
        for (const tool of fine.tools)
          expect([tool.w, tool.h]).toEqual([32, 32]);
        assertApart(fine);

        const touch = await measure(touchContext);
        expect(touch.hoverNone).toBe(true);
        for (const tool of touch.tools) {
          expect(tool.hit.r - tool.hit.l).toBeGreaterThanOrEqual(44);
          expect(tool.hit.b - tool.hit.t).toBeGreaterThanOrEqual(44);
        }
        assertApart(touch);
      } finally {
        await fineContext.close();
        await touchContext.close();
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
