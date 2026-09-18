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
 * imports no CSS of its own). Desktop tests measure the rendered x-offset of
 * the avatar (the last laid-out control there — the `⋯` overflow is
 * `display: none` at desktop widths, and the phone-only Settings gear that
 * used to trail it is gone; Settings lives in the sidebar drawer's footer).
 * Phone tests measure the action cluster's own width across states.
 *
 * Root cause: `.app-toolbar__conn-state` (`components/chat/chat.css`) was
 * `white-space: nowrap` with no reserved width, and the visible label text
 * differs in length across connection states ("Connected" vs "Reconnecting"
 * vs "Can't connect" vs "No Station" vs "Pair" — `HeaderActions.tsx`'s own
 * `connStateLabel`). `.app-toolbar__conn-name` (the identity chip, which
 * would otherwise be a second variable-width sibling) is hidden entirely
 * under the shell's mobile breakpoint (`index.css`, archive#3766).
 *
 * Two viewports, because the two rows now hold the contract differently. At
 * desktop widths the state text always shows, so the chip reserves its own
 * width (the 116px `min-width`) and the tests pin every label-bearing state
 * to one trailing-control position. On a phone the chip is dot-only in EVERY
 * state — the banner layer announces the states that need a decision, and
 * the drawer footer owns Settings — so there is no label width left to
 * reserve and station#4474's contract holds there by construction: the tests
 * pin that no state lays out any text and the cluster measures identical
 * across states.
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
  ConnectionStatusDot: ({
    status,
    size = 8,
  }: {
    status: string;
    size?: number;
  }) => (
    <span
      data-testid="connection-status"
      data-state={status}
      // Sized from the prop, not from a literal: the real dot is `size` wide
      // in every state (the alert branch's triangle takes the same `size`),
      // and the row bound this file asserts against counts it. A zero-width
      // stand-in would leave the fixture's chip lighter than the budget and
      // quietly spend that slack; a hardcoded 7 would stop tracking the call
      // site the moment it changed. `flexShrink` mirrors the real component.
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flexShrink: 0,
      }}
    />
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

/**
 * #1132: drivable, because the notification badge is an in-flow flex child of
 * the same `flex-shrink: 0` cluster the connection chip sits in, so its width
 * is row width — and `min-width: 18px; padding: 0 5px` is a floor, not a
 * ceiling. A fixture pinned at zero cannot see that at all.
 */
let attentionPendingCount = 0;

vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({
    data: { items: [], pendingCount: attentionPendingCount },
  }),
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
      showProfileMenu={false}
      onCloseProfileMenu={vi.fn()}
      onToggleProfileMenu={vi.fn()}
      userInitials="ST"
      onCloseHelp={() => {}}
      onCloseNotifications={() => {}}
      onCloseOverflow={() => {}}
      onHelpPrompt={() => {}}
      onOpenConnections={() => {}}
      onOpenProfile={() => {}}
      onOpenHelp={() => {}}
      onOpenNotifications={() => {}}
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
      attentionPendingCount = 0;
    });

    /**
     * The x of the row's TRAILING control — the sibling furthest from the chip,
     * so any width the chip fails to reserve shows up here.
     *
     * The avatar: the `⋯` overflow is `display: none` at desktop widths and
     * the phone-only Settings gear that used to trail the avatar is gone
     * (Settings lives in the sidebar drawer's footer), so on this 1280px
     * fixture the avatar is the last laid-out control. The contract
     * station#4474 pinned is about the chip not reflowing its siblings, and
     * it holds for whichever sibling is last.
     */
    async function trailingControlX(
      markup: string,
      viewport: { width: number; height: number },
    ): Promise<number> {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(buildFixtureHtml(markup));
        const box = await page
          .locator('[aria-label="Profile and settings"]')
          .boundingBox();
        expect(box, 'trailing toolbar control not visible').not.toBe(null);
        return box!.x;
      } finally {
        await page.close();
      }
    }

    /**
     * station#1401, retired arithmetic. This used to pin that the widest
     * labelled cluster still fits at the first width that keeps the label
     * (375px), against a 396px row budget derived term by term. There is no
     * label anymore: the phone chip is dot-only in every state, so the
     * cluster cannot grow with the connection state and the property worth
     * pinning is invariance, not fit. Every news-carrying state — including
     * the two longest labels the old budget was written for ("Needs
     * re-pairing", "Awaiting approval") — must lay out zero text and measure
     * the same cluster width, and the chip must sit at the 44px touch floor.
     * A regressed label (or a re-added reservation) shows up here as a wider
     * cluster in exactly that state.
     */
    test('the phone cluster is invariant across every state — dot-only by construction (#1401)', async () => {
      const viewport = { width: 390, height: 200 };
      const states: ChipState[] = [
        'connected',
        'connecting',
        'error',
        'needs-credential',
        'needs-repair',
        'awaiting-approval',
      ];
      const clusterWidths: number[] = [];
      for (const state of states) {
        const page = await browser.newPage({ viewport });
        try {
          await page.setContent(
            buildFixtureHtml(await renderMarkupForState(state)),
          );
          const measured = await page.evaluate(() => {
            const cluster = document.querySelector<HTMLElement>(
              '.app-toolbar__actions',
            );
            const boxes = Array.from(cluster?.children ?? [])
              .map((child) => child.getBoundingClientRect())
              .filter((box) => box.width > 0);
            if (!boxes.length) throw new Error('no toolbar controls rendered');
            const chip =
              document.querySelector<HTMLElement>('.app-toolbar__conn');
            if (!chip) throw new Error('connection chip not found');
            // Absent in the collapsed `connected` form (`compactConn`
            // renders no span at all); `display: none` in every other state
            // at this breakpoint. Either way it lays out no boxes.
            const label = document.querySelector<HTMLElement>(
              '.app-toolbar__conn-state',
            );
            return {
              content:
                Math.max(...boxes.map((box) => box.right)) -
                Math.min(...boxes.map((box) => box.left)),
              chipWidth: chip.getBoundingClientRect().width,
              // Laid out, not merely present: `display: none` is exactly what
              // this test is about, and a hidden span has no boxes.
              labelBoxes: label?.getClientRects().length ?? 0,
              accessibleName: chip.getAttribute('aria-label'),
            };
          });
          expect(
            measured.labelBoxes,
            `the ${state} state lays out chip text on a phone — the chip is dot-only there`,
          ).toBe(0);
          expect(
            Math.round(measured.chipWidth),
            `the ${state} chip is wider than the 44px touch floor on a phone`,
          ).toBeLessThanOrEqual(44);
          expect(
            measured.accessibleName,
            `the ${state} chip must keep its words in the accessible name`,
          ).toBeTruthy();
          clusterWidths.push(Math.round(measured.content * 100) / 100);
        } finally {
          await page.close();
        }
      }
      expect(
        clusterWidths,
        'The phone action cluster changed width as the connection chip flipped state — the chip must not reflow the toolbar.',
      ).toEqual(states.map(() => clusterWidths[0]));
    });

    test('the trailing control holds its position across every label-bearing state on a desktop-width toolbar', async () => {
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
        xs.push(
          await trailingControlX(await renderMarkupForState(state), viewport),
        );
      }

      expect(
        xs,
        'The trailing toolbar control shifted horizontally as the connection chip flipped state — the chip must reserve its own width rather than reflow the rest of the toolbar.',
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

      /** Any sibling icon button, for the one-button-size comparison below. */
      const siblingWidth = async (): Promise<number> => {
        const page = await browser.newPage({ viewport });
        try {
          await page.setContent(
            buildFixtureHtml(await renderMarkupForState('connected')),
          );
          const box = await page
            .locator('[aria-label="Notifications"]')
            .boundingBox();
          expect(box, 'notifications control not visible').not.toBe(null);
          return box!.width;
        } finally {
          await page.close();
        }
      };

      const collapsed = await chipWidth('connected');
      const widest = await chipWidth('awaiting-approval');
      const sibling = await siblingWidth();

      // #1552 D1: the collapsed chip is the SAME size as its siblings, which is
      // the whole of "one button size" — asserted as an equality against a
      // measured sibling rather than as the literal 44px this used to pin, so it
      // cannot pass while the row holds two different box sizes and cannot red
      // merely because the shared size changed. (It was 44px on every pointer,
      // making the smallest-content control the largest box in the row; the 44px
      // floor still applies under the coarse-pointer query, where it is a WCAG
      // 2.5.5 obligation rather than a look.)
      expect(Math.round(collapsed)).toBe(Math.round(sibling));
      // And it must not have grown a label back: a chip still rendering
      // "Connected · Default" measures ~200px.
      expect(collapsed).toBeLessThan(widest - 80);
    });

    /**
     * The row's membership, both directions. The desktop row is three named
     * controls (Layout, the status dot, Notifications, the avatar — of which
     * `HeaderActions` renders three; Layout is `RegionToolbarControls`, a
     * sibling in the toolbar, not in this cluster). The phone row is the
     * connection dot, Notifications, and the `⋯` overflow — no avatar (it is
     * `--secondary` there) and no Settings gear: Settings lives in the
     * sidebar drawer's footer, which the hamburger opens.
     *
     * Added because a fault injection went green without it, and kept
     * because a `display` rule can fail either way: a regressed gear (or a
     * regressed avatar/overflow) changes this inventory, and
     * `tests/toolbar-reachability.spec.ts` measures the same inventory
     * against the running app.
     */
    test('the fine-pointer row holds three named controls; a phone holds the dot, the bell, and the overflow', async () => {
      const inventory = async (viewport: {
        width: number;
        height: number;
      }): Promise<string[]> => {
        const page = await browser.newPage({ viewport });
        try {
          await page.setContent(
            buildFixtureHtml(await renderMarkupForState('connected')),
          );
          return await page.evaluate(() =>
            [
              ...document.querySelectorAll<HTMLElement>(
                '.app-toolbar__actions button',
              ),
            ]
              // Laid out, not merely present: `display: none` is exactly what
              // this test is about, and a hidden control has no boxes.
              .filter((button) => button.getClientRects().length > 0)
              .map(
                (button) =>
                  button.getAttribute('aria-label') ??
                  button.getAttribute('title') ??
                  (button.textContent || '').trim(),
              ),
          );
        } finally {
          await page.close();
        }
      };

      const desktop = await inventory({ width: 1280, height: 400 });
      expect(desktop).toEqual([
        'Manage Stations — Connected · Default',
        'Notifications',
        'Profile and settings',
      ]);
      expect(desktop).not.toContain('Open settings');

      // The `connected` fixture renders the chip compact (dot-only) at both
      // widths, so the phone inventory names the chip by its accessible
      // name — the same string as desktop here.
      const phone = await inventory({ width: 390, height: 600 });
      expect(phone).toEqual([
        'Manage Stations — Connected · Default',
        'Notifications',
        'More actions',
      ]);
      expect(phone).not.toContain('Profile and settings');
      expect(phone).not.toContain('Open settings');
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

    test('lays out no chip text on a phone, so there is no separator to place', async () => {
      // The state span itself is `display: none` at this breakpoint, and a
      // `::after` on a hidden element renders nothing — so the trailing "· "
      // the desktop chip prints after the state cannot appear here either.
      // `measureChip` still finds the span in the DOM (it is hidden, not
      // absent) and reads zero text geometry out of it.
      const chip = await measureChip('needs-credential', {
        width: 390,
        height: 200,
      });

      expect(chip.nameVisible).toBe(false);
      expect(chip.gapBetweenPhrases).toBeNull();
    });

    /**
     * #1132, retired breakpoint. This used to pin that the chip drops its
     * label below the width the row can hold (375px keeps it, 374px drops
     * it). There is no label to drop anymore: the phone chip is dot-only in
     * every state, so what this pins instead is that the error state — the
     * one whose "Can't connect" text used to survive here — lays out no text
     * at any phone width while keeping its words in the accessible name. A
     * screen reader reads the same sentence whatever the viewport, because
     * the name is the button's `aria-label` and never this span's text.
     *
     * WHAT THIS FIXTURE CAN SEE: the chip's own box and the button's
     * accessible name, in a real Chromium page with the real stylesheets. It
     * cannot see the row's absolute geometry — `HeaderActions` mounts alone
     * here, so every control is "inside the viewport" whatever the chip does.
     * The reachability claim itself is browser-measured against the whole app
     * in `tests/toolbar-reachability.spec.ts`.
     */
    test('the error chip lays out no text at phone widths, keeping its accessible name (#1132)', async () => {
      const measure = async (width: number) => {
        const page = await browser.newPage({
          viewport: { width, height: 200 },
        });
        try {
          await page.setContent(
            buildFixtureHtml(await renderMarkupForState('error')),
          );
          return await page.evaluate(() => {
            const button = document.querySelector<HTMLElement>(
              '[data-testid="app-toolbar-connection"]',
            );
            const label = document.querySelector<HTMLElement>(
              '.app-toolbar__conn-state',
            );
            if (!button || !label) throw new Error('connection chip not found');
            return {
              chipWidth: Math.round(button.getBoundingClientRect().width),
              labelBoxes: label.getClientRects().length,
              accessibleName: button.getAttribute('aria-label'),
            };
          });
        } finally {
          await page.close();
        }
      };

      // Both sides of the retired breakpoint: the label stays gone above and
      // below it, and the chip stays at the touch floor.
      for (const width of [375, 374, 360]) {
        const measured = await measure(width);
        expect(
          measured.labelBoxes,
          `the error state lays out chip text at ${width}px — the phone chip is dot-only`,
        ).toBe(0);
        expect(measured.chipWidth).toBeLessThanOrEqual(44);
        expect(measured.accessibleName).toContain("Can't connect");
      }
    });

    /**
     * #1132. The dot-only chip is a BOUND only if every member of the row is
     * bounded, and one was not: the notification badge is an in-flow flex child
     * of the same `flex-shrink: 0` cluster, and `chat.css`'s
     * `min-width: 18px; padding: 0 5px` is a floor. Measured in this fixture
     * before the cap: 18.00px at one digit, 21.80px at "12", 23.91px at "99",
     * 28.59px at "123", 35.58px at "1234" — so a person with a hundred pending
     * items grew the cluster ~10px past the width the tests above pin.
     *
     * Both halves, because either alone is satisfiable while the row is still
     * unbounded: the GLYPH is capped at two characters, and the resulting BOX
     * is no wider than a two-character badge. A cap that rendered "9999+"
     * would pass the first and fail the second.
     *
     * No pixel figure is asserted here, and two attempts to assert one both
     * red on CI. Glyph metrics are platform-specific: the badge is 23.80px on
     * macOS and 25.34px on the Linux runner, and "+" is NARROWER than a digit
     * on one and WIDER on the other, so even "no wider than two digits" is a
     * platform claim rather than a property.
     *
     * What is a property, and is all the row arithmetic needs, is that the
     * badge STOPS GROWING: past the cap its width is the same whatever the
     * count, so a member that was unbounded in the count is now a constant.
     * The size of that constant is a per-platform measurement, recorded in
     * `chat.css` as a macOS figure. Nothing enforces that figure: the e2e
     * never renders a badge at all, and at its 360px case the label is
     * suppressed anyway, so the row there sits nowhere near the bound. That
     * gap is station#1721.
     */
    test('the notification badge is bounded, so the row stays bounded (#1132)', async () => {
      const measureBadge = async (pendingCount: number) => {
        attentionPendingCount = pendingCount;
        const page = await browser.newPage({
          viewport: { width: 390, height: 200 },
        });
        try {
          await page.setContent(
            buildFixtureHtml(await renderMarkupForState('error')),
          );
          return await page.evaluate(() => {
            const badge = document.querySelector<HTMLElement>(
              '.app-toolbar__notification-badge',
            );
            const bell = badge?.closest('button');
            if (!badge || !bell) throw new Error('no notification badge');
            return {
              text: badge.textContent,
              width: badge.getBoundingClientRect().width,
              accessibleName: bell.getAttribute('aria-label'),
            };
          });
        } finally {
          await page.close();
        }
      };

      const single = await measureBadge(3);
      expect(single.text).toBe('3');

      const many = await measureBadge(123);
      expect(
        many.text,
        'a three-digit count must not reach this badge, or the row is unbounded',
      ).toBe('9+');

      // The bound itself: past the cap the badge is a constant, so no count a
      // person can accumulate moves the trailing controls any further right.
      const far = await measureBadge(999999);
      expect(far.text).toBe('9+');
      expect(
        far.width,
        'the badge must stop growing at the cap, or the row arithmetic is not a bound',
      ).toBe(many.width);
      expect(single.width).toBeLessThanOrEqual(many.width);

      // The exact count is what the cap gives up on screen, so it must survive
      // in the accessible name — that is the trade this cap is allowed to make.
      expect(many.accessibleName).toContain('123 need attention');
    });

    // The old 120px chip-budget test (#1401) retired with the label it
    // bounded: the dot-only chip sits at the 44px touch floor in every
    // state, which the invariance test above pins directly.
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
