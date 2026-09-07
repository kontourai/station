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
 * 1. THE CONNECTION CHIP MUST BE IN A NEWS-CARRYING STATE, AND THE RUN MUST
 *    KNOW WHICH ONE. Connected (and idle) render dot-only at ~44px, because
 *    `chat.css` hides `.app-toolbar__conn-state` for those two states under
 *    the mobile breakpoint. A news-carrying state renders that span, and the
 *    chip grows by however wide the span is allowed to be — which is what
 *    pushed the actions cluster past the viewport edge. EVERY defect in this
 *    class only exists in the wide state, and two independent lanes have each
 *    measured this toolbar in the CONNECTED state and concluded it fits.
 *
 *    Since #1132 the STATE is no longer the only thing that decides whether
 *    that span renders: below a measured width `chat.css` collapses the chip
 *    to its dot in every state, because the row cannot hold the label and the
 *    Settings gear at once. So "the span has zero width" no longer means "the
 *    drive landed on connected/idle", and precondition 1(b) reads which of the
 *    two it is out of the live cascade rather than assuming. At those widths
 *    the narrow chip is the correct layout and the thing to assert is that it
 *    APPLIED — see `labelWidthSuppression`.
 *
 *    That span's width is NOT a constant, and this comment deliberately does
 *    not name one. It was `min-width: 116px` (chip 151px) when the defects in
 *    this class shipped; #1424 replaced that at the mobile breakpoint with
 *    `min-width: 0; max-width: 85px`. Anything written here is a transcription
 *    that goes stale the next time the row's budget is re-derived, so the
 *    suite reads the computed value live (`connectionStateMaxWidth`) and this
 *    text describes the mechanism instead.
 *
 *    "A news state" is a class, though, and a precondition satisfied by the
 *    cheapest member of a class is the same trap one level down. So each case
 *    below drives ONE NAMED state and pins the exact modifier class it got,
 *    and `assertToolbarPreconditions` additionally measures every
 *    news-carrying label in the chip's live font and asserts they all fit
 *    inside the span it measured. That is what makes a run over two states a
 *    measurement of the widest chip any of the five can produce, by
 *    derivation rather than by assertion — and it fails loudly, naming the
 *    label, the day someone adds copy that no longer fits.
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
 * Every visible `connStateLabel` (`HeaderActions.tsx`) for a state whose text
 * survives the mobile breakpoint — i.e. all but `connected`/`idle`, which
 * `chat.css` renders dot-only.
 *
 * This list is not decoration. `assertToolbarPreconditions` measures each of
 * these in the chip's own live font and asserts they ALL fit inside the span
 * it just measured, which is what turns "this run drove one news state" into
 * "this run measured the widest the chip can be in any of them". Add a state's
 * label here when you add the state, or the derivation silently stops covering
 * it.
 */
const NEWS_CARRYING_LABELS = [
  'Reconnecting', // connecting
  "Can't connect", // error
  'Pair', // needs-credential
  'Awaiting approval', // awaiting-approval
  'Needs re-pairing', // needs-repair
] as const;

/**
 * Sub-pixel tolerance when comparing two independently laid-out widths.
 * Layout reports values like 84.99993896484375 for an 85px box.
 */
const SUBPIXEL_TOLERANCE_PX = 0.01;

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
 * 412 is the Pixel 7's own viewport. 402 is a second real Android width. 390 is
 * the common iPhone width #1401 closed. 360 is the common Android width #1132
 * closed, and it is the only one of the four BELOW `chat.css`'s dot-only
 * breakpoint — so it is the only case that evaluates that rule at all, and the
 * only place a regression in it can surface. Four rather than two because a
 * single width cannot notice a defect confined to a narrow band, and a narrow
 * band is exactly what either of those two fixes leaves behind if it stops
 * applying.
 */
const TOOLBAR_WIDTHS: readonly number[] = [412, 402, 390, 360];

