/**
 * #5493: a maximized dock fills the content area whatever other regions are
 * on. With the Bottom region open, a dock maximized in the Right region used
 * to fill only the content row: the hidden bottom shell's track kept its size
 * and left an empty band under the dock. The mirrored case (a maximized
 * bottom dock beside an open Right region) and the unmaximized layout are
 * measured too.
 *
 * jsdom lays nothing out, so the desktop grid is measured in Chromium against
 * the real cascade (`index.css`), with the region shells' real classes.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);
const css = resolveCssImports(resolve(HERE, '../index.css'));

/** The app frame with a toolbar, the page, a side shell and a bottom shell. */
function frame({
  right,
  bottom,
  side,
}: {
  right: string;
  bottom: string;
  side: 'left' | 'right';
}): string {
  return `<div class="app app--with-sidebar" style="height:900px">
    <div class="app__main" style="height:900px">
      <header class="app-toolbar" style="height:48px">Toolbar</header>
      <main class="main-content"><div class="content-view">Page</div></main>
      <section class="chat-dock chat-dock--${side} ${right}" data-region="${side}" data-testid="right"><div class="dock-slot__body" data-testid="right-body">Side pane</div></section>
      <section class="chat-dock chat-dock--bottom ${bottom}" data-region="bottom" data-testid="bottom"><div class="dock-slot__body" data-testid="bottom-body">Bottom pane</div></section>
    </div>
  </div>`;
}

describe.skipIf(!chromiumAvailable)(
  'a maximized region fills the content area',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      assertNoImportsSurvive(css);
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    async function measure(
      right: string,
      bottom: string,
      side: 'left' | 'right' = 'right',
    ) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      try {
        await page.setContent(
          `<style>${css}</style>${frame({ right, bottom, side })}`,
        );
        const box = async (id: string) =>
          page.getByTestId(id).evaluate((node) => {
            const r = node.getBoundingClientRect();
            return {
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              shown: getComputedStyle(node).display !== 'none',
            };
          });
        const main = await page
          .locator('.app__main')
          .evaluate((node) => node.getBoundingClientRect().toJSON());
        return {
          main,
          right: await box('right'),
          bottom: await box('bottom'),
          bodyConnected: await page
            .getByTestId('bottom-body')
            .evaluate((node) => node.isConnected),
        };
      } finally {
        await page.close();
      }
    }

    test('a dock maximized in the Right region reaches the bottom with the Bottom region on', async () => {
      const { main, right, bottom, bodyConnected } = await measure(
        'is-maximized',
        '',
      );
      expect(right.shown).toBe(true);
      expect(right.bottom).toBeGreaterThanOrEqual(main.bottom - 0.5);
      expect(right.left).toBeLessThanOrEqual(main.left + 0.5);
      expect(right.right).toBeGreaterThanOrEqual(main.right - 0.5);
      // The bottom shell is hidden, not removed: its pane keeps its state.
      expect(bottom.shown).toBe(false);
      expect(bodyConnected).toBe(true);
    });

    test('a dock maximized in the Left region reaches the bottom with the Bottom region on', async () => {
      const {
        main,
        right: left,
        bottom,
      } = await measure('is-maximized', '', 'left');
      expect(left.shown).toBe(true);
      expect(left.bottom).toBeGreaterThanOrEqual(main.bottom - 0.5);
      expect(left.left).toBeLessThanOrEqual(main.left + 0.5);
      expect(left.right).toBeGreaterThanOrEqual(main.right - 0.5);
      expect(bottom.shown).toBe(false);
    });

    test('a maximized bottom dock reaches across with the Right region on (the mirrored case)', async () => {
      const { main, right, bottom } = await measure('', 'is-maximized');
      expect(bottom.shown).toBe(true);
      expect(bottom.bottom).toBeGreaterThanOrEqual(main.bottom - 0.5);
      expect(bottom.left).toBeLessThanOrEqual(main.left + 0.5);
      expect(bottom.right).toBeGreaterThanOrEqual(main.right - 0.5);
      expect(right.shown).toBe(false);
    });

    test('unmaximized, the Right and Bottom regions share the area as before', async () => {
      const { main, right, bottom } = await measure('', '');
      expect(right.shown && bottom.shown).toBe(true);
      // The right dock stays in the content row, above the bottom region,
      // which runs the full width along the bottom.
      expect(right.bottom).toBeLessThanOrEqual(bottom.top + 0.5);
      expect(bottom.bottom).toBeGreaterThanOrEqual(main.bottom - 0.5);
      expect(bottom.top).toBeGreaterThan(main.top + 100);
      expect(right.right).toBeGreaterThanOrEqual(main.right - 0.5);
    });
  },
);

/**
 * A geometry check that silently skips is indistinguishable from one that
 * passes, so the missing precondition fails loudly instead.
 */
test.skipIf(chromiumAvailable)(
  'region maximize geometry — Chromium not installed, cannot verify (#5493)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'maximized region could not be measured — this is a missing ' +
        'precondition, not a passing check.',
    );
  },
);
