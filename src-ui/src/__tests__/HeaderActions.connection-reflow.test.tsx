/**
 * @vitest-environment jsdom
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

/**
 * archive#4474 — reproduces (and pins the fix for) "the connection-status
 * component reflows content" as it applies to `HeaderActions`' toolbar
 * connection chip (`ConnectionStatusDot` + `.app-toolbar__conn-state`,
 * `@kontourai/station-connect`'s `ConnectionStatusDot`), the ONE instance of
 * this status surface mounted on every page — see `HeaderActions.tsx`'s own
 * comment naming `ChatDockMobileConnection` as the mobile-dock twin, the
 * other consumer.
 *
 * jsdom does not lay out CSS (same precondition as
 * `BannerHost.touch-target.test.tsx` / `BannerHost.disclosure-overlap.test.tsx`),
 * so this renders the real `HeaderActions` component through
 * `@testing-library/react`, injects the resulting markup for several
 * connection states into a real Chromium page carrying the real, cascade-
 * resolved `index.css` + `components/chat/chat.css` (`.app-toolbar__conn*`
 * lives there, not in a component-local stylesheet — `HeaderActions.tsx`
 * imports no CSS of its own), and measures the actual rendered x-offset of a
 * fixed sibling control (`Open settings`, the last item in the action
 * cluster).
 *
 * Root cause: `.app-toolbar__conn-state` (`components/chat/chat.css`) was
 * `white-space: nowrap` with no reserved width, and the visible label text
 * differs in length across connection states ("Connected" vs "Reconnecting"
 * vs "Can't connect" vs "No Station" vs "Pair" — `HeaderActions.tsx`'s own
 * `connStateLabel`). `.app-toolbar__conn-name` (the identity chip, which
 * would otherwise be a second variable-width sibling) is hidden entirely
 * under the shell's mobile breakpoint (`index.css`, archive#3766), so on a
 * phone the STATE LABEL alone drives the connection chip's width — and every
 * other toolbar icon sitting after it in the same flex row
 * (`.app-toolbar__actions`) shifts horizontally when it changes.
 *
 * Two separate assertions, because the mobile breakpoint has a genuine,
 * documented exception this fix must not fight: `chat.css` deliberately
 * hides the state text for `connected`/`idle` on mobile ("the toolbar chip
 * stays compact … dot only while healthy"), so `connected` is narrower than
 * every news-carrying state THERE by design. The desktop-width test is the
 * full reproduction (state text is always shown, so `connected` participates
 * too).
 *
 * #1401 replaced the phone-width half. It used to pin that the states which
 * DO show text on mobile agree with each other in width — which they did,
 * via a 116px reservation, while agreeing on a position OUTSIDE the viewport:
 * `.app-toolbar__actions` is `flex-shrink: 0` and the brand bottoms out, so
 * the row's content width is viewport-independent and Settings sat at
 * x=377..421 at every phone width. Clipped on a 412px Pixel 7; past its own
 * centre, and so unreachable rather than merely clipped, below 399px. The two
 * properties are not both attainable here — holding the states to a common
 * width means reserving the longest (~102px natural), which still leaves the
 * row wider than a 390 or 402px viewport — so the reservation is released at
 * this breakpoint and the phone-width test now pins the property that was
 * being traded away. The agreement property is unaffected at desktop widths,
 * where the row has the room and the test above still enforces it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const CHAT_CSS_PATH = resolve(HERE, '../components/chat/chat.css');

function buildFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(CHAT_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

let connectionStatus: 'connected' | 'connecting' | 'error' = 'connected';
let connectionReason: string | null = null;

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionStatusDot: ({ status }: { status: string }) => (
    <span data-testid="connection-status" data-state={status} />
  ),
  useConnectionStatus: () => ({
    status: connectionStatus,
    reason: connectionReason,
    recheck: vi.fn(),
  }),
  // No pending record in this environment's real localStorage, so this
  // never needs to be mocked to reach `awaiting-approval` — archive#4512
  // review wires `reason === 'awaiting-approval'` into
  // `connectionIndicatorState` directly, which `renderMarkupForState` below
  // reaches through `connectionReason` alone.
  useConnections: () => ({
    activeConnection: {
      id: 'c1',
      name: 'Default',
      lastSuccessAt: '2026-08-18T00:00:00.000Z',
      endpoints: [],
    },
    connections: [
      {
        id: 'c1',
        name: 'Default',
        lastSuccessAt: '2026-08-18T00:00:00.000Z',
        endpoints: [],
      },
    ],
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({ data: { items: [], pendingCount: 0 } }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ supervisesBundledServer: true }),
}));

vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

vi.mock('../components/notifications/NotificationHistory', () => ({
  NotificationHistory: () => null,
}));

vi.mock('../components/header/HelpMenu', () => ({ HelpMenu: () => null }));
vi.mock('../components/header/OverflowMenu', () => ({
  OverflowMenu: () => null,
}));

/**
 * Every label-bearing chip state, not just the original three — archive#4512
 * review widened this after `needs-repair` and `awaiting-approval`
 * shipped two labels LONGER than any this guard previously reproduced
 * ("Needs re-pairing" ≈97px, "Awaiting approval" ≈102px vs "Can't connect"
 * ≈81px), and a straight revert of the reserved-width bump these two
 * required stayed green here: nothing exercised the strings it was sized
 * for.
 */
