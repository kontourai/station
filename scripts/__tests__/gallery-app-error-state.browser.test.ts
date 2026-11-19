import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type Browser,
  chromium,
  type Page,
  type Route,
} from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTENSIONS_UNAVAILABLE_LABEL } from '../../src-ui/src/core/pluginRegistryCopy';
import { enUSCatalog } from '../../src-ui/src/i18n/catalog.en-US';
import {
  type AppErrorSurfaceCounts,
  createFailedRequestLog,
  failedScreenReason,
  READ_APP_ERROR_SURFACES,
} from '../../tests/helpers/gallery-app-error-state';
import {
  createDocumentTracker,
  observeGalleryRequests,
} from '../../tests/helpers/gallery-document-tracker';
import {
  captureScreens,
  failedScreenFields,
  MAX_SECOND_CAPTURES,
  type ScreenResult,
} from '../../tests/helpers/gallery-screen-attempt';
import { auditGalleryScreen } from '../../tests/helpers/gallery-ui-audit';
import { judge } from '../gallery-ui-findings.mjs';

// The Gallery's browser-side probes, run in a real Chromium against fixture
// pages: the error-surface reader, and the capture loop wired as
// tests/screenshots.spec.ts wires it (observeGalleryRequests feeding the
// document tracker and the failed-request log, captureScreens running the
// real attemptScreen) against a small real page.

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
// A hard clip that hides what it holds (hit-target:unreachable), inside the
// `#root` the hit-target audit measures.
const clipped = (html: string) =>
  `<div id="root"><div style="height:100px;overflow:hidden"><div style="height:500px"></div>${html}</div></div>`;
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

  it('records a stalled route even without a failed request or English copy', async () => {
    await open(
      '<div class="error-state route-pending-recovery" role="alert"></div>',
    );
    expect(await surfaces()).toEqual({ 'route-pending-recovery': 1 });
  });
});

/**
 * A screen of the fixture app. `mode` picks what its page does; the chunk
 * `/assets/Lazy-abcdefgh.js` fails (aborted, after `abortAfterMs`) on the
 * attempts listed in `failChunk`.
 */
interface FixtureScreen {
  name: string;
  mode:
    | 'lazy'
    /** `lazy`, with the error row inside a hard clip, as on the phone dock. */
    | 'lazy-clipped'
    | 'route-push'
    | 'render-error'
    | 'cross-origin'
    | 'leaves-with-history-change';
  failChunk?: number[];
  abortAfterMs?: number;
  /** Milliseconds the server holds this screen's navigation response. */
  navigationDelayMs?: number;
  afterAudit?: (page: Page) => Promise<void>;
}

