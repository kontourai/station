/**
 * #1400 — every visible control in the app toolbar must be reachable at its
 * own centre.
 *
 * WHY THIS EXISTS. Two toolbar occlusion defects (#917, #1384) shipped to main
 * and nothing designed to catch them did. What eventually noticed #1384 was a
 * Playwright actionability timeout in `tests/device-pairing-mobile.spec.ts` —
 * a spec about device pairing, whose failure names neither the toolbar nor
 * what was covering what.
 *
 * The mobile assertions that exist are blind by construction:
 *   - `tests/android/mobile-layout.spec.ts:11` hit-tests only the Settings
 *     action — the far-right control, never the covered one.
 *   - its touch-target floor: an overlapped 44px button still measures 44px.
 *   - the suite's usual overflow assertion,
 *     `documentElement.scrollWidth > clientWidth`, measures DOCUMENT overflow,
 *     which is false in every one of these cases — the toolbar row clips, it
 *     does not scroll the document.
 *
 * ...and, as the `PHONE` comment below records, that whole suite is behind a
 * trigger no toolbar change reaches, so on #1384's broken commit those three
 * did not merely lack power — they never executed.
 *
 * The fixture uses a long saved Station name and 101 pending approvals.
 * Both can grow the row: the saved name fills its cap where room permits,
 * and the bell renders the widest badge (9+) while announcing the real count.
 * Each case confirms the connection state and the complete control inventory
 * before hit-testing every center and the toolbar's right gutter.
 *
 * A first-run overlay would legitimately cover the whole page in a fresh
 * profile. It is DISMISSED (`dismissSetupLauncher`, as the rest of this suite
 * does) rather than excluded from the hit test — scoping the hit test to the
 * toolbar's stacking context would have made the guard blind to exactly the
 * kind of full-page layer that #917's own comment records taking the hit test
 * at "More actions".
 */

import type { AttentionProjection } from '@kontourai/station-contracts/attention';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts/environment-security';
import { devices, expect, type Page, test } from '@playwright/test';
import { dismissSetupLauncher } from './helpers/orchestration';

/** Pixel 7's own viewport height, held constant so only width varies. */
const VIEWPORT_HEIGHT = 839;

/**
 * The device emulation, declared HERE rather than inherited from a Playwright
 * project.
 *
 * This spec lived in `tests/android/` first, which is the `android` project's
 * testDir and supplies this profile for free. That was a mistake, and a
 * self-defeating one: `android-test.yml` only runs on `workflow_run` of
 * `Main: Android build`, and `build-android.yml` is
 * path-filtered to `src-desktop/**` and six named scripts — `src-ui/**` and
 * `tests/android/**` are in neither list. A toolbar change therefore triggers
 * no Android build, so no Main: Android tests, so no guard. That is very likely also
 * why the android suite was "37/37 green" on #1384's broken commit: it never
 * ran on it at all.
 *
 * Nothing here needs an APK or the Android build — it is a browser layout
 * assertion, and the Pixel 7 profile is just a convenient viewport + touch
 * preset. Declaring it inline lets the spec live in `tests/`, where a lane
 * that a UI change actually triggers can run it.
 *
 * `assertToolbarPreconditions` turns that inline declaration into a CHECKED
 * precondition (`coarsePointer`, `mobileBreakpoint`), because a silently
 * desktop context would measure a different toolbar and prove nothing.
 *
 * The four fields are named rather than spread from the descriptor wholesale:
 * `devices['Pixel 7']` also carries `defaultBrowserType`, which Playwright
 * refuses inside a describe-group `test.use` ("because it forces a new
 * worker"), and a `viewport`/`screen` that each case overrides anyway. Naming
 * them also says which emulation is load-bearing — `hasTouch`/`isMobile` are
 * what make `(pointer: coarse)` match, and that is what folds the region
 * controls into the `⋯` menu (#917).
 */
const PIXEL_7 = devices['Pixel 7'];
const PHONE = {
  userAgent: PIXEL_7.userAgent,
  deviceScaleFactor: PIXEL_7.deviceScaleFactor,
  isMobile: PIXEL_7.isMobile,
  hasTouch: PIXEL_7.hasTouch,
} as const;

