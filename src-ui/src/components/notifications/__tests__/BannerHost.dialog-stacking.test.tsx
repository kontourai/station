/**
 * @vitest-environment jsdom
 *
 * #1638: the banner host painted over an open modal surface and its own
 * controls took the clicks.
 *
 * MEASURED LIVE before the fix, on a temp-home instance at 390x844 with two
 * real product notices up (the Board-unavailable redirect notice and the
 * update-available notice) and the New Chat sheet open:
 *
 *   .banner-host             z-index 9201, pointer-events: none
 *   .new-chat-modal__overlay z-index 10000, nearest stacking-context ancestor
 *                            section.chat-dock (position: fixed, z-index 9200)
 *   document.elementFromPoint(195, 160)  // centre of the sheet's search input
 *     -> button.banner-host__cap "1 more notice, 1 informational"
 *
 * and Playwright refused the click with the issue's own sentence:
 * `<button ... class="banner-host__cap banner-host__cap--info">1 more notice,
 * 1 informational</button> from <section ... class="banner-host ...">…</section>
 * subtree intercepts pointer events`.
 *
 * WHY IT HAPPENS. `.chat-dock` is `position: fixed` with a z-index, so it is a
 * stacking context, and `ChatDock.tsx` renders `ChatDockModalStack` INSIDE it.
 * Every dock dialog therefore paints at whatever the DOCK's z-index is, not at
 * the `--layer-dialog` its overlay declares. Two pieces of shell chrome sat
 * above that, and BOTH are reachable on a phone: `BannerHost.css` raises the
 * notice to `--layer-dock + 1` wherever the dock leaves no column to inset
 * into, and the mobile `.app__main > .chat-dock.is-maximized` rule drops a
 * maximized dock to `--layer-sticky + 1` (101), under even the plain
 * `--layer-notice`. The reported journey was in the SECOND state — the phone
 * dock maximizes itself — which is why both shapes are measured below and why
 * lowering the notice alone was not the fix.
 *
 * The interceptor is a REAL control, not a transparent container: the host and
 * its items are `pointer-events: none` and only the cap / dismiss / collapse /
 * action rectangles opt back in. So `pointer-events` was already right, and
 * the fix is the ordering: `index.css` promotes a dock that HOSTS a
 * `.responsive-surface-overlay` to `--layer-dialog`, which is the layer the
 * dialog declared and could not reach.
 *
 * WHAT THIS FIXTURE COMPOSES, AND WHY IT NEEDS THE DOCK. The subject is a hit
 * test, which no source scan can see (`src-ui/AGENTS.md`: "DOM/source-string
 * assertions do not establish CSS layout, hit testing"). So: the REAL
 * `BannerHost` and the REAL `ResponsiveDialogSurface`, rendered through
 * `@testing-library/react`, injected into a real Chromium page carrying
 * `index.css` + `BannerHost.css` with every `@import` resolved — the same
 * harness as `BannerHost.touch-target.test.tsx`. The shell containers around
 * them (`.app__main`, `.chat-dock`) are the load-bearing part: put the dialog
 * anywhere else and it reaches `--layer-dialog` on its own and the fixture
 * measures nothing. `assertTheDockStillTrapsItsDialogs` keeps that honest.
 *
 * PRECONDITION: launches a real Chromium. Per this repo's browser-test
 * doctrine, a missing browser FAILS loudly rather than skipping — see the
 * tail of this file and `docs/guides/testing.md`.
 *
 * RESOURCE CLASSIFICATION: listed in `scripts/vitest-resource-manifest.mjs`'s
 * `PROCESS_HEAVY_VITEST_FILES`, same shape as the touch-target files.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { act, render } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
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
} from '../../../../../tests/helpers/css-cascade-fixture';
import { bannerStore } from '../../../contexts/banner-store';
import { Button } from '../../Button';
import { ResponsiveDialogSurface } from '../../ResponsiveDialogSurface';
import { BannerHost } from '../BannerHost';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const BANNER_CSS_PATH = resolve(HERE, '../BannerHost.css');
const NEW_CHAT_MODAL_PATH = resolve(HERE, '../../modals/NewChatModal.tsx');
const COMPOSER_ACTIONS_MENU_PATH = resolve(
  HERE,
  '../../chat-dock/ComposerActionsMenu.tsx',
);

const VIEWPORT = { width: 390, height: 844 };

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })),
});

function buildFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(BANNER_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

/**
 * The stack the issue reported: one visible card plus the cap that hides the
 * second ("1 more notice, 1 informational"). Two notices, because the cap is
 * the control that actually intercepted — `buildBannerStackView` renders no
 * cap unless something is hidden behind it.
 */
