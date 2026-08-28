/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { act, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../../tests/helpers/touch-target';
import { bannerStore } from '../../../contexts/banner-store';
import { BannerHost } from '../BannerHost';

/**
 * archive#3453. The floor this file enforces (44 CSS px, WCAG 2.5.5) was
 * previously observable ONLY by `tests/connect-reconnect-banner.spec.ts`'s
 * "keeps the reconnect action reachable on a phone viewport" test — real
 * end-to-end Playwright, against a live built app. No static gate here can
 * see a *computed*, cascade-resolved height: `gate:ui-contracts`'s ratchets
 * (`responsive-surface-ratchet.mjs`, `accent-foreground-ratchet.mjs`,...)
 * all parse CSS source text, never a browser's resolved cascade, so none of
 * them can tell a component's own declared value apart from what actually
 * wins once a more (or less) specific rule elsewhere in the app is in play.
 * archive#3453 found exactly that gap live: `.banner-host__action`'s mobile
 * `min-height` read 42px in the stylesheet, but a *global* touch-target net
 * in `index.css` (`:is([class*="__actions"],...) > :is(button, a,.button,
 * [role="button"])`, itself scoped to the same mobile breakpoint) is MORE
 * specific and already won that fight at 44px — so the real, rendered
 * control was never actually broken. Its sibling `.banner-host__dismiss`
 * WAS: it sits outside that global net's reach (a sibling of
 * `.banner-host__actions`, not a descendant of it) and rendered at a real
 * 40x40 on a phone viewport, below the floor, undetected because provider-
 * hosted E2E has been dead since a billing outage (see
 * `docs/strategy/local-merge-readiness.md`).
 *
 * This check closes that gap the cheap way the issue asked for: render the
 * REAL `BannerHost` component (through `@testing-library/react`, jsdom) with
 * a fixture that exercises every one of its interactive controls
 * (`.banner-host__action`, `.banner-host__dismiss`, `.banner-host__disclosure`,
 * `.banner-host__cap`), inject the resulting markup — not hand-typed markup
 * naming individual selectors — into a real Chromium page carrying the REAL,
 * unmodified source stylesheets (`index.css`'s global net + `BannerHost.css`'s
 * own rules, `@import`s fully resolved — both the `url(...)` and bare-string
 * forms, recursively, through the SAME package resolution the real bundler
 * uses — rather than stripped, with `assertNoImportsSurvive` making that a
 * proven property of the composed CSS rather than a claim about the regex),
 * and enumerate EVERY `button, a` under `.banner-host`, asserted as an exact,
 * ordered class-name list (not just a count) so a control silently dropped
 * while another is silently added cannot cancel out. Binding the audit to
 * real markup and a real enumeration — instead of naming selectors by hand —
 * means a fifth control added later is not silently unaudited, and a class
 * rename is not silently green against a fixture element that no longer
 * matches anything the product renders.
 *
 * It is not a substitute for E2E generally (it drives one component through
 * jsdom + a synthetic page rather than the live app), but it is proportionate
 * to the one property this issue is about and it CAN run pre-merge. Full E2E
 * remains the broader-journey coverage; this is a narrow, cheap supplement
 * for the one property that E2E was the only thing observing.
 *
 * PRECONDITION: this file launches a real Chromium (via `@playwright/test`,
 * already a devDependency), and `npm ci` does not install it — root
 * `postinstall` is `patch-package` only. `npm run install:playwright` (or CI's
 * `full-regression` job, which now runs it) provisions the repo-local browser
 * this file requires; see `docs/guides/testing.md`. Per this repo's browser-
 * test doctrine ("no conditional green exits"), a missing precondition FAILS
 * this file loudly with an actionable message rather than skipping silently —
 * an unchecked property must never read as a clean pass.
 *
 * RESOURCE CLASSIFICATION: this file is listed in
 * `scripts/vitest-resource-manifest.mjs`'s `PROCESS_HEAVY_VITEST_FILES`. It
 * spawns a real Chromium process through `playwright-core`, which the
 * manifest's direct-`child_process`-import scan cannot see (same shape as the
 * ACP integration tests already classified there) — a cold browser launch
 * under a full corpus plus a sibling session is exactly the load-dependent
 * case this repo's resource partition exists to keep out of the ordinary
 * four-worker pool.
 *
 * The CSS-import-resolution/Chromium-precondition machinery
 * (`resolveCssImports`, `assertNoImportsSurvive`, `chromiumIsInstalled`,
 * `playwrightBrowsersDirectory`) moved to
 * `tests/helpers/css-cascade-fixture.ts` when
 * `NotificationContainer.touch-target.test.tsx` (archive#3513) needed a
 * byte-identical copy — only this file's own fixture-building
 * (`buildFixtureCss`, `presentFixtureBanners`) stays local.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const BANNER_CSS_PATH = resolve(HERE, '../BannerHost.css');

function buildFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(BANNER_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

/**
 * Presents two banners so `BannerHost` renders all four control classes at
 * once: the front (highest-priority, connectionBlocking-band) banner carries
 * an action, is dismissible, and has `detail` (so its "Details" disclosure
 * toggle renders); a second, lower-priority banner has nothing live ahead of
 * it in its own band, so it is hidden behind the top-level stack cap — which
 * is what makes `.banner-host__cap` render at all (see
 * `buildBannerStackView`: the cap is null unless something is actually
 * hidden). This is an audit fixture, not a claim that one production banner
 * ever carries all four simultaneously — the point is exhaustive control
 * coverage of what `BannerHost.tsx` CAN render, not one realistic instance.
 */
function presentFixtureBanners(): void {
  act(() => {
    bannerStore.present({
      id: 'station-3453:front',
      priority: 100, // connectionBlocking band — see BANNER_PRIORITY.
      tone: 'blocked',
      message: "Can't reach the connection",
      detail:
        'Retrying automatically. Some actions are read-only until it recovers.',
      dismissible: true,
      dismissAriaLabel: 'Dismiss notice',
      actions: [{ label: 'Try now', onClick: () => {} }],
    });
    bannerStore.present({
      id: 'station-3453:hidden',
      priority: 10, // info band — sorts behind the front banner's cap.
      tone: 'info',
      message: 'A lower-priority notice hidden behind the cap',
    });
  });
}

function renderFixtureMarkup(): string {
  presentFixtureBanners();
  const { container, unmount } = render(<BannerHost connectionSlot={false} />);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function buildFixtureHtml(): string {
  const css = buildFixtureCss();
  const markup = renderFixtureMarkup();
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${css}</style>
  </head>
  <body>${markup}</body>
</html>`;
}

/**
 * WCAG 2.5.5's Inline Exception: the SC does not apply to a target that
 * "is in a sentence or block of text." `.banner-host__disclosure` ("Details",
 * archive#4470b — a constant label plus a small caret, no longer the "More"/
 * "Less" verb pair) is rendered inline, directly after the banner's message
 * text, as part of the running sentence (see `BannerHost.tsx`'s render: the
 * toggle sits inside the same `.banner-host__message` flow, immediately after
 * `{banner.message}`) — not a standalone action row. Disposed explicitly here
 * rather than silently excluded, so a reader does not have to rediscover why
 * it is exempt (measured today: 63.81px wide, 44.00px tall at 390x844 — wider
 * than the old "More"/"Less" text because the label is a whole word plus a
 * caret glyph now, which is exactly what the width exemption exists to not
 * care about).
 *
 * The exemption is WIDTH ONLY, matching exactly what the measurement and the
 * exception justify — nothing here excuses a height regression. An earlier
 * version of this Set exempted both dimensions on the same rationale, which
 * is broader than the rationale earns: collapsing this control's `min-height`
 * from 44px to 20px (fighting its `margin: -14px 0` inline placement) left
 * the audit green, because the exempt branch skipped the whole control
 * rather than just its width.
 */
const WCAG_WIDTH_EXEMPT_CLASSES = new Set(['banner-host__disclosure']);

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'BannerHost mobile touch targets (station#3453)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    afterEach(() => {
      act(() => bannerStore.reset());
    });

    test('every interactive control BannerHost renders clears the touch-target floor at a phone viewport, or is disposed as a named exception', async () => {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.setContent(buildFixtureHtml());
        const controls = page.locator('.banner-host').locator('button, a');
        const count = await controls.count();
        const classNames: string[] = [];
        for (let i = 0; i < count; i += 1) {
          classNames.push((await controls.nth(i).getAttribute('class')) ?? '');
        }
        // Exact, ORDERED membership — not a count. A count can't tell "the
        // right 4 controls" from "4 controls, one dropped and a different
        // one added by coincidence": cardinality alone cancels those out.
        // DOM order here is fixed by BannerHost.tsx's render (message+
        // disclosure, then actions, then dismiss, then the top-level cap),
        // so asserting the exact array also pins that shape — a control
        // silently dropped fails LOUD here even if something else silently
        // replaces its slot in the count.
        expect(
          classNames,
          `expected exactly these controls under .banner-host, in DOM order, ` +
            `but found ${JSON.stringify(classNames)} — BannerHost.tsx's render ` +
            `changed. Update this list and audit whichever control differs.`,
        ).toEqual([
          'banner-host__disclosure',
          'banner-host__action banner-host__action--secondary',
          // Added by #3511 (every banner collapsible). This list reddened on
          // that merge, which is the assertion working: a control appeared and
          // the enumeration refused to describe itself as complete without it.
          // Audited on arrival — `.banner-host__collapse` declares
          // `min-width: 44px; min-height: 44px` in BannerHost.css, so it clears
          // MIN_TOUCH_TARGET_PX on its own rather than via index.css's net, and
          // the measurement loop below re-proves that on every run.
          'banner-host__collapse',
          'banner-host__dismiss',
          'banner-host__cap banner-host__cap--info',
        ]);

        const failures: string[] = [];
        for (let i = 0; i < count; i += 1) {
          const control = controls.nth(i);
          const className = classNames[i] ?? '';
          const accessibleName =
            (await control.getAttribute('aria-label')) ??
            (await control.textContent())?.trim() ??
            '';
          const label = `<${await control.evaluate((el) => el.tagName.toLowerCase())} class="${className}"> "${accessibleName}"`;

          // Elements found via `.nth` off a locator that already matched
          // them are attached and present by construction — there is no
          // "waiting for a selector that might not exist" race here, so a
          // null box means genuinely not visible (e.g. display:none), not a
          // rename. `boundingBox` on an existing-but-invisible element
          // returns null without an auto-wait/timeout race.
          const box = await control.boundingBox();
          if (box === null) {
            failures.push(
              `${label}: not visible (boundingBox() returned null)`,
            );
            continue;
          }

          if (box.height < MIN_TOUCH_TARGET_PX) {
            failures.push(
              `${label}: height ${box.height}px < ${MIN_TOUCH_TARGET_PX}px floor`,
            );
          }

          // WIDTH-only exemption (WCAG_WIDTH_EXEMPT_CLASSES above) — height
          // is still checked for every control, exempt or not.
          const widthExempt = [...WCAG_WIDTH_EXEMPT_CLASSES].some((cls) =>
            className.split(/\s+/).includes(cls),
          );
          if (widthExempt) continue; // Disposed above — WCAG 2.5.5 Inline Exception.

          if (box.width < MIN_TOUCH_TARGET_PX) {
            failures.push(
              `${label}: width ${box.width}px < ${MIN_TOUCH_TARGET_PX}px floor`,
            );
          }
        }

        expect(
          failures,
          `touch-target floor violation(s) at 390x844:\n${failures.join('\n')}`,
        ).toEqual([]);
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'BannerHost mobile touch targets — Chromium not installed, cannot verify (station#3453)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'BannerHost touch-target floor (station#3453) could not be checked — ' +
        'this is a missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
