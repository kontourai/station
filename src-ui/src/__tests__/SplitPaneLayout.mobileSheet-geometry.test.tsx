/**
 * @vitest-environment jsdom
 *
 * A framed mobile detail sheet is portaled out of the route and fixed to the
 * viewport, between the app toolbar and the chat dock. Its Back control and
 * its last row must both be reachable: the sheet stops above the dock instead
 * of scrolling its end underneath it, starts below the toolbar, and nothing
 * sticky inside it covers Back once the sheet scrolls.
 *
 * jsdom lays out nothing, so this renders the real framed `SplitPaneLayout`,
 * puts the portaled sheet's markup into Chromium with the cascade-resolved
 * stylesheets, stands a toolbar and a dock over it as fixed blocks sized by
 * the same tokens the shell sets, and hit-tests.
 *
 * WHAT THIS FIXTURE DOES NOT REPRODUCE: the shell's positioned and
 * transformed ancestors. With none present, `position: absolute` resolves
 * against the viewport exactly as `fixed` does, so this cannot tell the two
 * apart; the portal tests in SplitPaneLayout.test.tsx own where the sheet
 * mounts.
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

vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({ navigate: vi.fn() });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => true,
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

import { PageFrame } from '../components/page-frame';
import { SplitPaneLayout } from '../components/SplitPaneLayout';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const CSS_PATHS = [
  resolve(HERE, '../index.css'),
  resolve(HERE, '../components/SplitPaneLayout.css'),
  resolve(HERE, '../components/page-frame/page-frame.css'),
  resolve(HERE, '../components/DetailHeader.css'),
];

const TOOLBAR_HEIGHT = 46;
const DOCK_HEIGHT = 120;
const VIEWPORT = { width: 390, height: 700 };

function sheetMarkup(): string {
  const { container, unmount } = render(
    <PageFrame spec={{ title: 'Models' }} routeIdentity="models-ollama">
      <SplitPaneLayout
        label="models"
        title="Models"
        items={[{ id: 'ollama', name: 'Ollama' }]}
        selectedId="ollama"
        onSelect={() => {}}
        onDeselect={() => {}}
        onSearch={() => {}}
      >
        <div className="detail-header">Ollama</div>
        {Array.from({ length: 30 }, (_, index) => (
          <p key={index} style={{ margin: 0, padding: '12px 16px' }}>
            Detail row {index + 1}
          </p>
        ))}
        <button type="button" data-testid="last-row">
          Last row
        </button>
      </SplitPaneLayout>
    </PageFrame>,
  );
  const slot = container.querySelector('.page-frame__mobile-detail-slot');
  if (!slot?.querySelector('.split-pane__right--portaled')) {
    throw new Error('the framed mobile sheet did not portal');
  }
  const html = slot.outerHTML;
  unmount();
  return html;
}

function fixtureHtml(sheet: string): string {
  const css = CSS_PATHS.map((path) => resolveCssImports(path)).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html style="--app-toolbar-total-height:${TOOLBAR_HEIGHT}px;--dock-slot-size:${DOCK_HEIGHT}px">
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div id="toolbar" style="position:fixed;top:0;left:0;right:0;height:${TOOLBAR_HEIGHT}px;z-index:1000;background:#333"></div>
    ${sheet}
    <div id="dock" style="position:fixed;bottom:0;left:0;right:0;height:${DOCK_HEIGHT}px;z-index:1000;background:#333"></div>
  </body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'the framed mobile detail sheet clears the toolbar and the dock',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    test('Back and the last row are hit-testable once the sheet scrolls to its end', async () => {
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.setContent(fixtureHtml(sheetMarkup()));
        const hits = await page.evaluate(() => {
          const sheet = document.querySelector('.split-pane__right--portaled');
          if (!sheet) throw new Error('the sheet is missing');
          sheet.scrollTop = sheet.scrollHeight;
          const hitsItself = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`${selector} is missing`);
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              (box.left + box.right) / 2,
              (box.top + box.bottom) / 2,
            );
            return Boolean(hit && element.contains(hit));
          };
          return {
            scrolled: sheet.scrollTop > 0,
            back: hitsItself('.split-pane__back'),
            lastRow: hitsItself('[data-testid="last-row"]'),
          };
        });
        // Precondition: the content overflows, so "the end" is a real scroll.
        expect(hits.scrolled).toBe(true);
        expect(hits).toEqual({ scrolled: true, back: true, lastRow: true });
      } finally {
        await page.close();
      }
    }, 120_000);
  },
);

test.skipIf(chromiumAvailable)(
  'mobile detail sheet clearance — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the mobile ' +
        'detail sheet could not be hit-tested. This is a missing precondition, ' +
        'not a passing check. Install it with `npm run install:playwright` ' +
        'and re-run.',
    );
  },
);
