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
 *   .banner-host            z-index 9201, pointer-events: none
 *   .new-chat-modal__overlay z-index 10000, nearest stacking-context ancestor
 *                            section.chat-dock (position: fixed, z-index 9200)
 *   document.elementFromPoint(195, 160)  // centre of the sheet's search input
 *     -> button.banner-host__cap "1 more notice, 1 informational"
 *
 * and Playwright reported the issue's own sentence, verbatim:
 * `<button ... class="banner-host__cap banner-host__cap--info">1 more notice,
 * 1 informational</button> from <section ... class="banner-host ...">…</section>
 * subtree intercepts pointer events`.
 *
 * WHY IT HAPPENS. `.chat-dock` is `position: fixed; z-index: var(--layer-dock)`,
 * so it is a stacking context, and `ChatDock.tsx` renders `ChatDockModalStack`
 * INSIDE it. Every dock dialog — New Chat, the task switcher, the model
 * picker, the overflow sheet — therefore paints at the dock's own 9200 no
 * matter that `.responsive-surface-overlay` declares
 * `z-index: var(--layer-dialog) !important` (10000). `BannerHost.css` raises
 * the host to `--layer-dock + 1` where the dock leaves no column to inset
 * into (a bottom dock on desktop, every dock mode on mobile) so a blocking
 * notice stays reachable — and that raise, meant for the dock's chrome,
 * lands one above every dialog the dock contains. `tokens.css` says the
 * ordering it broke out loud: "passive notices remain below active dialogs".
 *
 * The interceptor is a REAL control, not a transparent container: the host
 * and its items are `pointer-events: none` and only the cap / dismiss /
 * collapse / action rectangles opt back in. So `pointer-events` is already
 * right here and the fix is the ordering — `--banner-dock-supersede` yields
 * to `--layer-notice` while a `.responsive-surface-overlay` is open in the
 * shell.
 *
 * WHAT THIS FIXTURE COMPOSES, AND WHY IT NEEDS THE DOCK. The subject is a
 * hit test, which no source scan can see (`src-ui/AGENTS.md`:
 * "DOM/source-string assertions do not establish CSS layout, hit testing").
 * So: the REAL `BannerHost` and the REAL `ResponsiveDialogSurface`, rendered
 * through `@testing-library/react`, injected into a real Chromium page
 * carrying `index.css` + `BannerHost.css` with every `@import` resolved —
 * the same harness as `BannerHost.touch-target.test.tsx`. The shell
 * containers around them (`.app__main`, `.chat-dock`) are the load-bearing
 * part: put the dialog anywhere else and it reaches `--layer-dialog` in the
 * root stacking context, outranks the banner on its own, and the fixture
 * measures nothing. `assertTheDockStillTrapsItsDialogs` keeps that honest —
 * if `.chat-dock` ever stops being a stacking context this file fails loudly
 * rather than passing for the wrong reason.
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
function presentFixtureBanners(): void {
  act(() => {
    bannerStore.present({
      id: 'station-1638:front',
      priority: 10,
      tone: 'info',
      message: 'This project has no Builder runs yet',
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
 * The overlay and panel class names `NewChatModal.tsx` passes to
 * `ResponsiveDialogSurface`. Read from the component rather than retyped, so
 * a rename there cannot leave this fixture measuring geometry no dialog has:
 * both classes live in `index.css`, and the shared `.responsive-surface-*`
 * rules alone supply no `position` (station#1616).
 */
function newChatModalSurfaceClasses(): {
  overlayClassName: string;
  panelClassName: string;
} {
  const source = readFileSync(NEW_CHAT_MODAL_PATH, 'utf8');
  const overlay = /overlayClassName="([^"]+)"/.exec(source)?.[1];
  const panel = /panelClassName="([^"]+)"/.exec(source)?.[1];
  if (!overlay || !panel) {
    throw new Error(
      'NewChatModal.tsx no longer passes literal overlayClassName/' +
        'panelClassName to ResponsiveDialogSurface, so this fixture can no ' +
        'longer compose the surface the issue was reported against. Point it ' +
        'at whatever the modal passes now rather than hard-coding the old ' +
        'class names.',
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
  const { overlayClassName, panelClassName } = newChatModalSurfaceClasses();
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

function renderBannerHostMarkup(): string {
  presentFixtureBanners();
  const { container, unmount } = render(<BannerHost connectionSlot={false} />);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

/**
 * The shell ancestry the defect lives in: `.app__main` is the positioned
 * container both the host and the dock sit in, and `.chat-dock` is the
 * stacking context that traps its own dialogs.
 */
function buildFixtureHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${buildFixtureCss()}</style>
  </head>
  <body>
    <div class="app app--with-sidebar">
      <div class="app__main">
        ${renderBannerHostMarkup()}
        <section class="chat-dock chat-dock--bottom">${renderDialogMarkup()}</section>
      </div>
    </div>
  </body>
</html>`;
}

interface Measured {
  dockTrapsDialogs: boolean;
  dockZIndex: string;
  hostZIndex: string;
  overlayZIndex: string;
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

    async function measure(): Promise<Measured> {
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.setContent(buildFixtureHtml());
        return await page.evaluate(() => {
          const describe_ = (element: Element | null) =>
            element
              ? `${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/).join('.')}`
              : 'null';
          const boxes = (element: Element) => element.getBoundingClientRect();

          const dock = document.querySelector('.chat-dock');
          const host = document.querySelector('.banner-host');
          const overlay = document.querySelector('.responsive-surface-overlay');
          const panel = document.querySelector('.responsive-surface-panel');
          if (!dock || !host || !overlay || !panel) {
            throw new Error(
              `fixture did not render: dock=${Boolean(dock)} host=${Boolean(host)} overlay=${Boolean(overlay)} panel=${Boolean(panel)}`,
            );
          }
          const dockStyle = getComputedStyle(dock);

          // Only the rectangles that actually take pointer events can
          // intercept: the host and its items are `pointer-events: none`.
          const bannerControls = Array.from(host.querySelectorAll('*')).filter(
            (element) => getComputedStyle(element).pointerEvents === 'auto',
          );

          const overlapping: Measured['overlapping'] = [];
          for (const control of panel.querySelectorAll('button')) {
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
            dockTrapsDialogs:
              dockStyle.position !== 'static' && dockStyle.zIndex !== 'auto',
            dockZIndex: dockStyle.zIndex,
            hostZIndex: getComputedStyle(host).zIndex,
            overlayZIndex: getComputedStyle(overlay).zIndex,
            overlapping,
          };
        });
      } finally {
        await page.close();
      }
    }

    /**
     * The fixture only measures the defect while the dock still traps the
     * dialogs it mounts. If it stops doing that, every assertion below would
     * pass because the dialog reached `--layer-dialog` on its own — a green
     * for the wrong reason.
     */
    function assertTheDockStillTrapsItsDialogs(measured: Measured): void {
      if (!measured.dockTrapsDialogs) {
        throw new Error(
          '`.chat-dock` no longer creates a stacking context (computed ' +
            `z-index ${measured.dockZIndex}), so a dialog mounted inside it ` +
            'now reaches --layer-dialog by itself and this fixture no longer ' +
            'models #1638. Re-point it at whatever ancestor traps a dialog ' +
            'now, or retire it with the reason.',
        );
      }
    }

    test('a control inside the open surface hit-tests to itself where the banner paints over it', async () => {
      const measured = await measure();
      assertTheDockStillTrapsItsDialogs(measured);

      // Power guard: without a real overlap this assertion is vacuous. The
      // live report was the cap over the sheet's search input; here it is the
      // cap and the dismiss/collapse row over the surface's own controls.
      expect(
        measured.overlapping.length,
        'no control inside the modal surface overlaps a banner control, so ' +
          'this measurement proves nothing. The banner stack or the surface ' +
          'geometry moved — restore an overlap rather than deleting the test.',
      ).toBeGreaterThan(0);

      const stolen = measured.overlapping.filter((entry) => !entry.hitsItself);
      expect(
        stolen,
        'the banner host took a click from a control inside an open modal ' +
          `surface (host z-index ${measured.hostZIndex}, overlay z-index ` +
          `${measured.overlayZIndex} trapped by .chat-dock at ` +
          `${measured.dockZIndex}):\n${stolen
            .map(
              (entry) =>
                `  ${entry.control} at (${entry.point.x}, ${entry.point.y}) hit ${entry.hit} (${entry.banner})`,
            )
            .join('\n')}`,
      ).toEqual([]);
    });

    test('the notice returns to its own named layer while the surface is open', async () => {
      const measured = await measure();
      assertTheDockStillTrapsItsDialogs(measured);
      // `--layer-notice`, the passive-notice layer `tokens.css` names — not
      // `--layer-dock + 1`, which is what put it over the dialog. Stated as a
      // number because the hit test above cannot distinguish "yielded to the
      // notice layer" from "yielded far enough by accident".
      expect(measured.hostZIndex).toBe('9000');
    });
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
