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
} from '../../../../../tests/helpers/css-cascade-fixture';

/**
 * station#4474 review round (H1) — this is the test the acceptance actually
 * asked for: measure content displacement across the `isFetching` flip in
 * the `error && !data` state, at a real, cascade-resolved 390px viewport,
 * and assert ZERO.
 *
 * Before this round, `error && !data` alternated between a ~114px
 * `SkeletonList` (isFetching) and a ~13px static line (not fetching) on
 * `useActionOperationsQuery`'s 5s `refetchInterval` — indefinitely, since a
 * persistent error never stops retrying. That is a NEW oscillation this
 * branch introduced while fixing audit F5 (the SkeletonList swap itself was
 * correct for genuine initial load; the mistake was extending it to the
 * background-retry-while-erroring case too). The fix collapses both arms of
 * "error, no data" onto the same static markup regardless of `isFetching`,
 * so there is nothing left to alternate between.
 *
 * jsdom does not lay out CSS (same precondition as the sibling geometry
 * tests — BannerHost.disclosure-overlap.test.tsx,
 * HeaderActions.connection-reflow.test.tsx), so this renders the real
 * `ActionOperationsSection` component through `@testing-library/react` for
 * both `isFetching` values, injects each markup ABOVE a fixed marker element
 * (standing in for "everything below" — the session list this pane sits
 * above as `listIntro`, per `SessionsView.tsx`) into a real Chromium page
 * carrying the real, cascade-resolved `index.css` + `Skeleton.css` +
 * `ActionOperationsSection.css`, and measures the marker's actual rendered
 * y-offset.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const SKELETON_CSS_PATH = resolve(HERE, '../../Skeleton.css');
const SECTION_CSS_PATH = resolve(HERE, '../ActionOperationsSection.css');

function buildFixtureCss(): string {
  const css = [INDEX_CSS_PATH, SKELETON_CSS_PATH, SECTION_CSS_PATH]
    .map((path) => resolveCssImports(path))
    .join('\n');
  assertNoImportsSurvive(css);
  return css;
}

const mutate = vi.fn();
const useActionOperationsQuery = vi.hoisted(() => vi.fn());
const useCancelActionOperationMutation = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk/action-operations', () => ({
  useActionOperationsQuery,
  useCancelActionOperationMutation,
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { ActionOperationsSection } from '../ActionOperationsSection';

function renderMarkupForIsFetching(isFetching: boolean): string {
  useActionOperationsQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isFetching,
    error: new Error('network'),
  });
  useCancelActionOperationMutation.mockReturnValue({
    mutate,
    isPending: false,
    error: null,
  });
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: true,
  });
  const { container, unmount } = render(<ActionOperationsSection />);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function buildFixtureHtml(markup: string): string {
  const css = buildFixtureCss();
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css}</style>
  </head>
  <body style="margin:0">
    <div id="probe">${markup}</div>
    <div data-testid="below-marker" style="height:20px">Session list would start here</div>
  </body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'ActionOperationsSection does not reflow content across the isFetching flip while erroring (station#4474 H1)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    test('the marker below the pane holds its y-offset whether or not a background retry is in flight', async () => {
      const fetchingMarkup = renderMarkupForIsFetching(true);
      const idleMarkup = renderMarkupForIsFetching(false);

      async function markerY(markup: string): Promise<number> {
        const page = await browser.newPage({
          viewport: { width: 390, height: 400 },
        });
        try {
          await page.setContent(buildFixtureHtml(markup));
          const box = await page
            .locator('[data-testid="below-marker"]')
            .boundingBox();
          expect(box, 'below-marker not visible').not.toBe(null);
          return box!.y;
        } finally {
          await page.close();
        }
      }

      const fetchingY = await markerY(fetchingMarkup);
      const idleY = await markerY(idleMarkup);

      expect(
        { fetchingY, idleY },
        'the marker below ActionOperationsSection moved between isFetching states — the error branch must render identical markup regardless of isFetching.',
      ).toEqual({ fetchingY: idleY, idleY });
    });
  },
);

test.skipIf(chromiumAvailable)(
  'ActionOperationsSection reflow — Chromium not installed, cannot verify (station#4474 H1)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'Activity-pane reflow fix (station#4474 H1) could not be checked — ' +
        'this is a missing precondition, not a passing check. Install it ' +
        'with `npm run install:playwright` and re-run.',
    );
  },
);