/**
 * Controls that must appear in the measured inventory before any verdict is
 * trusted. Each is identified by the same key `measureToolbarControls` reports,
 * so a rename fails here with the inventory printed rather than silently
 * shrinking what gets checked.
 *
 * No Settings gear: Settings is the account menu's "Open settings" row in
 * the sidebar drawer's footer (`SidebarAccountControl`), reached through
 * `Toggle menu`. The bell (`Notifications`) holds the fourth slot instead.
 */
const REQUIRED_CONTROL_KEYS = [
  'Toggle menu', // aria-label, .app-toolbar__sidebar-toggle
  'app-toolbar-connection', // data-testid, the connection chip
  'Notifications', // aria-label, the notification bell
  'Search or jump to…', // aria-label, command palette
  'More actions', // aria-label, .app-toolbar__overflow-btn
] as const;

/**
 * Check common phone widths, the current tight-gap boundary (360/361), the
 * former label-drop boundary (374/375/376), and the 300px supported floor.
 * 600px checks the same mobile toolbar with room for the full long-name slot.
 */
const TOOLBAR_WIDTHS: readonly number[] = [
  600, 440, 412, 402, 393, 390, 376, 375, 374, 361, 360, 320, 300,
];

/**
 * The product names the toolbar is driven with. "Station Nightly" is the
 * owner's real build and is ~107px in the real font against ~52px for
 * "Station": a layout tuned to one name passes the other's width by luck.
 */
const PRODUCT_NAMES: readonly string[] = ['Station', 'Station Nightly'];

const NAME_WHOLE_WIDTHS: Readonly<Record<string, readonly number[]>> = {
  Station: [600],
  'Station Nightly': [600],
};
const NAME_HIDDEN_WIDTHS: Readonly<Record<string, readonly number[]>> = {
  'Station Nightly': [320],
};

/** The toolbar's own side padding (index.css `--app-toolbar-gutter` on a phone). */
const TOOLBAR_GUTTER = 12;

const STATION_NAME = 'Station for the Connected Operations Workspace';
const PENDING_COUNT = 101;

async function driveWideToolbar(page: Page): Promise<void> {
  await page.addInitScript((name) => {
    const key = 'station-connect-connections';
    const profiles = localStorage.getItem(key);
    if (!profiles) return;
    const active = localStorage.getItem('station-connect-connections-active');
    const connections: { id: string; name: string }[] = JSON.parse(profiles);
    const connection = connections.find((profile) => profile.id === active);
    if (!connection) return;
    connection.name = name;
    localStorage.setItem(key, JSON.stringify(connections));
  }, STATION_NAME);

  const date = '2026-01-01T00:00:00.000Z';
  const data: AttentionProjection = {
    pendingCount: PENDING_COUNT,
    items: Array.from({ length: PENDING_COUNT }, (_, index) => ({
      kind: 'approval',
      id: `approval-${index}`,
      title: `Approval ${index + 1}`,
      createdAt: date,
      updatedAt: date,
      source: {
        notificationId: `notification-${index}`,
        notificationSource: 'toolbar-reachability',
      },
      actions: [],
    })),
  };
  await page.route('**/api/attention', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { success: true, data } })
      : route.fallback(),
  );
}

/**
 * The web profile always reports "Station", so a non-default name is applied
 * to the rendered toolbar before first paint and kept there across React
 * commits: the real stylesheet and the real font then lay out the real
 * product name. (The home link's label follows it.)
 */
async function applyProductName(page: Page, name: string): Promise<void> {
  if (name === 'Station') return;
  await page.addInitScript((productName) => {
    const apply = () => {
      for (const brand of document.querySelectorAll('.app-toolbar__brand')) {
        if (brand.textContent !== productName) brand.textContent = productName;
      }
      for (const logo of document.querySelectorAll('.app-toolbar__logo')) {
        const label = `${productName} home`;
        if (logo.getAttribute('aria-label') !== label)
          logo.setAttribute('aria-label', label);
      }
    };
    new MutationObserver(apply).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.addEventListener('DOMContentLoaded', apply);
  }, name);
}

