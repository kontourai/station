/**
 * @vitest-environment jsdom
 *
 * #1666: Developer -> Telemetry's header collapsed to a few-pixel column when
 * the Activity pane narrowed the main region — the "Monitoring" title clipped
 * to nothing and the subtitle wrapped one word per line down six lines.
 *
 * The cause is geometry, and it is invisible to jsdom, which lays nothing out.
 * `.detail-header__left` carries `min-width: 0`, which removes a flex child's
 * automatic min-content floor, so against a `flex-shrink: 0` actions block it
 * absorbed the entire shortfall and was driven to ZERO instead of truncating.
 * The rule that would have wrapped the row was keyed on a VIEWPORT media
 * query, and this header's width is set by its REGION — so in a 1440px window
 * with a docked pane it could never match.
 *
 * Three failure modes are pinned here, because the fix has to hold all three
 * at once and two of them were introduced by candidate fixes for the first:
 *
 *   COLLAPSE   the identity starved to nothing beside a wide actions block.
 *   OVERFLOW   `min-width: 0` removed to give the identity a floor — which
 *              stops a long title ellipsizing and runs it past the region.
 *   COLUMN     the wrap threshold expressed as a `flex-basis` LENGTH, which is
 *              the MAIN size — a width while the header is a row, a HEIGHT
 *              once a responsive block stacks it, where 20rem inflated a 23px
 *              identity to 320px on every consumer.
 *   SUBTITLE   the wrap decision taking the subtitle's content width into
 *              account, so the header spent a whole second row widening a
 *              subtitle that wrapped to the same line count either way — 61px
 *              taller across 217 region widths, nothing clipped, nothing
 *              overflowing. A wrap must mean the identity and the actions
 *              cannot share a row.
 *
 * Asserting a class name or a CSS declaration would not have caught any of
 * them: every declaration involved was "present" throughout every defect.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { DetailHeader } from '../components/DetailHeader';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const CSS_PATHS = [
  resolve(HERE, '../index.css'),
  resolve(HERE, '../components/DetailHeader.css'),
  resolve(HERE, '../views/MonitoringWidgets.css'),
];

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

/**
 * Telemetry's real header: a wide actions cluster (the session summary plus
 * the live controls) beside a title and subtitle. The actions are what starve
 * the identity, so a fixture without them cannot reproduce the collapse.
 */
