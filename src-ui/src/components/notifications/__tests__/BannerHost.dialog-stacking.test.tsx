/**
 * @vitest-environment jsdom
 *
 * #1638 / #1662: a surface mounted inside the dock renders OUTSIDE the dock's
 * stacking context, so the layer its overlay declares is the layer it gets.
 *
 * THE TRAP THIS PINS THE REMOVAL OF. A dock is a stacking context in both its
 * forms — `position: fixed` with `z-index: var(--layer-dock)` on mobile,
 * `position: relative` in the desktop region grid keeping the same z-index —
 * and `ChatDock.tsx` renders `ChatDockModalStack` inside it. A dialog mounted
 * there could never honour `--layer-dialog`; it painted at whatever the dock's
 * own z-index happened to be. Measured live at 390x844 with two real notices
 * up and the New Chat sheet open: host `z-index: 9201`, overlay `z-index:
 * 10000` with `section.chat-dock` (fixed, 9200) as its nearest
 * stacking-context ancestor, and `document.elementFromPoint(195, 160)` — the
 * centre of the sheet's search input — returning `button.banner-host__cap`.
 * Playwright refused the click with `banner-host ... intercepts pointer
 * events`, which is #1638.
 *
 * `ResponsiveDialogSurface` now portals to `document.body`, so there is no
 * z-index rule to test: the property is structural, and these shapes assert
 * it three ways — the surface is outside every dock, a dialog control is
 * reachable where the notice host paints, and the chrome that must stay
 * reachable does.
 *
 * WHAT THIS FIXTURE COMPOSES. The subject is a hit test, which no source scan
 * can see (`src-ui/AGENTS.md`: "DOM/source-string assertions do not establish
 * CSS layout, hit testing"). So: the REAL `BannerHost`, the REAL
 * `ResponsiveDialogSurface` (through real consumers' own class names, read
 * from those components rather than retyped), the REAL `PortableDraftsMenu`
 * and a REAL `NotificationCard`, rendered through `@testing-library/react`
 * and injected into a real Chromium page carrying `index.css` +
 * `BannerHost.css` + `chat.css` + `NotificationContainer.css` with every
 * `@import` resolved — the same harness as `BannerHost.touch-target.test.tsx`.
 * Because the surface portals, the fixture serializes `document.body` rather
 * than a render container: the portaled overlay lands beside the shell there,
 * which IS the shape under test.
 *
 * The shell containers (`.app__main`, `.chat-dock`, `.notification-container`)
 * are written as their product class names because their CSS is what decides
 * geometry and stacking; `assertTheDockWouldStillTrapASurface` keeps that
 * honest — if a dock ever stops being a stacking context these shapes prove
 * nothing and the file says so instead of passing.
 *
 * PRECONDITION: launches a real Chromium. Per this repo's browser-test
 * doctrine, a missing browser FAILS loudly rather than skipping.
 *
 * RESOURCE CLASSIFICATION: listed in `scripts/vitest-resource-manifest.mjs`'s
 * `PROCESS_HEAVY_VITEST_FILES`, same shape as the touch-target files.
 */

import { readFileSync } from 'node:fs';
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
} from '../../../../../tests/helpers/css-cascade-fixture';
import { bannerStore } from '../../../contexts/banner-store';
import { Button } from '../../Button';
import { PortableDraftsMenu } from '../../chat/PortableDraftsMenu';
import { ResponsiveDialogSurface } from '../../ResponsiveDialogSurface';
import { BannerHost } from '../BannerHost';
import { NotificationCard } from '../NotificationCard';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const BANNER_CSS_PATH = resolve(HERE, '../BannerHost.css');
const CHAT_CSS_PATH = resolve(HERE, '../../chat/chat.css');
const NOTIFICATION_CSS_PATH = resolve(HERE, '../NotificationContainer.css');
const NEW_CHAT_MODAL_PATH = resolve(HERE, '../../modals/NewChatModal.tsx');

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

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
  const css = [
    resolveCssImports(INDEX_CSS_PATH),
    resolveCssImports(BANNER_CSS_PATH),
    resolveCssImports(CHAT_CSS_PATH),
    resolveCssImports(NOTIFICATION_CSS_PATH),
  ].join('\n');
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
 * the shared `.responsive-surface-*` rules supply no `position` and no
 * background of their own (station#1616, and `FirstRunHomeChapter.css` says so
 * in its own docblock), and the feature classes that do live in `index.css`.
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