const CHIP_MIN_WIDTH = 44;
const chipNameCap = (viewportWidth: number) =>
  Math.min(0.28 * viewportWidth, 120);

/** Each drive exercises the health coordinator and asserts its exact state. */
const NEWS_STATES: ReadonlyArray<{
  id: string;
  /** The `app-toolbar__conn--*` modifier this drive must produce, exactly. */
  modifier: string;
  drive: (page: Page) => Promise<void>;
}> = [
  {
    // The healthy state. No route is changed: the fixture Station answers its
    // handshake. The chip is the same width as in the failure states.
    id: 'connected',
    modifier: 'app-toolbar__conn--connected',
    drive: async () => {},
  },
  {
    // Refusing the public handshake the health coordinator probes with
    // (`probeServerConnection`, src-ui/src/lib/serverHealth.ts) is the real
    // "host stopped answering" path through the real state machine. Only that
    // one endpoint is refused — `/api/system/status` and the rest of the app
    // keep working — so this is the toolbar a user with an unreachable
    // Station actually sees. Preferred over `context.setOffline(true)`, which
    // only affects requests the coordinator has yet to make and was observed
    // still reading `Connected` 12s later.
    id: 'error (unreachable host)',
    modifier: 'app-toolbar__conn--error',
    drive: async (page) => {
      await page.route(`**${PUBLIC_STATION_HANDSHAKE_PATH}*`, (route) =>
        route.abort('connectionrefused'),
      );
    },
  },
  {
    id: 'needs-repair (identity mismatch)',
    modifier: 'app-toolbar__conn--needs-repair',
    // The REAL handshake, with only the identity field removed, so every other
    // check in `probeServerConnection` passes on the server's own live answer
    // (schema version, auth scheme, transports, and the compatibility verdict,
    // which fails closed when that block is absent) and the probe reaches its
    // identity branch on genuine data. The stored e2e profile pins no expected
    // environmentId, so the reachable branch is `typeof environmentId !==
    // 'string'` — an answer that cannot prove which Station it is — rather
    // than a value mismatch. Same classification, `identity-mismatch`.
    drive: async (page) => {
      await page.route(`**${PUBLIC_STATION_HANDSHAKE_PATH}*`, async (route) => {
        const response = await route.fetch();
        let body: Record<string, unknown>;
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          // Not JSON: hand back exactly what the server said rather than
          // inventing a handshake. The state assertion then fails loudly
          // instead of this drive silently becoming a different test.
          return route.fulfill({ response });
        }
        delete body.environmentId;
        return route.fulfill({ response, json: body });
      });
    },
  },
];

interface MeasuredControl {
  /** Stable identity: data-testid, else aria-label, else title, else selector. */
  key: string;
  /** Human-readable selector-ish description for failure messages. */
  description: string;
  rect: { x: number; y: number; width: number; height: number };
  centre: { x: number; y: number };
  reachable: boolean;
  /** Why it is not reachable; `null` when it is. */
  verdict: string | null;
}

interface ToolbarMeasurement {
  viewportWidth: number;
  viewportHeight: number;
  toolbarRect: { x: number; y: number; width: number; height: number } | null;
  connectionClass: string | null;
  connectionStateText: string | null;
  connectionStateWidth: number | null;
  connectionChipWidth: number | null;
  /**
   * The app name in the lockup: its text, its box, the lockup's clip box and
   * its computed `text-overflow`. `null` when the toolbar has no brand.
   */
  brand: {
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    lockupRect: { x: number; y: number; width: number; height: number };
    textOverflow: string;
    scrollWidth: number;
    clientWidth: number;
  } | null;
  /** The compact label's laid-out width (0 when the chip shows only its dot). */
  connectionLabelWidth: number;
  notificationBadgeWidth: number;
  /** Visible links in the toolbar whose name ends "home", and the brand's tab/AT state. */
  homeLinks: string[];
  brandTabIndex: string | null;
  brandAriaHidden: string | null;
  /** `(pointer: coarse)` — what decides the region-control fold (#917). */
  coarsePointer: boolean;
  /** The app's own mobile breakpoint, copied from `chat.css` verbatim. */
  mobileBreakpoint: boolean;
  maxTouchPoints: number;
  controls: MeasuredControl[];
}