describe('the capture loop against a real page', { timeout: 60_000 }, () => {
  let server: Server;
  let origin: string;
  let otherOrigin: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (url.pathname === '/assets/Lazy-abcdefgh.js') {
        response.writeHead(200, {
          'content-type': 'text/javascript',
          'access-control-allow-origin': '*',
        });
        return response.end('export default 1;');
      }
      // Held until the navigation that replaces its document tears it down.
      if (url.pathname === '/assets/Stray-abcdefgh.js') return;
      if (url.pathname.startsWith('/screen/')) {
        const delay = Number(url.searchParams.get('delay') ?? 0);
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(fixturePage(url.searchParams.get('mode') ?? 'lazy'));
        }, delay);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
    // The same server under another host name is another origin.
    otherOrigin = `http://localhost:${port}`;
  });
  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
  });

  const fixturePage = (mode: string) =>
    `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="app"><button>Send</button></div>
<script type="module">
  const mode = ${JSON.stringify(mode)};
  const fail = () => {
    document.body.insertAdjacentHTML('afterbegin', mode === 'lazy-clipped'
      ? ${JSON.stringify(clipped(lazyRow))}
      : ${JSON.stringify(lazyRow)});
    document.body.dataset.ready = '1';
  };
  const done = () => { document.body.dataset.ready = '1'; };
  if (mode === 'render-error') fail();
  else if (mode === 'cross-origin') {
    const script = document.createElement('script');
    script.src = ${JSON.stringify(`${otherOrigin}/assets/Lazy-abcdefgh.js`)};
    script.onload = done;
    script.onerror = fail;
    document.head.append(script);
  } else {
    const chunk = import('/assets/Lazy-abcdefgh.js');
    // A router's history change while the chunk is still loading.
    if (mode === 'route-push')
      setTimeout(() => history.pushState(null, '', '?routed'), 100);
    chunk.then(done, fail);
  }
  // The outgoing document changes its history, then issues a script request,
  // while the next screen's navigation is pending.
  if (mode === 'leaves-with-history-change')
    window.addEventListener('gallery-leave', () =>
      setTimeout(() => {
        history.replaceState(null, '', '?leaving');
        const stray = document.createElement('script');
        stray.src = '/assets/Stray-abcdefgh.js';
        document.head.append(stray);
      }, 50),
    );
</script></body></html>`;

  async function capture(
    screens: FixtureScreen[],
    audit: (page: Page, screen: string) => Promise<unknown> = async () => null,
  ) {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
    });
    const page = await context.newPage();
    const documents = createDocumentTracker();
    const failedRequests = createFailedRequestLog(origin, documents);
    const stopObserving = observeGalleryRequests(page, {
      documents,
      failedRequests,
    });
    const results = new Map<string, ScreenResult<unknown>>();
    const logs: string[] = [];
    const chunk = '**/assets/Lazy-abcdefgh.js';
    try {
      await captureScreens(page, screens, {
        failedRequests,
        ports: (screen, attempt) => {
          return {
            capture: async (photo) => {
              if (screen.failChunk?.includes(attempt))
                await page.route(chunk, async (route: Route) => {
                  await new Promise((resolve) =>
                    setTimeout(resolve, screen.abortAfterMs ?? 0),
                  );
                  await route.abort('aborted');
                });
              await page.goto(
                `${origin}/screen/${screen.name}?mode=${screen.mode}&delay=${screen.navigationDelayMs ?? 0}`,
              );
              await page.waitForSelector('body[data-ready]');
              await photo();
            },
            readSurfaces: async () =>
              (await page.evaluate(
                READ_APP_ERROR_SURFACES,
              )) as AppErrorSurfaceCounts,
            screenshot: async () => {
              await page.screenshot();
            },
            readControls: async () => [],
            audit: () => audit(page, screen.name),
            fallbackScreenshot: async () => {},
            cleanup: async () => {
              await page.unroute(chunk);
              // Source text: this lane has no DOM lib.
              await page.evaluate(
                "window.dispatchEvent(new Event('gallery-leave'))",
              );
            },
            now: () => performance.now(),
            wait: (ms) => page.waitForTimeout(ms),
            settleWindowMs: 0,
            evidence: () => {
              const { records, omitted } = failedRequests.snapshot();
              return { failedRequests: records, omitted, consoleErrors: [] };
            },
          };
        },
        keepFirstImage: () => null,
        log: (line) => logs.push(line),
        screenStarted: () => {},
        screenCaptured: (screen, result) => results.set(screen.name, result),
        screenFinished: () => {},
      });
    } finally {
      stopObserving();
      await context.close();
    }
    return { results, logs };
  }

  it('captures a lost chunk download again and passes it as a transient', async () => {
    const { results, logs } = await capture([
      { name: 'flaky', mode: 'lazy', failChunk: [1] },
    ]);
    expect(results.get('flaky')).toMatchObject({
      attempts: 2,
      final: { ok: true },
      record: {
        second: 'passed',
        identity:
          'app-error-surface: lazy-boundary-row; failed chunk requests: /assets/Lazy-<hash>.js',
      },
    });
    expect(logs[0]).toMatch(/^::warning title=Gallery transient app error::/);
  });

  it('fails a screen whose lazy chunk is lost on both captures as a chunk failure, with no layout findings', async () => {
    // Positive control: the same clipped error row, audited, is exactly the
    // hit-target signature hosted runs blamed on pull requests (#5028).
    await open(clipped(lazyRow));
    const rowAudit = await auditGalleryScreen(page, 'error-row');
    expect(rowAudit.findings.map(({ identity }) => identity)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^hit-target:unreachable:.*Retry/),
        expect.stringMatching(/^hit-target:unreachable:.*Reload/),
      ]),
    );

    const { results } = await capture(
      [{ name: 'lost-chunk', mode: 'lazy-clipped', failChunk: [1, 2] }],
      auditGalleryScreen,
    );
    const result = results.get('lost-chunk');
    expect(result).toMatchObject({
      attempts: 2,
      final: { ok: false },
      record: { second: 'app-error-surface' },
    });
    if (!result || result.final.ok) return;
    // What the spec writes to capture.json for the screen, and logs.
    const fields = failedScreenFields(result, []);
    expect(
      failedScreenReason('lost-chunk', fields.error, fields.appError),
    ).toMatch(
      /^lazy chunk unavailable: lost-chunk \(\/assets\/Lazy-abcdefgh\.js net::ERR_[A-Z_]+\)$/,
    );
    // What the findings judge and attribution read from it.
    const verdict = judge(
      { selection: null, screens: [{ name: 'lost-chunk', ...fields }] },
      { screens: {} },
    );
    expect(verdict.failures).toEqual([
      {
        screen: 'lost-chunk',
        identity: 'capture-failed',
        detail:
          'app-error-surface: lazy-boundary-row; failed chunk requests: /assets/Lazy-<hash>.js',
      },
    ]);
  });

  it(`shares one budget of ${MAX_SECOND_CAPTURES} second captures across the run`, async () => {
    const screens = Array.from(
      { length: MAX_SECOND_CAPTURES + 2 },
      (_, index): FixtureScreen => ({
        name: `flaky-${index}`,
        mode: 'lazy',
        failChunk: [1],
      }),
    );
    const { results } = await capture(screens);
    expect(
      screens.map(({ name }) => results.get(name)?.record?.second),
    ).toEqual([
      ...Array(MAX_SECOND_CAPTURES).fill('passed'),
      'budget-exhausted',
      'budget-exhausted',
    ]);
  });

  it("runs the screen's own afterAudit against the page", async () => {
    const titles: string[] = [];
    const { results } = await capture([
      {
        name: 'checked',
        mode: 'lazy',
        afterAudit: async (page) => {
          titles.push(new URL(page.url()).pathname);
        },
      },
      {
        name: 'broken',
        mode: 'lazy',
        afterAudit: async () => {
          throw new Error('recovery did not happen');
        },
      },
    ]);
    expect(titles).toEqual(['/screen/checked']);
    expect(results.get('checked')?.final.ok).toBe(true);
    expect(results.get('broken')?.final).toMatchObject({
      ok: false,
      message: 'recovery did not happen',
    });
  });

  it("keeps a chunk that fails after the live page's own history change current", async () => {
    const { results } = await capture([
      { name: 'routed', mode: 'route-push', failChunk: [1], abortAfterMs: 400 },
    ]);
    expect(results.get('routed')).toMatchObject({
      attempts: 2,
      record: { second: 'passed' },
    });
    expect(results.get('routed')?.record?.first.failedRequests).toMatchObject([
      { path: '/assets/Lazy-abcdefgh.js', document: 'current' },
    ]);
  });

  it("does not count the outgoing page's history change as the next document", async () => {
    const { results } = await capture([
      { name: 'outgoing', mode: 'leaves-with-history-change' },
      // A render error: no failed chunk of its own, held so the outgoing
      // page acts while this navigation is pending.
      { name: 'next', mode: 'render-error', navigationDelayMs: 400 },
    ]);
    const next = results.get('next');
    expect(next?.final.ok).toBe(false);
    if (next?.final.ok !== false) return;
    // Reached: the outgoing page's script failed during this navigation.
    expect(next.final.appError?.failedRequests).toContainEqual(
      expect.objectContaining({
        path: '/assets/Stray-abcdefgh.js',
        document: 'previous',
      }),
    );
    expect(next.final.message).toBe(
      'app-error-surface: lazy-boundary-row; no failed chunk request',
    );
    expect(next.record).toBeNull();
    expect(next.attempts).toBe(1);
  });

  it("does not carry one screen's failed chunk into the next screen's attempt", async () => {
    const { results } = await capture([
      { name: 'flaky', mode: 'lazy', failChunk: [1] },
      // A render error: a surface with no failed request of its own.
      { name: 'render-error', mode: 'render-error' },
    ]);
    expect(results.get('flaky')?.record?.second).toBe('passed');
    const next = results.get('render-error');
    expect(next).toMatchObject({ attempts: 1, record: null });
    expect(next?.final).toMatchObject({
      ok: false,
      message: 'app-error-surface: lazy-boundary-row; no failed chunk request',
    });
  });

  it('does not take a cross-origin script for one of the app chunks', async () => {
    const { results } = await capture([
      { name: 'cdn', mode: 'cross-origin', failChunk: [1, 2] },
    ]);
    const cdn = results.get('cdn');
    expect(cdn?.final.ok).toBe(false);
    if (cdn?.final.ok !== false) return;
    expect(cdn.final.appError?.failedRequests).toContainEqual(
      expect.objectContaining({
        path: `${new URL(otherOrigin).host}/assets/Lazy-abcdefgh.js`,
        appAsset: false,
        document: 'current',
      }),
    );
    expect(cdn.final.message).toBe(
      'app-error-surface: lazy-boundary-row; no failed chunk request',
    );
    expect(cdn.record).toBeNull();
  });
});
