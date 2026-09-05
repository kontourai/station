/**
 * @vitest-environment jsdom
 *
 * #1552 D4 — ONE MENU PRIMITIVE, proved in a real engine.
 *
 * This shell had five independent menu vocabularies across the six surfaces this
 * file measures: the dock's placement menu
 * and its More menu (6px radius, 2px padding, 32px rows, no label inset), the
 * header's `⋯` overflow menu (8px radius, no padding, 44px rows, a hairline
 * between EVERY row), the region Layout menu (that surface again, plus ruled
 * `fieldset` groups), the breadcrumb's layout switcher (a 6px radius over
 * `6px 10px` rows with an accent-tinted active row), and the header's help menu,
 * which had no class at all — every rule of it was an inline style, including its own
 * per-row `borderBottom` and a pair of mouse handlers assigning
 * `style.background` because there was no selector to hang `:hover` on.
 *
 * The claim is that all of them now resolve to the SAME spec: 8px radius, 6px
 * padding, a 32px row floor, a 12px label inset over a 16px glyph slot, and no
 * per-row rule. Every one of those is a cascade outcome, not a declaration —
 * this file's predecessor (`RegionLayoutMenu.dividers.test.tsx`) exists because
 * a single-class fix for the hairline TIED on specificity with the flat rule
 * ninety lines below it, so source order won: the declaration read correct, a
 * text scan for it read green, and the hairlines were still drawn. A declaration
 * is not a cascade (archive#3341), and only a real engine resolves one.
 *
 * THE LABEL OFFSET is measured with a `Range` over each row's own label text
 * rather than by re-reading the three declarations that produce it (padding +
 * slot + gap). Those three agreeing is not the same claim as the labels landing
 * on one x — a row that forgot its glyph slot satisfies all three and still
 * starts its label 24px to the left, which is precisely the misalignment D4 set
 * out to remove.
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
  /** Flipped per-menu: the overflow menu's region rows are the coarse branch. */
  bottomOnly: false,
  isMobile: false,
}));

vi.mock('../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/RegionModelContext')>();
  const { REGION_SURFACE_REGISTRY } = await import('../regions/region-model');
  const model = {
    regions: harness.regions,
    lastShownRegion: null,
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
  useIsMobile: () => harness.isMobile,
  useDockSlotDevice: () => ({
    viewportWidth: harness.bottomOnly ? 390 : 1456,
    coarsePointer: harness.bottomOnly,
  }),
  availablePlacements: () =>
    harness.bottomOnly ? ['bottom'] : ['left', 'right', 'bottom'],
}));

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
  useShortcutDisplay: () => '⌘D',
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isDesktop: false }),
}));

vi.mock('@kontourai/station-connect', () => ({
  ConnectionStatusDot: () => <span data-dot="1" />,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useProjectLayoutsQuery: () => ({
    data: [
      { slug: 'coding', name: 'Coding', icon: '⌘' },
      { slug: 'review', name: 'Review', icon: '✓' },
    ],
    refetch: () => {},
  }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ setLayout: () => {} }),
}));

import { ChatDockHeaderMoreMenu } from '../components/chat-dock/ChatDockHeaderMoreMenu';
import { DockPlacementControl } from '../components/chat-dock/DockPlacementControl';
import { HelpMenu } from '../components/header/HelpMenu';
import { LayoutSwitcher } from '../components/header/LayoutSwitcher';
import { OverflowMenu } from '../components/header/OverflowMenu';
import { RegionToolbarControls } from '../components/header/RegionToolbarControls';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const CHAT_CSS_PATH = resolve(HERE, '../components/chat/chat.css');

/**
 * Each entry renders one real menu, opens it the way a user does, and hands back
 * the body markup with the portalled panel in it. `selector` is how the fixture
 * finds that panel in the combined page.
 */
