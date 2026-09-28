/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { Dialog } from '../components/Dialog';

/**
 * SHELL-02: the dialog body scrolls, so a long form can never push its commit
 * action below the fold. That is a layout claim — the panel's `max-height`,
 * its flex column, and the body's shrink and overflow have to agree under the
 * real cascade — so it is measured in Chromium against the eagerly loaded
 * `index.css`, where the chrome lives, rather than read off the rule text.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const VIEWPORT = { width: 1024, height: 480 };

function renderLongDialogMarkup(): string {
  const { unmount } = render(
    <Dialog
      title="New Project"
      closeLabel="Close new project"
      onClose={vi.fn()}
      footer={<button type="button">Create</button>}
    >
      <div style={{ height: '2000px' }}>
        A form far taller than the viewport
      </div>
    </Dialog>,
  );
  // The surface portals to `document.body`.
  const markup = document.body.innerHTML;
  unmount();
  return markup;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'Dialog chrome keeps its commit action on screen (real cascade)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    test('the body scrolls, so a long form can never push its commit action below the fold', async () => {
      const css = resolveCssImports(INDEX_CSS_PATH);
      assertNoImportsSurvive(css);
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.setContent(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${renderLongDialogMarkup()}</body>
</html>`);

        // The overflow is taken up by the body, not the page or the panel.
        const body = page.locator('.station-dialog__body');
        const scroll = await body.evaluate((el) => {
          el.scrollTop = 200;
          return {
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            scrollTop: el.scrollTop,
          };
        });
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
        // It is a scroller, so the rest of the form is reachable.
        expect(scroll.scrollTop, 'the dialog body does not scroll').toBe(200);

        const create = page.getByRole('button', { name: 'Create' });
        const box = await create.boundingBox();
        expect(box, 'Create has no layout box').not.toBeNull();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(VIEWPORT.height);

        // Visible AND reachable: a press at its centre lands on it.
        const hit = await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.textContent ?? null,
          { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
        );
        expect(hit).toBe('Create');
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'Dialog chrome geometry — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the dialog ' +
        'footer geometry could not be measured — this is a missing ' +
        'precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