function presentFixtureBanners(critical: boolean): void {
  act(() => {
    bannerStore.present({
      id: 'station-1638:front',
      priority: 10,
      tone: critical ? 'error' : 'info',
      criticalChrome: critical || undefined,
      message: critical
        ? 'Station could not load the plugin registry'
        : 'This project has no Builder runs yet',
      dismissible: true,
      dismissAriaLabel: 'Dismiss notice',
    });
    bannerStore.present({
      id: 'station-1638:hidden',
      priority: 10,
      tone: 'info',
      message: 'A second notice, hidden behind the cap',
    });
  });
}

/**
 * The overlay and panel class names a real consumer passes to
 * `ResponsiveDialogSurface`. Read from the component rather than retyped, so a
 * rename there cannot leave this fixture measuring geometry no surface has:
 * the shared `.responsive-surface-*` rules alone supply no `position`
 * (station#1616), and the feature classes that do live in `index.css`.
 */
function surfaceClassesOf(path: string): {
  overlayClassName: string;
  panelClassName: string;
} {
  const source = readFileSync(path, 'utf8');
  const overlay = /overlayClassName="([^"]+)"/.exec(source)?.[1];
  const panel = /panelClassName="([^"]+)"/.exec(source)?.[1];
  if (!overlay || !panel) {
    throw new Error(
      `${path} no longer passes literal overlayClassName/panelClassName to ` +
        'ResponsiveDialogSurface, so this fixture can no longer compose the ' +
        'surface it models. Point it at whatever that component passes now ' +
        'rather than hard-coding the old class names.',
    );
  }
  return { overlayClassName: overlay, panelClassName: panel };
}

/**
 * A modal surface with a column of ordinary controls. `Button` is the repo's
 * standard action primitive (`src-ui/AGENTS.md`), and the claim under test is
 * about ANY control inside an open surface — the live report happened to be
 * the New Chat sheet's agent card and its search input.
 */
function renderDialogMarkup(): string {
  const { overlayClassName, panelClassName } =
    surfaceClassesOf(NEW_CHAT_MODAL_PATH);
  const { container, unmount } = render(
    <ResponsiveDialogSurface
      ariaLabel="New Chat"
      overlayClassName={overlayClassName}
      panelClassName={panelClassName}
      onClose={() => {}}
    >
      {Array.from({ length: 8 }, (_, index) => (
        <Button key={index}>{`Choose agent ${index + 1}`}</Button>
      ))}
    </ResponsiveDialogSurface>,
  );
  const markup = container.innerHTML;
  unmount();
  return markup;
}

/**
 * The OTHER shape `ResponsiveDialogSurface` renders: a desktop anchored
 * popover. It is fixed-inset for stacking escape and click-away and carries no
 * scrim (`.composer-popover-overlay[data-anchored]` in `chat.css`), which is
 * why it must not take the dialog layer — a promoted dock would paint over the
 * toasts `NotificationContainer.css` promises stay reachable above it.
 *
 * Driven through the real component rather than by writing `data-anchored`
 * into markup: the attribute is what the rule keys on, and the surface only
 * writes it once it has measured a mounted anchor, so the trigger renders
 * first and the surface mounts on the next commit.
 */
function AnchoredPopoverFixture() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [anchorMounted, setAnchorMounted] = useState(false);
  useEffect(() => setAnchorMounted(true), []);
  const { overlayClassName, panelClassName } = surfaceClassesOf(
    COMPOSER_ACTIONS_MENU_PATH,
  );
  return (
    <>
      <button type="button" ref={anchorRef}>
        Actions
      </button>
      {anchorMounted ? (
        <ResponsiveDialogSurface
          ariaLabel="Chat actions"
          anchorRef={anchorRef}
          overlayClassName={overlayClassName}
          panelClassName={panelClassName}
          onClose={() => {}}
        >
          <Button>Delegate</Button>
        </ResponsiveDialogSurface>
      ) : null}
    </>
  );
}

function renderAnchoredPopoverMarkup(): string {
  const { container, unmount } = render(<AnchoredPopoverFixture />);
  const markup = container.innerHTML;
  unmount();
  if (!markup.includes('data-anchored')) {
    throw new Error(
      'the anchored fixture rendered no `data-anchored` overlay, so it no ' +
        'longer models the popover shape the promotion must skip. ' +
        'ResponsiveDialogSurface changed how it flags an anchored surface — ' +
        'follow it rather than deleting the case.',
    );
  }
  return markup;
}

function renderDockContents(surface: DockSurface): string {
  if (surface === 'modal') return renderDialogMarkup();
  if (surface === 'anchored') return renderAnchoredPopoverMarkup();
  return '<div class="chat-dock__body">Dock contents</div>';
}

