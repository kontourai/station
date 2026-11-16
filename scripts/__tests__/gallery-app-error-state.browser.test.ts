import { type Browser, chromium, type Page } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTENSIONS_UNAVAILABLE_LABEL } from '../../src-ui/src/core/pluginRegistryCopy';
import {
  LAYOUT_SHIFT_RECORDER,
  type LayoutShiftEntry,
  READ_APP_ERROR_SURFACES,
  READ_PERFORMANCE_NOW,
  readLayoutShiftsSince,
  summariseLayoutShifts,
} from '../../tests/helpers/gallery-app-error-state';

// The Gallery's browser-side probes, run in a real Chromium against fixture
// pages: the error-surface reader and the layout-shift recorder.

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await (
    await browser.newContext({ viewport: { width: 800, height: 600 } })
  ).newPage();
  await page.addInitScript(LAYOUT_SHIFT_RECORDER);
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const open = (body: string) =>
  page.goto(
    `data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0">${body}</body></html>`)}`,
  );
const surfaces = () => page.evaluate(READ_APP_ERROR_SURFACES);
// The product's own row, rendered from the component the app mounts. The
// specifier is a value so this lane (no JSX) does not compile the .tsx; the
// src-ui lane typechecks it.
const LAZY_BOUNDARY_MODULE = '../../src-ui/src/components/LazyBoundary';
let lazyRow = '';
beforeAll(async () => {
  const { LazyBoundaryError } = await import(LAZY_BOUNDARY_MODULE);
  lazyRow = renderToStaticMarkup(
    createElement(LazyBoundaryError, { onRetry: () => {} }),
  );
  expect(lazyRow).toContain('lazy-boundary__error');
});
const toast = (title: string) =>
  `<div data-testid="toast-card" class="toast-card"><strong>${title}. Station could not start the extension registry.</strong><button>Reload Station</button></div>`;

describe('app error surfaces', { timeout: 60_000 }, () => {
  it('reads nothing on a page without them', async () => {
    await open(`<div class="app">${toast('Saved')}</div>`);
    expect(await surfaces()).toEqual({});
  });

  it("names the lazy boundary's row and the extension registry toast", async () => {
    await open(
      `${lazyRow}${lazyRow}<div class="app"></div>${toast(EXTENSIONS_UNAVAILABLE_LABEL)}`,
    );
    expect(await surfaces()).toEqual({
      'lazy-boundary-row': 2,
      'extension-registry-toast': 1,
    });
  });
});

describe('layout shift recorder', { timeout: 60_000 }, () => {
  const shiftsSince = async (since: number) =>
    summariseLayoutShifts(
      (await page.evaluate(readLayoutShiftsSince(since))) as {
        supported: boolean;
        dropped: number;
        entries: LayoutShiftEntry[];
      },
    );
  // Source text: this lane compiles without the DOM lib.
  const frames = () =>
    page.evaluate(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );

  it('records a shift after the window opens with its source, and not one before it', async () => {
    await open(
      '<div id="top"></div><div class="app" style="height:300px;background:#888">content</div><button id="grow" onclick="document.getElementById(\'top\').style.height=\'60px\'">grow</button>',
    );
    await frames();
    await page.evaluate("document.querySelector('#top').style.height = '20px'");
    await frames();
    const since = (await page.evaluate(READ_PERFORMANCE_NOW)) as number;
    // What the lazy boundary's row does above `.app`.
    await page.evaluate(
      `document.querySelector('#top').insertAdjacentHTML('afterend', ${JSON.stringify(lazyRow)})`,
    );
    await frames();
    const summary = await shiftsSince(since);
    expect(summary.supported).toBe(true);
    expect(summary.count).toBe(1);
    expect(summary.score).toBeGreaterThan(0);
    expect(summary.largest?.sources).toContain('div.app');
    expect((await shiftsSince(0)).count).toBe(2);
  });

  it('leaves out a shift that follows input', async () => {
    await open(
      '<div id="top"></div><div class="app" style="height:300px">content</div><button id="grow" onclick="document.getElementById(\'top\').style.height=\'60px\'">grow</button>',
    );
    await frames();
    const since = (await page.evaluate(READ_PERFORMANCE_NOW)) as number;
    await page.click('#grow');
    await frames();
    expect((await shiftsSince(since)).count).toBe(0);
  });
});
