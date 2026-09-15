/**
 * The runner's default per-test timeout, in one place so that the value
 * `playwright.config.ts` sets and the value tests reason about cannot diverge.
 *
 * It lives in its own module, with no import of `@playwright/test`, precisely so
 * a vitest lane can read it: `readinessTestTimeoutRefusal`'s premise is that this
 * default is BELOW the readiness budget, and a premise pinned against a
 * transcribed literal is not pinned at all — raise the runner's default and the
 * guard silently stops firing for the default caller while a hardcoded `30_000`
 * in a test stays green.
 */
export const PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS = 30_000;

/**
 * How long this fixture's status wait may run, given the per-test budget it is
 * running INSIDE.
 *
 * WHY A SHARE AND NOT A COPY. This wait used to be given a flat `30_000`, which
 * is byte for byte `PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS` and therefore
 * `playwright.config.ts`'s per-test timeout. The two clocks are not
 * independent: the test's clock STARTED during fixture setup, before this
 * helper was entered, so an inner deadline equal to the outer one is
 * structurally unable to win no matter how the run goes. Playwright always
 * expired first, and what the reader got was a bare
 * `Test timeout of 30000ms exceeded` — naming neither `/api/system/status` nor
 * the class premise. The helper's own `TimeoutError`, which names the URL, and
 * the two `expect()`s that follow it, which name the class the server actually
 * reported, could never be reached. Every diagnostic this fixture contains was
 * downstream of a race it could not win.
 *
 * A HALF-BUDGET SHARE is what makes it winnable rather than merely smaller: it
 * leaves the first half for whatever setup preceded this call and the last for
 * the assertions that follow, so the inner deadline fires first for any
 * division of the budget between them. Read from `test.info()` at call time
 * rather than from the constant, so a caller that raised its own timeout with
 * `test.setTimeout` gets a proportionally larger share instead of silently
 * keeping the default's.
 *
 * `0` is Playwright's "no timeout"; outside a Playwright worker there is no
 * test clock to lose to. Both take the default budget's share.
 */
export function deviceClassStatusTimeoutMs(
  perTestTimeoutMs: number | undefined,
): number {
  const budget =
    perTestTimeoutMs === undefined || perTestTimeoutMs === 0
      ? PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS
      : perTestTimeoutMs;
  // NO MINIMUM FLOOR, deliberately. A first draft floored this at 5_000 so a
  // very small budget would still leave a wait long enough to tell silence
  // from an answer — and the sweep in
  // `scripts/__tests__/device-class-status-budget.test.ts` caught that a floor
  // and this function's one invariant are in direct conflict: at a 5_000
  // budget the floor returns 5_000, which is not strictly less than 5_000, and
  // the matched-deadline defect is back at exactly the budget where the margin
  // is thinnest. A caller whose whole test budget is 5s has no room for a
  // longer wait to occupy; lengthening the inner one cannot buy time the test
  // does not have, it only restores the race. Half, always.
  return Math.floor(budget / 2);
}
