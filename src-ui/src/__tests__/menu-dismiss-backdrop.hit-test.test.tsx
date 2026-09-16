/**
 * @vitest-environment jsdom
 *
 * #2112 — THE DISMISS-BACKDROP INVARIANT FOUR MENUS DEPEND ON.
 *
 * #2081 fixed the two `useMenuFocus` consumers whose trigger stays reachable
 * while their menu is open. Five others were ruled out — `OverflowMenu`,
 * `ProfileMenu`, `HelpMenu`, `RegionToolbarControls` and
 * `ChatDockHeaderMoreMenu` — on the grounds that each renders a full-viewport
 * dismiss backdrop that OUTRANKS the chrome its own trigger sits in, so a press
 * at the trigger's location lands on the backdrop and closes the menu, which is
 * what the user wants. Nothing enforced that.
 *
 * The invariant is arithmetic spread across two files and several rules: the
 * backdrops sit at `calc(var(--layer-navigation) - 1)` = 9349 while
 * `.app-toolbar` is `--layer-sticky` (100) on mobile and carries no `z-index`
 * at all otherwise, and neither `.app` nor `.app__main` opens a stacking
 * context above them. `index.css` states it in prose. Raise the toolbar past
 * 9349, drop a backdrop, or give an ancestor of the toolbar a stacking context
 * that OUTRANKS 9349, and four consumers silently reacquire #2081's defect.
 * `RegionToolbarControls` now opens TWO panels, and both are measured: the
 * folded device's flat Regions menu, which is what is left of the
 * `ToolbarMenuSurface` backdrop the original ruling was about, and — since
 * #2155 — #2154's chooser, which every per-region toggle opens on a hold or a
 * right-click. A reachable trigger under the chooser would take the user's
 * dismissing press as a show/hide of the very region the panel is about.
 *
 * "Outranks" is load-bearing in that sentence, and #2112's own wording ("give
 * an ancestor of the toolbar a stacking context") is looser than the mechanism.
 * MEASURED: `.app__main { position: relative; z-index: 1 }` creates a stacking
 * context and this file stays green, correctly — a LOW-z context CLAMPS the
 * whole toolbar further below the backdrop, which makes the invariant more
 * true, not less. The same rule at `z-index: 9400` reds all seven shapes. An
 * injection is only a verdict once it reaches the case.
 *
 * WHY THIS IS A BROWSER TEST AND NOT A SCAN. jsdom computes no layout, no paint
 * order and no hit testing: `document.elementFromPoint` there is not a weak
 * signal, it is no signal, and a jsdom test calling it would pass identically
 * over every regression named above. A source or computed-style scan is no
 * better — it can read `9349` off a declaration while an ANCESTOR lifts the
 * whole toolbar above the backdrop, which is one of the three regressions, and
 * the repo has already been burned by a declaration that read correct and lost
 * the cascade (`menu-primitive.cascade.test.tsx`). So this composes the real
 * shell chrome, the real menus and the real stylesheets into a real Chromium
 * page and asks the only question that answers it: what does a press at these
 * coordinates actually land on.
 *
 * WHAT THE FIXTURE COMPOSES. The REAL `Header` (so the toolbar's controls are
 * its own, in their own order, at their own widths) inside the real
 * `.app > .app__main` chain `App.tsx` renders it in, beside a maximized bottom
 * dock carrying the REAL `ChatDockHeaderMoreMenu` — the "maximized region, dock
 * open" arrangement #2112 asks for, and the one where the dock's own
 * `--layer-dock` competes. The menus portal to `document.body` exactly as they
 * do live, and serializing `document.body` after opening one preserves both the
 * subtree and the document order, which is half of what decides paint order
 * between equal layers.
 *
 * GEOMETRY IS MEASURED, NOT GUESSED. Two of these menus position themselves
 * from their trigger's `getBoundingClientRect()` and `window.innerWidth`
 * (`RegionToolbarControls`' `anchorRight`, `ChatDockHeaderMoreMenu`'s
 * `position`), and in jsdom both read zero — which would drop those panels
 * somewhere no product state puts them, potentially ON TOP of the very controls
 * this file probes, turning a backdrop hit into a menu hit and reporting a
 * false red. So every shape runs TWICE: once with the menu closed to measure
 * the real laid-out trigger rect and viewport in Chromium, then again with
 * those measurements fed back into jsdom before the menu is opened. The panels
 * then land where the product puts them, and `menuCoversProbe` below fails
 * loudly if one still covers a probe rather than quietly proving nothing.
 *
 * PRECONDITION: launches a real Chromium. Per this repo's browser-test
 * doctrine, a missing browser FAILS loudly rather than skipping.
 *
 * RESOURCE CLASSIFICATION: listed in `scripts/vitest-resource-manifest.mjs`'s
 * `PROCESS_HEAVY_VITEST_FILES`, same shape as `menu-primitive.cascade.test.tsx`
 * and `ChatDockHeaderMoreMenu.layering.test.tsx`.
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

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1456, height: 900 };

/** Flipped per shape before each render; every mock below reads it. */
const harness = vi.hoisted(() => ({ isMobile: false, bottomOnly: false }));

vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => harness.isMobile,
  useDockSlotDevice: () => ({
    viewportWidth: harness.bottomOnly ? PHONE.width : DESKTOP.width,
    coarsePointer: harness.isMobile,
  }),
  availablePlacements: () =>
    harness.bottomOnly ? ['bottom'] : ['left', 'right', 'bottom'],
}));

vi.mock('../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/RegionModelContext')>();
  const { REGION_SURFACE_REGISTRY } = await import('../regions/region-model');
  const model = {
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
    lastShownRegion: null,
    surfaces: REGION_SURFACE_REGISTRY,
    setRegion: vi.fn(),
    placeSurface: vi.fn(),
    showSurface: vi.fn(),
    toggleSurface: vi.fn(),
  };
  return {
    ...actual,
    useRegionModelOptional: () => model,
    useRegionModel: () => model,
  };
});

// The chooser a region toggle opens carries the dock's project read
// (`RegionChooserPanel` → `useDockProject`). No project here: the rows that
// need one list disabled with the reason, which changes none of the geometry
// this file measures.
vi.mock('../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({ chatDockProjectSlug: null }),
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProject: () => ({ project: undefined, isLoading: false }),
}));

vi.mock('../hooks/useActiveProject', () => ({
  useActiveProject: () => ({ projectSlug: null }),
}));

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
  useShortcutDisplay: () => '⌘,',
}));

vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    isDesktop: false,
    supervisesBundledServer: false,
    productName: 'Station',
  }),
}));

vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionStatusDot: () => <span className="fixture-status-dot" />,
  useConnectionStatus: () => ({
    status: 'connected',
    reason: null,
    recheck: () => {},
  }),
  useConnections: () => ({
    activeConnection: {
      id: 'c1',
      name: 'Default',
      lastSuccessAt: '2026-09-01T00:00:00.000Z',
      endpoints: [],
    },
    connections: [
      {
        id: 'c1',
        name: 'Default',
        lastSuccessAt: '2026-09-01T00:00:00.000Z',
        endpoints: [],
      },
    ],
  }),
  usePendingPairingApproval: () => null,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({ data: { items: [], pendingCount: 0 } }),
}));

/**
 * The header's own view model is replaced wholesale: it reaches auth,
 * navigation, chat launching and the engine-connections query, none of which
 * decides a pixel. What this file needs from it is the four `show*` flags, and
 * driving them directly is what lets a shape mount exactly one menu open.
 */
const viewModel = vi.hoisted(() => ({
  showHelp: false,
  showNotifications: false,
  showOverflow: false,
  showProfileMenu: false,
}));

vi.mock('../components/header/useHeaderViewModel', () => ({
  useHeaderViewModel: () => ({
    breadcrumb: null,
    closeHelp: () => {},
    closeNotifications: () => {},
    closeOverflow: () => {},
    closeProfileMenu: () => {},
    goHome: () => {},
    handleHelpPrompt: () => {},
    helpPrompts: [
      { label: 'What can I do here?', prompt: 'help' },
      { label: 'Explain this page', prompt: 'explain' },
    ],
    openConnectionModal: () => {},
    openProfile: () => {},
    openHelp: () => {},
    settingsShortcut: '⌘,',
    showHelp: viewModel.showHelp,
    showNotifications: viewModel.showNotifications,
    showOverflow: viewModel.showOverflow,
    showProfileMenu: viewModel.showProfileMenu,
    toggleNotifications: () => {},
    toggleOverflow: () => {},
    toggleProfileMenu: () => {},
    userInitials: 'ST',
  }),
}));