type ChipState =
  | 'connected'
  | 'connecting'
  | 'error'
  | 'needs-credential'
  | 'needs-repair'
  | 'awaiting-approval';

function statusAndReasonFor(state: ChipState): {
  status: 'connected' | 'connecting' | 'error';
  reason: string | null;
} {
  switch (state) {
    case 'connected':
      return { status: 'connected', reason: null };
    case 'connecting':
      return { status: 'connecting', reason: null };
    case 'error':
      return { status: 'error', reason: 'unreachable' };
    case 'needs-credential':
      return { status: 'error', reason: 'authentication-failed' };
    case 'needs-repair':
      return { status: 'error', reason: 'identity-mismatch' };
    case 'awaiting-approval':
      return { status: 'error', reason: 'awaiting-approval' };
  }
}

async function renderMarkupForState(state: ChipState): Promise<string> {
  const { status, reason } = statusAndReasonFor(state);
  connectionStatus = status;
  connectionReason = reason;
  const { HeaderActions } = await import('../components/header/HeaderActions');
  const { container, unmount } = render(
    <HeaderActions
      helpPrompts={[]}
      settingsShortcut="⌘,"
      showHelp={false}
      showNotifications={false}
      showOverflow={false}
      userInitials="ST"
      onCloseHelp={() => {}}
      onCloseNotifications={() => {}}
      onCloseOverflow={() => {}}
      onHelpPrompt={() => {}}
      onOpenConnections={() => {}}
      onOpenProfile={() => {}}
      onToggleHelp={() => {}}
      onToggleNotifications={() => {}}
      onToggleSettings={() => {}}
      onToggleOverflow={() => {}}
      onViewAllNotifications={() => {}}
    />,
  );
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function buildFixtureHtml(markup: string): string {
  const css = buildFixtureCss();
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${markup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'HeaderActions connection chip does not reflow sibling toolbar controls (station#4474)',
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
    });

    async function settingsX(
      markup: string,
      viewport: { width: number; height: number },
    ): Promise<number> {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(buildFixtureHtml(markup));
        const box = await page
          .locator('[aria-label="Open settings"]')
          .boundingBox();
        expect(box, 'Open settings control not visible').not.toBe(null);
        return box!.x;
      } finally {
        await page.close();
      }
    }

    test('the Settings control holds its position across every label-bearing state on a desktop-width toolbar', async () => {
      // Every visibly different label this chip can show — including the two
      // widest, "Needs re-pairing" and "Awaiting approval" — must not move any
      // sibling control.
      //
      // #1536 F removed `connected` from this list, and that is a trade, not
      // an oversight: its single-Station form now renders NO label at all
      // (`compactConn` in `HeaderActions.tsx`), so a connect or a drop moves
      // the cluster once by design — the same trade #1401 already made at
      // phone width, where `connected` has been dot-only since archive#3311.
      // What that buys is measured by the test below. The reservation this
      // file pinned is still what holds the remaining states to one width, and
      // `connected` is the only state leaving the set.
      const viewport = { width: 1280, height: 400 };
      const states: ChipState[] = [
        'connecting',
        'error',
        'needs-credential',
        'needs-repair',
        'awaiting-approval',
        'connecting',
      ];
      const xs: number[] = [];
      for (const state of states) {
        xs.push(await settingsX(await renderMarkupForState(state), viewport));
      }

      expect(
        xs,
        'Settings control shifted horizontally as the connection chip flipped state — the chip must reserve its own width rather than reflow the rest of the toolbar.',
      ).toEqual(states.map(() => xs[0]));
    });

    test('the collapsed connected chip reclaims the width the label-bearing states reserve (#1536 F)', async () => {
      // The point of collapsing it: a fact that never changes while you work
      // stops holding ~150px of the row that runs out of width first. Measured
      // against the widest label-bearing state in the same fixture, so this
      // cannot pass on an absolute number that drifts with the font.
      const viewport = { width: 1280, height: 400 };
      const chipWidth = async (state: ChipState): Promise<number> => {
        const page = await browser.newPage({ viewport });
        try {
          await page.setContent(
            buildFixtureHtml(await renderMarkupForState(state)),
          );
          const box = await page.locator('.app-toolbar__conn').boundingBox();
          expect(box, `connection chip not visible in ${state}`).not.toBe(null);
          return box!.width;
        } finally {
          await page.close();
        }
      };

      const collapsed = await chipWidth('connected');
      const widest = await chipWidth('awaiting-approval');

      // 44px is the hit-target floor the collapsed form sets for itself
      // (`.app-toolbar__conn--compact`), and it must not have grown a label
      // back: a chip still rendering "Connected · Default" measures ~200px.
      expect(Math.round(collapsed)).toBeLessThanOrEqual(56);
      expect(Math.round(collapsed)).toBeGreaterThanOrEqual(44);
      expect(collapsed).toBeLessThan(widest - 80);
    });

    /**
     * #1536 C3: the chip read "<state> · Default" with the middle dot detached
     * from the state word and leading the identity — because the separator was
     * the IDENTITY's `::before` while the state label sat centred inside its
     * 116px reservation, leaving ~23px of empty box between the two.
     *
     * MEASURED ON A NON-COMPACT STATE. #1536 F collapsed the `connected` chip
     * to its status dot when there is one Station and an identity to name
     * (`compactConn`), so that state renders neither part and has no separator
     * to place. Every label-bearing state still renders both, which is where
     * the defect lived and where it must stay fixed.
     */
    async function measureChip(
      state: ChipState,
      viewport: { width: number; height: number },
    ) {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(
          buildFixtureHtml(await renderMarkupForState(state)),
        );
        return await page.evaluate(() => {
          const stateSpan = document.querySelector('.app-toolbar__conn-state');
          const nameSpan = document.querySelector('.app-toolbar__conn-name');
          if (!stateSpan) throw new Error('no state span');
          const textRight = (element: Element): number | null => {
            const node = element.firstChild;
            if (!node) return null;
            const range = document.createRange();
            range.selectNodeContents(element);
            const rect = range.getBoundingClientRect();
            return rect.width === 0 ? null : rect.right;
          };
          const textLeft = (element: Element): number | null => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const rect = range.getBoundingClientRect();
            return rect.width === 0 ? null : rect.left;
          };
          return {
            stateAfter: window.getComputedStyle(stateSpan, '::after').content,
            nameBefore: nameSpan
              ? window.getComputedStyle(nameSpan, '::before').content
              : null,
            nameVisible: nameSpan
              ? nameSpan.getBoundingClientRect().width > 0
              : false,
            gapBetweenPhrases:
              nameSpan && textRight(stateSpan) !== null
                ? (textLeft(nameSpan) ?? 0) - (textRight(stateSpan) ?? 0)
                : null,
          };
        });
      } finally {
        await page.close();
      }
    }

    test('the separator belongs to the part before it, next to the state it follows', async () => {
      const chip = await measureChip('connecting', {
        width: 1280,
        height: 400,
      });

      // Structural: the dot is the STATE's trailing separator, not the
      // identity's leading one, so inline layout puts it against "Connected".
      expect(chip.stateAfter).toBe('" · "');
      expect(chip.nameBefore).toBe('none');
      expect(chip.nameVisible).toBe(true);
      // Geometric: and the reservation's slack no longer splits the phrase.
      // Measured in this fixture, not estimated: 36.0px with the label
      // centred inside its reservation, 18.0px with it aligned to the end.
      // Each half of the fix reddens this on its own.
      expect(chip.gapBetweenPhrases).not.toBeNull();
      expect(chip.gapBetweenPhrases as number).toBeLessThanOrEqual(24);
    });

    test('prints no separator on a phone, where the part it leads into is hidden', async () => {
      // `:has()` cannot see `display: none`, so the breakpoint that hides the
      // identity has to suppress the dot as well — otherwise the fix trades a
      // leading dot for a trailing one. `needs-credential` keeps its label
      // there ("dot only while healthy" only covers connected/idle).
      const chip = await measureChip('needs-credential', {
        width: 390,
        height: 200,
      });

      expect(chip.nameVisible).toBe(false);
      expect(chip.stateAfter).toBe('none');
    });

    test('the connection chip fits the width a phone row can spare', async () => {
      // #1401. NOT a position assertion: this fixture mounts `HeaderActions`
      // alone, so the cluster starts at x=0 and the Settings control is
      // always "inside the viewport" here no matter how wide the chip grows —
      // an earlier version of this test asserted its right edge and passed
      // with the defect restored, which is how that was found. The chip's own
      // width is the thing this fixture can actually see, so pin that against
      // the budget the real row leaves it.
      //
      // Budget at 390px, measured on a running app in the `error` state:
      // the row's left side (hamburger, logo, brand at its floor, gaps) ends
      // at x=126 and `.app-toolbar__actions` carries three further 44px
      // controls plus three 4px gaps = 144. 390 - 126 - 144 leaves **120px**
      // for the connection chip. With the 116px reservation it rendered at
      // 151px and put Settings at x=377..421 — past a 390px viewport, past a
      // 412px Pixel 7, and past its own centre (x≈399) below 399px, which is
      // unreachable rather than merely clipped. Released, the chip renders at
      // 114px in this state and the row ends at 384.
      const viewport = { width: 390, height: 200 };
      const CHIP_BUDGET_PX = 120;
      const states: ChipState[] = [
        'connecting',
        'error',
        'needs-credential',
        'needs-repair',
        'awaiting-approval',
      ];
      for (const state of states) {
        const page = await browser.newPage({ viewport });
        try {
          await page.setContent(
            buildFixtureHtml(await renderMarkupForState(state)),
          );
          const box = await page.locator('.app-toolbar__conn').boundingBox();
          expect(box, `connection chip not visible in ${state}`).not.toBe(null);
          expect(
            Math.round(box!.width),
            `The connection chip is wider than the ${CHIP_BUDGET_PX}px a ${viewport.width}px row can spare in the ${state} state, which pushes the Settings control off the screen (#1401).`,
          ).toBeLessThanOrEqual(CHIP_BUDGET_PX);
        } finally {
          await page.close();
        }
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'HeaderActions connection-chip reflow — Chromium not installed, cannot verify (station#4474)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'connection-chip reflow fix (station#4474) could not be checked — ' +
        'this is a missing precondition, not a passing check. Install it ' +
        'with `npm run install:playwright` and re-run.',
    );
  },
);
