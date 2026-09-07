/**
 * @vitest-environment jsdom
 *
 * #1666: Developer -> Telemetry's header collapsed to a few-pixel column when
 * the Activity pane narrowed the main region — the "Monitoring" title clipped
 * to nothing and the subtitle wrapped one word per line down six lines.
 *
 * The cause is geometry, and it is invisible to jsdom, which lays nothing out.
 * `.detail-header__left` carried `min-width: 0`, which removes a flex child's
 * automatic min-content floor, so against a `flex-shrink: 0` actions block it
 * absorbed the entire shortfall and was driven to ZERO instead of truncating.
 * The rule that would have wrapped the row was keyed on a VIEWPORT media
 * query, and this header's width is set by its REGION — so in a 1440px window
 * with a docked pane it could never match.
 *
 * That is what these measurements pin: at a narrow region inside a WIDE
 * viewport (where no media query helps), the identity keeps real width, the
 * title is never clipped, and the subtitle stays legible. Asserting a class
 * name or a CSS declaration would not have caught it — both were "present"
 * throughout the defect.
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
 * the identity, so a fixture without them cannot reproduce the defect.
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
 * A long title with actions — the shape `min-width: 0` on `__left` exists to
 * serve. A fix that removes that floor makes this OVERFLOW its region instead
 * of ellipsizing, on desktop and on a phone, which is why it is measured here
 * rather than assumed.
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

function fixtureHtml(markup: string, regionWidth: number): string {
  const css = CSS_PATHS.map((path) => resolveCssImports(path)).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html><head><style>${css}</style></head>
<body style="margin:0">
  <div id="region" style="width:${regionWidth}px">${markup}</div>
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
      markup: string = headerMarkup(),
    ) {
      const page = await browser!.newPage({
        viewport: { width: viewportWidth, height: 900 },
      });
      try {
        await page.setContent(fixtureHtml(markup, regionWidth));
        return await page.evaluate(() => {
          const pick = (selector: string) =>
            document.querySelector(selector) as HTMLElement | null;
          const subtitle = pick('.detail-header__subtitle');
          const title = pick('.detail-header__title');
          const left = pick('.detail-header__left');
          if (!subtitle || !title || !left) throw new Error('header not found');
          const lineHeight = Number.parseFloat(
            getComputedStyle(subtitle).lineHeight,
          );
          return {
            identityWidth: Math.round(left.getBoundingClientRect().width),
            subtitleWidth: Math.round(subtitle.getBoundingClientRect().width),
            subtitleLines: Math.round(
              subtitle.getBoundingClientRect().height / lineHeight,
            ),
            titleWidth: Math.round(title.getBoundingClientRect().width),
            titleClipped: title.scrollWidth > title.clientWidth + 1,
            // How far the identity runs past its region's content box.
            overflow: Math.round(
              Math.max(
                0,
                left.getBoundingClientRect().right -
                  (
                    document.getElementById('region') as HTMLElement
                  ).getBoundingClientRect().right,
              ),
            ),
          };
        });
      } finally {
        await page.close();
      }
    }

    /**
     * 1440px is the gallery's desktop viewport and is deliberately far above
     * every media-query breakpoint in this file, so nothing viewport-keyed can
     * be what makes these pass. 500 and 600 are the region widths at which the
     * pre-fix header measured 0px and 76px of identity respectively.
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
     * of the REGION it occupies, not of the window it happens to sit in. Two
     * viewports that straddle every breakpoint in this file must agree, given
     * the same region width.
     */
    test('the same region width lays out identically across viewports', async () => {
      // 1440 and 700 both sit outside the 769-1180 tablet band, which
      // deliberately gives the actions their own row as a property of the
      // viewport class rather than of this header's width. Everywhere else,
      // one region width must mean one layout.
      const wide = await measure(600, 1440);
      const narrowViewport = await measure(600, 700);
      expect(narrowViewport).toEqual(wide);
    }, 120_000);

    /**
     * The regression a floor-based fix introduces, pinned so it cannot come
     * back: removing `min-width: 0` from `__left` stops a long title
     * ellipsizing and pushes the identity past its region — measured at 470px
     * inside a 390px phone region, and 470px inside a 500px desktop region.
     */
    test.each([
      [390, 390],
      [500, 1440],
    ])(
      'a long title ellipsizes rather than overflowing a %ipx region',
      async (regionWidth, viewportWidth) => {
        const m = await measure(regionWidth, viewportWidth, longTitleMarkup());
        expect(m.overflow).toBe(0);
      },
      60_000,
    );
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
