/**
 * @vitest-environment jsdom
 *
 * D3: the Layout menu is grouped per region, and the shared
 * `.app-toolbar__overflow-menu button + button` hairline rules EVERY row — right
 * for the header's flat ⋯ menu, wrong here, where it makes the group boundary
 * (the one division that carries meaning) look exactly like the six that do not.
 *
 * The guard is a measurement rather than a scan of the stylesheet because the
 * first attempt at this fix was a single-class selector that TIED on specificity
 * with the flat rule ~90 lines below it, so source order won and the hairlines
 * stayed — while a text scan for `border-top: 0` read green. A declaration is
 * not a cascade (archive#3341's lesson, in a second place), and only a real
 * engine resolves one.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const harness = vi.hoisted(() => ({
  regions: {
    main: { visible: true, size: 0, occupant: 'home' as string | null },
    left: { visible: false, size: 400, occupant: null },
    right: { visible: false, size: 400, occupant: null },
    bottom: { visible: true, size: 320, occupant: 'chat' },
  },
}));

vi.mock('../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/RegionModelContext')>();
  const { REGION_SURFACE_REGISTRY } = await import('../regions/region-model');
  const model = {
    regions: harness.regions,
    surfaces: REGION_SURFACE_REGISTRY,
    setRegion: vi.fn(),
    placeSurface: vi.fn(),
    showSurface: vi.fn(),
  };
  return {
    ...actual,
    useRegionModelOptional: () => model,
    useRegionModel: () => model,
  };
});

vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  useDockSlotDevice: () => ({ viewportWidth: 1456, coarsePointer: false }),
  availablePlacements: () => ['left', 'right', 'bottom'],
}));

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
}));

import { RegionToolbarControls } from '../components/header/RegionToolbarControls';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const CHAT_CSS_PATH = resolve(HERE, '../components/chat/chat.css');

/** The real open menu, portalled to the body, in its real document order. */
function bodyMarkupWithOpenMenu(): string {
  render(<RegionToolbarControls />);
  fireEvent.click(screen.getByRole('button', { name: 'Layout regions' }));
  screen.getByRole('menu', { name: 'Layout regions' });
  return document.body.innerHTML;
}

function fixtureHtml(bodyMarkup: string): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(CHAT_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">${bodyMarkup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'the Layout menu rules its groups, not its rows (#1536 F, D3)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => {
      cleanup();
      document.body.innerHTML = '';
    });

    test('no row inside a group carries a top border, and each group after the first does', async () => {
      const markup = bodyMarkupWithOpenMenu();
      const page = await browser.newPage({
        viewport: { width: 1456, height: 900 },
      });
      try {
        await page.setContent(fixtureHtml(markup));
        const measured = await page.evaluate(() => {
          const groups = [
            ...document.querySelectorAll('.app-toolbar__region-menu-group'),
          ];
          const width = (element: Element) =>
            Math.round(
              Number.parseFloat(
                getComputedStyle(element).borderTopWidth || '0',
              ),
            );
          return {
            groups: groups.map((group, index) => ({
              legend: group.querySelector('legend')?.textContent ?? '',
              border: width(group),
              first: index === 0,
              rowBorders: [...group.querySelectorAll('button')].map((row) => ({
                label: row.textContent ?? '',
                border: width(row),
              })),
            })),
            // The flat menu's own rule must still be in force — this is a
            // scoped override, not a global removal — so a row of the header's
            // ⋯ menu would still be ruled. Proven by the selector still
            // matching here at all: `.app-toolbar__region-menu` sets the
            // exception, and removing it restores the hairline (see the
            // injection recorded in the delivery notes).
            flatRuleExists: [...document.styleSheets].some((sheet) =>
              [...sheet.cssRules].some(
                (rule) =>
                  rule instanceof CSSStyleRule &&
                  rule.selectorText ===
                    '.app-toolbar__overflow-menu button + button',
              ),
            ),
          };
        });

        // The default arrangement builds four groups with two multi-row ones,
        // so the "inside a group" case is genuinely exercised.
        expect(measured.groups.map((group) => group.legend)).toEqual([
          'Main',
          'Left',
          'Right',
          'Bottom',
        ]);
        expect(
          measured.groups.filter((group) => group.rowBorders.length > 1).length,
        ).toBeGreaterThan(1);

        for (const group of measured.groups) {
          for (const row of group.rowBorders) {
            expect(
              row.border,
              `"${row.label}" in ${group.legend} must not be ruled off from the row above it`,
            ).toBe(0);
          }
          // One divider per group instead: every group but the first.
          expect(group.border, `${group.legend}'s own divider`).toBe(
            group.first ? 0 : 1,
          );
        }
        expect(measured.flatRuleExists).toBe(true);
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'Layout menu dividers — Chromium not installed, cannot verify (#1536 F)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the Layout ' +
        'menu’s resolved row/group borders could not be measured — this is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