import { ChatDockHeaderMoreMenu } from '../components/chat-dock/ChatDockHeaderMoreMenu';
import { Header } from '../components/header/Header';
import type { DockShellChrome } from '../hooks/useDockShellChrome';
import { RegionChromeBar } from '../workspace-panes/RegionChromeBar';

/** The chrome a bar needs to render its strip: open, fine pointer, bottom. */
function tabMoveChrome(): DockShellChrome {
  const noop = () => {};
  return {
    isDockOpen: true,
    isDockMaximized: true,
    dockMode: 'bottom',
    dockHeight: 320,
    dockWidth: 400,
    setDockHeight: noop,
    setDockWidth: noop,
    previousDockHeight: 320,
    setPreviousDockHeight: noop,
    previousDockOpen: true,
    setPreviousDockOpen: noop,
    isDragging: false,
    setIsDragging: noop,
    dockSnap: 'full',
    liveDragHeight: null,
    setLiveDragHeight: noop,
    isCollapsedDragPreview: false,
    toolbarHeight: 46,
    collapsedHeight: 38,
    isMobile: false,
    visualViewport: { style: {}, height: 800, offsetTop: 0 } as never,
    availableDockSlotPlacements: ['left', 'bottom', 'right'],
    effectiveDockSlotPlacement: 'bottom',
    surfaceShortcutId: 'dock.toggle',
    surfaceTitle: 'Activity',
    canMaximize: true,
    regionPanes: [],
    selectRegionPane: noop,
    ownsMaximizeShortcut: true,
    applyDockSnap: noop,
    setRegionOpen: noop,
    commitDesktopBottomHeight: noop,
    commitDockPlacement: noop,
    restoreDockToDocked: noop,
    onSidePanelResizePointerDown: noop,
    onMobileHeaderDragPointerDown: noop,
    onMobileHeaderDragClickCapture: noop,
    activeProjectSlug: null,
    setActiveProjectSlug: noop,
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const CHAT_CSS_PATH = resolve(HERE, '../components/chat/chat.css');
const HEADER_MENU_CSS_PATH = resolve(
  HERE,
  '../components/header/HeaderMenu.css',
);
// #2155: the panel a region toggle opens is #2154's chooser, whose own frame
// and anchoring live here. Without it the panel has no `position: fixed` and
// lands in normal flow, where it covers nothing and proves nothing.
const REGION_CHOOSER_CSS_PATH = resolve(
  HERE,
  '../workspace-panes/RegionEmptyChooser.css',
);

type MenuId =
  | 'overflow'
  | 'profile'
  | 'help'
  | 'region'
  | 'folded-regions'
  | 'dock-more'
  | 'tab-move'
  | 'bar-move';

interface Shape {
  /** Reads as the test name, so keep it a sentence. */
  readonly name: string;
  readonly menu: MenuId;
  readonly viewport: { width: number; height: number };
  /**
   * Which chrome this shape's toolbar draws. `tablet` is a COARSE pointer
   * wide enough to escape the mobile media query (#917): `availablePlacements`
   * folds it to one dock, so the toolbar renders the folded "Regions" menu —
   * the surviving `ToolbarMenuSurface` consumer since #2155 moved the
   * per-region control's panel to the chooser, and a menu this file must
   * still measure (review M6).
   */
  readonly device: 'phone' | 'desktop' | 'tablet';
  /** The backdrop this menu renders, by accessible name. */
  readonly backdropLabel: string;
  /**
   * The control that OPENS this menu, by accessible name, where the chrome has
   * one. `null` where it genuinely does not: `HelpMenu` is opened from a row
   * inside the profile or overflow menu, and that menu closes before this one
   * opens, so there is no trigger left on screen to cover. Its backdrop still
   * has to outrank the toolbar — a press on any toolbar control must dismiss
   * it rather than activate that control — which is what the probe sweep
   * asserts for every shape.
   */
  readonly openerLabel: string | null;
}

const SHAPES: readonly Shape[] = [
  {
    name: 'the header’s ⋯ overflow menu on a phone, where its trigger exists',
    menu: 'overflow',
    viewport: PHONE,
    device: 'phone',
    backdropLabel: 'Close more actions menu',
    // `.app-toolbar__overflow-btn` is `display: none` until the mobile
    // breakpoint (chat.css), so this menu only has a trigger to cover here.
    openerLabel: 'More actions',
  },
  {
    name: 'the avatar’s profile menu on a desktop, where its trigger exists',
    menu: 'profile',
    viewport: DESKTOP,
    device: 'desktop',
    backdropLabel: 'Close profile menu',
    // The mirror of the overflow button: `.app-toolbar__action--secondary` is
    // hidden at the mobile breakpoint, so the avatar is a fine-pointer control.
    openerLabel: 'Profile and settings',
  },
  {
    name: 'the header’s help menu on a phone',
    menu: 'help',
    viewport: PHONE,
    device: 'phone',
    backdropLabel: 'Close help menu',
    openerLabel: null,
  },
  {
    name: 'the header’s help menu on a desktop',
    menu: 'help',
    viewport: DESKTOP,
    device: 'desktop',
    backdropLabel: 'Close help menu',
    openerLabel: null,
  },
  {
    name: 'the region toggle’s chooser on a desktop, where its trigger exists',
    menu: 'region',
    viewport: DESKTOP,
    device: 'desktop',
    backdropLabel: 'Close the Add to Left region menu',
    // On a phone `commandsInOverflowMenu` renders no region control at all —
    // the commands move into the ⋯ menu — so this control is desktop-only.
    // Since #2155 every region toggle opens #2154's chooser on a hold or a
    // right-click, whatever the region holds; the fixture opens `left`'s.
    openerLabel: 'Left region',
  },
  {
    // The folded "Regions" menu, and the reason it is a shape of its own
    // (#2155 review M6): it is the last consumer of `ToolbarMenuSurface`,
    // whose backdrop is the one the region shape above used to measure. A
    // coarse pointer at 1180x820 — a tablet in landscape — is the device
    // that draws it: bottom-only by `availablePlacements`, but too wide for
    // the mobile query that would move its commands into the `⋯` menu.
    name: 'the toolbar’s folded Regions menu on a coarse, wide device',
    menu: 'folded-regions',
    viewport: { width: 1180, height: 820 },
    device: 'tablet',
    backdropLabel: 'Close regions menu',
    openerLabel: 'Regions',
  },
  {
    // #2143: a tab's move menu, opened from the region bar's strip. Desktop
    // only: the strip does not render on the mobile layout.
    name: 'a tab’s move menu on a desktop, where its tab exists',
    menu: 'tab-move',
    viewport: DESKTOP,
    device: 'desktop',
    backdropLabel: 'Close move menu for Activity',
    openerLabel: 'Activity',
  },
  {
    // #2160: the SAME menu, opened from the region bar's own Move button —
    // the route a lone pane has, where no tab exists to right-click. The
    // button sits in the bar's actions cluster, so its trigger is chrome the
    // backdrop must outrank just as the tab's is. Desktop only, like the "+".
    name: 'a pane’s move menu opened from the region bar’s Move button',
    menu: 'bar-move',
    viewport: DESKTOP,
    device: 'desktop',
    backdropLabel: 'Close move menu for Activity',
    openerLabel: 'Move Activity',
  },
  {
    name: 'the dock header’s More menu on a phone',
    menu: 'dock-more',
    viewport: PHONE,
    device: 'phone',
    backdropLabel: 'Close more dock actions',
    openerLabel: 'More dock actions',
  },
  {
    name: 'the dock header’s More menu on a desktop',
    menu: 'dock-more',
    viewport: DESKTOP,
    device: 'desktop',
    backdropLabel: 'Close more dock actions',
    openerLabel: 'More dock actions',
  },
];

function buildFixtureCss(): string {
  const css = [
    resolveCssImports(INDEX_CSS_PATH),
    resolveCssImports(CHAT_CSS_PATH),
    resolveCssImports(HEADER_MENU_CSS_PATH),
    resolveCssImports(REGION_CHOOSER_CSS_PATH),
  ].join('\n');
  assertNoImportsSurvive(css);
  return css;
}

/**
 * The measured trigger geometry pass 1 hands back to pass 2. `null` on the
 * first pass, where nothing has been measured yet and the menus stay closed.
 */
interface TriggerGeometry {
  readonly rect: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  };
  readonly innerWidth: number;
  readonly innerHeight: number;
}

/**
 * Renders the shell and returns `document.body`'s markup — the shape under
 * test, since every menu here portals to the body and its position in document
 * order is part of what decides paint order.
 */
async function renderShellMarkup(
  shape: Shape,
  geometry: TriggerGeometry | null,
): Promise<string> {
  harness.isMobile = shape.device === 'phone';
  // Coarse: a phone, and a tablet too. Only the phone matches the mobile
  // media query, which is what decides whether the region commands move into
  // the `⋯` menu or stay in the toolbar as the folded control.
  harness.bottomOnly = shape.device !== 'desktop';
  viewModel.showHelp = geometry !== null && shape.menu === 'help';
  viewModel.showOverflow = geometry !== null && shape.menu === 'overflow';
  viewModel.showProfileMenu = geometry !== null && shape.menu === 'profile';
  viewModel.showNotifications = false;

  if (geometry) {
    // `RegionToolbarControls` and `ChatDockHeaderMoreMenu` both derive their
    // panel's position from `window.inner*` at the moment of the press.
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: geometry.innerWidth,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: geometry.innerHeight,
    });
  }

  render(
    <div className="app app--with-sidebar">
      <div className="app__main">
        <Header onNavigate={() => {}} onToggleSettings={() => {}} />
        <main className="main-content" id="station-main" tabIndex={-1}>
          <div className="content-view" />
        </main>
        {/* The arrangement #2112 asks for: an open, maximized bottom dock, so
            `--layer-dock` (9200) is a live competitor rather than an absent
            one, and the dock's own ⋯ is on screen. */}
        <section
          className="chat-dock chat-dock--bottom is-maximized"
          data-region="bottom"
        >
          {shape.menu === 'tab-move' || shape.menu === 'bar-move' ? (
            <RegionChromeBar
              chrome={tabMoveChrome()}
              groupId="region:bottom"
              tabs={[
                {
                  surfaceId: 'chat',
                  instanceId: 'workspace-chat',
                  title: 'Chat',
                },
                {
                  surfaceId: 'activity',
                  instanceId: 'workspace-activity',
                  title: 'Activity',
                },
              ]}
              selectedSurfaceId="activity"
              onSelectTab={() => {}}
              onCloseTab={undefined}
              onReorderTab={() => {}}
              onMoveTab={() => {}}
              leadingSlotRef={() => {}}
              trailingSlotRef={() => {}}
            />
          ) : (
            <div className="chat-dock__header">
              <ChatDockHeaderMoreMenu
                actions={[
                  {
                    key: 'settings',
                    label: 'Chat settings',
                    onSelect: () => {},
                  },
                  {
                    key: 'tasks',
                    label: 'Background tasks',
                    onSelect: () => {},
                  },
                ]}
              />
            </div>
          )}
        </section>
      </div>
    </div>,
  );

  if (geometry) {
    if (shape.menu === 'tab-move' || shape.menu === 'bar-move') {
      // The move menu anchors under whichever trigger opened it, and pass 1's
      // measurement of that trigger is what it anchors to. A tab opens it on
      // `contextmenu`; the bar's Move button on `click`.
      const opener =
        shape.menu === 'tab-move'
          ? screen.getByRole('tab', { name: shape.openerLabel as string })
          : screen.getByRole('button', { name: shape.openerLabel as string });
      opener.getBoundingClientRect = () => geometry.rect as DOMRect;
      if (shape.menu === 'tab-move') fireEvent.contextMenu(opener);
      else fireEvent.click(opener);
    } else if (
      shape.menu === 'region' ||
      shape.menu === 'folded-regions' ||
      shape.menu === 'dock-more'
    ) {
      const opener = screen.getByLabelText(shape.openerLabel as string, {
        exact: false,
      });
      // Both components read the trigger's rect at the moment they open.
      // jsdom reports zeros for it, which would put the panel somewhere no
      // product state does; pass 1's real measurement is what makes the panel
      // land where Chromium would actually draw it.
      opener.getBoundingClientRect = () => geometry.rect as DOMRect;
      // A region toggle's CLICK shows or hides the region (#2155); the panel
      // is behind the hold and its pointer-independent twin, `contextmenu` —
      // the one a test can dispatch without a 500ms clock.
      if (shape.menu === 'region') fireEvent.contextMenu(opener);
      else fireEvent.click(opener);
    }
    // The three header menus are behind `LazyBoundary`, so the portal does not
    // exist on the render that flips their flag. Awaiting the backdrop by name
    // is what makes the serialized body contain an OPEN menu rather than a
    // suspended one.
    //
    // This is also where "someone deleted a backdrop" lands — MEASURED, by
    // removing `ProfileMenu`'s and watching it red here rather than in the
    // browser. The rethrow is what carries the reason: without it the reader
    // gets testing-library's generic "unable to find a label" over a serialized
    // body dump, which describes the symptom and not the invariant.
    try {
      await screen.findByLabelText(shape.backdropLabel);
    } catch (cause) {
      throw new Error(
        `the open ${shape.menu} menu rendered no dismiss backdrop named ` +
          `"${shape.backdropLabel}". #2081 ruled this menu out of its fix ` +
          'precisely because it draws one; without it the menu no longer ' +
          'covers its own trigger and this file cannot measure the invariant. ' +
          'Either the backdrop was removed — the regression — or it was ' +
          'renamed, in which case point this shape at the new name.',
        { cause },
      );
    }
  }

  return document.body.innerHTML;
}