/**
 * Reads the whole verdict in one page evaluation so every number in a failure
 * message came from the same layout, not from a sequence of round-trips that a
 * re-render could have straddled.
 */
async function measureToolbarControls(page: Page): Promise<ToolbarMeasurement> {
  return page.evaluate(() => {
    const CONTROL_SELECTOR =
      'button, a[href], [role="button"], [role="link"], input, select, textarea, summary';

    const describe = (element: Element | null): string => {
      if (!element) return '<none>';
      let text = element.tagName.toLowerCase();
      const classes = element.getAttribute('class')?.trim();
      if (classes) text += `.${classes.split(/\s+/).join('.')}`;
      const testId = element.getAttribute('data-testid');
      if (testId) text += `[data-testid="${testId}"]`;
      const label =
        element.getAttribute('aria-label') ?? element.getAttribute('title');
      if (label) text += `[label="${label}"]`;
      return text;
    };

    const keyOf = (element: Element): string =>
      element.getAttribute('data-testid') ??
      element.getAttribute('aria-label') ??
      element.getAttribute('title') ??
      describe(element);

    const round = (value: number) => Math.round(value * 100) / 100;
    const rectOf = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: round(bounds.x),
        y: round(bounds.y),
        width: round(bounds.width),
        height: round(bounds.height),
      };
    };

    const visible = (element: Element): boolean => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      // Chromium's own visibility predicate: covers an ancestor's
      // `visibility: hidden`, `content-visibility`, and zero opacity, which a
      // per-element `getComputedStyle` read does not.
      const check = (
        element as Element & {
          checkVisibility?: (options: {
            checkOpacity: boolean;
            checkVisibilityCSS: boolean;
          }) => boolean;
        }
      ).checkVisibility;
      if (typeof check === 'function') {
        return check.call(element, {
          checkOpacity: true,
          checkVisibilityCSS: true,
        });
      }
      const style = getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0
      );
    };

    const toolbar = document.querySelector<HTMLElement>('.app-toolbar');
    const connection = document.querySelector<HTMLElement>(
      '[data-testid="app-toolbar-connection"]',
    );
    const connectionState = connection?.querySelector<HTMLElement>(
      '.app-toolbar__conn-state',
    );

    // The app name wraps out of its clipped lockup when the row cannot hold it
    // whole (index.css `.app-toolbar__lockup`). A wordmark clipped away is not
    // a control anyone can reach OR see, so it is out of the inventory; the
    // brand assertions in `assertToolbarPreconditions` own whether that is
    // allowed at this width.
    const clippedAway = (element: Element): boolean => {
      const lockup = element.closest('.app-toolbar__lockup');
      if (!lockup) return false;
      return (
        element.getBoundingClientRect().top >=
        lockup.getBoundingClientRect().bottom - 0.5
      );
    };

    const controls = Array.from(
      toolbar?.querySelectorAll<HTMLElement>(CONTROL_SELECTOR) ?? [],
    )
      .filter(visible)
      .filter((element) => !clippedAway(element))
      .map((element) => {
        const rect = rectOf(element);
        const centre = {
          x: round(rect.x + rect.width / 2),
          y: round(rect.y + rect.height / 2),
        };
        const insideViewport =
          centre.x >= 0 &&
          centre.x < window.innerWidth &&
          centre.y >= 0 &&
          centre.y < window.innerHeight;
        if (!insideViewport) {
          return {
            key: keyOf(element),
            description: describe(element),
            rect,
            centre,
            reachable: false,
            verdict: `centre (${centre.x}, ${centre.y}) is outside the ${window.innerWidth}x${window.innerHeight} viewport`,
          };
        }
        const hit = document.elementFromPoint(centre.x, centre.y);
        // `closest()` semantics: the control itself, or one of its own
        // children (an `svg`, a `path`, a label `span`) counts as reaching it.
        if (hit && (hit === element || element.contains(hit))) {
          return {
            key: keyOf(element),
            description: describe(element),
            rect,
            centre,
            reachable: true,
            verdict: null,
          };
        }
        if (!hit) {
          return {
            key: keyOf(element),
            description: describe(element),
            rect,
            centre,
            reachable: false,
            verdict: `nothing is hit-testable at its centre (${centre.x}, ${centre.y})`,
          };
        }
        const covering = describe(hit);
        const inToolbar = Boolean(hit.closest('.app-toolbar'));
        const coveringRect = rectOf(hit);
        return {
          key: keyOf(element),
          description: describe(element),
          rect,
          centre,
          reachable: false,
          verdict:
            `covered at its centre (${centre.x}, ${centre.y}) by ${covering} ` +
            `at x=${coveringRect.x}..${round(coveringRect.x + coveringRect.width)} ` +
            `(${inToolbar ? 'inside' : 'OUTSIDE'} .app-toolbar)`,
        };
      });

    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      toolbarRect: toolbar ? rectOf(toolbar) : null,
      connectionClass: connection?.getAttribute('class') ?? null,
      connectionStateText: connectionState?.textContent ?? null,
      connectionStateWidth: connectionState
        ? rectOf(connectionState).width
        : null,
      connectionChipWidth: connection ? rectOf(connection).width : null,
      brand: (() => {
        const brand = document.querySelector<HTMLElement>(
          '.app-toolbar__brand',
        );
        const lockup = document.querySelector<HTMLElement>(
          '.app-toolbar__lockup',
        );
        if (!brand || !lockup) return null;
        return {
          text: brand.textContent ?? '',
          rect: rectOf(brand),
          lockupRect: rectOf(lockup),
          textOverflow: getComputedStyle(brand).textOverflow,
          scrollWidth: brand.scrollWidth,
          clientWidth: brand.clientWidth,
        };
      })(),
      connectionLabelWidth:
        connection
          ?.querySelector<HTMLElement>('.app-toolbar__conn-label')
          ?.getBoundingClientRect().width ?? 0,
      notificationBadgeWidth:
        toolbar
          ?.querySelector('.app-toolbar__notification-badge')
          ?.getBoundingClientRect().width ?? 0,
      homeLinks: Array.from(
        toolbar?.querySelectorAll<HTMLElement>('[role="link"]') ?? [],
      )
        .filter((link) => /home$/.test(link.getAttribute('aria-label') ?? ''))
        .map((link) => link.getAttribute('aria-label') ?? ''),
      brandTabIndex:
        document
          .querySelector('.app-toolbar__brand')
          ?.getAttribute('tabindex') ?? null,
      brandAriaHidden:
        document
          .querySelector('.app-toolbar__brand')
          ?.getAttribute('aria-hidden') ?? null,
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      // Byte-for-byte the query `chat.css` uses for its mobile branch. If this
      // is false the page is being styled as a desktop and every measurement
      // below is of a different toolbar.
      mobileBreakpoint: window.matchMedia(
        '(max-width: 768px), (max-height: 540px) and (pointer: coarse)',
      ).matches,
      maxTouchPoints: navigator.maxTouchPoints,
      controls,
    };
  });
}