function headerMarkup(): string {
  const { container, unmount } = render(
    <DetailHeader
      title="Monitoring"
      subtitle="Live agent activity, health, and usage"
      icon={
        <div className="status-badge">
          <span className="status-dot status-dot-connected" />
        </div>
      }
    >
      <div className="monitoring-summary">
        <span className="stat-item">
          <span className="stat-label">Active sessions:</span>
          <span className="stat-value">0</span>
        </span>
        <span className="stat-item">
          <span className="stat-label">Running turns:</span>
          <span className="stat-value">0</span>
        </span>
      </div>
      <div className="monitoring-header-actions">
        <button type="button" className="button">
          ● LIVE
        </button>
        <button type="button" className="button">
          CLEAR ALL
        </button>
      </div>
    </DetailHeader>,
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

/**
 * A title longer than any region measured here, with actions — the shape
 * `min-width: 0` on `__left` exists to serve. A fix that removes that floor
 * makes this OVERFLOW its region instead of ellipsizing, on desktop and on a
 * phone, which is why it is measured rather than assumed.
 */
function longTitleMarkup(): string {
  const { container, unmount } = render(
    <DetailHeader
      title="Reduce default toolbar clutter in the chat dock"
      badge={{ label: 'unsaved', variant: 'warning' }}
    >
      <button type="button" className="editor-btn editor-btn--danger">
        Delete
      </button>
      <button type="button" className="editor-btn editor-btn--primary">
        Save
      </button>
    </DetailHeader>,
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

/**
 * A short identity beside the wide actions — the shape that says whether the
 * wrap point comes from CONTENT or from a number. These two can share a row at
 * a 776px region and cannot at 600px, so a threshold pinned to a length wraps
 * the first one too.
 */
function shortIdentityWideActionsMarkup(): string {
  const { container, unmount } = render(
    <DetailHeader title="Add model connection">
      <div className="monitoring-summary">
        <span className="stat-item">
          <span className="stat-label">Active sessions:</span>
          <span className="stat-value">0</span>
        </span>
        <span className="stat-item">
          <span className="stat-label">Running turns:</span>
          <span className="stat-value">0</span>
        </span>
      </div>
      <div className="monitoring-header-actions">
        <button type="button" className="button">
          ● LIVE
        </button>
        <button type="button" className="button">
          CLEAR ALL
        </button>
      </div>
    </DetailHeader>,
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

/**
 * A subtitle-bearing consumer with a compact action cluster — the shape that
 * says whether the SUBTITLE is allowed to influence the wrap. Its subtitle is
 * longer than the 62ch cap, so the cap binds and the text needs two lines at
 * any width this header can offer.
 */
function subtitledCompactActionsMarkup(): string {
  const { container, unmount } = render(
    <DetailHeader
      title="Issue tracker"
      subtitle={
        'Connect this project to an external issue tracker and keep its task ' +
        'state in sync across every workspace and device that opens it later on'
      }
    >
      <button type="button" className="editor-btn">
        Disconnect
      </button>
      <button type="button" className="editor-btn editor-btn--primary">
        Save
      </button>
    </DetailHeader>,
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

function fixtureHtml(
  markup: string,
  regionWidth: number,
  wrapperClass?: string,
): string {
  const css = CSS_PATHS.map((path) => resolveCssImports(path)).join('\n');
  assertNoImportsSurvive(css);
  const inner = wrapperClass
    ? `<div class="${wrapperClass}">${markup}</div>`
    : markup;
  return `<!doctype html>
<html><head><style>${css}</style></head>
<body style="margin:0">
  <div id="region" style="width:${regionWidth}px">${inner}</div>
</body></html>`;
}

describe.skipIf(!chromiumAvailable)(
  'DetailHeader survives a narrow region inside a wide viewport (#1666)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

    beforeAll(async () => {
      browser = await chromium.launch();
    }, 120_000);
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    async function measure(
      regionWidth: number,
      viewportWidth: number,
      options: { markup?: string; wrapperClass?: string } = {},
    ) {
      const markup = options.markup ?? headerMarkup();
      const page = await browser!.newPage({
        viewport: { width: viewportWidth, height: 900 },
      });
      try {
        await page.setContent(
          fixtureHtml(markup, regionWidth, options.wrapperClass),
        );
        return await page.evaluate(() => {
          const pick = (selector: string) =>
            document.querySelector(selector) as HTMLElement | null;
          const header = pick('.detail-header');
          const title = pick('.detail-header__title');
          const left = pick('.detail-header__left');
          const region = document.getElementById('region');
          if (!header || !title || !left || !region) {
            throw new Error('header not found');
          }
          // Optional: several consumers render no subtitle at all, and the
          // long-title fixture below is one of them.
          const subtitle = pick('.detail-header__subtitle');
          const lineHeight = subtitle
            ? Number.parseFloat(getComputedStyle(subtitle).lineHeight)
            : 0;
          const regionRight = region.getBoundingClientRect().right;
          return {
            identityWidth: Math.round(left.getBoundingClientRect().width),
            // The identity's own box height. `flex-basis` is the MAIN size, so
            // a wrap threshold written as one is read as a HEIGHT wherever a
            // responsive block stacks this header into a column.
            identityHeight: Math.round(left.getBoundingClientRect().height),
            subtitleWidth: subtitle
              ? Math.round(subtitle.getBoundingClientRect().width)
              : null,
            subtitleLines: subtitle
              ? Math.round(subtitle.getBoundingClientRect().height / lineHeight)
              : null,
            titleWidth: Math.round(title.getBoundingClientRect().width),
            titleClipped: title.scrollWidth > title.clientWidth + 1,
            // How far the identity runs past its region's content box.
            overflow: Math.round(
              Math.max(0, left.getBoundingClientRect().right - regionRight),
            ),
          };
        });
      } finally {
        await page.close();
      }
    }

    /**
     * COLLAPSE. 1440px is the gallery's desktop viewport and is deliberately
     * far above every media-query breakpoint in this file, so nothing
     * viewport-keyed can be what makes these pass. 500 and 600 are the region
     * widths at which the pre-fix header measured 0px and 76px of identity.
     *
     * These four are the GUARDRAIL: literals with deliberate headroom between
     * pass and fail, chosen against the pre-fix measurements (0px identity,
     * 32px title, six lines) so they stay robust across renderer differences
     * rather than tracking one engine's pixel rounding. They are derived from
     * nothing in the layout, because a threshold computed from the same layout
     * it checks would move with the defect.
     *
     * The PIN is the viewport-agreement test below: it compares measurements
     * to each other rather than to any chosen number, so it is tight by
     * construction and states the actual property — layout is a function of
     * the region, not the window.
     */
    test.each([
      [500, 1440],
      [600, 1440],
      [700, 1440],
      // The 641-768px band had no wrap rule at all before this change and
      // collapsed by the identical mechanism.
      [600, 700],
    ])(
      'a %ipx region in a %ipx viewport keeps the header legible',
      async (regionWidth, viewportWidth) => {
        const m = await measure(regionWidth, viewportWidth);

        // The identity must keep real width. Pre-fix: 0px at 500, 76px at 600.
        expect(m.identityWidth).toBeGreaterThan(150);

        // The title must never be truncated away. Pre-fix: clipped to 32px at
        // a 600px region and to 0px at 500px.
        expect(m.titleClipped).toBe(false);
        expect(m.titleWidth).toBeGreaterThan(80);

        // The subtitle must reflow, not collapse into a one-word column.
        // Pre-fix: 0-32px wide across six lines.
        expect(m.subtitleWidth).toBeGreaterThan(120);
        expect(m.subtitleLines).toBeLessThanOrEqual(2);
      },
      60_000,
    );

    /**
     * The property the fix is really about: the header's layout is a function
     * of the REGION it occupies, not of the window it happens to sit in. Three
     * viewports that straddle every breakpoint in this file must agree, given
     * the same region width.
     */
    test('the same region width lays out identically across viewports', async () => {
      // 1440, 1200 and 700 all sit OUTSIDE the 769-1180 tablet band, which
      // deliberately gives the actions their own row as a property of the
      // viewport class rather than of this header's width. Everywhere else,
      // one region width must mean one layout.
      //
      // 1200 replaced an earlier 1000, which is inside that band: there
      // `__left` resolves to a band-forced `flex-basis: 100%` rather than to
      // anything this fix decides, and the comparison passed only because a
      // 600px region is one of the few widths where the forced and the
      // content-derived layouts coincide. At a 900px region it is false. The
      // pin is meant to be tight by construction, so it must not depend on
      // that coincidence.
      const wide = await measure(600, 1440);
      const alsoAboveBand = await measure(600, 1200);
      const narrowViewport = await measure(600, 700);
      expect(alsoAboveBand).toEqual(wide);
      expect(narrowViewport).toEqual(wide);
    }, 120_000);

    /**
     * OVERFLOW. The regression a floor-based fix introduces, pinned so it
     * cannot come back: dropping `min-width: 0` from `__left` stops a long
     * title ellipsizing and pushes the identity past its region.
     *
     * The two assertions are discriminated by DIFFERENT injections, which is
     * why both are here:
     *
     *   `overflow === 0`     reds when the phone block's `flex-wrap: nowrap`
     *                        is removed (390px case: the identity measures
     *                        470px inside a 390px region, 96px past its edge).
     *   `titleClipped`       reds when `min-width: 0` is removed from `__left`
     *                        (500px case: the title stops ellipsizing and the
     *                        identity simply takes its own row instead).
     *
     * Restoring the whole floor-based variant reds both. Neither assertion
     * alone would catch both injections, and `overflow === 0` on its own would
     * also pass for a fixture whose title merely fit.
     */
    test.each([
      // Phone, where the header stacks into a column.
      [390, 390],
      // Desktop viewport, narrow region — no media query is involved at all.
      [500, 1440],
    ])(
      'a long title ellipsizes rather than overflowing a %ipx region',
      async (regionWidth, viewportWidth) => {
        const m = await measure(regionWidth, viewportWidth, {
          markup: longTitleMarkup(),
        });
        expect(m.overflow).toBe(0);
        expect(m.titleClipped).toBe(true);
        expect(m.identityWidth).toBeLessThanOrEqual(regionWidth);
      },
      60_000,
    );

    /**
     * COLUMN. Every responsive block that stacks this header makes the main
     * axis vertical, and `flex-basis` is the MAIN size. `__left` keeps
     * `flex-basis: auto` precisely so that stays content-derived in both
     * directions; a LENGTH there would be 320px of height once stacked — a
     * 23px identity in a 405px phone header, on every consumer, and it would
     * need a reset inside every stacking rule to undo.
     *
     * So this is not pinning a reset — there is none to pin. It pins the
     * property the resets would otherwise have had to restore, which is what
     * makes reintroducing a length basis fail here instead of on a phone.
     *
     * Both stacking rules are covered, because they are in different files and
     * cover different bands: `DetailHeader.css` stacks at <= 640px, and
     * `views/MonitoringWidgets.css` stacks `.monitoring-page`'s header at
     * <= 768px — so the 641-768px band is reachable only through the second.
     */
    test.each([
      [390, 390, undefined],
      [430, 430, undefined],
      [700, 700, 'monitoring-page'],
      [760, 760, 'monitoring-page'],
    ])(
      'a stacked %ipx header is the height of its content, not of the wrap threshold',
      async (regionWidth, viewportWidth, wrapperClass) => {
        const m = await measure(regionWidth, viewportWidth, {
          wrapperClass,
        });
        // Content measures 45px here (title row + subtitle). 320px is the
        // basis being read as a height; 120 leaves headroom on both sides.
        expect(m.identityHeight).toBeLessThan(120);
        // A stacked header hands the identity the full region, so nothing
        // truncates and nothing runs past the edge.
        expect(m.overflow).toBe(0);
        expect(m.titleClipped).toBe(false);
      },
      60_000,
    );

    /**
     * The wrap point is CONTENT, not a number. A short identity and a wide
     * actions block fit together at a 776px region and do not at 600px, so
     * this asserts both directions against the same fixture: a threshold
     * pinned to a length (20rem measured 728px of identity and a 121px header
     * at 776px) wraps the first case too, and reds here.
     *
     * The two-sided form is the point. "Does not wrap at 776" alone would also
     * pass for a header that never wraps, which is the defect at the top of
     * this file.
     */
    test('the wrap point comes from content, in both directions', async () => {
      const markup = shortIdentityWideActionsMarkup();

      // They fit: one row, the identity at its content width.
      const shares = await measure(776, 1440, { markup });
      expect(shares.identityWidth).toBeLessThan(450);
      expect(shares.titleClipped).toBe(false);
      expect(shares.overflow).toBe(0);

      // They do not fit: the actions take their own row rather than starving
      // the identity, which pre-fix measured 76px here.
      const wraps = await measure(600, 1440, { markup });
      expect(wraps.identityWidth).toBeGreaterThan(450);
      expect(wraps.titleClipped).toBe(false);
      expect(wraps.overflow).toBe(0);
    }, 120_000);

    /**
     * SUBTITLE. A wrap means the identity and the actions cannot share a row.
     * It must not mean the subtitle would like more width.
     *
     * At a 700px region this title and these two buttons fit together with
     * room to spare, so the header must stay one row. While the subtitle
     * counted toward the wrap decision it did not: the header took a second
     * row (identity 652px, header 158px) to give the subtitle 508px, and the
     * subtitle then wrapped to two lines exactly as it does at 451px. 61px of
     * height, the same line count, nothing clipped and nothing overflowing —
     * measured across 217 region widths on shapes like this one, and the same
     * complaint #1678 makes about the tablet band.
     *
     * This also stands in for the subtitle's `max-width: 62ch`. That cap used
     * to set the wrap point, so a typography change could move it; now the
     * subtitle is out of the decision entirely, and removing the cap changes
     * only how wide the subtitle RENDERS. Asserting the cap here would pass
     * with or without it, so the property worth pinning is this one.
     */
    test('the subtitle does not buy a second row it cannot use', async () => {
      const m = await measure(700, 1440, {
        markup: subtitledCompactActionsMarkup(),
      });

      // Wrapped, the identity would be the region's full 652px content box.
      expect(m.identityWidth).toBeLessThan(550);
      expect(m.titleClipped).toBe(false);
      expect(m.overflow).toBe(0);
      // And it is still a legible subtitle, not a starved one.
      expect(m.subtitleLines).toBeLessThanOrEqual(2);
      expect(m.subtitleWidth).toBeGreaterThan(300);
    }, 60_000);
  },
);

/**
 * A geometry check that silently skips is indistinguishable from one that
 * passes, so the missing precondition fails loudly instead. Matches
 * `ChatDockActiveIdentity.overflow.test.tsx`'s pair.
 */
test.skipIf(chromiumAvailable)(
  'DetailHeader narrow-region geometry — Chromium not installed, cannot verify (#1666)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the detail ' +
        'header’s behaviour in a narrowed region could not be measured — this ' +
        'is a missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