function fixtureHtml(bodyMarkup: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${buildFixtureCss()}</style>
  </head>
  <body style="margin:0">${bodyMarkup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

interface Probe {
  /** The control's accessible name, for the failure message. */
  readonly name: string;
  readonly className: string;
  readonly point: { x: number; y: number };
  readonly hit: string;
  readonly hitsBackdrop: boolean;
  readonly offscreen: boolean;
}

interface Measured {
  readonly backdropPresent: boolean;
  readonly backdropCoversViewport: boolean;
  readonly panelPresent: boolean;
  /** Set when the menu panel itself sits over a probe point — a bad fixture. */
  readonly menuCoversProbe: string | null;
  readonly dockLaidOut: boolean;
  readonly dockZIndex: string;
  readonly openerProbe: Probe | null;
  readonly probes: readonly Probe[];
}

describe.skipIf(!chromiumAvailable)(
  'every dismiss backdrop outranks the chrome its own trigger sits in (#2112)',
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

    /**
     * Writes the two custom properties the running app's visual-viewport
     * tracker owns. They are read by `.app-toolbar__*-menu`'s `top` and by the
     * maximized dock's `height`; left unset, those `calc()`s are invalid and
     * both surfaces fall back to a geometry no device produces.
     */
    async function applyViewportVars(
      page: Awaited<ReturnType<typeof browser.newPage>>,
      viewport: { width: number; height: number },
    ): Promise<void> {
      await page.evaluate((height: number) => {
        const root = document.documentElement;
        root.style.setProperty('--chat-visual-viewport-top', '0px');
        root.style.setProperty('--chat-visual-viewport-height', `${height}px`);
        root.style.setProperty('--chat-visual-viewport-bottom', `${height}px`);
      }, viewport.height);
    }

    /** Pass 1: the shell with every menu closed, measured for real. */
    async function measureTrigger(shape: Shape): Promise<TriggerGeometry> {
      const markup = await renderShellMarkup(shape, null);
      cleanup();
      document.body.innerHTML = '';
      const page = await browser.newPage({ viewport: shape.viewport });
      try {
        await page.setContent(fixtureHtml(markup));
        await applyViewportVars(page, shape.viewport);
        return await page.evaluate((openerLabel: string | null) => {
          const viewport = {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
          };
          if (!openerLabel) {
            return {
              rect: {
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                width: 0,
                height: 0,
              },
              ...viewport,
            };
          }
          // A control is found by its `aria-label`, or — for a tab, whose
          // name is its text (#2143's move menu opens from one) — by role.
          const opener =
            [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(
              (element) =>
                (element.getAttribute('aria-label') ?? '').startsWith(
                  openerLabel,
                ) && element.getBoundingClientRect().width > 0,
            ) ??
            [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
              (element) =>
                (element.textContent ?? '').trim() === openerLabel &&
                element.getBoundingClientRect().width > 0,
            );
          if (!opener) {
            throw new Error(
              `the closed shell rendered no laid-out control named ` +
                `"${openerLabel}", so there is no trigger to measure. Either ` +
                'the control moved behind a different breakpoint or its name ' +
                'changed.',
            );
          }
          const rect = opener.getBoundingClientRect();
          return {
            rect: {
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            },
            ...viewport,
          };
        }, shape.openerLabel);
      } finally {
        await page.close();
      }
    }

    /** Pass 2: the same shell with the shape's menu open, hit-tested. */
    async function measure(shape: Shape): Promise<Measured> {
      const geometry = await measureTrigger(shape);
      const markup = await renderShellMarkup(shape, geometry);
      cleanup();
      document.body.innerHTML = '';
      const page = await browser.newPage({ viewport: shape.viewport });
      try {
        await page.setContent(fixtureHtml(markup));
        await applyViewportVars(page, shape.viewport);
        return await page.evaluate(
          ({
            backdropLabel,
            openerLabel,
          }: {
            backdropLabel: string;
            openerLabel: string | null;
          }): Measured => {
            const describe_ = (element: Element | null) =>
              element
                ? `${element.tagName.toLowerCase()}${
                    String(element.className).trim()
                      ? `.${String(element.className).trim().split(/\s+/).join('.')}`
                      : ''
                  }`
                : 'null';

            const backdrop = document.querySelector<HTMLElement>(
              `.header-menu__dismiss-backdrop[aria-label="${backdropLabel}"]`,
            );
            if (!backdrop) {
              return {
                backdropPresent: false,
                backdropCoversViewport: false,
                panelPresent: false,
                menuCoversProbe: null,
                dockLaidOut: false,
                dockZIndex: 'absent',
                openerProbe: null,
                probes: [],
              };
            }
            // The menu this backdrop belongs to: its next element sibling, the
            // shape every one of these portals renders.
            const panel = backdrop.nextElementSibling as HTMLElement | null;
            const backdropRect = backdrop.getBoundingClientRect();
            const panelRect = panel?.getBoundingClientRect() ?? null;

            const dock = document.querySelector<HTMLElement>('.chat-dock');
            const dockRect = dock?.getBoundingClientRect();

            const probeFor = (control: Element): Probe => {
              const rect = control.getBoundingClientRect();
              const point = {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              };
              const hit = document.elementFromPoint(point.x, point.y);
              return {
                name:
                  control.getAttribute('aria-label') ??
                  control.textContent ??
                  '',
                className: describe_(control),
                point,
                hit: describe_(hit),
                hitsBackdrop: hit === backdrop,
                offscreen:
                  point.x < 0 ||
                  point.y < 0 ||
                  point.x >= window.innerWidth ||
                  point.y >= window.innerHeight,
              };
            };

            // Every control of the shell chrome a press could land on while
            // this menu is open: the toolbar's row, and the dock header's.
            const controls = [
              ...document.querySelectorAll<HTMLElement>(
                '.app-toolbar button, .chat-dock__header button',
              ),
            ].filter((control) => {
              const rect = control.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });

            const probes = controls.map(probeFor);
            const opener = openerLabel
              ? (controls.find((control) =>
                  (control.getAttribute('aria-label') ?? '').startsWith(
                    openerLabel,
                  ),
                ) ??
                controls.find(
                  (control) =>
                    control.getAttribute('role') === 'tab' &&
                    (control.textContent ?? '').trim() === openerLabel,
                ))
              : undefined;

            // A panel sitting on a probe point would make that probe report a
            // menu hit and prove nothing about the backdrop. That is a broken
            // fixture, not a product fact, so it is reported rather than
            // absorbed.
            const covered = panelRect
              ? probes.find(
                  (probe) =>
                    !probe.offscreen &&
                    probe.point.x >= panelRect.left &&
                    probe.point.x <= panelRect.right &&
                    probe.point.y >= panelRect.top &&
                    probe.point.y <= panelRect.bottom,
                )
              : undefined;

            return {
              backdropPresent: true,
              backdropCoversViewport:
                backdropRect.left <= 0 &&
                backdropRect.top <= 0 &&
                backdropRect.right >= window.innerWidth &&
                backdropRect.bottom >= window.innerHeight,
              panelPresent: Boolean(
                panel?.classList.contains('menu-surface') &&
                  panel.getBoundingClientRect().width > 0,
              ),
              menuCoversProbe: covered
                ? `${covered.name} (${covered.className})`
                : null,
              dockLaidOut: Boolean(
                dockRect && dockRect.width > 0 && dockRect.height > 0,
              ),
              dockZIndex: dock ? getComputedStyle(dock).zIndex : 'absent',
              openerProbe: opener ? probeFor(opener) : null,
              probes,
            };
          },
          {
            backdropLabel: shape.backdropLabel,
            openerLabel: shape.openerLabel,
          },
        );
      } finally {
        await page.close();
      }
    }

    test.each(SHAPES)(
      'the fixture renders a real menu over real chrome: $name',
      async (shape) => {
        const measured = await measure(shape);
        expect(
          measured.backdropPresent,
          `"${shape.backdropLabel}" is in the rendered tree but not in the page ` +
            'this fixture served, so the markup was lost between serializing ' +
            'the body and loading it. A DELETED backdrop does not reach here: ' +
            'it reds in `renderShellMarkup`, which is where that message ' +
            'lives.',
        ).toBe(true);
        expect(
          measured.backdropCoversViewport,
          'the backdrop no longer covers the whole viewport, so it cannot ' +
            'cover its own trigger wherever that trigger sits.',
        ).toBe(true);
        expect(
          measured.panelPresent,
          'the menu panel did not render beside its backdrop, so nothing here ' +
            'models an OPEN menu.',
        ).toBe(true);
        expect(
          measured.menuCoversProbe,
          'the menu panel is sitting on top of a chrome control this shape ' +
            'probes, so the hit test below would report the panel rather than ' +
            'the backdrop and prove nothing. Fix the fixture geometry.',
        ).toBeNull();
        // The dock is in the fixture to make `--layer-dock` (9200) a live
        // competitor. If it stopped being one, these shapes measure less than
        // they claim and must say so rather than pass.
        expect(
          measured.dockLaidOut,
          'the fixture dock has no box, so the "maximized region, dock open" ' +
            'arrangement #2112 asks for is not actually present.',
        ).toBe(true);
        expect(
          Number(measured.dockZIndex),
          `the dock computes z-index ${measured.dockZIndex}, so it no longer ` +
            'stacks above ordinary content and these shapes no longer model a ' +
            'menu opened over it.',
        ).toBeGreaterThan(0);
        // A sweep over an empty list passes vacuously. The toolbar and the dock
        // header both render controls in every shape.
        expect(
          measured.probes.filter((probe) => !probe.offscreen).length,
          'no on-screen chrome control was found to probe',
        ).toBeGreaterThan(1);
      },
    );

    test.each(SHAPES)(
      'a press at every chrome control lands on the backdrop, not the control: $name',
      async (shape) => {
        const measured = await measure(shape);
        const onscreen = measured.probes.filter((probe) => !probe.offscreen);
        const stolen = onscreen.filter((probe) => !probe.hitsBackdrop);
        expect(
          stolen.map(
            (probe) =>
              `"${probe.name}" at (${probe.point.x}, ${probe.point.y}) hit ${probe.hit}`,
          ),
          'while this menu is open, a press at these chrome controls does NOT ' +
            'reach its dismiss backdrop. That is #2081’s defect: the control ' +
            'takes the press instead of the menu closing. The usual causes are ' +
            'a toolbar or dock z-index raised past the backdrop’s 9349, a ' +
            'stacking context above 9349 introduced on an ancestor of that ' +
            'chrome, or the backdrop itself losing its layer.',
        ).toEqual([]);
      },
    );

    test.each(SHAPES.filter((shape) => shape.openerLabel !== null))(
      'the backdrop outranks this menu’s OWN trigger: $name',
      async (shape) => {
        const measured = await measure(shape);
        const opener = measured.openerProbe;
        expect(
          opener,
          `this shape names "${shape.openerLabel}" as the control that opens ` +
            'the menu, and no such control is on screen while it is open. If ' +
            'the trigger is genuinely gone the shape should say so; if it moved ' +
            'behind a breakpoint, the shape is measuring the wrong viewport.',
        ).not.toBeNull();
        expect(opener?.offscreen, 'the trigger is outside the viewport').toBe(
          false,
        );
        expect(
          opener?.hitsBackdrop,
          `a press at the centre of "${shape.openerLabel}" (${opener?.point.x}, ` +
            `${opener?.point.y}) landed on ${opener?.hit}, not on this menu’s ` +
            'dismiss backdrop. This is exactly the rule-out #2081 relied on for ' +
            'this menu: the backdrop covers its own trigger, so the press ' +
            'closes the menu. With the trigger reachable, `OverflowMenu`, ' +
            '`ProfileMenu` and `ChatDockHeaderMoreMenu` close-and-reopen, and ' +
            '`RegionToolbarControls` — whose handler only ever OPENS — goes ' +
            'inert.',
        ).toBe(true);
      },
    );
  },
);

test.skipIf(chromiumAvailable)(
  'dismiss-backdrop invariant — Chromium not installed, cannot verify (#2112)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the dismiss ' +
        'backdrops’ reachability over their own triggers could not be measured ' +
        '— this is a missing precondition, not a passing check. Install it ' +
        'with `npm run install:playwright` and re-run.',
    );
  },
);
