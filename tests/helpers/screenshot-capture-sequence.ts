/**
 * #1650: the gallery suite's per-screen capture ORDER, as a unit.
 *
 * `tests/screenshots.spec.ts` photographs 48 screens for exact-pixel
 * comparison, and the order of its pre-shot steps is load-bearing: several of
 * them exist only because a later step could otherwise mutate the DOM after
 * the guarantee an earlier one established. That ordering used to live inline
 * in a Playwright `test()` body, where nothing but a full 48-screen browser run
 * could observe it — and a browser run observes the PIXELS, not the sequence,
 * so a step silently moving to the wrong side of another one would surface only
 * as intermittent flake, which is the problem this ordering exists to reduce.
 *
 * The sequence is therefore expressed here as an ordered composition of
 * caller-supplied steps, deliberately carrying no Playwright import: the spec
 * keeps every mechanic (viewport, navigation, the assertion helpers, the
 * screenshot call and its output path) and passes them in as closures. A unit
 * test can then drive it with recording doubles and assert the order itself.
 *
 * The ONE exception is the web-font settle, which this module performs itself
 * rather than accepting as a step — see `settleWebFonts`. Everything else is
 * caller-supplied and therefore unbound: this module proves the ORDER its steps
 * run in, never that a step does what its name says. The spec's wiring of the
 * other six steps to real Playwright calls is checked by `typecheck:e2e` and by
 * reading the diff, not by this module's test.
 */

/**
 * The single browser capability this module needs for itself.
 *
 * Structural on purpose: Playwright's `Page` satisfies it, so the spec passes
 * its real page and this module still imports no Playwright.
 */
export interface FontSettleTarget {
  evaluate(pageFunction: () => Promise<unknown>): Promise<unknown>;
}

/**
 * The browser-side probe, reached through `globalThis` and typed locally rather
 * than through the DOM lib.
 *
 * This module is compiled by two lanes and only one of them loads DOM
 * (`tsconfig.e2e.json`; the root/`scripts` lane is `lib: ["ES2022"]`, and it is
 * the lane that runs this module's own unit test). Naming `document` directly
 * would not compile there. The assertion erases at emit, so what Playwright
 * serializes into the page is `globalThis.document.fonts.ready`.
 *
 * Exported so the unit test can invoke it against a stubbed font set and prove
 * it actually reads the ready promise.
 */
export function readDocumentFontsReady(): Promise<unknown> {
  const fontDocument = (
    globalThis as unknown as {
      document: {
        documentElement: { getBoundingClientRect(): unknown };
        fonts: { ready: Promise<unknown> };
      };
    }
  ).document;
  // Flush styles/layout first: a just-mounted control may not have requested
  // its font yet when an already-resolved fonts.ready promise is read.
  fontDocument.documentElement.getBoundingClientRect();
  return fontDocument.fonts.ready;
}

/**
 * Await every web font the document currently needs.
 *
 * archive#4464: a web-font swap (FOUT/FOIT) landing mid-shot is a well-known
 * source of exactly the kind of tiny, isolated text/border-edge pixel noise the
 * gallery's own two-consecutive-runs acceptance check was still catching after
 * every other identified source was fixed — one capture can race the
 * fallback-to-real-font swap and the next can miss it entirely.
 *
 * What one call guarantees: at the moment it resolves, every `FontFace` the
 * document has requested SO FAR has finished loading or failed, so no
 * fallback-to-real-font swap is still pending for the text in the DOM as it
 * stands.
 *
 * What it does NOT guarantee: anything about text that is not in the DOM yet.
 * `FontFaceSet.ready` resolves for the loads pending when it is read; a DOM
 * mutation afterwards can request a face that has not loaded and start a fresh
 * swap. That is why the sequence below calls this twice rather than once
 * (#1650).
 *
 * What it is NOT: evidence about any particular screen's measured run-to-run
 * variance — and the screen this was first hypothesised against now argues the
 * other way. `overlay-connection-banner` opens a disclosure in its own
 * `afterGoto` and does differ between runs of an unchanged tree, but #1645
 * measured that on macOS as a difference confined to the thickness of one
 * active-tab underline, and #1665 identifies it on the pinned CI container as
 * the one CONFIRMED CONTENT RACE among the 48 screens — a sentence that changes
 * the banner's line count and shifts everything below it, which no font settle
 * can fix. This settle is correct ordering on its own terms; it is not offered
 * as a fix for that screen or any other.
 *
 * This module performs the settle rather than accepting it as a step so the STEP
 * MAP cannot supply an inert one: it no longer hands in a settle at all.
 *
 * The risk moved rather than vanished, and it is worth naming precisely. It is
 * now the passed-in OBJECT, and this module's own test doubles are exactly such
 * a caller — they record the page function and return without invoking it, which
 * is an inert settle wired in by a caller. What binds the real one is
 * `typecheck:e2e`: `FontSettleTarget` is asserted against Playwright's `Page` at
 * the spec's call site, so an object without a usable `evaluate` fails that
 * lane. Beyond the type, that the spec passes its real page is checked by
 * reading the diff, exactly like the other six steps.
 */