function renderInventory(measurement: ToolbarMeasurement): string {
  const lines = measurement.controls.map(
    (control) =>
      `  ${control.reachable ? 'ok  ' : 'FAIL'} ${control.key} — ${control.description} ` +
      `at x=${control.rect.x}..${Math.round(control.rect.x + control.rect.width)}` +
      (control.verdict ? `\n         ${control.verdict}` : ''),
  );
  return (
    `viewport ${measurement.viewportWidth}x${measurement.viewportHeight}; ` +
    `coarse pointer ${measurement.coarsePointer}, mobile breakpoint ` +
    `${measurement.mobileBreakpoint}, maxTouchPoints ${measurement.maxTouchPoints}; ` +
    `toolbar ${JSON.stringify(measurement.toolbarRect)}; ` +
    `brand ${JSON.stringify(measurement.brand)}; ` +
    `connection chip ${measurement.connectionChipWidth}px ` +
    `(${measurement.connectionClass}, state text ${JSON.stringify(measurement.connectionStateText)} ` +
    `at ${measurement.connectionStateWidth}px)\n` +
    `${measurement.notificationBadgeWidth}px notification badge; ${measurement.controls.length} visible control(s):\n${lines.join('\n')}`
  );
}

/**
 * Everything that must hold before a reachability verdict means anything.
 * Each of these fails LOUDLY: a guard that cannot establish its own
 * preconditions must red, not pass over an empty or narrow-state toolbar.
 */
