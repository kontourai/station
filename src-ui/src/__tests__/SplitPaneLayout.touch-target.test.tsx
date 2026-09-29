/**
 * @vitest-environment jsdom
 *
 * On a coarse pointer every control the split-pane list offers has a 44px hit
 * area; on a fine pointer the drawn density is unchanged.
 *
 * Measured before this change in the running Activity list: trailing
 * controls 20px tall, the "Hide list pane" collapse control 24px, the group
 * toggle ~18px — on every device, because only the narrow-viewport branch
 * sized anything, and only rows.
 *
 * Hit testing is layout, which jsdom does not do. Following
 * `SplitPaneLayout.railName.overflow.test.tsx`, the real `SplitPaneLayout`
 * markup goes into a real Chromium page with the cascade-resolved app CSS.
 * The coarse context is Chromium's own touch emulation (`hasTouch` +
 * `isMobile`), which is what flips `(pointer: coarse)`; the page asserts that
 * media query matches before measuring, so an emulation change cannot turn
 * this into a fine-pointer run that passes by measuring nothing.
 *
 * A HIT area is proven with `elementFromPoint`, not a computed style: a point
 * 21px above a 20px-tall control's centre (outside its drawn box) must land on
 * that control.
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
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: '(max-width: 768px)',
}));

import { SplitPaneLayout } from '../components/SplitPaneLayout';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const CSS_PATHS = [
  resolve(HERE, '../index.css'),
  resolve(HERE, '../components/SplitPaneLayout.css'),
];
const TOUCH_TARGET = 44;

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

/** A chip-sized control, the size Activity's trailing pill was measured at. */
const chip = (label: string) => (
  <button
    type="button"
    data-probe={label}
    style={{ height: 20, padding: '0 6px', fontSize: 11, lineHeight: '18px' }}
  >
    {label}
  </button>
);

function fixtureHtml(): string {
  const group = {
    id: 'run',
    label: 'Run · 1 delegated session',
    renderSummary: () => chip('summary'),
  };
  const { container, unmount } = render(
    <SplitPaneLayout
      label="fixture"
      title="Fixture"
      items={[
        { id: 'root', name: 'Root task', group, trailing: chip('root-pill') },
        { id: 'child', name: 'Child task', group },
        { id: 'solo', name: 'Solo', trailing: chip('solo-pill') },
        { id: 'after', name: 'After' },
      ]}
      selectedId={null}
      onSelect={() => {}}
      onSearch={() => {}}
    >
      <div>detail</div>
    </SplitPaneLayout>,
  );
  const left = container.querySelector('.split-pane__left');
  if (!left) throw new Error('the rail did not render');
  const rail = left.outerHTML;
  unmount();
  const css = CSS_PATHS.map((path) => resolveCssImports(path)).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html data-theme="light">
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div class="split-pane" style="display:flex;width:1000px;height:700px">
      <div style="width:320px;display:flex">${rail}</div>
    </div>
  </body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'split-pane list controls meet 44px on a coarse pointer only',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let html: string;

    beforeAll(async () => {
      browser = await chromium.launch();
      html = fixtureHtml();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    async function measure(coarse: boolean) {
      const context = await browser.newContext({
        // Wider than the 768px narrow-viewport branch: the case the old CSS
        // left at desktop density (a tablet in landscape).
        viewport: { width: 1000, height: 700 },
        hasTouch: coarse,
        isMobile: coarse,
      });
      const page = await context.newPage();
      try {
        await page.setContent(html);
        return await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector<HTMLElement>(selector);
            if (!element) throw new Error(`${selector} did not render`);
            return element.getBoundingClientRect();
          };
          /** Does a tap just outside the drawn box still reach the control? */
          const hitsAbove = (selector: string, offset: number) => {
            const element = document.querySelector<HTMLElement>(selector);
            if (!element) throw new Error(`${selector} did not render`);
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2 - offset,
            );
            return {
              drawnHeight: rect.height,
              reached: Boolean(
                hit && (hit === element || element.contains(hit)),
              ),
            };
          };
          const collapse = box('.split-pane__collapse');
          const toggle = box('.split-pane__group-toggle');
          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            collapse: { width: collapse.width, height: collapse.height },
            toggleHeight: toggle.height,
            rowHeight: box('.split-pane__item').height,
            trailing: hitsAbove('[data-probe="solo-pill"]', 21),
            groupTrailing: hitsAbove('[data-probe="root-pill"]', 21),
            summary: hitsAbove('[data-probe="summary"]', 21),
          };
        });
      } finally {
        await context.close();
      }
    }

    test('coarse: collapse, group toggle and rows are 44px boxes', async () => {
      const result = await measure(true);
      expect(result.coarse).toBe(true);
      expect(result.collapse.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(result.collapse.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(result.toggleHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(result.rowHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    });

    test('coarse: a 20px trailing or summary control is reachable 21px from its centre', async () => {
      const result = await measure(true);
      expect(result.coarse).toBe(true);
      for (const probe of [
        result.trailing,
        result.groupTrailing,
        result.summary,
      ]) {
        // The drawn control stays chip-sized; only its hit area grows.
        expect(probe.drawnHeight).toBeLessThan(TOUCH_TARGET / 2);
        expect(probe.reached).toBe(true);
      }
    });

    test('fine: desktop density is unchanged', async () => {
      const result = await measure(false);
      expect(result.coarse).toBe(false);
      expect(result.collapse.height).toBe(24);
      expect(result.rowHeight).toBeLessThan(TOUCH_TARGET);
      expect(result.trailing.reached).toBe(false);
    });
  },
);

test.skipIf(chromiumAvailable)(
  'SplitPaneLayout coarse-pointer touch targets — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so this could ' +
        'not be measured — a missing precondition, not a passing check. ' +
        'Install it with `npm run install:playwright` and re-run.',
    );
  },
);
