import { describe, expect, test } from 'vitest';
import { LOCAL_UI_SESSION_ATTEMPT_LIMIT } from '../../src-ui/src/lib/local-ui-session-retry.js';
import {
  LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
  type LocalUiAccessObservation,
  MAX_HOST_RECOVERY_RELOADS,
  readinessTestTimeoutRefusal,
  type SettledLocalUiAccessScreen,
  waitForLocalUiAccessReadinessThrough,
} from '../../tests/helpers/local-ui-access-readiness.js';

/**
 * The gate's settled screens arrive after real elapsed time, so every fake
 * advances the clock: a wait consumes its whole budget unless a screen is
 * scripted, and a recovery reload costs a second.
 */
function observation(
  screens: SettledLocalUiAccessScreen[],
  overrides: Partial<LocalUiAccessObservation> = {},
) {
  const queue = [...screens];
  const state = {
    now: 0,
    reloads: 0,
    waits: [] as number[],
    reloadBudgets: [] as number[],
  };
  return {
    state,
    observation: {
      waitForSettledScreen: async (timeoutMs: number) => {
        state.waits.push(timeoutMs);
        const next = queue.shift();
        if (!next) {
          state.now += timeoutMs;
          return 'timeout';
        }
        state.now += 1_000;
        return next;
      },
      accessRequiredDetail: async () => 'Failed to fetch',
      pendingScreenDetail: async () =>
        'the gate’s "taking longer than expected" alert',
      reloadAfterHostRecovery: async (timeoutMs: number) => {
        state.reloadBudgets.push(timeoutMs);
        state.reloads += 1;
        state.now += 1_000;
      },
      now: () => state.now,
      ...overrides,
    } satisfies LocalUiAccessObservation,
  };
}

/**
 * The budget exceeds `playwright.config.ts`'s 30 s default per-test timeout, so a
 * caller that has not raised its own `test.setTimeout` cannot reach any of the
 * sentences above — the test dies first, as a bare `Test timeout of Nms
 * exceeded`, which is the unnamed failure this whole helper exists to abolish.
 * The obligation is therefore derived rather than documented.
 *
 * WHAT THIS DOES NOT COVER: that the browser adapter calls this. The call is one
 * `if` at the top of `waitForLocalUiAccessReadiness`, which needs a real
 * Playwright `Page` and worker to execute, so it is verified by reading.
 */