function assertToolbarPreconditions(
  measurement: ToolbarMeasurement,
  expectedModifier: string,
): void {
  const context = renderInventory(measurement);

  expect(
    measurement.toolbarRect,
    `no .app-toolbar rendered\n${context}`,
  ).not.toBeNull();

  // Precondition 0 — the device emulation this spec declares for itself
  // actually took effect. This spec no longer inherits a Playwright project's
  // device profile, so a `test.use` that stopped being applied would silently
  // measure a DESKTOP toolbar: `.app-toolbar__action--secondary` visible,
  // `.app-toolbar__overflow-btn` hidden, the region controls unfolded, and a
  // completely different set of controls to hit-test. That would not be a
  // false pass so much as a measurement of the wrong product, so it must red.
  expect(
    measurement.coarsePointer,
    `the page does not report (pointer: coarse), so touch emulation is not ` +
      `applied and this is not the mobile toolbar — check this describe's ` +
      `test.use({ ...PHONE })\n${context}`,
  ).toBe(true);
  expect(
    measurement.mobileBreakpoint,
    `the app's own mobile breakpoint does not match, so chat.css is styling ` +
      `this as a desktop and the measurement is of a different toolbar` +
      `\n${context}`,
  ).toBe(true);

  // Precondition 1 — the named chip, in the exact state this case drove.
  //
  // (a) The named state, not merely "some news state". A drive that silently
  //     landed somewhere else would still satisfy a class-level check while
  //     measuring a chip nobody chose.
  expect(
    (measurement.connectionClass ?? '').split(/\s+/),
    `this case drives ${expectedModifier}, but the chip is in a different ` +
      `state — the drive did not do what it claims, so the measurement is of ` +
      `an unchosen state\n${context}`,
  ).toContain(expectedModifier);

  // (b) The compact chip shows the Station name and keeps its touch target.
  expect(
    measurement.connectionStateWidth ?? 0,
    `the ${expectedModifier} chip lays out state text on a phone - the ` +
      `state lives in the dot and the accessible name\n${context}`,
  ).toBe(0);
  const chipWidth = measurement.connectionChipWidth ?? Number.POSITIVE_INFINITY;
  expect(
    chipWidth,
    `the ${expectedModifier} chip must meet the ${CHIP_MIN_WIDTH}px touch ` +
      `floor at ${measurement.viewportWidth}px\n${context}`,
  ).toBeGreaterThanOrEqual(CHIP_MIN_WIDTH);
  const nameCap = chipNameCap(measurement.viewportWidth);
  expect(measurement.connectionLabelWidth, context).toBeGreaterThan(0);
  expect(measurement.connectionLabelWidth, context).toBeLessThanOrEqual(
    nameCap,
  );
  if (measurement.viewportWidth === 600) {
    expect(measurement.connectionLabelWidth, context).toBeCloseTo(nameCap, 1);
  }

  // (c) The app name: whole or absent, never a stub. A text-overflow ellipsis
  //     is the "S…" defect, and the name must be whole wherever it can fit.
  const brand = measurement.brand;
  expect(brand, `no app-name lockup rendered\n${context}`).not.toBeNull();
  if (brand) {
    expect(
      brand.textOverflow,
      `the app name must not truncate with an ellipsis\n${context}`,
    ).not.toBe('ellipsis');
    const insideLockup =
      brand.rect.x >= brand.lockupRect.x - 0.5 &&
      brand.rect.x + brand.rect.width <=
        brand.lockupRect.x + brand.lockupRect.width + 0.5 &&
      brand.rect.y + brand.rect.height <=
        brand.lockupRect.y + brand.lockupRect.height + 0.5;
    const clippedAway =
      brand.rect.y >= brand.lockupRect.y + brand.lockupRect.height - 0.5;
    expect(
      insideLockup || clippedAway,
      `the app name is partly clipped instead of whole or hidden\n${context}`,
    ).toBe(true);
    // The palette now sits between the lockup and the Station control.
    const palette = measurement.controls.find(
      (control) => control.key === 'Search or jump to…',
    );
    if (palette) {
      const rowGap = measurement.viewportWidth <= 360 ? 2 : 8;
      const slot = palette.rect.x - rowGap - brand.lockupRect.x;
      const needed = 22 + 10 + brand.rect.width;
      if (slot >= needed) {
        expect(
          insideLockup,
          `the app name "${brand.text}" is hidden at ${measurement.viewportWidth}px ` +
            `although its ${slot}px slot holds the ${needed}px it needs\n${context}`,
        ).toBe(true);
      }
    }
    // Literal, slot-independent pins (see NAME_WHOLE_WIDTHS).
    const width = measurement.viewportWidth;
    if (NAME_WHOLE_WIDTHS[brand.text]?.includes(width)) {
      expect(
        insideLockup && !clippedAway,
        `the app name "${brand.text}" must be visible at ${width}px\n${context}`,
      ).toBe(true);
      expect(
        brand.scrollWidth,
        `the app name "${brand.text}" is clipped at ${width}px\n${context}`,
      ).toBeLessThanOrEqual(brand.clientWidth);
      expect(brand.textOverflow).not.toBe('ellipsis');
    }
    if (NAME_HIDDEN_WIDTHS[brand.text]?.includes(width)) {
      expect(
        clippedAway,
        `the app name "${brand.text}" is expected wrapped away at ${width}px\n${context}`,
      ).toBe(true);
    }
    // Exactly one home link in the accessibility tree, and it is the logo; the
    // wordmark that can vanish is neither a tab stop nor announced.
    expect(
      measurement.homeLinks,
      `exactly one home link\n${context}`,
    ).toHaveLength(1);
    expect(
      measurement.controls.map((control) => control.key),
      context,
    ).toContain(`${brand.text} home`);
    expect(measurement.brandTabIndex, context).toBeNull();
    expect(measurement.brandAriaHidden, context).toBe('true');
  }

  // A non-empty, complete inventory — precondition 2.
  const keys = measurement.controls.map((control) => control.key);
  for (const required of REQUIRED_CONTROL_KEYS) {
    // The bell's label gains a ", N need attention" suffix when its first
    // notification arrives, which lands at a different moment per run.
    expect(
      keys.map((key) => (key.startsWith(`${required}, `) ? required : key)),
      `required toolbar control '${required}' is missing from the measured ` +
        `inventory — this guard would be checking less than it claims\n${context}`,
    ).toContain(required);
  }
}