type DockSurface = 'modal' | 'bare-modal' | 'drafts' | 'none';

/** A modal dialog with a feature overlay class — the reported case. */
function ClassedModal() {
  const { overlayClassName, panelClassName } =
    surfaceClassesOf(NEW_CHAT_MODAL_PATH);
  return (
    <ResponsiveDialogSurface
      ariaLabel="New Chat"
      overlayClassName={overlayClassName}
      panelClassName={panelClassName}
      onClose={() => {}}
    >
      {Array.from({ length: 8 }, (_, index) => (
        <Button key={index}>{`Choose agent ${index + 1}`}</Button>
      ))}
    </ResponsiveDialogSurface>
  );
}

/**
 * A dialog that passes NO overlay class at all — the shape
 * `ConversationContextResetDialog`, `ConnectedStationBasisPane` and
 * `SessionOutputInspector` render. They paint no scrim, which is why the
 * discarded scrim-derived promotion would have left them broken; the portal
 * does not care what they paint.
 */
function BareModal() {
  return (
    <ResponsiveDialogSurface
      ariaLabel="Replace engine context"
      onClose={() => {}}
    >
      {Array.from({ length: 8 }, (_, index) => (
        <Button key={index}>{`Bare dialog control ${index + 1}`}</Button>
      ))}
    </ResponsiveDialogSurface>
  );
}

/** The real scrim-less, anchor-less popover whose promotion was a regression. */
function DraftsPopover() {
  return (
    <PortableDraftsMenu
      input="a draft"
      attachments={[]}
      open
      onOpenChange={() => {}}
      onRestore={() => {}}
    />
  );
}

function dockContents(surface: DockSurface) {
  if (surface === 'modal') return <ClassedModal />;
  if (surface === 'bare-modal') return <BareModal />;
  if (surface === 'drafts') return <DraftsPopover />;
  return <div className="chat-dock__body">Dock contents</div>;
}

/**
 * A real notification card inside the real wrappers that decide whether it can
 * be clicked at all. `.notification-container` is `pointer-events: none` and
 * only specific descendants opt back in — `.toast-stack__item` is the one the
 * live container wraps every transient in — so a card placed directly in the
 * container is unhittable no matter what the stacking says. The first draft of
 * this fixture did exactly that and reported the popover swallowing a click
 * that nothing could have received. `ToastCard` itself is module-local to
 * `NotificationContainer.tsx`; `NotificationCard` is the exported card with a
 * real control, and the wrappers around it are what this measures.
 */