/**
 * The news-carrying connection states this guard drives, each through the real
 * health-coordinator path, and each PINNED by the exact modifier class it must
 * produce. Driving "a news state" and accepting whichever one arrives is the
 * trap this list exists to close.
 *
 * MEASURED, because the reason for driving more than one is not what it looks
 * like. Intrinsic widths in the live DM Sans face at this size: "Awaiting
 * approval" 100.23px, "Needs re-pairing" 95.94px, "Can't connect" 78.75px,
 * "Reconnecting" 77.70px, "Pair" 21.06px. Whether label length changes the
 * geometry depends on where the span's bounds sit relative to those numbers,
 * and that has already moved once: under the `min-width: 116px` reservation
 * these defects shipped with, every label was shorter than the floor, so the
 * span rendered at 116px and the chip at 151px in all of them; under #1424's
 * mobile `max-width: 85px`, the two longest are clipped to the ceiling and
 * the shorter ones render at their own width.
 *
 * What survives both regimes — and the reason this pair is worth driving — is
 * that the two longest labels land on the SAME width as each other in either
 * one, so neither case can mask a regression in the other. The suite
 * re-derives that from live measurements on every run rather than trusting
 * this paragraph, and fails naming the label if it stops holding. (A
 * raw-label comparison suggests otherwise — 79px vs 125px — but that is the
 * text width before the span's bounds apply, which is a component-fixture
 * reading, not this page's.)
 *
 * So this pair is not two different widths; it is two different MECHANISMS
 * reaching the wide chip, one of which cannot mask a regression in the other,
 * plus a named state in the failure output either way. The claim that they
 * cover the whole class is carried by `newsLabelWidths` in the preconditions,
 * not by this list's length.
 */