/**
 * The assertion itself, with no tolerance list: at an enforced width every
 * visible control must be reachable. The message names the covering element
 * and whether it sits inside or outside the toolbar — which is the whole point
 * of #1400, since what noticed #1384 was an actionability timeout in an
 * unrelated spec that named neither.
 */
function assertReachability(measurement: ToolbarMeasurement): void {
  const context = renderInventory(measurement);
  const centers = measurement.controls.map((control) => control.centre.y);
  expect(
    Math.max(...centers) - Math.min(...centers),
    `toolbar controls must stay in one row\n${context}`,
  ).toBeLessThanOrEqual(1);
  const unreachable = measurement.controls.filter(
    (control) => !control.reachable,
  );
  expect(
    unreachable.map((control) => `${control.key}: ${control.verdict}`),
    `toolbar control(s) unreachable at their own centre at ` +
      `${measurement.viewportWidth}px\n${context}`,
  ).toEqual([]);
  // Reachable is not enough: a control that ends past the toolbar's own right
  // padding is flush against (or beyond) the screen edge.
  const pastGutter = measurement.controls
    .filter(
      (control) =>
        control.rect.x + control.rect.width >
        measurement.viewportWidth - TOOLBAR_GUTTER + 0.5,
    )
    .map(
      (control) =>
        `${control.key} ends at ${control.rect.x + control.rect.width}`,
    );
  expect(
    pastGutter,
    `toolbar control(s) inside the ${TOOLBAR_GUTTER}px right gutter at ` +
      `${measurement.viewportWidth}px\n${context}`,
  ).toEqual([]);
}