const MENUS: readonly {
  name: string;
  selector: string;
  /**
   * The row elements to measure. `.menu-row` everywhere except the Layout
   * picker, whose rows are `radiogroup`s holding a segmented control rather than
   * commands — a different pattern, deliberately (#1552 D2), so it does not wear
   * the command-row class. What it DOES share is the part this file is about: the
   * surface spec, the 12px inset, the 16px glyph slot, and the label x.
   */
  rowSelector?: string;
  /**
   * Whether the rows declare the family's own 32px `min-height`. False for the
   * picker: its height comes from the segmented control inside it (which is
   * measured against the same 32px floor as a laid-out box below), so a declared
   * floor would be a second, redundant opinion about the same number.
   */
  rowsDeclareFloor?: boolean;
  open: () => void;
}[] = [
  {
    name: 'the header’s Layout picker',
    selector: '.app-toolbar__region-menu',
    rowSelector: '.region-placement__row',
    rowsDeclareFloor: false,
    open: () => {
      harness.bottomOnly = false;
      harness.isMobile = false;
      render(<RegionToolbarControls />);
      fireEvent.click(screen.getByRole('button', { name: 'Layout regions' }));
    },
  },
  {
    name: 'the header’s ⋯ overflow menu',
    selector: '.app-toolbar__overflow-menu:not(.app-toolbar__region-menu)',
    open: () => {
      // The coarse branch, so the region rows render inside it too — that
      // `fieldset` is the group whose leading hairline D4 replaced with a gap.
      harness.bottomOnly = true;
      harness.isMobile = true;
      render(
        <OverflowMenu
          isOpen
          connStatus="connected"
          userInitials="ST"
          onClose={() => {}}
          onOpenConnections={() => {}}
          onOpenHelp={() => {}}
          onOpenProfile={() => {}}
        />,
      );
    },
  },
  {
    name: 'the header’s help menu',
    selector: '.app-toolbar__help-menu',
    open: () => {
      render(
        <HelpMenu
          isOpen
          prompts={[
            { label: 'What can I do here?', prompt: 'help' },
            { label: 'Explain this page', prompt: 'explain' },
          ]}
          onClose={() => {}}
          onSelectPrompt={() => {}}
        />,
      );
    },
  },
  {
    name: 'the dock header’s More menu',
    selector: '.chat-dock__more-menu',
    open: () => {
      render(
        <ChatDockHeaderMoreMenu
          actions={[
            { key: 'a', label: 'Chat settings', onSelect: () => {} },
            { key: 'b', label: 'Copy thread ID', onSelect: () => {} },
          ]}
        />,
      );
      fireEvent.click(screen.getByLabelText('More dock actions'));
    },
  },
  {
    name: 'the breadcrumb’s layout switcher',
    selector: '.layout-switcher__menu',
    open: () => {
      render(<LayoutSwitcher projectSlug="demo" layoutSlug="coding" />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch layout' }));
    },
  },
  {
    name: 'the dock’s placement menu',
    selector: '.dock-placement-menu:not(.chat-dock__more-menu)',
    open: () => {
      render(
        <div className="chat-dock__header">
          <DockPlacementControl
            availablePlacements={['left', 'bottom', 'right']}
            effectivePlacement="bottom"
            onPlacementChange={() => {}}
          />
        </div>,
      );
      fireEvent.click(screen.getByLabelText('Move the dock'));
    },
  },
];

/** One combined page carrying every menu, so one cascade resolves them all. */
function fixtureHtml(): string {
  const fragments: string[] = [];
  for (const menu of MENUS) {
    document.body.innerHTML = '';
    menu.open();
    fragments.push(document.body.innerHTML);
    cleanup();
  }
  document.body.innerHTML = '';
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(CHAT_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">${fragments.join('\n')}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'every menu in the shell resolves to one spec (#1552 D4)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let measured: {
      name: string;
      surface: { radius: number; padding: number; rowGap: number };
      rows: {
        text: string;
        minHeight: number;
        rowLeft: number;
        height: number;
        paddingLeft: number;
        labelOffset: number;
        borderTop: number;
        borderBottom: number;
        hasGlyphSlot: boolean;
        slotWidth: number;
      }[];
    }[];

    beforeAll(async () => {
      browser = await chromium.launch();
      const page = await browser.newPage({
        viewport: { width: 1456, height: 900 },
      });
      try {
        await page.setContent(fixtureHtml());
        measured = await page.evaluate(
          (
            menus: {
              name: string;
              selector: string;
              rowSelector?: string;
            }[],
          ) => {
            const px = (value: string) =>
              Math.round(Number.parseFloat(value || '0'));
            return menus.map((menu) => {
              const panel = document.querySelector(menu.selector);
              if (!panel) throw new Error(`no panel for ${menu.name}`);
              const panelStyle = getComputedStyle(panel);
              // Every row of the family, wherever it sits — including inside a
              // `.menu-group`, which is where the retired group hairlines were.
              const rows = [
                ...panel.querySelectorAll(menu.rowSelector ?? '.menu-row'),
              ];
              return {
                name: menu.name,
                surface: {
                  radius: px(panelStyle.borderTopLeftRadius),
                  padding: px(panelStyle.paddingTop),
                  rowGap: px(panelStyle.rowGap),
                },
                rows: rows.map((row) => {
                  const style = getComputedStyle(row);
                  const rowRect = row.getBoundingClientRect();
                  const slot = row.querySelector(
                    '.menu-row__glyph, .region-placement__glyph',
                  );
                  // The label's own left edge, from a Range over the text node
                  // that carries it — the thing a reader's eye lines up on.
                  // The row's own label: its direct text node, or — for the
                  // picker, whose label is wrapped so the segments can sit
                  // opposite it — the text node beside the glyph slot.
                  const labelHost =
                    row.querySelector('.region-placement__surface') ?? row;
                  const label = [...labelHost.childNodes].find(
                    (node) =>
                      node.nodeType === Node.TEXT_NODE &&
                      (node.textContent ?? '').trim().length > 0,
                  );
                  const range = document.createRange();
                  if (label) range.selectNodeContents(label);
                  return {
                    text: (row.textContent ?? '').trim().slice(0, 40),
                    minHeight: px(style.minHeight),
                    rowLeft: Math.round(rowRect.left),
                    height: Math.round(rowRect.height),
                    paddingLeft: px(style.paddingLeft),
                    labelOffset: label
                      ? Math.round(
                          range.getBoundingClientRect().left - rowRect.left,
                        )
                      : -1,
                    borderTop: px(style.borderTopWidth),
                    borderBottom: px(style.borderBottomWidth),
                    hasGlyphSlot: slot !== null,
                    slotWidth: slot
                      ? Math.round(slot.getBoundingClientRect().width)
                      : -1,
                  };
                }),
              };
            });
          },
          MENUS.map((menu) => ({
            name: menu.name,
            selector: menu.selector,
            rowSelector: menu.rowSelector,
          })),
        );
      } finally {
        await page.close();
      }
    });

    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => {
      cleanup();
      document.body.innerHTML = '';
    });

    test('all six menus render, and every one of them has rows to measure', () => {
      // The precondition. A selector that stopped matching would otherwise take
      // its menu silently out of every assertion below.
      expect(measured.map((menu) => menu.name)).toEqual(
        MENUS.map((menu) => menu.name),
      );
      for (const menu of measured) {
        expect(
          menu.rows.length,
          `${menu.name} rendered no rows`,
        ).toBeGreaterThan(1);
      }
    });

    test('one surface spec: 8px radius, 6px padding, a 4px group gap', () => {
      for (const menu of measured) {
        expect(menu.surface, menu.name).toEqual({
          radius: 8,
          padding: 6,
          rowGap: 4,
        });
      }
    });

    test('one row spec: a 32px floor, a 12px inset, and a 16px glyph slot on every row', () => {
      for (const [index, menu] of measured.entries()) {
        const declaresFloor = MENUS[index]?.rowsDeclareFloor !== false;
        for (const row of menu.rows) {
          const where = `"${row.text}" in ${menu.name}`;
          if (declaresFloor) {
            expect(row.minHeight, `${where} row height floor`).toBe(32);
          }
          expect(row.height, `${where} laid-out height`).toBeGreaterThanOrEqual(
            32,
          );
          expect(row.paddingLeft, `${where} label inset`).toBe(12);
          // Reserved whether or not the row has a glyph — that is what makes the
          // labels line up in a menu that mixes the two.
          expect(row.hasGlyphSlot, `${where} must reserve a glyph slot`).toBe(
            true,
          );
          expect(row.slotWidth, `${where} glyph slot`).toBe(16);
        }
      }
    });

    test('every label in every menu starts at the same x inside its row', () => {
      const offsets = new Map<number, string[]>();
      for (const menu of measured) {
        for (const row of menu.rows) {
          // -1 means the row carries no direct label text node. No row does
          // today; if one appears, this must red rather than be skipped, because
          // an unmeasurable row is not an aligned one.
          expect(
            row.labelOffset,
            `"${row.text}" in ${menu.name} has no measurable label`,
          ).toBeGreaterThan(0);
          const seen = offsets.get(row.labelOffset) ?? [];
          seen.push(`${menu.name}: "${row.text}"`);
          offsets.set(row.labelOffset, seen);
        }
      }
      expect(
        [...offsets.keys()],
        `labels start at more than one x:\n${[...offsets]
          .map(([offset, rows]) => `  ${offset}px — ${rows.join('; ')}`)
          .join('\n')}`,
      ).toHaveLength(1);
      // 12px inset + 16px slot + 8px gap. Asserted as a number as well as an
      // agreement, so a change that moves all six together still gets read.
      expect([...offsets.keys()][0]).toBe(36);
    });

    test('no row anywhere carries a rule — a group is named, never fenced', () => {
      for (const menu of measured) {
        for (const row of menu.rows) {
          const where = `"${row.text}" in ${menu.name}`;
          expect(row.borderTop, `${where} top rule`).toBe(0);
          expect(row.borderBottom, `${where} bottom rule`).toBe(0);
        }
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'menu primitive — Chromium not installed, cannot verify (#1552 D4)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the shared ' +
        'menu geometry could not be measured — this is a missing precondition, ' +
        'not a passing check. Install it with `npm run install:playwright` and ' +
        're-run.',
    );
  },
);
