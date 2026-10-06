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
 * The rail with more items than a short window shows (design audit D1/U12,
 * delta review): it scrolls, so the last items — the Browser launcher and
 * "+" — stay reachable, while the Browser flyout and a tooltip, drawn on the
 * body with `position: fixed` from the item's box, are not clipped by it.
 * Static markup with the real cascade; the placement formula is the
 * component's (`RailTip`, `BrowserRailItem`), applied here in-page.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const WORKBENCH_CSS_PATH = resolve(HERE, '../CodingWorkbench.css');
const ROUTE_TRANSITION_CSS_PATH = resolve(
  HERE,
  '../../../app-shell/route-transition.css',
);
const HOST_ACTIONS_CSS_PATH = resolve(
  HERE,
  '../../../workspace-panes/WorkspacePaneHostActions.css',
);
const VIEWPORT = { width: 1280, height: 800 };
const ITEMS = 20;

function railMarkup(): string {
  const items = Array.from(
    { length: ITEMS },
    (_, index) =>
      `<span class="coding-workbench__rail-tip-anchor"><button type="button" class="coding-workbench__rail-item" data-rail-item="pane-${index}" aria-label="Pane ${index}">${index}</button></span>`,
  ).join('');
  // The shell's own chain above the layout, as the app mounts it: the route
  // wrapper keeps its automatic minimum height (flow routes scroll in
  // `.content-view`), so nothing above the workbench bounds its height.
  return `<div id="root"><div class="app app--with-sidebar"><div class="app__main"><main class="main-content" id="station-main"><div class="content-view"><div class="route-transition"><div class="workspace-host-actions__frame"><div class="workspace-host-actions__content">
  <div class="coding-workbench" data-mode="panels">
    <div class="coding-workbench__main"><div class="coding-workbench__pages"></div></div>
    <nav class="coding-workbench__rail" aria-label="Views">${items}
      <div class="coding-workbench__rail-slot"><span class="coding-workbench__rail-tip-anchor"><button type="button" class="coding-workbench__rail-item" data-rail-item="browser" aria-label="Open Browser pane">B</button></span></div>
      <span class="coding-workbench__rail-tip-anchor"><button type="button" class="coding-workbench__rail-item coding-workbench__rail-item--add" aria-label="Add pane">+</button></span>
    </nav>
  </div>
</div></div></div></main></div></div></div>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'The Coding rail with many panes (real cascade)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test('at 800px tall with 20 items the rail scrolls to its last item, and a fixed flyout and tooltip placed from an item render unclipped', async () => {
      const css =
        resolveCssImports(INDEX_CSS_PATH) +
        '\n' +
        readFileSync(ROUTE_TRANSITION_CSS_PATH, 'utf8') +
        '\n' +
        readFileSync(HOST_ACTIONS_CSS_PATH, 'utf8') +
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
  <body>${railMarkup()}</body>
</html>`);
        // The route wrapper enters with a short translate; measure after it
        // settles, not mid-animation.
        await page.evaluate(() =>
          Promise.all(document.getAnimations().map((a) => a.finished)),
        );
        const rail = page.locator('.coding-workbench__rail');
        const add = page.getByRole('button', { name: 'Add pane' });
        const before = await rail.evaluate((el) => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: getComputedStyle(el).overflowY,
        }));
        expect(before.overflowY).toBe('auto');
        // The rail scrolls inside the window; the layout does not grow past
        // it (the route's scroller has nothing to scroll).
        const railBox = (await rail.boundingBox())!;
        // An unbounded rail ends near 1,000px.
        expect(railBox.y + railBox.height).toBeLessThanOrEqual(VIEWPORT.height);
        const outer = await page
          .locator('.content-view')
          .evaluate((el) => el.scrollHeight - el.clientHeight);
        expect(outer).toBeLessThanOrEqual(0);
        expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
        const addBefore = (await add.boundingBox())!;
        expect(addBefore.y + addBefore.height).toBeGreaterThan(VIEWPORT.height);

        // Reachable: scrolled to the end, "+" is on screen and under the pointer.
        await rail.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        const addAfter = (await add.boundingBox())!;
        expect(addAfter.y + addAfter.height).toBeLessThanOrEqual(
          VIEWPORT.height,
        );
        const hitAdd = await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.getAttribute('aria-label'),
          {
            x: addAfter.x + addAfter.width / 2,
            y: addAfter.y + addAfter.height / 2,
          },
        );
        expect(hitAdd).toBe('Add pane');

        // The flyout and a tooltip, placed as the component places them.
        const geometry = await page.evaluate(() => {
          const trigger = document.querySelector<HTMLElement>(
            '[data-rail-item="browser"]',
          )!;
          const anchor = trigger.getBoundingClientRect();
          const gap = 8;
          const flyout = document.createElement('section');
          flyout.className = 'coding-workbench__rail-panel';
          flyout.setAttribute('aria-label', 'Browser');
          // The launcher's shape: a labelled address field, its button, a hint.
          flyout.innerHTML =
            '<form><label style="display:block">Browser address<input style="display:block;width:100%" /></label><button type="button">Open Browser</button><p>The address is opened on this Station.</p></form>';
          flyout.style.position = 'fixed';
          flyout.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - 160 - 8))}px`;
          flyout.style.right = `${window.innerWidth - anchor.left + gap}px`;
          document.body.append(flyout);
          const tip = document.createElement('span');
          tip.className = 'tooltip tooltip--left coding-workbench__rail-tip';
          tip.setAttribute('role', 'tooltip');
          tip.textContent = 'Open Browser';
          tip.style.position = 'fixed';
          tip.style.top = `${anchor.top + anchor.height / 2}px`;
          tip.style.right = `${window.innerWidth - anchor.left + gap}px`;
          tip.style.transform = 'translateY(-50%)';
          document.body.append(tip);
          const rail = document
            .querySelector('.coding-workbench__rail')!
            .getBoundingClientRect();
          const f = flyout.getBoundingClientRect();
          const t = tip.getBoundingClientRect();
          const centreHit = document
            .elementFromPoint(f.left + f.width / 2, f.top + f.height / 2)
            ?.closest('[aria-label="Browser"]');
          return {
            railLeft: rail.left,
            flyout: { x: f.left, y: f.top, w: f.width, h: f.height },
            flyoutHit: centreHit !== null,
            tip: {
              x: t.left,
              y: t.top,
              w: t.width,
              h: t.height,
              visibility: getComputedStyle(tip).visibility,
              opacity: getComputedStyle(tip).opacity,
            },
          };
        });
        expect(geometry.flyout.w).toBeGreaterThan(200);
        expect(geometry.flyout.h).toBeGreaterThan(40);
        expect(geometry.flyout.x).toBeGreaterThanOrEqual(0);
        expect(geometry.flyout.y).toBeGreaterThanOrEqual(0);
        expect(geometry.flyout.x + geometry.flyout.w).toBeLessThanOrEqual(
          geometry.railLeft,
        );
        expect(geometry.flyout.y + geometry.flyout.h).toBeLessThanOrEqual(
          VIEWPORT.height,
        );
        expect(geometry.flyoutHit).toBe(true);
        expect(geometry.tip.visibility).toBe('visible');
        expect(geometry.tip.opacity).toBe('1');
        expect(geometry.tip.w).toBeGreaterThan(24);
        expect(geometry.tip.x).toBeGreaterThanOrEqual(0);
        expect(geometry.tip.x + geometry.tip.w).toBeLessThanOrEqual(
          geometry.railLeft,
        );
        expect(geometry.tip.y).toBeGreaterThanOrEqual(0);
        expect(geometry.tip.y + geometry.tip.h).toBeLessThanOrEqual(
          VIEWPORT.height,
        );
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'Coding rail geometry — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the rail ' +
        'geometry could not be measured — a missing precondition, not a ' +
        'passing check. Install it with `npm run install:playwright`.',
    );
  },
);