function Chrome() {
  return (
    <div className="notification-container">
      <div className="toast-stack" data-count={1}>
        <div className="toast-stack__item" data-depth={0} data-front="true">
          <NotificationCard
            notification={{
              id: 'fixture-approval',
              source: 'fixture',
              category: 'approval',
              title: 'Approval requested',
              priority: 'high',
              status: 'delivered',
              createdAt: new Date(0).toISOString(),
            }}
            onDismiss={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

interface DockSpec {
  readonly className: string;
  readonly surface: DockSurface;
}

interface Shape {
  readonly name: string;
  readonly viewport: { width: number; height: number };
  readonly critical: boolean;
  readonly docks: readonly DockSpec[];
  /** Every control inside the dialog panel must hit-test to itself. */
  readonly expectsDialogReachable: boolean;
  /**
   * Additionally: the notice host must overlap a dialog control, and the
   * dialog must own those points. Only the phone shapes place the stack over
   * the sheet — at 1440x900 the sheet is centred and the notice band is not
   * on top of it, which is why this is per shape and not universal.
   */
  readonly expectsNoticeOverlap: boolean;
  /**
   * Whether the notification card's own control must hit-test to itself.
   * Recorded PER SHAPE rather than asserted universally, because the answer
   * differs by surface kind and the difference is the point: a dialog is
   * meant to supersede a toast (`NotificationContainer.css` says so), a
   * scrim-less popover is not.
   */
  readonly expectsChromeReachable: boolean;
}

const BOTTOM_DOCK = 'chat-dock chat-dock--bottom';
const MAXIMIZED_DOCK = 'chat-dock is-maximized chat-dock--bottom';

const SHAPES: readonly Shape[] = [
  {
    name: 'the reported case: a sheet in a bottom dock under a notice',
    viewport: PHONE,
    critical: false,
    docks: [{ className: BOTTOM_DOCK, surface: 'modal' }],
    expectsDialogReachable: true,
    expectsNoticeOverlap: true,
    expectsChromeReachable: false,
  },
  {
    name: "a maximized dock's sheet under #920's critical card",
    viewport: PHONE,
    critical: true,
    docks: [{ className: MAXIMIZED_DOCK, surface: 'modal' }],
    expectsDialogReachable: true,
    expectsNoticeOverlap: true,
    expectsChromeReachable: false,
  },
  {
    name: 'a dialog that paints no scrim and passes no overlay class',
    viewport: PHONE,
    critical: false,
    docks: [{ className: BOTTOM_DOCK, surface: 'bare-modal' }],
    expectsDialogReachable: true,
    expectsNoticeOverlap: false,
    expectsChromeReachable: false,
  },
  {
    name: 'two region docks, the dialog in one of them',
    viewport: DESKTOP,
    critical: false,
    docks: [
      { className: BOTTOM_DOCK, surface: 'modal' },
      { className: BOTTOM_DOCK, surface: 'none' },
    ],
    expectsDialogReachable: true,
    expectsNoticeOverlap: false,
    expectsChromeReachable: false,
  },
  {
    name: 'a desktop region-grid dock, the dialog inside it',
    viewport: DESKTOP,
    critical: false,
    docks: [{ className: BOTTOM_DOCK, surface: 'modal' }],
    expectsDialogReachable: true,
    expectsNoticeOverlap: false,
    expectsChromeReachable: false,
  },
  {
    name: 'only a scrim-less popover open: the toast stays reachable',
    viewport: DESKTOP,
    critical: false,
    docks: [{ className: BOTTOM_DOCK, surface: 'drafts' }],
    expectsDialogReachable: false,
    expectsNoticeOverlap: false,
    expectsChromeReachable: true,
  },
];

function buildFixtureHtml(shape: Shape): string {
  presentFixtureBanners(shape.critical);
  const { unmount } = render(
    <>
      <div className="app app--with-sidebar">
        <div className="app__main">
          <BannerHost connectionSlot={false} />
          {shape.docks.map((dock, index) => (
            <section
              // biome-ignore lint/suspicious/noArrayIndexKey: fixture order is the identity
              key={index}
              className={dock.className}
              data-region="bottom"
            >
              {dockContents(dock.surface)}
            </section>
          ))}
        </div>
      </div>
      <Chrome />
    </>,
  );
  // The surface portals to `document.body`, so the body IS the shape under
  // test: the shell, plus the overlay beside it rather than inside the dock.
  const markup = document.body.innerHTML;
  unmount();
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${buildFixtureCss()}</style>
  </head>
  <body>${markup}</body>
</html>`;
}

interface Measured {
  dockWouldTrap: boolean;
  dockZIndexes: string[];
  overlayInsideADock: boolean;
  overlayParent: string;
  overlayZIndex: string | null;
  hostZIndex: string;
  dialogControls: {
    control: string;
    point: { x: number; y: number };
    hit: string;
    hitsItself: boolean;
  }[];
  dialogOverlaps: {
    control: string;
    point: { x: number; y: number };
    hit: string;
    hitsItself: boolean;
  }[];
  chromeControls: {
    control: string;
    point: { x: number; y: number };
    hit: string;
    hitsItself: boolean;
  }[];
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'a dock surface renders outside the dock, so its declared layer is real (#1638, #1662)',
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
      const page = await browser.newPage({ viewport: shape.viewport });
      try {
        await page.setContent(buildFixtureHtml(shape));
        return await page.evaluate(() => {
          const describe_ = (element: Element | null) =>
            element
              ? `${element.tagName.toLowerCase()}${String(element.className).trim() ? `.${String(element.className).trim().split(/\s+/).join('.')}` : ''}`
              : 'null';
          const hitFor = (control: Element) => {
            const rect = control.getBoundingClientRect();
            const point = {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            };
            const hit = document.elementFromPoint(point.x, point.y);
            return {
              control: describe_(control),
              point,
              hit: describe_(hit),
              hitsItself: Boolean(
                hit && (hit === control || control.contains(hit)),
              ),
            };
          };

          const docks = Array.from(document.querySelectorAll('.chat-dock'));
          const host = document.querySelector('.banner-host');
          if (docks.length === 0 || !host) {
            throw new Error(
              `fixture did not render: docks=${docks.length} host=${Boolean(host)}`,
            );
          }
          const overlay = document.querySelector('.responsive-surface-overlay');
          const panel = overlay?.querySelector('.responsive-surface-panel');

          const bannerControls = Array.from(host.querySelectorAll('*')).filter(
            (element) => getComputedStyle(element).pointerEvents === 'auto',
          );

          // Points where a dialog control and a banner control overlap: the
          // dialog must own them.
          const dialogOverlaps: Measured['dialogOverlaps'] = [];
          for (const control of panel?.querySelectorAll('button') ?? []) {
            const controlBox = control.getBoundingClientRect();
            for (const banner of bannerControls) {
              const bannerBox = banner.getBoundingClientRect();
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
              dialogOverlaps.push({
                control: describe_(control),
                point,
                hit: describe_(hit),
                hitsItself: Boolean(
                  hit && (hit === control || control.contains(hit)),
                ),
              });
            }
          }

          const dialogControls = Array.from(
            panel?.querySelectorAll('button') ?? [],
          ).map(hitFor);

          const chromeControls = Array.from(
            document.querySelectorAll('.notification-container button'),
          ).map(hitFor);

          return {
            dockWouldTrap: docks.every((dock) => {
              const style = getComputedStyle(dock);
              return style.position !== 'static' && style.zIndex !== 'auto';
            }),
            dockZIndexes: docks.map((dock) => getComputedStyle(dock).zIndex),
            overlayInsideADock: Boolean(overlay?.closest('.chat-dock')),
            overlayParent: describe_(overlay?.parentElement ?? null),
            overlayZIndex: overlay ? getComputedStyle(overlay).zIndex : null,
            hostZIndex: getComputedStyle(host).zIndex,
            dialogControls,
            dialogOverlaps,
            chromeControls,
          };
        });
      } finally {
        await page.close();
      }
    }

    /**
     * These shapes only mean anything while a dock would still trap what it
     * mounts. If one stops being a stacking context, the portal is no longer
     * what keeps the surface reachable and every assertion below would pass
     * for the wrong reason.
     */
    function assertTheDockWouldStillTrapASurface(measured: Measured): void {
      if (!measured.dockWouldTrap) {
        throw new Error(
          '`.chat-dock` no longer creates a stacking context (computed ' +
            `z-index ${measured.dockZIndexes.join(', ')}), so a surface ` +
            'mounted inside it would reach --layer-dialog by itself and this ' +
            'file no longer models #1638. Re-point it at whatever ancestor ' +
            'traps a surface now, or retire it with the reason.',
        );
      }
    }

    test.each(SHAPES)(
      'the surface renders outside every dock: $name',
      async (shape) => {
        const measured = await measure(shape);
        assertTheDockWouldStillTrapASurface(measured);
        expect(
          measured.overlayInsideADock,
          'the surface is inside a dock again, so its declared --layer-dialog ' +
            `is clamped to the dock's own z-index (${measured.dockZIndexes.join(', ')}). ` +
            `Its parent is ${measured.overlayParent}.`,
        ).toBe(false);
        expect(measured.overlayParent).toBe('body');
      },
    );

    test.each(SHAPES.filter((shape) => shape.expectsDialogReachable))(
      'every control in the dialog hit-tests to itself: $name',
      async (shape) => {
        const measured = await measure(shape);
        assertTheDockWouldStillTrapASurface(measured);
        expect(
          measured.dialogControls.length,
          'the dialog rendered no control, so nothing was measured.',
        ).toBeGreaterThan(0);
        const unreachable = measured.dialogControls.filter(
          (entry) => !entry.hitsItself,
        );
        expect(
          unreachable,
          `a dialog control was covered (overlay z-index ${measured.overlayZIndex}, ` +
            `docks at ${measured.dockZIndexes.join(', ')}):\n${unreachable
              .map(
                (entry) =>
                  `  ${entry.control} at (${entry.point.x}, ${entry.point.y}) hit ${entry.hit}`,
              )
              .join('\n')}`,
        ).toEqual([]);
      },
    );

    test.each(SHAPES.filter((shape) => shape.expectsNoticeOverlap))(
      'the dialog owns the points where the notice host paints over it: $name',
      async (shape) => {
        const measured = await measure(shape);
        assertTheDockWouldStillTrapASurface(measured);

        // Power guard: with no overlap this proves nothing. The live report
        // was the notice's collapsed-stack cap over the sheet's search input.
        expect(
          measured.dialogOverlaps.length,
          'no dialog control overlaps a banner control, so this measurement ' +
            'proves nothing. The banner stack or the surface geometry moved — ' +
            'restore an overlap rather than deleting the test.',
        ).toBeGreaterThan(0);

        const stolen = measured.dialogOverlaps.filter(
          (entry) => !entry.hitsItself,
        );
        expect(
          stolen,
          `the notice host took a click from a dialog control (host z-index ${measured.hostZIndex}, ` +
            `overlay z-index ${measured.overlayZIndex}, docks at ${measured.dockZIndexes.join(', ')}):\n${stolen
              .map(
                (entry) =>
                  `  ${entry.control} at (${entry.point.x}, ${entry.point.y}) hit ${entry.hit}`,
              )
              .join('\n')}`,
        ).toEqual([]);
      },
    );

    test.each(SHAPES.filter((shape) => shape.expectsChromeReachable))(
      'the chrome stays reachable when only a popover is open: $name',
      async (shape) => {
        const measured = await measure(shape);
        assertTheDockWouldStillTrapASurface(measured);

        expect(
          measured.chromeControls.length,
          'the notification container rendered no control, so this shape ' +
            'cannot observe whether the chrome stays reachable.',
        ).toBeGreaterThan(0);

        const swallowed = measured.chromeControls.filter(
          (entry) => !entry.hitsItself,
        );
        expect(
          swallowed,
          'a scrim-less popover swallowed a click meant for the notification ' +
            `chrome (overlay z-index ${measured.overlayZIndex}):\n${swallowed
              .map(
                (entry) =>
                  `  ${entry.control} at (${entry.point.x}, ${entry.point.y}) hit ${entry.hit}`,
              )
              .join('\n')}`,
        ).toEqual([]);
      },
    );
  },
);

test.skipIf(chromiumAvailable)(
  'dock-surface stacking — Chromium not installed, cannot verify (#1638)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'dock-surface stacking checks (#1638) could not be run — this is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
