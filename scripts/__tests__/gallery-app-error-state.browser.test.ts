import { type Browser, chromium, type Page } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTENSIONS_UNAVAILABLE_LABEL } from '../../src-ui/src/core/pluginRegistryCopy';
import { enUSCatalog } from '../../src-ui/src/i18n/catalog.en-US';
import { READ_APP_ERROR_SURFACES } from '../../tests/helpers/gallery-app-error-state';

// The Gallery's browser-side probes, run in a real Chromium against fixture
// pages: the error-surface reader.

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await (
    await browser.newContext({ viewport: { width: 800, height: 600 } })
  ).newPage();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const open = (body: string) =>
  page.goto(
    `data:text/html,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${body}</body></html>`)}`,
  );
const surfaces = () => page.evaluate(READ_APP_ERROR_SURFACES);
// The product's own row, rendered from the component the app mounts. The
// specifier is a value so this lane (no JSX) does not compile the .tsx; the
// src-ui lane typechecks it.
const LAZY_BOUNDARY_MODULE = '../../src-ui/src/components/LazyBoundary';
const ERROR_STATE_MODULE = '@kontourai/station-sdk/error-state';
let lazyRow = '';
// RouteViewBoundary's chunk failure: the shared ErrorState with the catalog's
// title (the boundary itself needs the shell's providers to render).
const routeChunk: Record<string, string> = {};
beforeAll(async () => {
  const { LazyBoundaryError } = await import(LAZY_BOUNDARY_MODULE);
  lazyRow = renderToStaticMarkup(
    createElement(LazyBoundaryError, { onRetry: () => {} }),
  );
  expect(lazyRow).toContain('lazy-boundary__error');
  const { ErrorState } = await import(ERROR_STATE_MODULE);
  for (const key of ['route.chunk.title', 'route.chunk.offlineTitle'] as const)
    routeChunk[key] = renderToStaticMarkup(
      createElement(ErrorState, { title: enUSCatalog[key], description: 'x' }),
    );
  routeChunk.other = renderToStaticMarkup(
    createElement(ErrorState, { title: 'Project list unavailable' }),
  );
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

  it("names the route boundary's chunk failure, online or offline, and no other error state", async () => {
    await open(routeChunk.other);
    expect(await surfaces()).toEqual({});
    await open(
      `${routeChunk['route.chunk.title']}${routeChunk['route.chunk.offlineTitle']}`,
    );
    expect(await surfaces()).toEqual({ 'route-chunk-error': 2 });
  });
});
