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
