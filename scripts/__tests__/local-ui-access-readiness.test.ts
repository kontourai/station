import { describe, expect, test } from 'vitest';
import {
  LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
  type LocalUiAccessObservation,
  MAX_HOST_RECOVERY_RELOADS,
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
  const state = { now: 0, reloads: 0, waits: [] as number[] };
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
      reloadAfterHostRecovery: async () => {
        state.reloads += 1;
        state.now += 1_000;
      },
      now: () => state.now,
      ...overrides,
    } satisfies LocalUiAccessObservation,
  };
}

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
    expect(LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
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
    const { observation: port } = observation(['host-unavailable', 'ready']);

    await waitForLocalUiAccessReadinessThrough(port, 10_000);

    // First wait gets the whole budget; the second gets what the first wait
    // (1s) and the reload (1s) left of it.
    expect(port.now()).toBe(3_000);
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
      'the access gate never settled. On screen: the gate’s "taking longer than expected" alert. Recovery reloads taken: 0.',
    );
  });

  test('a screen the helper does not model is reported, not silently waited out', async () => {
    const { observation: port } = observation(['unmodelled']);

    await expect(waitForLocalUiAccessReadinessThrough(port)).rejects.toThrow(
      'the access gate settled into a screen this helper does not model',
    );
  });

  test('an exhausted budget is not spent on one more wait', async () => {
    const { observation: port, state } = observation(['host-unavailable']);

    await expect(
      waitForLocalUiAccessReadinessThrough(port, 1_500),
    ).rejects.toThrow('the access gate never settled');
    // 1s wait + 1s reload overran the 1.5s budget, so no second wait was made.
    expect(state.waits).toEqual([1_500]);
  });
});