const NEWS_STATES: ReadonlyArray<{
  id: string;
  /** The `app-toolbar__conn--*` modifier this drive must produce, exactly. */
  modifier: string;
  /**
   * Exactly one entry is the state whose chip is at least as wide as any
   * news-carrying state could render. That entry carries the coverage claim
   * for the whole class, checked against live label measurements in
   * `assertToolbarPreconditions`; the others deliberately do not.
   */
  coversClassMaximum: boolean;
  drive: (page: Page) => Promise<void>;
}> = [
  {
    // Refusing the public handshake the health coordinator probes with
    // (`probeServerConnection`, src-ui/src/lib/serverHealth.ts) is the real
    // "host stopped answering" path through the real state machine. Only that
    // one endpoint is refused — `/api/system/status` and the rest of the app
    // keep working — so this is the toolbar a user with an unreachable
    // Station actually sees. Preferred over `context.setOffline(true)`, which
    // only affects requests the coordinator has yet to make and was observed
    // still reading `Connected` 12s later.
    id: 'error ("Can\'t connect")',
    modifier: 'app-toolbar__conn--error',
    // The shortest news label (78.75px). Not the class maximum, and after
    // #1424 measurably narrower than one — which is exactly why driving only
    // this state is not enough.
    coversClassMaximum: false,
    drive: async (page) => {
      await page.route(`**${PUBLIC_STATION_HANDSHAKE_PATH}*`, (route) =>
        route.abort('connectionrefused'),
      );
    },
  },
  {
    id: 'needs-repair ("Needs re-pairing")',
    modifier: 'app-toolbar__conn--needs-repair',
    // 95.94px of text — second-longest after "Awaiting approval" (100.23px),
    // but both exceed the span's `max-width` ceiling after #1424 and both sit
    // under the reservation before it, so this state's chip is exactly as wide
    // as that one's either way. The assertion re-derives that from live
    // measurements on every run rather than trusting this comment, and fires
    // if it ever stops holding.
    coversClassMaximum: true,
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
   * Intrinsic text width of every `NEWS_CARRYING_LABELS` entry, measured in
   * the chip label's own computed font on this page. `null` when the span is
   * absent (a dot-only chip), which precondition 1 fails on first.
   */
  newsLabelWidths: Record<string, number> | null;
  /** `(pointer: coarse)` — what decides the region-control fold (#917). */
  coarsePointer: boolean;
  /**
   * The label span's computed `max-width` in px, or `null` for `none` — the
   * ceiling past which the copy ellipsises and the box grows no further. Read
   * from the page rather than transcribed, because it is a live CSS value
   * that changes (#1424 takes it from 120px to 85px) and a transcribed copy
   * would quietly go stale.
   */
  connectionStateMaxWidth: number | null;
  /**
   * The width rule that hides the chip's LABEL on width alone (#1132), found
   * in the live stylesheet rather than transcribed, plus whether this viewport
   * matches it. `null` when no such rule exists.
   *
   * There are now two independent reasons `.app-toolbar__conn-state` can have
   * zero width — the two dot-only STATES, and this WIDTH breakpoint — and
   * precondition 1(b) below has to tell them apart or it blames the drive for
   * a correct layout.
   */
  labelWidthSuppression: { condition: string; matches: boolean } | null;
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
  return page.evaluate((newsLabels: readonly string[]) => {
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

    /**
     * The intrinsic width each news-carrying label WOULD take, rendered with
     * the live chip label's own computed typography (the self-hosted DM Sans
     * face at its real size/weight/letter-spacing) rather than a guess.
     *
     * Measured off-layout in a clone that drops the width constraints, so this
     * reports the text's own width rather than the clamped box's — the whole
     * point is to compare "what the copy needs" against "what the box gives".
     */
    const measureNewsLabelWidths = (
      labelElement: HTMLElement | null | undefined,
    ): Record<string, number> | null => {
      if (!labelElement) return null;
      const style = getComputedStyle(labelElement);
      const probe = document.createElement('span');
      probe.style.font = style.font;
      probe.style.fontFamily = style.fontFamily;
      probe.style.fontSize = style.fontSize;
      probe.style.fontWeight = style.fontWeight;
      probe.style.letterSpacing = style.letterSpacing;
      probe.style.whiteSpace = 'nowrap';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.minWidth = '0';
      probe.style.maxWidth = 'none';
      document.body.append(probe);
      const widths: Record<string, number> = {};
      for (const label of newsLabels) {
        probe.textContent = label;
        widths[label] = round(probe.getBoundingClientRect().width);
      }
      probe.remove();
      return widths;
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
      newsLabelWidths: measureNewsLabelWidths(connectionState),
      connectionStateMaxWidth: (() => {
        if (!connectionState) return null;
        const declared = getComputedStyle(connectionState).maxWidth;
        const parsed = Number.parseFloat(declared);
        return declared === 'none' || Number.isNaN(parsed)
          ? null
          : round(parsed);
      })(),
      // Read out of the live cascade, not transcribed: any @media rule that
      // declares `display: none` for `.app-toolbar__conn-state` through a
      // selector naming NO connection-state modifier is a width rule. The
      // state rules (`.app-toolbar__conn--connected .app-toolbar__conn-state`)
      // are excluded by that test, and the sibling `__conn-name`/`__conn-note`
      // rules never mention this selector at all. A transcribed pixel value
      // here would be the exact staleness `connectionStateMaxWidth` above
      // already exists to avoid.
      labelWidthSuppression: (() => {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRule[];
          try {
            rules = Array.from(sheet.cssRules ?? []);
          } catch {
            continue; // A cross-origin sheet cannot be inspected; none of ours are.
          }
          for (const rule of rules) {
            if (!(rule instanceof CSSMediaRule)) continue;
            for (const inner of Array.from(rule.cssRules ?? [])) {
              if (!(inner instanceof CSSStyleRule)) continue;
              const selector = inner.selectorText;
              if (!selector.includes('.app-toolbar__conn-state')) continue;
              if (selector.includes('.app-toolbar__conn--')) continue;
              if (inner.style.display !== 'none') continue;
              return {
                condition: rule.conditionText,
                matches: window.matchMedia(rule.conditionText).matches,
              };
            }
          }
        }
        return null;
      })(),
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
  }, NEWS_CARRYING_LABELS);
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
function assertToolbarPreconditions(
  measurement: ToolbarMeasurement,
  expectedModifier: string,
  coversClassMaximum: boolean,
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

  // (b) The label span is actually laid out — WHERE THE STYLESHEET LAYS IT OUT.
  //     Independent of (a): the class is what the component wrote, this is what
  //     the browser did with it. Deliberately not a pixel threshold: an earlier
  //     revision required >=110px, which encoded the 116px reservation of the
  //     day and would have reddened this guard on #1424 — a change that narrows
  //     the span to <=85px without making the chip any less news-carrying. The
  //     strength here comes from (a) and (c), which are tied to mechanisms
  //     rather than to a number.
  //
  //     #1132 gave zero width a SECOND cause. It used to have exactly one —
  //     `chat.css` hides this span for connected/idle — so "zero width IS the
  //     dot-only chip" was a sound reading, and this assertion could say so.
  //     There is now also a width breakpoint below which the chip is
  //     deliberately dot-only in EVERY state, because the row cannot hold the
  //     label and `Open settings` at once. Left as it was, this would fail at
  //     those widths blaming the drive for reaching connected/idle — a wrong
  //     diagnosis of a correct layout, and the reason the 360px case could not
  //     simply be un-skipped.
  //
  //     So the fork is read out of the live cascade
  //     (`labelWidthSuppression`), never transcribed, and BOTH sides assert:
  //     above the breakpoint the span must be laid out; at or below it the span
  //     must NOT be, because the narrow presentation is what makes the row fit
  //     and a regression that stopped applying it is exactly what this guard's
  //     reachability check would then catch one assertion later.
  const labelSuppressedByWidth =
    measurement.labelWidthSuppression?.matches === true;
  if (labelSuppressedByWidth) {
    expect(
      measurement.connectionStateWidth ?? 0,
      `this viewport matches ${JSON.stringify(measurement.labelWidthSuppression?.condition)}, ` +
        `where chat.css collapses the chip to its dot so the action cluster ` +
        `fits — but the label span still laid out, so the rule that keeps ` +
        `\`Open settings\` on screen at this width is not applying\n${context}`,
    ).toBe(0);
  } else {
    expect(
      measurement.connectionStateWidth ?? 0,
      `.app-toolbar__conn-state has zero width at a width where no rule ` +
        `suppresses it, which is the dot-only chip — chat.css hides this span ` +
        `for connected/idle, and a measurement of it cannot reproduce any ` +
        `defect in this class\n${context}`,
    ).toBeGreaterThan(0);
  }

  // (c) THE DERIVATION that makes driving two states a statement about all
  //     five. Every news-carrying label, measured in this chip's own live
  //     font, fits inside the span just measured — so no state this guard did
  //     NOT drive could have produced a wider chip, and the geometry checked
  //     below is the worst case for the whole class rather than for whichever
  //     member happened to be cheapest to reach.
  //
  //     When this fires, the guard has not found a layout bug; it has found
  //     that its own coverage claim expired. The remedy is to drive the state
  //     that owns the offending label and assert it directly.
  // Only the state DESIGNATED as the class maximum carries this claim. The
  // others are deliberately narrower — that is the point of driving more than
  // one — so asserting it of every case would red the `error` case the moment
  // #1424 lands and the labels stop being equal-width.
  if (!coversClassMaximum) return;
  // …and it cannot be checked below the width breakpoint, where no state lays
  // the label out at all. The class maximum is not lost there, it is trivial:
  // every news-carrying state renders the SAME dot-only chip, which the branch
  // above has just asserted, so there is no wider member to miss.
  if (labelSuppressedByWidth) return;
  const measuredSpan = measurement.connectionStateWidth ?? 0;
  const ceiling =
    measurement.connectionStateMaxWidth ?? Number.POSITIVE_INFINITY;
  const widest = Object.entries(measurement.newsLabelWidths ?? {}).reduce(
    (best, entry) => (entry[1] > best[1] ? entry : best),
    ['<none>', 0] as [string, number],
  );
  // What the widest label would actually lay the span out to: its own text
  // width, capped by `max-width` (past which the copy ellipsises and the box
  // stops growing). Comparing against the raw text width instead would red
  // whenever a label is merely ellipsised — true of two labels the moment
  // #1424 lands — which is a clamp doing its job, not a coverage gap.
  const widestReachableSpan = Math.min(widest[1], ceiling);
  expect(
    measuredSpan + SUBPIXEL_TOLERANCE_PX,
    `${expectedModifier} is designated as the widest news-carrying state, but ` +
      `it measured a ${measuredSpan}px label span while '${widest[0]}' would ` +
      `lay out to ${widestReachableSpan}px (text ${widest[1]}px, capped by ` +
      `max-width ${ceiling}px). Some state this suite does not drive renders a ` +
      `WIDER chip, so the geometry checked below is not the worst case for the ` +
      `class and this guard's coverage claim is stale. Drive the state that ` +
      `owns that label and move the designation to it (see NEWS_STATES)` +
      `\n${context}`,
  ).toBeGreaterThanOrEqual(widestReachableSpan);

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

// The coverage claim above is carried by exactly one entry. Losing it (or
// duplicating it) would silently drop the class-maximum check while every test
// still passed, so it fails collection instead of failing quietly.
const CLASS_MAXIMUM_STATES = NEWS_STATES.filter(
  (state) => state.coversClassMaximum,
);
if (CLASS_MAXIMUM_STATES.length !== 1) {
  throw new Error(
    `exactly one NEWS_STATES entry must set coversClassMaximum; found ` +
      `${CLASS_MAXIMUM_STATES.length} (${CLASS_MAXIMUM_STATES.map((state) => state.id).join(', ') || 'none'})`,
  );
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

    for (const state of NEWS_STATES) {
      test(`every visible app-toolbar control is reachable at its own centre — ${state.id}`, async ({
        page,
      }) => {
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
        assertToolbarPreconditions(
          measurement,
          state.modifier,
          state.coversClassMaximum,
        );
        assertReachability(measurement);
      });
    }
  });
}
