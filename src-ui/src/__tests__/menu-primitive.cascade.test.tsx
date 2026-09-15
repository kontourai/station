/**
 * @vitest-environment jsdom
 *
 * #1552 D4 — ONE MENU PRIMITIVE, proved in a real engine.
 *
 * This shell had five independent menu vocabularies across the six surfaces that
 * predate it — plus the avatar's ProfileMenu, which #1552 D1 added onto the
 * shared spec, for seven measured here (the Boards row menu joined later; see
 * the #2113 note at the foot of this block): the dock's placement menu
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
 *
 * #2113 — THE COARSE BRANCH. The 32px row above is the FINE-pointer floor. The
 * family also declares a touch floor, `.menu-row.menu-row { min-height: 44px }`
 * inside `@media (max-width: 768px), (pointer: coarse)` in chat.css, and until
 * now nothing checked it for any member of the family: not a measurement, and
 * on this commit not even a text scan. This fixture ran one page with no
 * `hasTouch`, so every number it ever reported came from the fine arm. A
 * declaration is not a cascade for the coarse branch either.
 *
 * SHAPE — A SECOND CONTEXT, NOT A SECOND ROW AND NOT A SECOND FILE. The branch
 * is selected by a device capability, so only a differently-configured browser
 * context can reach it: `browser.newContext({ hasTouch: true })`. A media
 * override, a `matchMedia` stub or a scan of the CSS text would all report on
 * something other than what Chromium resolved, which is the whole point of
 * having a real engine here. It is not a new row in `MENUS` because the branch
 * is not another menu: the same surfaces are the ones a finger has to hit, so
 * the shape is one table measured twice rather than a longer table.
 *
 * The two contexts share ONE page markup (`fixtureHtml()` is built once, in
 * jsdom, and is byte-identical for both): the branch under test is a cascade
 * outcome, so re-rendering would vary the input this file exists to hold still.
 * Both contexts are 1456px wide, so `(max-width: 768px)` — the media rule's
 * OTHER arm, the one that would make a 44 mean "this is a phone" rather than
 * "this is a finger" — matches in NEITHER, and `pointer` is the only thing that
 * differs. `the two contexts differ in pointer and in nothing else` asserts
 * exactly that, so a 44 here cannot be attributed to width.
 *
 * The coarse expectations sit in their own `describe` beside the fine ones
 * rather than folded into them, because they are a different claim about the
 * same rows: a 32px floor with a laid-out box that clears it, versus a 44px
 * one. Reading the two blocks side by side is how a reviewer sees which floor
 * belongs to which device — folding them into one parameterized assertion would
 * hide that behind a variable. What the coarse block does NOT restate is the
 * rest of the spec:
 * `nothing but the row floor moves` compares the coarse measurement against the
 * fine one field by field, so the radius, inset, glyph slot, label x and absent
 * rules are proven unchanged under touch without a second copy of their numbers
 * — and the Layout picker, which declares no floor of its own, is covered by
 * that comparison rather than silently dropping out of the coarse block.
 *
 * #2113, SECOND HALF — THE BOARDS ROW MENU, an eighth member and the table's
 * last three rows. `ProjectSidebarBoards` adopted `.menu-surface`/`.menu-row`
 * in #2083 precisely so its rows would inherit the floors above instead of
 * growing a fourth page-local coarse block; until it is measured here, that
 * adoption is a declaration in a stylesheet and the 44 is a number a reviewer
 * once read off a screen. It joins as THREE entries rather than one because a
 * `MENUS` entry is a PANEL — `selector` resolves to the single element whose
 * computed style is the surface spec — and this menu has three surfaces
 * (actions, delete confirm, project picker), each its own `role="menu"`, each
 * mounted separately, and only ever one at a time.
 *
 * It is also the family's first member that reserves NO glyph slot, which is a
 * decision #2083 argued (a 240px rail, and none of the other seven is ever on
 * screen beside it) rather than an omission. `rowsReserveGlyphSlot: false`
 * carries that, and carries it as a claim: those rows are asserted to have no
 * slot and to agree with each other on the inset-only x, so the flag cannot
 * hide a row that regained the slot or a surface that drifted from its
 * siblings. Its membership list is pinned in the label-x test for the same
 * reason the touch-floor opt-out's is.
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
    main: {
      visible: true,
      size: 0,
      panes: ['home'],
      occupant: 'home' as string | null,
    },
    left: { visible: false, size: 400, panes: [], occupant: null },
    right: { visible: false, size: 400, panes: [], occupant: null },
    bottom: { visible: true, size: 320, panes: ['chat'], occupant: 'chat' },
  },
  /** Flipped per-menu: the overflow menu's region rows are the coarse branch. */
  bottomOnly: false,
  isMobile: false,
  /**
   * What `ProjectSidebarBoards` reads. One Board, because one row's menu is
   * all three surfaces below ever show (`mode` holds a single slug), and two
   * projects so the picker has more than one row to measure.
   */
  board: { slug: 'roadmap', name: 'Roadmap', icon: '▦' },
  projects: [
    { id: 'p1', slug: 'atlas', name: 'Atlas' },
    { id: 'p2', slug: 'beacon', name: 'Beacon' },
  ],
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
  // `ProjectSidebarBoards`'s four mutations and its list. Inert on purpose:
  // this file opens the menus and measures them, and none of the three
  // surfaces below performs its action — a mutation that changed the list
  // would change the markup the two contexts share.
  usePersonalLayoutsQuery: () => ({ data: [harness.board] }),
  useCreatePersonalLayoutMutation: () => ({
    isPending: false,
    mutate: () => {},
  }),
  useUpdatePersonalLayoutMutation: () => ({ mutate: () => {} }),
  useDeletePersonalLayoutMutation: () => ({ mutate: () => {} }),
  usePromotePersonalLayoutMutation: () => ({ mutate: () => {} }),
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: harness.projects, isLoading: false }),
}));

vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({ setLayout: () => {} });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

import { ChatDockHeaderMoreMenu } from '../components/chat-dock/ChatDockHeaderMoreMenu';
import { DockPlacementControl } from '../components/chat-dock/DockPlacementControl';
import { HelpMenu } from '../components/header/HelpMenu';
import { LayoutSwitcher } from '../components/header/LayoutSwitcher';
import { OverflowMenu } from '../components/header/OverflowMenu';
import { ProfileMenu } from '../components/header/ProfileMenu';
import { RegionToolbarControls } from '../components/header/RegionToolbarControls';
import { ProjectSidebarBoards } from '../components/project-sidebar/ProjectSidebarBoards';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const CHAT_CSS_PATH = resolve(HERE, '../components/chat/chat.css');
/**
 * The Boards menu's own sheet, composed in beside the two above because it
 * OVERRIDES a measured property: `.sidebar__board-menu .menu-row` adds
 * `padding-block: var(--space-2)` so a wrapped project name is not flush to
 * the row's edges. Leaving it out would measure a row this app never renders.
 * Nothing in it reaches the other seven menus — every selector is
 * `.sidebar__board-*` or `.sidebar--collapsed`.
 */
const BOARDS_CSS_PATH = resolve(
  HERE,
  '../components/project-sidebar/ProjectSidebarBoards.css',
);

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
  /**
   * Whether the rows carry the family's 16px glyph slot, and with it the
   * shared 36px label x. False for the Boards row menu's three surfaces,
   * which deliberately omit it (#2083): the slot exists so menus a reader
   * compares in sequence start their labels on one x, and that menu opens
   * inside a 240px rail where none of the other seven is ever on screen
   * beside it, so reserving 24px of it would align with nothing. The flag is
   * not a skip — a menu that sets it is asserted to carry NO slot, so
   * adding one here reds just as loudly as losing one elsewhere.
   */
  rowsReserveGlyphSlot?: boolean;
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
    name: 'the avatar’s profile menu',
    selector: '.app-toolbar__profile-menu',
    open: () => {
      // The fine pointer, where this menu exists at all: on a phone the avatar
      // that opens it is hidden and the panel closes itself (see ProfileMenu).
      harness.bottomOnly = false;
      harness.isMobile = false;
      render(
        <ProfileMenu
          isOpen
          isProfileActive={false}
          isSettingsActive={false}
          settingsShortcut="⌘,"
          userInitials="ST"
          onClose={() => {}}
          onOpenProfile={() => {}}
          onOpenHelp={() => {}}
          onToggleSettings={() => {}}
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
  ...boardMenuEntries(),
];

/**
 * The Boards row menu's three surfaces (#2113, second half), reached through
 * the REAL `ProjectSidebarBoards` — its `⋯` trigger clicked, then the command
 * that opens the surface. Nothing here hand-authors a row: the `.menu-row`
 * elements measured are the ones `BoardRowMenu` renders, which is the only
 * way this file can say anything about what the cascade does to them.
 *
 * ALL THREE, not one. They are three separate `role="menu"` surfaces, each
 * mounted by its own `BoardRowMenu` call with its own `useMenuFocus` ref, and
 * only ONE of them can be on screen at a time — `mode` holds a single slug —
 * so a page carrying one carries no evidence about the other two. #2083's
 * review measured all three at 44.00px by hand and that hand measurement is
 * exactly what this replaces. They are three `MENUS` rows rather than one
 * because an entry is a PANEL: `selector` resolves to a single element whose
 * own computed style is the surface spec, and the confirm and the picker each
 * have a surface of their own to prove.
 *
 * What differs between them is worth having measured rather than assumed. The
 * confirm and the picker both open with a `.sidebar__board-confirm` paragraph
 * ABOVE their rows — a non-row child of `.menu-surface`, which no other member
 * of the family has — and the picker's rows carry arbitrary project names
 * rather than fixed command labels, which is the case
 * `.sidebar__board-menu .menu-row`'s `padding-block` was added for.
 */
function boardMenuEntries(): {
  name: string;
  selector: string;
  rowsReserveGlyphSlot?: boolean;
  open: () => void;
}[] {
  const board = harness.board.name;
  // Each surface renders its own copy of the section, because reaching the
  // picker means leaving the actions menu. The combined page therefore holds
  // three Boards fragments, told apart by the `aria-label` each menu already
  // announces to a screen reader.
  const openBoardMenu = (...commands: string[]) => {
    harness.bottomOnly = false;
    harness.isMobile = false;
    render(
      <ProjectSidebarBoards
        collapsed={false}
        isMobile={false}
        navigate={() => {}}
        activePath="/"
      />,
    );
    // The row's `⋯`. Its accessible name is the same string the actions menu
    // wears, which is why the selectors below are class-scoped.
    fireEvent.click(screen.getByLabelText(`${board} actions`));
    for (const command of commands) {
      fireEvent.click(screen.getByRole('menuitem', { name: command }));
    }
  };
  return [
    {
      name: 'the Boards row’s actions menu',
      selector: `.sidebar__board-menu[aria-label="${board} actions"]`,
      rowsReserveGlyphSlot: false,
      open: () => openBoardMenu(),
    },
    {
      name: 'the Boards row’s delete confirm',
      selector: `.sidebar__board-menu[aria-label="Delete ${board}"]`,
      rowsReserveGlyphSlot: false,
      open: () => openBoardMenu('Delete'),
    },
    {
      name: 'the Boards row’s project picker',
      selector: `.sidebar__board-menu[aria-label="Move ${board} to a project"]`,
      rowsReserveGlyphSlot: false,
      open: () => openBoardMenu('Move to project…'),
    },
  ];
}

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
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(CHAT_CSS_PATH)}\n${resolveCssImports(BOARDS_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">${fragments.join('\n')}</body>
</html>`;
}

type MeasuredRow = {
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
};

type MeasuredMenu = {
  name: string;
  surface: { radius: number; padding: number; rowGap: number };
  rows: MeasuredRow[];
};

type Measurement = {
  /** What Chromium itself answered, not what the context requested. */
  pointerIsCoarse: boolean;
  /**
   * The other arm of `@media (max-width: 768px), (pointer: coarse)`. False in
   * both contexts, so a coarse floor is attributable to the pointer alone.
   */
  viewportIsNarrow: boolean;
  menus: MeasuredMenu[];
};

/**
 * One page in one browser context, measured. `hasTouch` is the only input that
 * differs between the two calls — same browser, same viewport, same markup.
 */
async function measure(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  html: string,
  hasTouch: boolean,
): Promise<Measurement> {
  const context = await browser.newContext({
    viewport: { width: 1456, height: 900 },
    hasTouch,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(
      (
        menus: {
          name: string;
          selector: string;
          rowSelector?: string;
        }[],
      ) => {
        const px = (value: string) =>
          Math.round(Number.parseFloat(value || '0'));
        return {
          pointerIsCoarse: window.matchMedia('(pointer: coarse)').matches,
          viewportIsNarrow: window.matchMedia('(max-width: 768px)').matches,
          menus: menus.map((menu) => {
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
          }),
        };
      },
      MENUS.map((menu) => ({
        name: menu.name,
        selector: menu.selector,
        rowSelector: menu.rowSelector,
      })),
    );
  } finally {
    await page.close();
    await context.close();
  }
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'every menu in the shell resolves to one spec (#1552 D4)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let fine: Measurement;
    let coarse: Measurement;

    beforeAll(async () => {
      browser = await chromium.launch();
      // Built ONCE and handed to both contexts: the markup is the control, the
      // pointer is the variable.
      const html = fixtureHtml();
      fine = await measure(browser, html, false);
      coarse = await measure(browser, html, true);
    });

    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => {
      cleanup();
      document.body.innerHTML = '';
    });

    test('all ten menus render, and every one of them has rows to measure', () => {
      // The precondition. A selector that stopped matching would otherwise take
      // its menu silently out of every assertion below.
      expect(fine.menus.map((menu) => menu.name)).toEqual(
        MENUS.map((menu) => menu.name),
      );
      for (const menu of fine.menus) {
        expect(
          menu.rows.length,
          `${menu.name} rendered no rows`,
        ).toBeGreaterThan(1);
      }
    });

    test('one surface spec: 8px radius, 6px padding, a 4px group gap', () => {
      for (const menu of fine.menus) {
        expect(menu.surface, menu.name).toEqual({
          radius: 8,
          padding: 6,
          rowGap: 4,
        });
      }
    });

    test('one row spec: a 32px floor, a 12px inset, and a 16px glyph slot on every row', () => {
      for (const [index, menu] of fine.menus.entries()) {
        const declaresFloor = MENUS[index]?.rowsDeclareFloor !== false;
        const reservesSlot = MENUS[index]?.rowsReserveGlyphSlot !== false;
        for (const row of menu.rows) {
          const where = `"${row.text}" in ${menu.name}`;
          if (declaresFloor) {
            expect(row.minHeight, `${where} row height floor`).toBe(32);
          }
          expect(row.height, `${where} laid-out height`).toBeGreaterThanOrEqual(
            32,
          );
          expect(row.paddingLeft, `${where} label inset`).toBe(12);
          if (reservesSlot) {
            // Reserved whether or not the row has a glyph — that is what makes
            // the labels line up in a menu that mixes the two.
            expect(row.hasGlyphSlot, `${where} must reserve a glyph slot`).toBe(
              true,
            );
            expect(row.slotWidth, `${where} glyph slot`).toBe(16);
          } else {
            // The opt-out asserted rather than skipped. A Boards row that
            // grew a slot would start its label 24px further in than the
            // paragraph above it and than every other row in its own menu,
            // which is a misalignment inside the surface rather than across
            // the family — so it reds here instead of going unmeasured.
            expect(
              row.hasGlyphSlot,
              `${where} must reserve no glyph slot`,
            ).toBe(false);
            expect(row.slotWidth, `${where} glyph slot`).toBe(-1);
          }
        }
      }
    });

    test('every label in every menu starts at the same x inside its row', () => {
      // The one lever that takes a menu out of the shared x, pinned for the
      // same reason the touch-floor opt-out is: dropping a menu out of the
      // family's alignment has to be an argued edit rather than a quiet one.
      // Its members are the Boards row menu's three surfaces, which reserve no
      // glyph slot (#2083) and land on their own x below.
      expect(
        MENUS.filter((menu) => menu.rowsReserveGlyphSlot === false).map(
          (menu) => menu.name,
        ),
      ).toEqual([
        'the Boards row’s actions menu',
        'the Boards row’s delete confirm',
        'the Boards row’s project picker',
      ]);

      const offsets = new Map<number, string[]>();
      const slotless = new Map<number, string[]>();
      for (const [index, menu] of fine.menus.entries()) {
        const bucket =
          MENUS[index]?.rowsReserveGlyphSlot === false ? slotless : offsets;
        for (const row of menu.rows) {
          // -1 means the row carries no direct label text node. No row does
          // today; if one appears, this must red rather than be skipped, because
          // an unmeasurable row is not an aligned one.
          expect(
            row.labelOffset,
            `"${row.text}" in ${menu.name} has no measurable label`,
          ).toBeGreaterThan(0);
          const seen = bucket.get(row.labelOffset) ?? [];
          seen.push(`${menu.name}: "${row.text}"`);
          bucket.set(row.labelOffset, seen);
        }
      }
      expect(
        [...offsets.keys()],
        `labels start at more than one x:\n${[...offsets]
          .map(([offset, rows]) => `  ${offset}px — ${rows.join('; ')}`)
          .join('\n')}`,
      ).toHaveLength(1);
      // 12px inset + 16px slot + 8px gap. Asserted as a number as well as an
      // agreement, so a change that moves all seven together still gets read.
      expect([...offsets.keys()][0]).toBe(36);

      // The slot-less surfaces are measured, not excused: they agree with each
      // other on one x too, and that x is the inset ALONE — which is the whole
      // content of "this menu omits the slot". A Boards surface that drifted
      // from its siblings, or that quietly regained the 24px, reds here.
      expect(
        [...slotless.keys()],
        `slot-less labels start at more than one x:\n${[...slotless]
          .map(([offset, rows]) => `  ${offset}px — ${rows.join('; ')}`)
          .join('\n')}`,
      ).toHaveLength(1);
      expect([...slotless.keys()][0]).toBe(12);
    });

    test('no row anywhere carries a rule — a group is named, never fenced', () => {
      for (const menu of fine.menus) {
        for (const row of menu.rows) {
          const where = `"${row.text}" in ${menu.name}`;
          expect(row.borderTop, `${where} top rule`).toBe(0);
          expect(row.borderBottom, `${where} bottom rule`).toBe(0);
        }
      }
    });

    describe('and under a coarse pointer, to its touch floor (#2113)', () => {
      test('the two contexts differ in pointer, and in nothing else that selects the branch', () => {
        // The precondition for everything below. If `hasTouch` stopped
        // flipping Chromium's primary pointer type, the "coarse" measurement
        // would silently be a second reading of the fine branch — so this
        // reads what the ENGINE resolved, not what the context requested.
        expect(fine.pointerIsCoarse, 'the fine context').toBe(false);
        expect(coarse.pointerIsCoarse, 'the coarse context').toBe(true);
        // `@media (max-width: 768px), (pointer: coarse)` has two arms. Both
        // contexts are 1456px wide, so the width arm matches in neither and a
        // 44 below is attributable to the pointer alone.
        expect(fine.viewportIsNarrow, 'the fine context').toBe(false);
        expect(coarse.viewportIsNarrow, 'the coarse context').toBe(false);
      });

      test('every command row rises from the 32px floor to a 44px one', () => {
        // `rowsDeclareFloor: false` is the one lever that drops a menu out of
        // this assertion without the precondition test above noticing, so the
        // opt-out list is pinned: removing a menu from the touch floor has to
        // be an argued edit rather than a quiet one.
        //
        // Its single member is the Layout picker, whose rows are `radiogroup`s
        // rather than commands (#1552 D2) and declare no floor in either
        // branch — and which does NOT clear 44 under touch. Measured by this
        // fixture when this block was written: its rows lay out at 38px over
        // 24px segments, identically in BOTH contexts, because neither
        // `.region-placement__row` nor `.region-placement__segment` is reached
        // by a coarse rule. That is reported as a finding on #2113 rather than
        // fixed or asserted here; this file makes no claim that the picker
        // clears a finger.
        expect(
          MENUS.filter((menu) => menu.rowsDeclareFloor === false).map(
            (menu) => menu.name,
          ),
        ).toEqual(['the header’s Layout picker']);

        for (const [index, menu] of coarse.menus.entries()) {
          if (MENUS[index]?.rowsDeclareFloor === false) continue;
          for (const row of menu.rows) {
            const where = `"${row.text}" in ${menu.name}`;
            expect(row.minHeight, `${where} coarse row floor`).toBe(44);
            // Not implied by the declaration above: this is the bounding box a
            // finger actually lands on, and a `transform` on the row or any
            // ancestor shrinks it while `min-height` goes on computing 44.
            // Proven by injection — `transform: scale(0.5)` on `.menu-row`
            // reds this line at 22px with the floor assertion still green.
            expect(
              row.height,
              `${where} coarse laid-out height`,
            ).toBeGreaterThanOrEqual(44);
          }
        }
      });

      test('nothing but the row floor moves: the rest of the spec is the same under touch', () => {
        // The counterpart to the assertion above, and what keeps the Layout
        // picker in the coarse block rather than dropping out of it: every
        // other measured property — radius, padding, group gap, inset, glyph
        // slot, label x, absent rules — is compared against the fine
        // measurement it already proved correct, so a touch context that
        // disturbed one of them reds HERE without a second copy of its
        // numbers. `minHeight` and `height` are the two that are meant to
        // differ, and are dropped by key so a property added to
        // `MeasuredRow` later is compared by default rather than forgotten.
        const withoutHeights = (menu: MeasuredMenu) =>
          JSON.parse(
            JSON.stringify(menu, (key, value) =>
              key === 'minHeight' || key === 'height' ? undefined : value,
            ),
          );
        expect(coarse.menus.map(withoutHeights)).toEqual(
          fine.menus.map(withoutHeights),
        );
      });
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
