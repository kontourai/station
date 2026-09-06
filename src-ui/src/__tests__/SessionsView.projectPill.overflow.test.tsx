/**
 * @vitest-environment jsdom
 *
 * #1582 E7: an Activity session row showed the chips "Evidence" and "dem…" —
 * a project label cut to three glyphs, which names no project at all.
 *
 * Nothing shortens the label. `sessionProjectLabel` passes it through verbatim
 * ("a long one is visually truncated with the full text on `title`, never
 * rewritten"), and the pill ellipsizes whatever width it is given. The width is
 * the defect: the row's trailing slot is capped at 38% of the row — a cap that
 * exists to stop a long trailing label from eating the NAME, and which is
 * right — and inside that cap `.session-evidence-button` is `flex: 0 0 auto;
 * white-space: nowrap`, so it takes its full width first and the pill divides
 * what is left. At the rail's 280px default that leaves the pill about three
 * glyphs, and at its 220px minimum, fewer.
 *
 * jsdom lays out nothing, so this is unobservable there. Following
 * `SplitPaneLayout.railName.overflow.test.tsx`: render the real
 * `SplitPaneLayout` with the real row content, put its markup into a real
 * Chromium page carrying the real cascade-resolved `index.css` plus the
 * stylesheets that own this row's geometry, and measure.
 *
 * WHAT THIS FIXTURE DOES NOT REPRODUCE, same as its sibling: `setContent` has
 * no base URL, so `@font-face` files never load and text is measured in a
 * fallback face. Whether a box is clipped, which line it lands on, and how many
 * glyphs fit in a measured width are all affected at the margin — so the
 * assertions below are about GEOMETRY (does the pill get a usable width, does
 * it stay inside the row) rather than about a specific string fitting.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: '(max-width: 768px)',
}));

import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { SessionEvidenceButton } from '../components/session/SessionEvidenceButton';
import { SessionProjectPill } from '../components/session/SessionProjectPill';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
/**
 * The three stylesheets that own this row's trailing geometry. A co-located
 * component stylesheet is imported by its own module and never reaches
 * `index.css`, so a fixture built from `index.css` alone measures an unstyled
 * row and passes for the wrong reason.
 */
const ROW_CSS_PATHS = [
  resolve(HERE, '../components/SplitPaneLayout.css'),
  resolve(HERE, '../components/session/SessionProjectPill.css'),
  resolve(HERE, '../components/session/SessionEvidenceButton.css'),
];

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

/**
 * The row the audit photographed: a session whose title is long enough to
 * ellipsize, carrying BOTH trailing controls. Both halves matter — the
 * evidence button is what spends the trailing slot's width before the pill
 * sees any of it, so a fixture with the pill alone cannot discriminate.
 */
const SESSION_TITLE = 'Run `pwd` and report the working directory';
const PROJECT_LABEL = 'demonstration-workspace';

function railMarkup(): string {
  const { container, unmount } = render(
    <SplitPaneLayout
      paneId="sessions-pill-overflow-fixture"
      label="sessions"
      title="Activity"
      items={[
        {
          id: 'session-1',
          name: SESSION_TITLE,
          subtitle: 'Completed · 2m ago',
          trailing: (
            <>
              <SessionEvidenceButton
                sessionTitle={SESSION_TITLE}
                onActivate={() => {}}
              />
              <SessionProjectPill
                label={PROJECT_LABEL}
                filterKey="demonstration-workspace"
                active={false}
                onToggle={() => {}}
              />
            </>
          ),
        },
      ]}
      selectedId={null}
      onSelect={() => {}}
      onSearch={() => {}}
    >
      <div>Nothing selected</div>
    </SplitPaneLayout>,
  );
  const left = container.querySelector('.split-pane__left');
  if (!left) throw new Error('the rail did not render');
  const html = left.outerHTML;
  unmount();
  return html;
}

