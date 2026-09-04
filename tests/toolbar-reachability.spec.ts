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
 *   - `tests/android/app-load.spec.ts`'s
 *     `documentElement.scrollWidth > clientWidth` measures DOCUMENT overflow,
 *     which is false in every one of these cases — the toolbar row clips, it
 *     does not scroll the document.
 *
 * ...and, as the `PHONE` comment below records, that whole suite is behind a
 * trigger no toolbar change reaches, so on #1384's broken commit those three
 * did not merely lack power — they never executed.
 *
 * THE TWO THINGS THAT MAKE THIS GUARD REAL, both of which it asserts as
 * preconditions rather than assuming:
 *
 * 1. THE CONNECTION CHIP MUST BE IN A NEWS-CARRYING STATE. Connected (and
 *    idle) render dot-only at ~44px, because `chat.css` hides
 *    `.app-toolbar__conn-state` for those two states under the mobile
 *    breakpoint. A news-carrying state ("Can't connect", "Reconnecting",
 *    "Needs re-pairing", "Awaiting approval") renders that span with its
 *    reserved `min-width: 116px`, and the chip measures ~151px — which is
 *    what pushes the actions cluster past the viewport edge. EVERY defect in
 *    this class only exists in the wide state, and two independent lanes have
 *    each measured this toolbar in the connected state and concluded it fits.
 *    So this spec fails loudly if it finds itself in the narrow state instead
 *    of quietly measuring a chip that proves nothing.
 *
 * 2. THE INVENTORY MUST NOT BE EMPTY OR HALF-EMPTY. A hit test over zero
 *    controls passes forever. `assertToolbarPreconditions` requires four
 *    named controls to be present in the measured inventory before any
 *    reachability verdict is read.
 *
 * A first-run overlay would legitimately cover the whole page in a fresh
 * profile. It is DISMISSED (`dismissSetupLauncher`, as the rest of this suite
 * does) rather than excluded from the hit test — scoping the hit test to the
 * toolbar's stacking context would have made the guard blind to exactly the
 * kind of full-page layer that #917's own comment records taking the hit test
 * at "More actions".
 */

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
 * `Build Android verification artifact`, and `build-android.yml` is
 * path-filtered to `src-desktop/**` and six named scripts — `src-ui/**` and
 * `tests/android/**` are in neither list. A toolbar change therefore triggers
 * no Android build, so no Android Tests, so no guard. That is very likely also
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
 * `HeaderActions` renders `app-toolbar__conn--${connState}`. These are the
 * states whose label survives the mobile breakpoint — i.e. every state except
 * `connected` and `idle`, which `chat.css` renders dot-only.
 */
const NEWS_CARRYING_CONN_STATE =
  /app-toolbar__conn--(error|connecting|needs-credential|awaiting-approval|needs-repair)(\s|$)/;

/**
 * `.app-toolbar__conn-state` reserves `min-width: 116px` (chat.css), and is
 * `display: none` — width 0 — in the two dot-only states. Anything at or above
 * this floor is the wide chip and nothing else can be; the margin below 116 is
 * for sub-pixel layout only, not for admitting a narrower state.
 */
const NEWS_CARRYING_STATE_MIN_WIDTH_PX = 110;

/**
 * Controls that must appear in the measured inventory before any verdict is
 * trusted. Each is identified by the same key `measureToolbarControls` reports,
 * so a rename fails here with the inventory printed rather than silently
 * shrinking what gets checked.
 */
const REQUIRED_CONTROL_KEYS = [
  'Toggle menu', // aria-label, .app-toolbar__sidebar-toggle
  'app-toolbar-connection', // data-testid, the connection chip
  'More actions', // aria-label, .app-toolbar__overflow-btn
  'Open settings', // aria-label, the Settings gear
] as const;

/**
 * The reason the two narrowest cases below are skipped. It is about the
 * LAYOUT, not about the width: both widths are fully supported phone widths
 * and the assertion is correct at both.
 *
 * `.app-toolbar__actions` is `flex-shrink: 0`, so the toolbar row's content
 * width is viewport-INDEPENDENT (~421px in a news-carrying connection state,
 * with the brand already bottomed out as the only shrinking member). The
 * Settings gear therefore occupies x=377..421 at every width here, and its
 * centre (x≈399) falls outside any viewport narrower than 399px — the row
 * clips rather than reflowing. Measured on this branch's base (bcf0be788):
 * reachable at 412 and 402, unreachable at 390 and at 360.
 */
const SETTINGS_UNREACHABLE_SKIP_REASON =
  '#1401 — this assertion is CORRECT at this width and fails on pristine main ' +
  'today: the Settings gear (x=377..421, centre x≈399) has its centre outside ' +
  'any viewport narrower than 399px, because `.app-toolbar__actions` is ' +
  'flex-shrink:0 and the row clips instead of reflowing. The width is ' +
  'supported; the layout is what is wrong. Un-skip this case in #1401’s own ' +
  'fix PR — it is the check that proves the fix.';

/**
 * Every width this guard knows about, widest first. A width with no
 * `skipReason` is ENFORCED with zero tolerance: any visible control there that
 * is not reachable at its own centre fails the suite.
 *
 * 412 is the `android` Playwright project's own viewport (Pixel 7). 402 is a
 * second real Android width above the #1401 threshold, and it matters that
 * there are TWO enforced widths: a single one cannot notice a defect that only
 * appears in a narrow band. 390 and 360 are present-but-skipped rather than
 * absent so the coverage stays visible in every run's output and #1401's fix
 * can un-skip them in one line, instead of the coverage living only in an
 * issue.
 */
