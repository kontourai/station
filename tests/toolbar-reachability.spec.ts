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
 * THE TWO THINGS THAT MAKE THIS GUARD REAL, both of which it asserts as
 * preconditions rather than assuming:
 *
 * 1. THE CONNECTION CHIP MUST BE IN THE DRIVEN STATE, AND DOT-ONLY. Every
 *    state renders dot-only at ~44px on mobile, because `chat.css` hides
 *    `.app-toolbar__conn-state` in every state under the mobile breakpoint —
 *    the banner layer announces the states that need a decision, and the
 *    drawer footer owns Settings. EVERY defect in the retired class lived in
 *    a labelled chip, and two independent lanes have each measured this
 *    toolbar in the CONNECTED state and concluded it fits. So each case below
 *    drives ONE NAMED failure state and pins the exact modifier class it got
 *    (a drive that silently lands elsewhere measures a chip nobody chose),
 *    and the preconditions assert the label span lays out zero width and the
 *    chip sits at the 44px touch floor. A regressed label shows up here as a
 *    wider chip in exactly that state.
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
 * No Settings gear: Settings lives in the sidebar drawer's footer
 * (`ProjectSidebarFooter`), reached through `Toggle menu`. The bell
 * (`Notifications`) holds the fourth slot instead.
 */
const REQUIRED_CONTROL_KEYS = [
  'Toggle menu', // aria-label, .app-toolbar__sidebar-toggle
  'app-toolbar-connection', // data-testid, the connection chip
  'Notifications', // aria-label, the notification bell
  'More actions', // aria-label, .app-toolbar__overflow-btn
] as const;

/**
 * WHY 390 AND 360 ARE NO LONGER SKIPPED.
 *
 * `.app-toolbar__actions` is `flex-shrink: 0`, so the toolbar row's content
 * width is viewport-INDEPENDENT (the brand is the only shrinking member and it
 * has already bottomed out). When this guard was written the row ended at
 * x≈421 and the Settings gear occupied x=377..421 at EVERY width, so its
 * centre (x≈399) fell outside any viewport narrower than 399px — the row
 * clipped rather than reflowing. Both widths were present-but-skipped, each
 * naming in its own reason the fix that would un-skip it.
 *
 * Both fixes have landed and both cases are enforced:
 *
 * - 390 by #1401/#1424, which released the chip's 116px `min-width`
 *   reservation at the mobile breakpoint. Measured on a running app, the gear
 *   moved to x=348..392, centre x=370, inside 390. That reason said "un-skip it
 *   there — it is the check that proves that fix"; this is that.
 *
 * - 360 by #1132 — and that reason was WRONG about what it would take. It said
 *   a hamburger plus four 44px controls plus the chip "does not fit in 360px at
 *   all, so no amount of narrowing makes every control reachable", and
 *   concluded that only a control LEAVING the row could close it. The
 *   arithmetic omitted the chip's own label: #1132 drops it below a measured
 *   width, taking the chip from 110px to its 44px floor and the cluster from
 *   266px to 200px. Measured on a running app at 360, every control resolves to
 *   itself and the row ends at x=348. No control left the toolbar.
 *
 * All four widths are enforced now, which is what the header's
 * "present-but-skipped so the coverage stays visible" note was holding the
 * place for.
 */

/**
 * Every width this guard enforces, widest first, all with zero tolerance: any
 * visible control at any of them that is not reachable at its own centre fails
 * the suite.
 *
 * 412 is the Pixel 7's own viewport. 402 is a second real Android width. 390
 * is the common iPhone width #1401 closed. 375 and 360 are the two sides of
 * the retired label-drop breakpoint (#1132/#1401): the chip is dot-only at
 * both now, and keeping both pins that no width-conditional label rule crept
 * back. Five rather than two because a single width cannot notice a defect
 * confined to a narrow band, and a narrow band is exactly what a regressed
 * breakpoint leaves behind.
 */
const TOOLBAR_WIDTHS: readonly number[] = [
  440, 412, 402, 393, 390, 375, 360, 320, 300,
];

/**
 * The product names the toolbar is driven with. "Station Nightly" is the
 * owner's real build and is ~107px in the real font against ~52px for
 * "Station": a layout tuned to one name passes the other's width by luck.
 */
const PRODUCT_NAMES: readonly string[] = ['Station', 'Station Nightly'];

/**
 * Literal expectations for the app name that do NOT depend on the measured
 * slot (the slot check in `assertToolbarPreconditions` is derived from the
 * post-layout chip position, so a chip that stopped being a fixed 44px dot
 * would shrink the slot and excuse a hidden name). Each list is pinned here as
 * literals.
 *
 * "Station Nightly" is the owner's real build: it is whole at 375 (a real
 * iPhone width) and 393 and every wider width, in every connection state, and
 * wrapped away whole at 320. "Station" is whole at 360, 375 and 393. The
 * widest measured name box is 107.41px; at 375 the row leaves the lockup about
 * 140px (22 logo + 10 gap + the name) with ~11px to spare, which is what these
 * pins protect. 360 is deliberately not listed for "Station Nightly": the row
 * is ~5px short of slack there, so it is whole or not by font metrics.
 */
