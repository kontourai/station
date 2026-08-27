/**
 * @vitest-environment jsdom
 *
 * station#4463 slice 2 fix round (M1, delta review round 3): a prior version
 * of this fix pinned the skeleton row's rhythm with a CSS-text assertion —
 * `expect(cssRuleFrom(skeletonCss, '.skeleton-list__item')).toContain(
 * 'min-height: 38px;')` — which is true of the STYLESHEET TEXT and false of
 * the RENDERED PAGE: `.skeleton-list__item` is a flex row with
 * `padding: 10px 12px` (Skeleton.css) around a two-line text column
 * (0.7rem + 6px gap + 0.6rem ≈ 26.8px), so its own natural content height
 * (≈46.8px) already exceeds the asserted 38px floor — the min-height never
 * binds, and the grep passed for a claim the browser never enforces. All 45
 * tests in the surrounding suite passed throughout.
 *
 * jsdom does not lay out CSS (same precondition as
 * `BannerHost.touch-target.test.tsx` / `HeaderActions.connection-reflow.test.tsx`),
 * so this renders the real `SplitPaneLayout` twice through
 * `@testing-library/react` — once loading (the skeleton row), once with one
 * real item (the row it stands in for) — injects both markups into a real
 * Chromium page carrying the real, cascade-resolved `index.css` (which pulls
 * in `@kontourai/ui/react/styles.css`, the source of `.skeleton`/`.skeleton--*`)
 * composed with `SplitPaneLayout.css` and `Skeleton.css` (both plain,
 * import-free component stylesheets — see `resolveCssImports`'s own
 * docblock for why a hand-picked excerpt would not do), and measures the
 * actual rendered row heights.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
  useNavigation: () => ({
    navigate: vi.fn(),
  }),
}));

const isMobileMock = vi.fn(() => false);
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileMock(),
  MOBILE_MEDIA_QUERY: '(max-width: 768px)',
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

import { SplitPaneLayout } from '../components/SplitPaneLayout';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const SPLIT_PANE_CSS_PATH = resolve(HERE, '../components/SplitPaneLayout.css');
const SKELETON_CSS_PATH = resolve(HERE, '../components/Skeleton.css');

function buildFixtureCss(): string {
  const css = [
    resolveCssImports(INDEX_CSS_PATH),
    // Plain, import-free component stylesheets — read directly rather than
    // through resolveCssImports, matching resolveCssImports' own base case
    // (a file with nothing to inline).
    readFileSync(SPLIT_PANE_CSS_PATH, 'utf8'),
    readFileSync(SKELETON_CSS_PATH, 'utf8'),
  ].join('\n');
  assertNoImportsSurvive(css);
  return css;
}

function renderListMarkup(props: {
  loading: boolean;
  items: Array<{ id: string; name: string; subtitle?: string }>;
}): string {
  const { container, unmount } = render(
    <SplitPaneLayout
      label="skills"
      title="Skills"
      items={props.items}
      selectedId={null}
      loading={props.loading}
      onSelect={vi.fn()}
      onSearch={vi.fn()}
    >
      <div>detail pane</div>
    </SplitPaneLayout>,
  );
  const markup = container.querySelector('.split-pane__list')?.outerHTML ?? '';
  unmount();
  cleanup();
  return markup;
}

function buildFixtureHtml(markup: string, css: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${markup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'SplitPaneLayout skeleton row matches the real item row it stands in for (station#4463 slice 2, M1)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let css: string;

    beforeAll(async () => {
      browser = await chromium.launch();
      css = buildFixtureCss();
    });

    afterAll(async () => {
      await browser?.close();
    });

    beforeEach(() => {
      isMobileMock.mockReturnValue(false);
    });

    afterEach(() => {
      cleanup();
    });

    async function rowHeight(
      markup: string,
      selector: string,
    ): Promise<number> {
      const page = await browser.newPage({
        viewport: { width: 1024, height: 600 },
      });
      try {
        await page.setContent(buildFixtureHtml(markup, css));
        const box = await page.locator(selector).first().boundingBox();
        expect(box, `${selector} not visible`).not.toBe(null);
        return box!.height;
      } finally {
        await page.close();
      }
    }

    test('a loading skeleton row is within 2px of a real item row', async () => {
      const skeletonMarkup = renderListMarkup({ loading: true, items: [] });
      const realMarkup = renderListMarkup({
        loading: false,
        items: [{ id: 'a', name: 'Alpha', subtitle: 'A subtitle' }],
      });

      const skeletonRowHeight = await rowHeight(
        skeletonMarkup,
        '.skeleton-list__item',
      );
      const realRowHeight = await rowHeight(realMarkup, '.split-pane__item');

      expect(
        Math.abs(skeletonRowHeight - realRowHeight),
        `skeleton row ${skeletonRowHeight}px vs real row ${realRowHeight}px`,
      ).toBeLessThanOrEqual(2);
    });
  },
);

test.skipIf(chromiumAvailable)(
  'SplitPaneLayout skeleton row geometry — Chromium not installed, cannot verify (station#4463 slice 2, M1)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'skeleton row geometry fix (station#4463 slice 2, M1) could not be ' +
        'checked — this is a missing precondition, not a passing check. ' +
        'Install it with `npm run install:playwright` and re-run.',
    );
  },
);