const TOOLBAR_WIDTHS: ReadonlyArray<{
  width: number;
  skipReason: string | null;
}> = [
  { width: 412, skipReason: null },
  { width: 402, skipReason: null },
  { width: 390, skipReason: SETTINGS_UNREACHABLE_SKIP_REASON },
  { width: 360, skipReason: SETTINGS_UNREACHABLE_SKIP_REASON },
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

    const controls = Array.from(
      toolbar?.querySelectorAll<HTMLElement>(CONTROL_SELECTOR) ?? [],
    )
      .filter(visible)
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
    `connection chip ${measurement.connectionChipWidth}px ` +
    `(${measurement.connectionClass}, state text ${JSON.stringify(measurement.connectionStateText)} ` +
    `at ${measurement.connectionStateWidth}px)\n` +
    `${measurement.controls.length} visible control(s):\n${lines.join('\n')}`
  );
}

/**
 * Everything that must hold before a reachability verdict means anything.
 * Each of these fails LOUDLY: a guard that cannot establish its own
 * preconditions must red, not pass over an empty or narrow-state toolbar.
 */
function assertToolbarPreconditions(measurement: ToolbarMeasurement): void {
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

  // The news-carrying connection state — precondition 1. Asserted two
  // independent ways: the state modifier class the component writes, and the
  // measured width of the label span, which is 0 in every dot-only state.
  expect(
    measurement.connectionClass ?? '',
    `the connection chip is not in a news-carrying state, so this measurement ` +
      `would be of the dot-only chip and could not reproduce any defect in ` +
      `this class\n${context}`,
  ).toMatch(NEWS_CARRYING_CONN_STATE);
  expect(
    measurement.connectionStateWidth ?? 0,
    `.app-toolbar__conn-state is narrower than its reserved 116px min-width, ` +
      `so the chip is not in its wide state\n${context}`,
  ).toBeGreaterThanOrEqual(NEWS_CARRYING_STATE_MIN_WIDTH_PX);

  // A non-empty, complete inventory — precondition 2.
  const keys = measurement.controls.map((control) => control.key);
  for (const required of REQUIRED_CONTROL_KEYS) {
    expect(
      keys,
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
  const unreachable = measurement.controls.filter(
    (control) => !control.reachable,
  );
  expect(
    unreachable.map((control) => `${control.key}: ${control.verdict}`),
    `toolbar control(s) unreachable at their own centre at ` +
      `${measurement.viewportWidth}px\n${context}`,
  ).toEqual([]);
}

/**
 * Puts the app into a news-carrying connection state by refusing the public
 * handshake the health coordinator probes with (`probeServerConnection` in
 * `src-ui/src/lib/serverHealth.ts`), which is the real "host stopped
 * answering" path through the real state machine.
 *
 * Registered BEFORE the first navigation so the coordinator's opening probe
 * already fails and the chip never renders its connected width — rather than
 * `context.setOffline(true)` on a loaded page, which only affects requests the
 * coordinator has yet to make and was observed still reading `Connected` 12s
 * later. Only this one endpoint is refused: `/api/system/status` and the rest
 * of the app keep working, so the toolbar under test is the one a user with an
 * unreachable Station actually sees.
 */
async function refuseStationHandshake(page: Page): Promise<void> {
  await page.route(`**${PUBLIC_STATION_HANDSHAKE_PATH}*`, (route) =>
    route.abort('connectionrefused'),
  );
}

for (const { width, skipReason } of TOOLBAR_WIDTHS) {
  const suffix = skipReason ? ' (skipped — #1401)' : '';
  test.describe(`Toolbar reachability on a phone at ${width}px${suffix}`, () => {
    // Per-width viewport at LOAD time, not a `setViewportSize` on an already
    // laid-out page: the mobile breakpoint and the region-control fold are
    // decided on mount, and a resize is not the same input. The Pixel 7
    // profile supplies the touch/mobile emulation the app's CSS keys on;
    // `assertToolbarPreconditions` verifies it actually applied.
    test.use({ ...PHONE, viewport: { width, height: VIEWPORT_HEIGHT } });

    // `#1401` is in the describe title as well as the annotation so the reason
    // is legible in a plain terminal reporter, which prints skipped tests by
    // title only.
    if (skipReason) test.skip(true, skipReason);

    test('every visible app-toolbar control is reachable at its own centre', async ({
      page,
    }) => {
      await refuseStationHandshake(page);
      await page.goto('/');
      await dismissSetupLauncher(page);

      const toolbar = page.locator('.app-toolbar');
      await expect(toolbar).toBeVisible({ timeout: 15_000 });

      const connection = page.locator('[data-testid="app-toolbar-connection"]');
      await expect(connection).toBeVisible({ timeout: 15_000 });
      // The coordinator retries a failed probe on a 500ms floor, so this
      // settles quickly; the generous ceiling is for a loaded CI host.
      await expect(connection).toHaveClass(NEWS_CARRYING_CONN_STATE, {
        timeout: 30_000,
      });

      const measurement = await measureToolbarControls(page);
      assertToolbarPreconditions(measurement);
      assertReachability(measurement);
    });
  });
}
