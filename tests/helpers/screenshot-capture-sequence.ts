/**
 * #1650: the gallery suite's per-screen capture ORDER, as a unit.
 *
 * `tests/screenshots.spec.ts` photographs 48 screens for exact-pixel
 * comparison, and the order of its pre-shot steps is load-bearing: several of
 * them exist only because a later step could otherwise mutate the DOM after
 * the guarantee an earlier one established. That ordering used to live inline
 * in a Playwright `test()` body, where nothing but a full 48-screen browser run
 * could observe it — and a browser run observes the PIXELS, not the sequence,
 * so a step silently moving to the wrong side of another one is exactly the
 * kind of change a passing gallery run cannot report.
 *
 * The sequence is therefore expressed here as an ordered composition of
 * caller-supplied steps, deliberately carrying no Playwright import and no
 * knowledge of a `Page`: the spec keeps every mechanic (viewport, navigation,
 * the assertion helpers, the screenshot call and its output path) and passes
 * them in as closures. A unit test can then drive it with recording doubles and
 * assert the order itself.
 *
 * This module owns ONLY the order. It deliberately does not own what any step
 * does, when a step is skipped, or the per-screen error handling around the
 * whole sequence — all of that stays with the spec, whose own comments explain
 * each step.
 */

/**
 * The pre-shot steps, in the shape the sequence composes them.
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
  /**
   * Await every web font the DOM currently needs. Called MORE THAN ONCE by
   * design — see the sequence body for why, and the spec's own
   * `settleWebFonts` for what a single call does and does not guarantee.
   */
  settleWebFonts: () => Promise<void>;
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
 *  - `settleWebFonts` runs a second time AFTER `afterGoto` and after
 *    `assertConnectionChrome`. Both of those steps can put text in the DOM (or
 *    wait for a state change that rewrites some), and a face needed only by
 *    that new text can begin loading after an earlier settle already resolved.
 *  - that second settle runs BEFORE `hideVolatileChrome` and the shot, with no
 *    step in between that can introduce text. `hideVolatileChrome` only hides
 *    elements that already exist, so it cannot start a font load; it therefore
 *    stays the last thing before the shot, as its own doc comment requires.
 */
export async function runScreenshotCaptureSequence(
  steps: ScreenshotCaptureSteps,
): Promise<void> {
  await steps.reachScreen();
  // Fonts settled once here, before the hook rather than only after it: the
  // hook drives real interactions, and a swap reflowing the page mid-hook can
  // move a target it is about to click. This settle is about the interaction;
  // the one below is about the photograph.
  await steps.settleWebFonts();
  await steps.assertNoLoadingSkeleton?.();
  await steps.afterGoto?.();
  await steps.assertConnectionChrome?.();
  await steps.settleWebFonts();
  await steps.hideVolatileChrome();
  await steps.screenshot();
}
