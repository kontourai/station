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

import { PageFrame } from '../components/page-frame';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { SPLIT_PANE_MIN_WIDTH } from '../components/split-pane-metrics';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const CSS_PATHS = [
  resolve(HERE, '../index.css'),
  resolve(HERE, '../components/SplitPaneLayout.css'),
  // The shared touch-target block (loaded app-wide through the header) owns
  // the search field's coarse floor, for split panes and modals alike.
  resolve(HERE, '../components/chat/chat.css'),
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
    // Two narrow adjacent clusters, the RunBoardSummary shape the review
    // found stealing each other's edge taps.
    renderSummary: () => (
      <>
        {chip('summary')}
        {chip('c2')}
      </>
    ),
  };
  const { container, unmount } = render(
    <SplitPaneLayout
      label="fixture"
      title="Fixture"
      items={[
        { id: 'root', name: 'Root task', group, trailing: chip('root-pill') },
        { id: 'child', name: 'Child task', group },
        {
          id: 'solo',
          name: 'Solo',
          // A narrow no-confirm control beside a wider one, next to the row
          // button's right edge: the Discard draft + Evidence shape.
          trailing: (
            <>
              {chip('x')}
              {/* Wider than the slot's 38% cap leaves beside 'x', so a
                  wrapping slot would stack the two in one row. */}
              {chip('solo-pill-with-a-long-label')}
            </>
          ),
        },
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
  // Framed, the collapse control shares the filter row with the search input;
  // Agents' rail at a 1024px tablet is 255px wide.
  const framed = render(
    <PageFrame spec={{ title: 'Agents' }} routeIdentity="agents">
      <SplitPaneLayout
        label="agents"
        title="Agents"
        items={[{ id: 'a', name: 'Alpha' }]}
        selectedId={null}
        onSelect={() => {}}
        onSearch={() => {}}
      >
        <div>detail</div>
      </SplitPaneLayout>
    </PageFrame>,
  );
  const framedLeft = framed.container.querySelector('.split-pane__left');
  if (
    !framedLeft?.querySelector('.split-pane__filter-row .split-pane__collapse')
  )
    throw new Error('the framed rail did not put collapse in the filter row');
  const framedRail = framedLeft.outerHTML;
  framed.unmount();
  // The narrowest rail with two trailing controls (a draft row's Discard
  // beside a row menu): both must fit without scrolling the list sideways.
  const minimal = render(
    <SplitPaneLayout
      label="min"
      title="Min"
      items={[
        {
          id: 'draft',
          name: 'A draft row with a long title',
          trailing: (
            <>
              {chip('min-a')}
              {chip('min-b')}
            </>
          ),
        },
      ]}
      selectedId={null}
      onSelect={() => {}}
      onSearch={() => {}}
    >
      <div>detail</div>
    </SplitPaneLayout>,
  );
  // The pane carries its persisted width inline (default 280px); a reader
  // who dragged it to the minimum has exactly this inline width.
  const minimalLeft =
    minimal.container.querySelector<HTMLElement>('.split-pane__left');
  if (!minimalLeft) throw new Error('the minimal rail did not render');
  minimalLeft.style.width = `${SPLIT_PANE_MIN_WIDTH}px`;
  const minimalRail = minimalLeft.outerHTML;
  minimal.unmount();
  const css = CSS_PATHS.map((path) => resolveCssImports(path)).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html data-theme="light">
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div class="split-pane" style="display:flex;width:1000px;height:700px">
      <div style="width:320px;display:flex">${rail}</div>
    </div>
    <div class="split-pane" id="narrow" style="display:flex;width:1000px;height:300px">
      <div style="width:255px;display:flex">${framedRail}</div>
    </div>
    <div class="split-pane" id="min" style="display:flex;width:1000px;height:300px">
      <div style="width:${SPLIT_PANE_MIN_WIDTH}px;display:flex">${minimalRail}</div>
    </div>
    <!-- #3102: the provider picker modal borrows the field outside a split pane. -->
    <div class="provider-picker-modal" id="picker" style="width:420px">
      <input class="list-filter-input provider-picker-modal__search" placeholder="Search providers" />
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
        viewport: { width: 1000, height: 1400 },
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
          /**
           * Taps 1, 3 and 8px inside each visible edge of each control (and
           * of the row button beside them) must land on that control and not
           * on a neighbour's enlarged hit area.
           */
          const edgeThieves: string[] = [];
          const probes = [
            ...document.querySelectorAll<HTMLElement>('[data-probe]'),
            ...document.querySelectorAll<HTMLElement>(
              '.split-pane__item-row .split-pane__item',
            ),
          ];
          for (const element of probes) {
            const r = element.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            for (const inset of [1, 3, 8]) {
              if (inset * 2 >= Math.min(r.width, r.height)) continue;
              for (const [x, y, edge] of [
                [r.left + inset, cy, 'left'],
                [r.right - inset, cy, 'right'],
                [cx, r.top + inset, 'top'],
                [cx, r.bottom - inset, 'bottom'],
              ] as const) {
                const hit = document.elementFromPoint(x, y);
                if (!hit || !(hit === element || element.contains(hit))) {
                  const name =
                    element.dataset.probe ?? element.textContent?.trim() ?? '?';
                  const thief =
                    (hit as HTMLElement | null)?.closest<HTMLElement>(
                      '[data-probe]',
                    )?.dataset.probe ?? hit?.className;
                  edgeThieves.push(`${name} ${edge}-${inset}px -> ${thief}`);
                }
              }
            }
          }
          const collapse = box('.split-pane__collapse');
          const narrowCollapse = box('#narrow .split-pane__collapse');
          const toggle = box('.split-pane__group-toggle');
          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            edgeThieves,
            narrowestControl: Math.min(
              ...[
                ...document.querySelectorAll<HTMLElement>('[data-probe]'),
              ].map((element) => element.getBoundingClientRect().width),
            ),
            stackedTrailing: [
              ...document.querySelectorAll<HTMLElement>(
                '.split-pane__item-trailing',
              ),
            ].some((slot) => {
              const tops = [...slot.children].map((child) =>
                Math.round(child.getBoundingClientRect().top),
              );
              return new Set(tops).size > 1;
            }),
            collapse: { width: collapse.width, height: collapse.height },
            minListOverflow: (() => {
              const list = document.querySelector<HTMLElement>(
                '#min .split-pane__list',
              );
              if (!list) throw new Error('the minimal rail did not render');
              return list.scrollWidth - list.clientWidth;
            })(),
            // The slot itself must hold both controls: a nowrap slot that is
            // too narrow overflows toward the row (justify-content: flex-end)
            // rather than scrolling the list.
            minSlotOverflow: (() => {
              const slot = document.querySelector<HTMLElement>(
                '#min .split-pane__item-trailing',
              );
              if (!slot) throw new Error('the minimal slot did not render');
              const controls = [...slot.children].map((child) =>
                child.getBoundingClientRect(),
              );
              const box = slot.getBoundingClientRect();
              return Math.max(
                box.left - Math.min(...controls.map((r) => r.left)),
                Math.max(...controls.map((r) => r.right)) - box.right,
              );
            })(),
            narrowCollapse: {
              width: narrowCollapse.width,
              height: narrowCollapse.height,
            },
            toggleHeight: toggle.height,
            searchHeight: box('.list-filter-input').height,
            narrowSearchHeight: box('#narrow .list-filter-input').height,
            pickerSearchHeight: box('#picker .list-filter-input').height,
            rowHeight: box('.split-pane__item').height,
            trailing: hitsAbove(
              '[data-probe="solo-pill-with-a-long-label"]',
              21,
            ),
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
      // A 255px framed rail: the search input must not squeeze it.
      expect(result.narrowCollapse.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(result.narrowCollapse.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(result.toggleHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(result.rowHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      // #3061: the search box measured 40px on a phone.
      expect(result.searchHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(result.narrowSearchHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(result.pickerSearchHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
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

    test.each([true, false])(
      'coarse=%s: every visible edge of a control, and of the row beside it, takes its own tap',
      async (coarse) => {
        const result = await measure(coarse);
        expect(result.coarse).toBe(coarse);
        expect(result.edgeThieves).toEqual([]);
        // Two trailing controls at the minimum rail width do not scroll the
        // list sideways.
        expect(result.minListOverflow).toBeLessThanOrEqual(0);
        expect(result.minSlotOverflow).toBeLessThanOrEqual(0.5);
        if (coarse) {
          // Width is real, not borrowed from a neighbour; and no slot stacks
          // two controls into one 44px row.
          expect(result.narrowestControl).toBeGreaterThanOrEqual(TOUCH_TARGET);
          expect(result.stackedTrailing).toBe(false);
        }
      },
    );

    test('fine: desktop density is unchanged', async () => {
      const result = await measure(false);
      expect(result.coarse).toBe(false);
      expect(result.collapse.height).toBe(24);
      expect(result.rowHeight).toBeLessThan(TOUCH_TARGET);
      expect(result.searchHeight).toBeLessThan(TOUCH_TARGET);
      expect(result.pickerSearchHeight).toBeLessThan(TOUCH_TARGET);
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