/**
 * The health coordinator keeps probing on its own retry ladder after a test
 * body returns, so a route handler can be mid-`route.fetch` when Playwright
 * tears the page down. That surfaces as `route.fetch: Test ended` and fails
 * the RUN while every test in it reported green — an exit code disagreeing
 * with its own summary, which is the worst shape a suite can have.
 *
 * Draining the handlers first is the documented remedy; `ignoreErrors` is
 * correct here because a probe abandoned at teardown carries no verdict.
 */
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

for (const width of TOOLBAR_WIDTHS) {
  test.describe(`Toolbar reachability on a phone at ${width}px`, () => {
    // Per-width viewport at LOAD time, not a `setViewportSize` on an already
    // laid-out page: the mobile breakpoint and the region-control fold are
    // decided on mount, and a resize is not the same input. The Pixel 7
    // profile supplies the touch/mobile emulation the app's CSS keys on;
    // `assertToolbarPreconditions` verifies it actually applied.
    test.use({ ...PHONE, viewport: { width, height: VIEWPORT_HEIGHT } });

    for (const productName of PRODUCT_NAMES)
      for (const state of NEWS_STATES) {
        test(`every visible app-toolbar control is reachable at its own centre — ${state.id}, "${productName}"`, async ({
          page,
        }) => {
          await applyProductName(page, productName);
          await driveWideToolbar(page);
          // Registered BEFORE the first navigation so the coordinator's opening
          // probe already resolves to this state and the chip never renders its
          // connected width at all.
          await state.drive(page);
          await page.goto('/');
          await dismissSetupLauncher(page);

          const toolbar = page.locator('.app-toolbar');
          await expect(toolbar).toBeVisible({ timeout: 15_000 });

          const connection = page.locator(
            '[data-testid="app-toolbar-connection"]',
          );
          await expect(connection).toBeVisible({ timeout: 15_000 });
          // The coordinator retries a failed probe on a 500ms floor, so this
          // settles quickly; the generous ceiling is for a loaded CI host. This
          // waits for the EXACT state, so a drive that reaches a different one
          // times out here naming what it wanted rather than measuring on.
          await expect(connection).toHaveClass(
            new RegExp(`(^|\\s)${state.modifier}(\\s|$)`),
            { timeout: 30_000 },
          );
          // The cold-launch intro is a modal dialog over an inert app until it
          // finishes (#3698), so nothing is reachable while it shows, by design.
          // Reachability is a claim about the app once the user can touch it.
          await expect(
            page.getByRole('dialog', { name: 'Starting Station', exact: true }),
          ).toBeHidden();

          await expect(
            connection.locator('.app-toolbar__conn-label'),
          ).toHaveText(STATION_NAME);
          const notifications = toolbar.getByRole('button', {
            name: new RegExp(
              `^Notifications, ${PENDING_COUNT} need attention$`,
            ),
          });
          await expect(notifications).toBeVisible();
          await expect(
            notifications.getByText('9+', { exact: true }),
          ).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          const measurement = await measureToolbarControls(page);
          await test.info().attach('toolbar geometry', {
            body: JSON.stringify(measurement),
            contentType: 'application/json',
          });
          assertToolbarPreconditions(measurement, state.modifier);
          assertReachability(measurement);
        });
      }
  });
}