function fixtureHtml(rail: string, railWidth: number): string {
  const css = [INDEX_CSS_PATH, ...ROW_CSS_PATHS]
    .map((path) => resolveCssImports(path))
    .join('\n');
  assertNoImportsSurvive(css);
  // The rail sizes ITSELF (`.split-pane__left` carries `min-width: 220px;
  // max-width: 420px` and the skeleton's persisted width), so wrapping it in a
  // sized parent does not change what the row measures — three cases all
  // measured the same 279px row until this override existed, which is coverage
  // that is not there. Pin the rail itself, and assert the width took.
  return `<!doctype html>
<html>
  <head><style>${css}
    .split-pane__left {
      width: ${railWidth}px !important;
      min-width: ${railWidth}px !important;
      max-width: ${railWidth}px !important;
      flex: 0 0 ${railWidth}px !important;
    }
  </style></head>
  <body style="margin:0">
    <div class="split-pane" style="display:flex;width:1440px;height:700px">
      ${rail}
      <div style="flex:1 1 auto">Nothing selected</div>
    </div>
  </body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'an Activity session row keeps its project chip readable (#1582 E7)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    async function measure(railWidth: number) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 700 },
      });
      try {
        await page.setContent(fixtureHtml(railMarkup(), railWidth));
        await page.evaluate(() => document.fonts?.ready);
        return await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              text: (element.textContent ?? '').trim(),
              // The whole label the pill WOULD need, against the width it got.
              contentWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
            };
          };
          return {
            pill: box('.session-project-pill'),
            evidence: box('.session-evidence-button'),
            trailing: box('.split-pane__item-trailing'),
            nameText: box('.split-pane__item-name-text'),
            row: box('.split-pane__item-row'),
          };
        });
      } finally {
        await page.close();
      }
    }

    /**
     * The discriminating number. Pre-fix, at the 280px default, the pill
     * measured about 40px wide — padding plus roughly three glyphs before the
     * ellipsis, which is the "dem…" the audit photographed. A minimum stated
     * in glyphs rather than a ratio: the point is that a reader can tell one
     * project from another, and 3 characters cannot.
     *
     * `--font-mono` at 0.6rem with 0.45rem of padding each side: 9 glyphs is
     * about 58px of text plus 14px of padding. The floor below is deliberately
     * under that measured figure rather than equal to it, so a font-metric
     * difference between this fixture's fallback face and the shipped one
     * cannot make the test the thing that fails.
     */
    const MIN_READABLE_PILL_PX = 64;

    test.each([220, 280, 420])(
      'the project chip gets a readable width at a %ipx rail',
      async (railWidth) => {
        const { pill, row } = await measure(railWidth);
        if (!pill || !row) throw new Error('the project pill did not render');
        // The parameter has to reach the layout, or these are three copies of
        // one case wearing three names. (Minus the rail's 1px right border.)
        expect(row.width).toBeCloseTo(railWidth - 1, 0);
        expect(pill.width).toBeGreaterThanOrEqual(MIN_READABLE_PILL_PX);
      },
    );

    test('the evidence button no longer takes its width before the chip sees any', async () => {
      const { pill, evidence, trailing } = await measure(280);
      if (!pill || !evidence || !trailing)
        throw new Error('the row did not render');
      // Pre-fix both sat on one line inside a 38% cap and the pill took what
      // was left. Either they now share the slot with the pill still legible,
      // or the pill has taken the line below — both are readable outcomes, and
      // asserting only one of them would pin a layout rather than the property.
      const sharesALine = pill.top < evidence.bottom - 1;
      if (sharesALine) {
        expect(pill.width).toBeGreaterThanOrEqual(MIN_READABLE_PILL_PX);
      } else {
        expect(pill.top).toBeGreaterThanOrEqual(evidence.bottom - 1);
      }
    });

    /**
     * The measurements this fix is worth, at the same fixture: the pill went
     * from 40.8px at every rail width (three glyphs) to 82 / 104.8 / 153.3 at
     * 220 / 280 / 420. At the widest rail the whole label now fits unclipped,
     * which is a stronger claim than any pixel floor: the reader sees the
     * project's name, not a prefix of it.
     */
    test('a wide rail shows the whole project name, not a prefix', async () => {
      const { pill } = await measure(420);
      if (!pill) throw new Error('the project pill did not render');
      expect(pill.text).toBe(PROJECT_LABEL);
      expect(pill.contentWidth).toBeLessThanOrEqual(pill.clientWidth);
    });

    test('nothing escapes the row to buy that width', async () => {
      const { row, pill, evidence, nameText } = await measure(280);
      if (!row || !pill || !evidence || !nameText)
        throw new Error('the row did not render');
      // The 38% trailing cap exists to protect the NAME (SplitPaneLayout.css).
      // A "fix" that widened the slot instead would pass the assertions above
      // and fail here, or push the pill outside the rail.
      expect(pill.right).toBeLessThanOrEqual(row.right + 1);
      expect(evidence.right).toBeLessThanOrEqual(row.right + 1);
      expect(pill.left).toBeGreaterThanOrEqual(row.left - 1);
      expect(nameText.width).toBeGreaterThan(0);
    });
  },
);