const NAME_WHOLE_WIDTHS: Readonly<Record<string, readonly number[]>> = {
  'Station Nightly': [440, 412, 402, 393, 390, 375],
  Station: [440, 412, 402, 393, 390, 375, 360, 320],
};
const NAME_HIDDEN_WIDTHS: Readonly<Record<string, readonly number[]>> = {
  'Station Nightly': [320],
};

/** The toolbar's own side padding (index.css `--app-toolbar-gutter` on a phone). */
const TOOLBAR_GUTTER = 12;

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

/**
 * The connection chip on a phone is a fixed 44px dot in every state (chat.css:
 * "Holding the dot reveals the name"). It no longer yields width to the app
 * name; the lockup is the one member of the row that does.
 */
const CHIP_DOT_WIDTH = 44;

/**
 * The connection states this guard drives, each through the real
 * health-coordinator path, and each PINNED by the exact modifier class it must
 * produce. Driving "a failure" and accepting whichever state arrives is the
 * trap this list exists to close.
 *
 * The chip is dot-only in every state on mobile, so these two cases no longer
 * measure different widths — they exercise two different MECHANISMS reaching
 * the same dot (a dead host vs. a host answering with the wrong identity),
 * plus a named state in the failure output either way. The retired
 * widest-label derivation (`newsLabelWidths`, the `max-width` ceiling read,
 * the `coversClassMaximum` designation) went with the label it measured:
 * there is no text width left to bound.
 */
const NEWS_STATES: ReadonlyArray<{
  id: string;
  /** The `app-toolbar__conn--*` modifier this drive must produce, exactly. */
  modifier: string;
  drive: (page: Page) => Promise<void>;
}> = [
  {
    // The healthy state. No route is changed: the fixture Station answers its
    // handshake. The chip is the same 44px dot as in the failure states.
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
    `${measurement.controls.length} visible control(s):\n${lines.join('\n')}`
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

  // Precondition 1 — the wide chip, in the exact state this case drove.
  //
  // (a) The named state, not merely "some news state". A drive that silently
  //     landed somewhere else would still satisfy a class-level check while
  //     measuring a chip nobody chose.
  expect(
    (measurement.connectionClass ?? '').split(/\s+/),
    `this case drives ${expectedModifier}, but the chip is in a different ` +
      `state — the drive did not do what it claims, so the measurement is of ` +
      `an unchosen state (and, if it is connected/idle, of the dot-only chip ` +
      `that cannot reproduce any defect in this class)\n${context}`,
  ).toContain(expectedModifier);

  // (b) The chip is the 44px dot in the exact state this case drove, with no
  //     label text laid out. It is the same in every state so a state flip
  //     cannot move its neighbours or take room from the app name.
  expect(
    measurement.connectionStateWidth ?? 0,
    `the ${expectedModifier} chip lays out label text on a phone - these ` +
      `states are dot-only\n${context}`,
  ).toBe(0);
  const chipWidth = measurement.connectionChipWidth ?? Number.POSITIVE_INFINITY;
  expect(
    chipWidth,
    `the ${expectedModifier} chip must be the ${CHIP_DOT_WIDTH}px dot at ` +
      `${measurement.viewportWidth}px\n${context}`,
  ).toBe(CHIP_DOT_WIDTH);

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
    // Hidden is only allowed when the slot genuinely cannot hold logo + gap +
    // the whole name. The slot is measured, not assumed: it runs from the
    // lockup's left edge to the chip (less the toolbar's 8px gap), and the
    // name's own box keeps its full width even while it is wrapped away.
    const chip = measurement.controls.find(
      (control) => control.key === 'app-toolbar-connection',
    );
    if (chip) {
      // The toolbar's own gap: 8px, 2px at and below 360px (index.css).
      const rowGap = measurement.viewportWidth <= 360 ? 2 : 8;
      const slot = chip.rect.x - rowGap - brand.lockupRect.x;
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
    expect(measurement.brandTabIndex, context).toBeNull();
    expect(measurement.brandAriaHidden, context).toBe('true');
  }

  // (d) The dot has no label to show: nothing of it is laid out.
  expect(
    measurement.connectionLabelWidth,
    `a ${chipWidth}px chip must be dot-only\n${context}`,
  ).toBe(0);

  // A non-empty, complete inventory — precondition 2.
  const keys = measurement.controls.map((control) => control.key);
  for (const required of REQUIRED_CONTROL_KEYS) {
    // The bell's label gains a " (N need attention)" suffix when its first
    // notification arrives, which lands at a different moment per run.
    expect(
      keys.map((key) => (key.startsWith(`${required} (`) ? required : key)),
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

          const measurement = await measureToolbarControls(page);
          assertToolbarPreconditions(measurement, state.modifier);
          assertReachability(measurement);
        });
      }
  });
}
