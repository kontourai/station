/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { act, render } from '@testing-library/react';
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
import { BannerHost } from '../components/notifications/BannerHost';
import { bannerStore } from '../contexts/banner-store';

/**
 * archive#4475 — the acceptance for this issue says to drive
 * every connections-flow control, WITH and WITHOUT an active banner. That
 * splits into two genuinely different properties, proven by two genuinely
 * different mechanisms, and this file is honest about covering only one:
 *
 *   1. "Does the control's onClick handler fire and do the right thing?"
 *      Already proven, exhaustively, by the pre-existing
 *      `ConnectionsSectionFrame.test.tsx` (jsdom + `fireEvent`) for every
 *      section's primary "Add" action (computers -> chooser, models/engines/
 *      tools -> `navigate(...)`) and is NOT re-proven here — jsdom cannot lay
 *      out CSS, so it cannot say anything about occlusion, and re-deriving
 *      the same handler-fired assertion in a heavier real-Chromium harness
 *      would not add evidence.
 *   2. "Is the control geometrically reachable — not painted over by an
 *      active banner sitting above it in the DOM?" THIS is what jsdom cannot
 *      prove and what this file adds: the real `ConnectionsSectionFrame`
 *      component (mocked the same way the existing jsdom test mocks it) is
 *      rendered into a real Chromium page at 390px, once with no banner and
 *      once with a live connection-blocking banner presented via the real
 *      `bannerStore`/`BannerHost`, and `document.elementFromPoint` at the
 *      "Add" button's and the first tab's own center is asserted to resolve
 *      back to that control in both cases.
 *
 * The "with banner" case deliberately does NOT rely on `BannerHost.tsx`'s
 * own space-reservation effect (`--banner-stack-height`) actually firing —
 * that effect reads real `getBoundingClientRect`s, which jsdom always
 * reports as zero, so it never writes a real value during the
 * `@testing-library/react` render this file extracts markup from. Instead
 * the banner is positioned WITHOUT any content-area inset (worst case: the
 * banner visually overlaps the page content beneath it, which is exactly
 * the pre-archive#3308 defect shape), so a pass here is the STRONGER claim that the
 * banner host's `pointer-events: none` transparency (BannerHost.css) keeps
 * page controls reachable even independent of the reservation timing, not
 * merely "reachable once reservation has pushed things out of the way."
 *
 * DRIVEN in this round: the "Add" action and the first section tab, for the
 * `computers` section, with and without an active banner, at 390px.
 * NOT driven (left open per the reviewer's instruction — see the coordinator
 * report): the other four sections' Add actions under a live banner (their
 * handler-fires property is already proven by the jsdom test; only the
 * hit-test axis is new here and this file samples one section rather than
 * all five), any modal's own internal controls (AddMachineModal,
 * ACPAddConnectionModal, etc.), and the Models/Engines/Tools detail panels.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const BANNER_CSS_PATH = resolve(
  HERE,
  '../components/notifications/BannerHost.css',
);
const PAGE_LAYOUT_CSS_PATH = resolve(HERE, '../views/page-layout.css');

function buildFixtureCss(): string {
  const css = [INDEX_CSS_PATH, BANNER_CSS_PATH, PAGE_LAYOUT_CSS_PATH]
    .map((path) => resolveCssImports(path))
    .join('\n');
  assertNoImportsSurvive(css);
  return css;
}

const navigate = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useConnectionsQuery: () => ({ data: [] }),
  useModelConnectionsQuery: () => ({ data: [] }),
  useAgentConnectionsQuery: () => ({ data: [] }),
  useIntegrationsQuery: () => ({ data: [] }),
  useGlobalKnowledgeStatusQuery: () => ({ data: undefined }),
  useSshEnvironmentsQuery: () => ({ data: [] }),
  sshEnvironmentsToKnownEnvironments: () => [],
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ connections: [] }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../components/page-frame', () => ({
  PageEyebrowTrail: ({
    segments,
  }: {
    segments: ReadonlyArray<{ label: string }>;
  }) => <span>{segments.map((s) => s.label).join(' / ')}</span>,
  PageFrameActions: ({ children }: { children: React.ReactNode }) => (
    <div className="page__actions">{children}</div>
  ),
  PageHeaderScope: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  usePageHeader: vi.fn(),
}));
vi.mock('../views/connections-hub/AddMachineModal', () => ({
  AddMachineModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="chooser" /> : null,
}));

import { ConnectionsSectionFrame } from '../views/ConnectionsSectionFrame';

function renderFixtureMarkup(input: { withBanner: boolean }): string {
  act(() => {
    bannerStore.reset();
    if (input.withBanner) {
      bannerStore.present({
        id: 'chrome:connection:offline',
        priority: 100,
        tone: 'blocked',
        badge: 'Credential required',
        message: "Tailnet Station isn't accepting this device's credential.",
        dismissible: false,
        actions: [{ label: 'Pair again', onClick: () => {} }],
      });
    }
  });
  const { container, unmount } = render(
    <div className="app__main">
      <BannerHost connectionSlot />
      <div className="main-content">
        <ConnectionsSectionFrame sectionId="computers">
          <div />
        </ConnectionsSectionFrame>
      </div>
    </div>,
  );
  const markup = container.innerHTML;
  unmount();
  act(() => bannerStore.reset());
  return markup;
}

function buildFixtureHtml(markup: string): string {
  const css = buildFixtureCss();
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${markup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'ConnectionsSectionFrame primary controls stay reachable under an active banner (station#4475)',
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

    test.each([
      ['without an active banner', false],
      ['with an active connection-blocking banner', true],
    ] as const)(
      'the Add action and the active tab hit-test to themselves at 390px — %s',
      async (_label, withBanner) => {
        const markup = renderFixtureMarkup({ withBanner });
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        try {
          await page.setContent(buildFixtureHtml(markup));

          if (withBanner) {
            expect(await page.locator('[role="alert"]').count()).toBe(1);
          } else {
            expect(await page.locator('[role="alert"]').count()).toBe(0);
          }

          for (const [name, locatorSelector, cssSelector] of [
            // The Playwright-only `:has-text` finds the control; a plain
            // CSS selector is what `Element.closest` inside the page can
            // actually parse for the hit-test.
            [
              'Add computer',
              'button:has-text("Add computer")',
              '.button.button--primary',
            ],
            [
              'Computers tab',
              '[role="tab"].page__tab--active',
              '[role="tab"].page__tab--active',
            ],
          ] as const) {
            const locator = page.locator(locatorSelector).first();
            const box = await locator.boundingBox();
            expect(box, `${name} not visible`).not.toBe(null);
            const cx = box!.x + box!.width / 2;
            const cy = box!.y + box!.height / 2;
            const resolvesToControl = await page.evaluate(
              ([cx, cy, cssSelector]) =>
                document
                  .elementFromPoint(cx as number, cy as number)
                  ?.closest(cssSelector as string) !== null,
              [cx, cy, cssSelector] as [number, number, string],
            );
            expect(resolvesToControl, `${name} not hittable`).toBe(true);
          }
        } finally {
          await page.close();
        }
      },
    );
  },
);

test.skipIf(chromiumAvailable)(
  'ConnectionsSectionFrame banner hit-test — Chromium not installed, cannot verify (station#4475)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'station#4475 hit-test check could not be checked — this is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