function renderBannerHostMarkup(critical: boolean): string {
  presentFixtureBanners(critical);
  const { container, unmount } = render(<BannerHost connectionSlot={false} />);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

/**
 * The shell ancestry the defect lives in: `.app__main` is the positioned
 * container the host and every region shell sit in, and each `.chat-dock` is a
 * stacking context that traps the surfaces it mounts. `RegionShells` mounts
 * ONE shell per occupied region, all direct children of `.app__main`, so the
 * two-dock shape below is a real layout, not a stress case.
 */
function buildFixtureHtml(shape: Shape): string {
  const docks = shape.docks
    .map(
      (dock) =>
        `<section class="${dock.className}">${renderDockContents(dock.surface)}</section>`,
    )
    .join('\n        ');
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${buildFixtureCss()}</style>
  </head>
  <body>
    <div class="app app--with-sidebar">
      <div class="app__main">
        ${renderBannerHostMarkup(shape.critical)}
        ${docks}
      </div>
    </div>
  </body>
</html>`;
}

type DockSurface = 'modal' | 'anchored' | 'none';

interface DockSpec {
  /** The classes `RegionShells`/`ChatDock` render for this dock state. */
  readonly className: string;
  readonly surface: DockSurface;
  /**
   * The z-index this dock must resolve to. `10000` is `--layer-dialog`, `9200`
   * `--layer-dock`, `101` the mobile maximized rule's `--layer-sticky + 1`.
   * Literals, not the tokens, so widening a token cannot move the expectation
   * with the code it is meant to pin.
   */
  readonly expectedZIndex: string;
}

interface Shape {
  readonly name: string;
  readonly critical: boolean;
  readonly docks: readonly DockSpec[];
  /**
   * Whether a modal surface is open somewhere, so the hit-test assertion has a
   * subject. The shapes without one exist to prove the promotion does NOT
   * fire — the direction the first version of this file could not see.
   */
  readonly hasModalSurface: boolean;
}

const BOTTOM_DOCK = 'chat-dock chat-dock--bottom';
const MAXIMIZED_DOCK = 'chat-dock is-maximized chat-dock--bottom';

const SHAPES: readonly Shape[] = [
  {
    name: 'an ordinary notice over a bottom dock hosting a modal',
    critical: false,
    hasModalSurface: true,
    docks: [
      { className: BOTTOM_DOCK, surface: 'modal', expectedZIndex: '10000' },
    ],
  },
  {
    name: "#920's critical card over a maximized dock hosting a modal",
    critical: true,
    hasModalSurface: true,
    docks: [
      { className: MAXIMIZED_DOCK, surface: 'modal', expectedZIndex: '10000' },
    ],
  },
  {
    name: 'a bottom dock with nothing open stays on the dock layer',
    critical: false,
    hasModalSurface: false,
    docks: [
      { className: BOTTOM_DOCK, surface: 'none', expectedZIndex: '9200' },
    ],
  },
  {
    name: 'a maximized dock with nothing open keeps its own sticky rank',
    critical: false,
    hasModalSurface: false,
    docks: [
      { className: MAXIMIZED_DOCK, surface: 'none', expectedZIndex: '101' },
    ],
  },
  {
    name: 'a sibling region dock hosting nothing is not promoted with it',
    critical: false,
    hasModalSurface: true,
    docks: [
      { className: BOTTOM_DOCK, surface: 'modal', expectedZIndex: '10000' },
      { className: BOTTOM_DOCK, surface: 'none', expectedZIndex: '9200' },
    ],
  },
  {
    name: 'a scrim-less anchored popover does not take the dialog layer',
    critical: false,
    hasModalSurface: false,
    docks: [
      { className: BOTTOM_DOCK, surface: 'anchored', expectedZIndex: '9200' },
    ],
  },
];

interface Measured {
  dockTrapsDialogs: boolean;
  dockZIndexes: string[];
  hostZIndex: string;
  overlayZIndex: string | null;
  overlapping: {
    control: string;
    banner: string;
    point: { x: number; y: number };
    hit: string;
    hitsItself: boolean;
  }[];
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'a notice never takes a click from an open modal surface (#1638)',
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

    async function measure(shape: Shape): Promise<Measured> {
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.setContent(buildFixtureHtml(shape));
        return await page.evaluate(() => {
          const describe_ = (element: Element | null) =>
            element
              ? `${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/).join('.')}`
              : 'null';
          const boxes = (element: Element) => element.getBoundingClientRect();

          const docks = Array.from(document.querySelectorAll('.chat-dock'));
          const host = document.querySelector('.banner-host');
          if (docks.length === 0 || !host) {
            throw new Error(
              `fixture did not render: docks=${docks.length} host=${Boolean(host)}`,
            );
          }
          // The MODAL surface, if any. An anchored popover carries the same
          // overlay class, so the panel this measures is the one the rule is
          // supposed to protect, never the popover it is supposed to ignore.
          const overlay = document.querySelector(
            '.responsive-surface-overlay:not([data-anchored])',
          );
          const panel = overlay?.querySelector('.responsive-surface-panel');

          // Only the rectangles that actually take pointer events can
          // intercept: the host and its items are `pointer-events: none`.
          const bannerControls = Array.from(host.querySelectorAll('*')).filter(
            (element) => getComputedStyle(element).pointerEvents === 'auto',
          );

          const overlapping: Measured['overlapping'] = [];
          for (const control of panel?.querySelectorAll('button') ?? []) {
            const controlBox = boxes(control);
            for (const banner of bannerControls) {
              const bannerBox = boxes(banner);
              // The centre of the OVERLAP, so the point is inside both boxes
              // by construction rather than by luck.
              const left = Math.max(controlBox.left, bannerBox.left);
              const right = Math.min(controlBox.right, bannerBox.right);
              const top = Math.max(controlBox.top, bannerBox.top);
              const bottom = Math.min(controlBox.bottom, bannerBox.bottom);
              if (right - left < 2 || bottom - top < 2) continue;
              const point = {
                x: Math.round((left + right) / 2),
                y: Math.round((top + bottom) / 2),
              };
              const hit = document.elementFromPoint(point.x, point.y);
              overlapping.push({
                control: describe_(control),
                banner: describe_(banner),
                point,
                hit: describe_(hit),
                hitsItself: Boolean(
                  hit && (hit === control || control.contains(hit)),
                ),
              });
            }
          }

          return {
            dockTrapsDialogs: docks.every((dock) => {
              const style = getComputedStyle(dock);
              return style.position !== 'static' && style.zIndex !== 'auto';
            }),
            dockZIndexes: docks.map((dock) => getComputedStyle(dock).zIndex),
            hostZIndex: getComputedStyle(host).zIndex,
            overlayZIndex: overlay ? getComputedStyle(overlay).zIndex : null,
            overlapping,
          };
        });
      } finally {
        await page.close();
      }
    }

    /**
     * The fixture only measures the defect while a dock still traps the
     * surfaces it mounts. If one stops doing that, the assertions below would
     * pass because the dialog reached `--layer-dialog` on its own — a green
     * for the wrong reason.
     */
    function assertTheDockStillTrapsItsDialogs(measured: Measured): void {
      if (!measured.dockTrapsDialogs) {
        throw new Error(
          '`.chat-dock` no longer creates a stacking context (computed ' +
            `z-index ${measured.dockZIndexes.join(', ')}), so a dialog ` +
            'mounted inside it now reaches --layer-dialog by itself and this ' +
            'fixture no longer models #1638. Re-point it at whatever ancestor ' +
            'traps a dialog now, or retire it with the reason.',
        );
      }
    }

    test.each(SHAPES.filter((shape) => shape.hasModalSurface))(
      'a control inside the open surface hit-tests to itself where the banner paints over it: $name',
      async (shape) => {
        const measured = await measure(shape);
        assertTheDockStillTrapsItsDialogs(measured);

        // Power guard: without a real overlap this assertion is vacuous. The
        // live report was the cap over the sheet's search input; here it is
        // the cap and the dismiss/collapse row over the surface's controls.
        expect(
          measured.overlapping.length,
          'no control inside the modal surface overlaps a banner control, so ' +
            'this measurement proves nothing. The banner stack or the surface ' +
            'geometry moved — restore an overlap rather than deleting the test.',
        ).toBeGreaterThan(0);

        const stolen = measured.overlapping.filter(
          (entry) => !entry.hitsItself,
        );
        expect(
          stolen,
          'the banner host took a click from a control inside an open modal ' +
            `surface (host z-index ${measured.hostZIndex}, overlay z-index ` +
            `${measured.overlayZIndex}, docks at ` +
            `${measured.dockZIndexes.join(', ')}):\n${stolen
              .map(
                (entry) =>
                  `  ${entry.control} at (${entry.point.x}, ${entry.point.y}) hit ${entry.hit} (${entry.banner})`,
              )
              .join('\n')}`,
        ).toEqual([]);
      },
    );

    test.each(SHAPES)(
      'each dock resolves to the layer its own contents earn: $name',
      async (shape) => {
        const measured = await measure(shape);
        // Both directions in one assertion, per dock: a dock hosting a modal
        // reaches `--layer-dialog`, and one hosting nothing — or hosting only
        // a scrim-less anchored popover — stays exactly where it was. The
        // hit test above cannot see either half: it passes for an
        // unconditional promotion, which is how the first version of this fix
        // shipped a rule whose entire `:has()` clause was unverified.
        expect(measured.dockZIndexes).toEqual(
          shape.docks.map((dock) => dock.expectedZIndex),
        );
      },
    );
  },
);

test.skipIf(chromiumAvailable)(
  'notice-vs-dialog stacking — Chromium not installed, cannot verify (#1638)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'notice-vs-dialog hit test (#1638) could not be checked — this is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