async function settleWebFonts(page: FontSettleTarget): Promise<void> {
  await page.evaluate(readDocumentFontsReady);
}

/**
 * The caller-supplied pre-shot steps, in the shape the sequence composes them.
 *
 * A step typed `| null` is one the spec legitimately skips for some screens.
 * Passing `null` is how a skip is expressed; the sequence never inspects a
 * screen to decide.
 */
export interface ScreenshotCaptureSteps {
  /**
   * Navigate to the screen and reach the state its own declaration asks for:
   * past the boot splash, past any declared `waitFor` selector, past the fixed
   * async-data settle.
   */
  reachScreen: () => Promise<void>;
  /** `null` for a screen that deliberately photographs a loading skeleton. */
  assertNoLoadingSkeleton: (() => Promise<void>) | null;
  /**
   * The screen's own post-navigation hook — the step that opens overlays,
   * drives interactions, and mounts text that was not in the DOM before it ran.
   * `null` for a screen that declares no hook.
   */
  afterGoto: (() => Promise<void>) | null;
  /**
   * Assert the gallery-wide connection posture. `null` for a screen that owns
   * its own connection state and must not be held to the shared one.
   */
  assertConnectionChrome: (() => Promise<void>) | null;
  /** Hide the chrome regions whose content is environment- or clock-derived. */
  hideVolatileChrome: () => Promise<void>;
  /** Take the shot. */
  screenshot: () => Promise<void>;
}

/**
 * Run the pre-shot steps in the one order that leaves nothing photographed
 * before the guarantees it needs are in place.
 *
 * Two properties are what this order is for, and what its unit test pins:
 *
 *  - the fonts are settled a second time AFTER `afterGoto` and after
 *    `assertConnectionChrome`. Both of those steps can put text in the DOM (or
 *    wait for a state change that rewrites some), and a face needed only by
 *    that new text can begin loading after an earlier settle already resolved.
 *  - that second settle runs BEFORE `hideVolatileChrome` and the shot, with no
 *    step in between that can introduce text. `hideVolatileChrome` hides
 *    elements that already exist and introduces no new text, so it stays the
 *    last thing before the shot, as its own doc comment in the spec requires.
 */
export async function runScreenshotCaptureSequence(
  page: FontSettleTarget,
  steps: ScreenshotCaptureSteps,
): Promise<void> {
  await steps.reachScreen();
  // Settled once here, before the hook rather than only after it: the hook
  // drives real interactions, and a swap reflowing the page mid-hook can move a
  // target it is about to click. This settle is about the interaction; the one
  // below is about the photograph.
  await settleWebFonts(page);
  await steps.assertNoLoadingSkeleton?.();
  await steps.afterGoto?.();
  await steps.assertConnectionChrome?.();
  await settleWebFonts(page);
  await steps.hideVolatileChrome();
  await steps.screenshot();
}