describe('readiness refuses a test timeout it cannot fit inside', () => {
  test('a caller under the default 30 s timeout is refused, naming both numbers', () => {
    const refusal = readinessTestTimeoutRefusal(
      30_000,
      LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
    );
    expect(refusal).toBeDefined();
    expect(refusal).toContain('30000ms timeout');
    expect(refusal).toContain(
      `${LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS}ms to settle`,
    );
    expect(refusal).toContain('test.setTimeout');
  });

  test('the live default IS the refused case, so this is not a hypothetical', () => {
    // Pins the premise the guard exists for: `playwright.config.ts` ships
    // `timeout: 30_000`, and the budget is above it. If the budget ever drops
    // below the config default the guard becomes dead code, and this reds.
    expect(LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  test('a timeout with room to spare passes', () => {
    expect(
      readinessTestTimeoutRefusal(
        LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS + 1,
        LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
      ),
    ).toBeUndefined();
    expect(
      readinessTestTimeoutRefusal(
        150_000,
        LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
      ),
    ).toBeUndefined();
  });

  test('exactly the budget is refused, and 0 — Playwright for "no timeout" — is not', () => {
    // Equality is doomed rather than borderline: a test whose entire timeout is
    // this wait's budget has nothing left for the goto before it.
    expect(
      readinessTestTimeoutRefusal(
        LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
        LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
      ),
    ).toBeDefined();
    expect(
      readinessTestTimeoutRefusal(0, LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS),
    ).toBeUndefined();
  });
});

describe('local UI access readiness wait', () => {
  test('returns as soon as the protected shell mounts', async () => {
    const { observation: port, state } = observation(['ready']);

    await expect(waitForLocalUiAccessReadinessThrough(port)).resolves.toEqual({
      hostRecoveryReloads: 0,
    });
    expect(state.reloads).toBe(0);
  });

  test('the whole budget is offered to the gate, not a degraded-window multiple', async () => {
    const { observation: port, state } = observation(['ready']);

    await waitForLocalUiAccessReadinessThrough(port);

    expect(state.waits).toEqual([LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS]);
    // Pins the budget against the revert this test exists for (station#1617):
    // it used to be DEGRADED_QUERY_TIMEOUT_MS (8_000) + 2_000, and a loaded
    // host answered the gate's one bootstrap request in 6.6s, leaving no room
    // for the reload the recovery screen asks for and a second request.
    //
    // The floor is now higher than that 20_000: since #1639 the gate makes up to
    // `LOCAL_UI_SESSION_ATTEMPT_LIMIT` identity requests before it settles into
    // the recovery screen, so a budget that only covered one of them would
    // report "never settled" for a gate that was about to answer. The literal is
    // deliberate alongside the derivation — a floor computed from the same
    // constants the budget uses could not notice them shrinking.
    expect(LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(LOCAL_UI_SESSION_ATTEMPT_LIMIT).toBeGreaterThan(1);
  });

  test('follows the recovery screen to the shell when the host was momentarily away', async () => {
    const { observation: port, state } = observation([
      'host-unavailable',
      'ready',
    ]);

    await expect(waitForLocalUiAccessReadinessThrough(port)).resolves.toEqual({
      hostRecoveryReloads: 1,
    });
    expect(state.reloads).toBe(1);
  });

  test('a recovery reload spends the same deadline rather than restarting it', async () => {
    const { observation: port, state } = observation([
      'host-unavailable',
      'ready',
    ]);

    await waitForLocalUiAccessReadinessThrough(port, 10_000);

    // The second wait is offered what the first wait (1s) and the reload (1s)
    // left of the original 10s — not a fresh 10s. The reload itself is bounded
    // by the same deadline, so its own navigation wait cannot outlive it.
    expect(state.waits).toEqual([10_000, 8_000]);
    expect(state.reloadBudgets).toEqual([9_000]);
  });

  test('a host that stays unavailable fails naming the state and the reloads taken', async () => {
    const { observation: port, state } = observation([
      'host-unavailable',
      'host-unavailable',
      'host-unavailable',
      'ready',
    ]);

    await expect(waitForLocalUiAccessReadinessThrough(port)).rejects.toThrow(
      `the access gate reported this Station's host process down or recovering after ${MAX_HOST_RECOVERY_RELOADS} recovery reload(s)`,
    );
    expect(state.reloads).toBe(MAX_HOST_RECOVERY_RELOADS);
  });

  test('a refused browser fails immediately with the gate’s own reason', async () => {
    const { observation: port, state } = observation([
      'host-unavailable',
      'access-required',
    ]);

    await expect(waitForLocalUiAccessReadinessThrough(port)).rejects.toThrow(
      'the access gate refused this browser and asked it to pair (Failed to fetch)',
    );
    expect(state.reloads).toBe(1);
  });

  test('a gate that never settles reports what was on screen', async () => {
    const { observation: port } = observation([]);

    await expect(waitForLocalUiAccessReadinessThrough(port)).rejects.toThrow(
      'the access gate never settled. On screen: the gate’s "taking longer than expected" alert.',
    );
  });

  test('a still-pending gate is waited through, not failed', async () => {
    // 'pending' is what the degraded alert reads as: the gate has not answered
    // yet, and `useDegradedQueryState` clears that state on a later success.
    const { observation: port, state } = observation([
      'pending',
      'pending',
      'ready',
    ]);

    await expect(waitForLocalUiAccessReadinessThrough(port)).resolves.toEqual({
      hostRecoveryReloads: 0,
    });
    expect(state.waits).toEqual([
      LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
      LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS - 1_000,
      LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS - 2_000,
    ]);
  });

  test('a timeout after recovery reloads does not claim the gate never settled', async () => {
    const { observation: port } = observation(['host-unavailable'], {
      pendingScreenDetail: async () => '"Reconnecting to this Station"',
    });

    await expect(
      waitForLocalUiAccessReadinessThrough(port, 1_500),
    ).rejects.toThrow(
      'the access gate settled into its host-recovery screen 1 time(s) and the deadline expired with no protected shell. On screen: "Reconnecting to this Station".',
    );
  });

  test("a recovery screen with no way forward surfaces the reload's own reason", async () => {
    // The adapter rejects when the screen offers no control. The wait must let
    // that sentence through rather than converting it into a timeout report.
    const { observation: port } = observation(['host-unavailable'], {
      reloadAfterHostRecovery: async () => {
        throw new Error(
          'the access gate\'s host-recovery screen offered no "Try again" control',
        );
      },
    });

    await expect(waitForLocalUiAccessReadinessThrough(port)).rejects.toThrow(
      'the access gate\'s host-recovery screen offered no "Try again" control',
    );
  });

  test('a screen the helper does not model is reported, not silently waited out', async () => {
    const { observation: port } = observation(['unmodelled']);

    await expect(waitForLocalUiAccessReadinessThrough(port)).rejects.toThrow(
      'the page rendered a screen this wait does not model',
    );
  });

  test('an exhausted budget is not spent on one more wait', async () => {
    const { observation: port, state } = observation(['host-unavailable']);

    await expect(
      waitForLocalUiAccessReadinessThrough(port, 1_500),
    ).rejects.toThrow('the deadline expired with no protected shell');
    // 1s wait + 1s reload overran the 1.5s budget, so no second wait was made.
    expect(state.waits).toEqual([1_500]);
  });
});
