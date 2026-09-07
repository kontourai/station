/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { act, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import {
  countVisibleLazyBoundaryErrors,
  waitForLazySurface,
} from '../../../tests/helpers/lazy-surface-readiness';
import {
  FULL_SCREEN_ERROR_SELECTOR,
  fullScreenLoaderLabel,
  LAZY_BOUNDARY_ERROR_SELECTOR,
  ROUTE_PENDING_STATUS_NAME,
  SETTLED_ERROR_STATE_SELECTOR,
  waitForRouteViewTarget,
} from '../../../tests/helpers/route-view-readiness';
import { RoutePendingSkeleton } from '../app-shell/RoutePendingSkeleton';

/**
 * Proving the two #1642 browser ADAPTERS, which their pure cores cannot reach.
 *
 * `scripts/__tests__/route-view-readiness.test.ts` and its lazy-surface sibling
 * drive every decision branch through the observation port, so the decisions are
 * covered. What they cannot cover is the half that turns a real page into those
 * observations: whether each selector matches what the component actually
 * renders, and whether the adapter classifies a real DOM into the outcome it
 * claims. That half is where both of the review's blocking defects lived, and
 * both produced a CONFIDENT FALSE SENTENCE — the exact failure mode the change
 * exists to eliminate — so leaving it unproven would have been a weak disclosure
 * rather than an honest one.
 *
 * WHAT THIS PROVES.
 *   - Every selector corresponds to the real component's rendered markup: the
 *     route pending skeleton's named live region, `ErrorState`, `FullScreenError`,
 *     `FullScreenLoader`'s label line, and `LazyBoundary`'s own failure — each
 *     rendered by the real component, with the real stylesheet resolved, in a real
 *     browser.
 *   - Each adapter OBSERVES AND REPORTS the specific outcome in each arrangement,
 *     including a failure rendered beside a target that did arrive, which is the
 *     resolve-for-the-wrong-reason risk.
 *   - Both blocking fixes, each in the direction that would catch its regression:
 *     a visible failure behind a hidden earlier match, and a pre-existing boundary
 *     failure that must not be attributed to this surface.
 *   - That the presence-not-visibility classification survives the stylesheet
 *     coupling it exists to remove.
 *
 * WHAT THIS DOES NOT PROVE, and it is not a small remainder. Nothing here binds
 * to the running application: it says nothing about whether the real Connections
 * route or the real layout gate reach these states, in this order, or in any
 * particular time, and nothing at all about whether any budget is adequate under
 * host load. Those need the live first-run suite and stay disclosed as unproven.
 * Synthetic arrangements of real markup are a statement about the adapters, not
 * about the journey.
 *
 * No ports, no server, and no Playwright runner: both adapters' only Playwright
 * import is `import type`, erased at runtime, so they need a page object and
 * nothing else.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const SKELETON_CSS = resolve(HERE, '../components/Skeleton.css');
const ROUTE_PENDING_CSS = resolve(
  HERE,
  '../app-shell/route-pending-skeleton.css',
);
const ERROR_STATE_CSS = resolve(
  REPO_ROOT,
  'packages/sdk/src/components/ErrorState.css',
);
const FULL_SCREEN_CSS = resolve(
  REPO_ROOT,
  'packages/sdk/src/components/FullScreen.css',
);

function fixtureCss(): string {
  const css = [
    SKELETON_CSS,
    ROUTE_PENDING_CSS,
    ERROR_STATE_CSS,
    FULL_SCREEN_CSS,
  ]
    .map((path) => resolveCssImports(path))
    .join('\n');
  assertNoImportsSurvive(css);
  return css;
}

/** Real component markup, extracted for the browser to lay out. */
function markupOf(element: React.ReactElement): string {
  const { container, unmount } = render(element);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  '#1642 readiness adapters classify a real page into the outcome they report',
  () => {
    let browser: Browser;
    let css: string;

    beforeAll(async () => {
      browser = await chromium.launch();
      css = fixtureCss();
    });

    afterAll(async () => {
      await browser?.close();
    });

    /** A page holding `body`, with the real stylesheet and an optional override. */
    async function pageWith(
      body: string,
      extraCss = '',
    ): Promise<{ page: Page; close: () => Promise<void> }> {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style><style>${extraCss}</style></head>` +
          `<body style="margin:0"><div id="root">${body}</div></body></html>`,
      );
      return { page, close: () => page.close() };
    }

    const TARGET =
      '<button type="button" class="target-surface">Arrived</button>';

    /**
     * A `Page` that counts `locator()` calls, which is how RE-ENTRY becomes
     * observable at all.
     *
     * The lazy adapter's anti-spin ternary cannot be guarded by elapsed time:
     * spinning and waiting both end at the deadline with the same message, so a
     * duration assertion passes either way and the ternary sits there reading
     * like something to tidy up. What differs is how many times the loop is
     * re-entered, and each re-entry re-reads the boundary count through
     * `page.locator`. Counting those calls is the cheapest thing that
     * distinguishes the two.
     *
     * Methods are bound to the real page, never to the proxy, so Playwright's
     * own internals are untouched by the wrapper.
     */
    function countingPage(page: Page): {
      page: Page;
      locatorCalls: () => number;
    } {
      let locatorCalls = 0;
      const counting = new Proxy(page, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          if (property === 'locator') {
            return (...args: unknown[]) => {
              locatorCalls += 1;
              return (value as (...rest: unknown[]) => unknown).apply(
                target,
                args,
              );
            };
          }
          return value.bind(target);
        },
      }) as Page;
      return { page: counting, locatorCalls: () => locatorCalls };
    }

    /** Real `RoutePendingSkeleton`, which is what publishes the named live region. */
    const PENDING = () => markupOf(<RoutePendingSkeleton />);

    function routeScreens(page: Page) {
      return {
        viewName: 'The fixture view',
        target: page.locator('.target-surface'),
        failures: [
          page.locator(SETTLED_ERROR_STATE_SELECTOR),
          page.locator(LAZY_BOUNDARY_ERROR_SELECTOR),
        ],
        pending: [
          page.getByRole('status', { name: ROUTE_PENDING_STATUS_NAME }),
        ],
      };
    }

    /* ── selector-to-component correspondence ── */

    test('the real route pending skeleton publishes the named live region the adapter looks for', async () => {
      const { page, close } = await pageWith(PENDING());
      try {
        const pending = page.getByRole('status', {
          name: ROUTE_PENDING_STATUS_NAME,
        });
        // The role, `aria-busy` and the label come from `Skeleton.tsx`; the copy
        // is the `route.loading` catalog entry. If any of the three drifted, the
        // adapter's pending marker would silently stop matching and every
        // slow-view timeout would be reported as an absent surface.
        expect(await pending.count()).toBeGreaterThan(0);
        expect(await pending.first().getAttribute('aria-busy')).toBe('true');
        // And it is laid out: the marker has a real box once the stylesheet
        // resolves, which is the premise the suppressed-sizing case removes.
        expect(await pending.first().isVisible()).toBe(true);
      } finally {
        await close();
      }
    });

    test("the full-screen loader's label line distinguishes the layout loader from the platform one", async () => {
      const { ErrorState, FullScreenError, FullScreenLoader } = await import(
        '@kontourai/station-sdk'
      );
      void ErrorState;
      const { page, close } = await pageWith(
        markupOf(<FullScreenLoader label="layout" />) +
          markupOf(<FullScreenLoader label="Station" />) +
          markupOf(<FullScreenError title="Failed to load layout" />),
      );
      try {
        // The reason this function exists: `.fs-screen` alone is shared with
        // `PlatformBootstrap`'s loader, which the access-gate wait matches on. A
        // bare `.fs-screen` pending marker would read "the platform is still
        // booting" as "this view is still loading" and blame the wrong thing.
        expect(await fullScreenLoaderLabel(page, 'layout').count()).toBe(1);
        expect(await fullScreenLoaderLabel(page, 'Station').count()).toBe(1);
        expect(await fullScreenLoaderLabel(page, 'nonesuch').count()).toBe(0);
        // And the error variant is neither loader, in both directions.
        expect(await page.locator(FULL_SCREEN_ERROR_SELECTOR).count()).toBe(1);
        const layoutLoader = fullScreenLoaderLabel(page, 'layout');
        expect(
          await layoutLoader
            .locator(`xpath=ancestor::*[contains(@class,"fs-screen--error")]`)
            .count(),
        ).toBe(0);
      } finally {
        await close();
      }
    });

    /* ── route-view adapter outcomes ── */

    test('a target on screen is observed as ready', async () => {
      const { page, close } = await pageWith(TARGET);
      try {
        const observed = await waitForRouteViewTarget(
          routeScreens(page),
          2_000,
        );
        expect(observed.screen).toBe('ready');
      } finally {
        await close();
      }
    });

    test('a failure rendered BESIDE a target that arrived is still ready', async () => {
      const { ErrorState } = await import('@kontourai/station-sdk');
      const { page, close } = await pageWith(
        markupOf(<ErrorState title="Unable to load Models" />) + TARGET,
      );
      try {
        // The resolve-for-the-wrong-reason case, and the reason `target` is
        // classified first: Connections renders its add action in the page frame
        // and its list error in the body, so a body error beside an arrived
        // action must not fail a wait that got what it came for.
        const observed = await waitForRouteViewTarget(
          routeScreens(page),
          2_000,
        );
        expect(observed.screen).toBe('ready');
      } finally {
        await close();
      }
    });

    test("a real ErrorState with no target is reported as the view's own failure, quoting it", async () => {
      const { ErrorState } = await import('@kontourai/station-sdk');
      const { page, close } = await pageWith(
        markupOf(<ErrorState title="Layout not found" />),
      );
      try {
        await expect(
          waitForRouteViewTarget(routeScreens(page), 2_000),
        ).rejects.toThrow(
          /settled into a failure of its own.*Layout not found/s,
        );
      } finally {
        await close();
      }
    });

    test('a visible failure behind a HIDDEN earlier match is still found', async () => {
      const { ErrorState } = await import('@kontourai/station-sdk');
      const { page, close } = await pageWith(
        markupOf(<ErrorState title="Hidden first" />) +
          markupOf(<ErrorState title="Visible second" />),
        '.error-state:first-of-type { display: none; }',
      );
      try {
        // Blocking defect two: the adapter sampled index zero, so a hidden earlier
        // match masked this one and the wait reported "rendered neither a pending
        // state nor a failure" while a failure was rendered AND visible.
        await expect(
          waitForRouteViewTarget(routeScreens(page), 2_000),
        ).rejects.toThrow(/settled into a failure of its own.*Visible second/s);
      } finally {
        await close();
      }
    });

    test('a visible target between HIDDEN matches is still observed as ready', async () => {
      const { page, close } = await pageWith(
        '<button type="button" class="target-surface" id="masking-first">Hidden first</button>' +
          TARGET +
          '<button type="button" class="target-surface" id="masking-last">Hidden last</button>',
        '#masking-first, #masking-last { display: none; }',
      );
      try {
        // The `target` half of the index-zero masking. Hidden matches on BOTH
        // sides deliberately: an arrangement with only a hidden first match is
        // satisfied by sampling the last one instead, which is not the property
        // being pinned. Only filtering for visibility answers this, so the case
        // fails under `target.first()` and under `target.last()` alike.
        //
        // A shorter budget than its siblings on purpose: the union's own
        // `.first()` is masked here too, so it waits the budget out before the
        // catch path classifies. That is the documented cost of the masking, and
        // the outcome is still `ready`.
        const observed = await waitForRouteViewTarget(routeScreens(page), 600);
        expect(observed.screen).toBe('ready');
      } finally {
        await close();
      }
    });

    test('a pending skeleton on screen times out as slow, quoting its pending state', async () => {
      const { page, close } = await pageWith(PENDING());
      try {
        await expect(
          waitForRouteViewTarget(routeScreens(page), 400),
        ).rejects.toThrow(
          /never settled.*still rendering its own pending state.*its pending state, which renders no text of its own/s,
        );
      } finally {
        await close();
      }
    });

    test('a page with neither target, failure nor pending is reported as absent rather than slow', async () => {
      const { page, close } = await pageWith(
        '<div class="unrelated">Settled, and empty</div>',
      );
      try {
        await expect(
          waitForRouteViewTarget(routeScreens(page), 400),
        ).rejects.toThrow(
          /settled without the surface this wait was given.*absent rather than late/s,
        );
      } finally {
        await close();
      }
    });

    test('a pending state present but UNPAINTED still reports slow, not absent', async () => {
      const { page, close } = await pageWith(
        PENDING(),
        // Every dimension of the skeleton comes from the stylesheet, so this is
        // reachable by a stylesheet edit nobody would connect to a test helper.
        '.skeleton-list, .skeleton-list * { width: 0 !important; height: 0 !important;' +
          ' padding: 0 !important; margin: 0 !important; border: 0 !important; }',
      );
      try {
        const pending = page.getByRole('status', {
          name: ROUTE_PENDING_STATUS_NAME,
        });
        // The premise: with sizing suppressed the marker is genuinely unpaintable,
        // so a visibility-based classification WOULD have called this absent.
        expect(await pending.count()).toBeGreaterThan(0);
        expect(await pending.first().isVisible()).toBe(false);

        // THE GUARDRAIL. Classifying pending by presence is what keeps a slow view
        // from being reported as one whose surface is absent. Removing the coupling
        // (the fix) and catching its return (this case) are different guarantees,
        // and this is the second one: revert the classification to visibility and
        // this test reds while nothing else does.
        await expect(
          waitForRouteViewTarget(routeScreens(page), 400),
        ).rejects.toThrow(
          /never settled.*still rendering its own pending state/s,
        );
      } finally {
        await close();
      }
    });

    /* ── lazy-surface adapter outcomes ── */

    const SHEET = '<div role="menu" aria-label="Chat actions">Sheet</div>';

    async function lazyBoundaryFailureMarkup(): Promise<string> {
      const { LazyBoundary } = await import('../components/LazyBoundary');
      // The REAL boundary in its real failure state: a rejecting import, caught by
      // `LazyImportErrorBoundary`, rendering the default failure. Not a hand-copied
      // approximation of its markup — that would prove only that I can retype a
      // class name.
      const failing = () =>
        Promise.reject(new Error('fixture: chunk rejected')) as Promise<{
          default: React.ComponentType<Record<string, never>>;
        }>;
      const { container, unmount } = render(
        <LazyBoundary load={failing} componentProps={{}} pending={null} />,
      );
      // Settle the rejected import INSIDE `act`, or the snapshot below is taken
      // before the boundary has committed its error state and the fixture is an
      // empty string — which reads as "the selector does not match" rather than
      // as "nothing was rendered yet". React says so on stderr; it is worth
      // heeding rather than filtering.
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
      const markup = container.innerHTML;
      expect(markup).toContain('lazy-boundary__error');
      unmount();
      return markup;
    }

    test("the real LazyBoundary failure is what the adapter's selector matches", async () => {
      const failure = await lazyBoundaryFailureMarkup();
      const { page, close } = await pageWith(failure);
      try {
        expect(
          await page.locator(LAZY_BOUNDARY_ERROR_SELECTOR).count(),
        ).toBeGreaterThan(0);
        expect(await countVisibleLazyBoundaryErrors(page)).toBe(1);
      } finally {
        await close();
      }
    });

    test('a mounted surface is observed as ready', async () => {
      const { page, close } = await pageWith(SHEET);
      try {
        const observed = await waitForLazySurface(
          page,
          {
            surfaceName: 'The fixture sheet',
            surface: page.getByRole('menu', { name: 'Chat actions' }),
            baselineUnavailableCount: 0,
          },
          2_000,
        );
        expect(observed.screen).toBe('ready');
      } finally {
        await close();
      }
    });

    test('a boundary failure that APPEARED is reported as this surface unavailable', async () => {
      const failure = await lazyBoundaryFailureMarkup();
      const { page, close } = await pageWith(failure);
      try {
        const observed = waitForLazySurface(
          page,
          {
            surfaceName: 'The fixture sheet',
            surface: page.getByRole('menu', { name: 'Chat actions' }),
            baselineUnavailableCount: 0,
          },
          2_000,
        );
        await expect(observed).rejects.toThrow(
          /The fixture sheet is unavailable.*appeared across this interaction.*React caches a rejected `lazy` import/s,
        );
      } finally {
        await close();
      }
    });

    test('a PRE-EXISTING boundary failure is not attributed to this surface', async () => {
      const failure = await lazyBoundaryFailureMarkup();
      const { page, close } = await pageWith(failure);
      try {
        // Blocking defect one, and the sharper of the two. `LazyBoundary`'s failure
        // text is one constant, so nothing in the sentence could have distinguished
        // this surface's failure from any other's — and the collision is reachable:
        // the dock's prewarmed boundary rejects exactly when the host is
        // unreachable, and these portaled sheets sort after it. A 20 s allowance
        // ended in milliseconds on a red naming the wrong component.
        const { page: counting, locatorCalls } = countingPage(page);
        const baseline = await countVisibleLazyBoundaryErrors(counting);
        expect(baseline).toBe(1);
        const callsBefore = locatorCalls();

        const startedAt = Date.now();
        await expect(
          waitForLazySurface(
            counting,
            {
              surfaceName: 'The fixture sheet',
              surface: page.getByRole('menu', { name: 'Chat actions' }),
              baselineUnavailableCount: baseline,
            },
            400,
          ),
        ).rejects.toThrow(/did not load within.*cannot distinguish/s);
        // It waited rather than failing instantly on someone else's error: the
        // honest "I could not tell", which is worth more than a confident wrong
        // name. The pre-fix adapter returned in single-digit milliseconds.
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);

        // AND it waited rather than SPUN, which the duration above cannot tell.
        // With the boundary back in the settled union, the old error resolves it
        // instantly on every pass, each pass re-reads the count, and the loop
        // burns the budget re-entering. Correct behaviour reaches `page.locator`
        // a handful of times: the union's construction, and one classification
        // on the way out.
        expect(locatorCalls() - callsBefore).toBeLessThanOrEqual(8);

        // And the sentence names what it declined to attribute. Without this the
        // message says no failure was seen while a rendered boundary failure is
        // on the page — true about attribution, and read as a claim about the
        // page.
        await expect(
          waitForLazySurface(
            page,
            {
              surfaceName: 'The fixture sheet',
              surface: page.getByRole('menu', { name: 'Chat actions' }),
              baselineUnavailableCount: baseline,
            },
            300,
          ),
        ).rejects.toThrow(
          /1 boundary failure\(s\) were already visible before this interaction and are excluded from attribution/,
        );
      } finally {
        await close();
      }
    });

    test('a failure that appeared BESIDE one already up reports both counts', async () => {
      const failure = await lazyBoundaryFailureMarkup();
      const { page, close } = await pageWith(failure + failure);
      try {
        // The arrangement neither suite had: a non-zero baseline AND a new
        // failure at the same time. Every earlier case had one or the other, so
        // the baseline clause of `unavailableDetail` was never reached and could
        // be deleted with both suites still green. Two failures are on the page
        // and one of them was already up when the interaction started.
        expect(await countVisibleLazyBoundaryErrors(page)).toBe(2);

        await expect(
          waitForLazySurface(
            page,
            {
              surfaceName: 'The fixture sheet',
              surface: page.getByRole('menu', { name: 'Chat actions' }),
              baselineUnavailableCount: 1,
            },
            400,
          ),
        ).rejects.toThrow(
          /1 boundary failure\(s\) appeared across this interaction.*1 were already visible before it, so this page had other surfaces failing already/s,
        );
      } finally {
        await close();
      }
    });

    test("the timeout carries the trigger's real open state when it publishes one", async () => {
      const { page, close } = await pageWith(
        '<button aria-label="Chat actions" aria-expanded="true">open</button>',
      );
      try {
        await expect(
          waitForLazySurface(
            page,
            {
              surfaceName: 'The fixture sheet',
              surface: page.getByRole('menu', { name: 'Chat actions' }),
              openIndicator: page.locator(
                'button[aria-label="Chat actions"][aria-expanded="true"]',
              ),
              baselineUnavailableCount: 0,
            },
            300,
          ),
        ).rejects.toThrow(/its trigger does report the surface open/);
      } finally {
        await close();
      }
    });

    test('and admits it when the trigger publishes none', async () => {
      const { page, close } = await pageWith(
        '<div>no trigger state here</div>',
      );
      try {
        // The Switch task trigger has no `aria-expanded` and no `aria-haspopup`,
        // so this sentence is the honest one for it.
        await expect(
          waitForLazySurface(
            page,
            {
              surfaceName: 'The fixture sheet',
              surface: page.getByRole('menu', { name: 'Chat actions' }),
              baselineUnavailableCount: 0,
            },
            300,
          ),
        ).rejects.toThrow(/publishes no open state/);
      } finally {
        await close();
      }
    });

    test('the baseline count sees only painted boundary failures', async () => {
      const failure = await lazyBoundaryFailureMarkup();
      const { page, close } = await pageWith(
        failure + failure,
        '.lazy-boundary__error:first-of-type { display: none; }',
      );
      try {
        expect(await page.locator(LAZY_BOUNDARY_ERROR_SELECTOR).count()).toBe(
          2,
        );
        // Visible, not present: an unpainted boundary error is not a failure
        // anyone is being shown, and one that becomes visible later should still
        // register as new.
        expect(await countVisibleLazyBoundaryErrors(page)).toBe(1);
      } finally {
        await close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  '#1642 readiness adapters — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the #1642 ' +
        'adapter screens could not be checked — this is a missing precondition, ' +
        'not a passing check. Install it with `npm run install:playwright` and ' +
        're-run.',
    );
  },
);
