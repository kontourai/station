import { describe, expect, test } from 'vitest';
import {
  deviceClassStatusTimeoutMs,
  PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS,
} from '../../tests/helpers/playwright-test-timeout.js';

/**
 * `openDeviceClassContext` waits for the app's own `/api/system/status` answer
 * and then asserts, twice, which device class the server reported. That wait
 * was given a flat `30_000`, which is byte for byte the per-test timeout in
 * `playwright.config.ts`.
 *
 * The two clocks are not independent. Playwright's started during fixture
 * setup, before the helper was entered, so an inner deadline equal to the outer
 * one is STRUCTURALLY unable to win: the test always died first, as a bare
 * `Test timeout of 30000ms exceeded` naming neither the URL nor the class
 * premise, and the helper's own `TimeoutError` plus both explanatory
 * `expect()`s were unreachable by construction.
 *
 * The function lives in `playwright-test-timeout.ts`, which imports
 * `@playwright/test` nowhere, exactly so a vitest lane can execute this
 * decision — the same arrangement `readinessTestTimeoutRefusal` uses, and for
 * the same reason: a budget rule that can only be read, never run, is not
 * pinned.
 */
describe('the device-class status wait gets a share of the test budget, not a copy', () => {
  test('it is strictly less than the budget it runs inside', () => {
    // The whole defect in one assertion: equality is the failing case, and a
    // helper that merely copied the constant would land exactly on it.
    expect(
      deviceClassStatusTimeoutMs(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS),
    ).toBeLessThan(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS);
  });

  test('it stays winnable for any budget a caller may set', () => {
    // Swept rather than sampled: the property is "strictly less at every
    // budget", and a single case cannot distinguish that from a coincidence at
    // one value. A literal 30_000 sits in the sweep alongside the constant, so
    // this still discriminates if the default is ever raised.
    for (const budget of [
      5_000, 10_000, 30_000, 45_000, 60_000, 120_000, 600_000,
    ]) {
      expect(deviceClassStatusTimeoutMs(budget)).toBeLessThan(budget);
    }
  });

  test('a raised per-test timeout raises the share with it', () => {
    // A caller using `test.setTimeout` gets proportionally more, rather than
    // silently keeping the default's share — which is why the helper reads
    // `test.info()` at call time instead of the constant.
    expect(deviceClassStatusTimeoutMs(120_000)).toBeGreaterThan(
      deviceClassStatusTimeoutMs(30_000),
    );
  });

  test('Playwright’s "no timeout" and a non-Playwright caller take the default share', () => {
    // `0` is Playwright's no-timeout; `undefined` is what
    // `currentTestTimeoutMs` answers outside a worker. Neither has a test clock
    // to lose to, so neither may produce `Infinity`, `NaN` or `0`.
    for (const absent of [0, undefined]) {
      const budget = deviceClassStatusTimeoutMs(absent);
      expect(budget).toBe(
        deviceClassStatusTimeoutMs(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS),
      );
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);
    }
  });

  test('a small budget does not get a floor that restores the matched deadline', () => {
    // This case is why the sweep above is a sweep. A first draft floored the
    // result at 5_000 so a tiny budget would still leave a usable wait; at a
    // 5_000 budget that returns 5_000, which is NOT strictly less, and the
    // exact defect this function exists to remove reappears at the budget with
    // the least margin. A caller whose whole test budget is 5s has no room for
    // a longer wait to occupy, so the floor could only buy back the race.
    expect(deviceClassStatusTimeoutMs(5_000)).toBeLessThan(5_000);
    expect(deviceClassStatusTimeoutMs(1_000)).toBeLessThan(1_000);
    expect(deviceClassStatusTimeoutMs(1_000)).toBeGreaterThan(0);
  });
});
