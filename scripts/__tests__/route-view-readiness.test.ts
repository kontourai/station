import { describe, expect, test } from 'vitest';
import { StationHttpError } from '../../packages/sdk/src/client/http.js';
import { shouldRetryProjectLayout } from '../../packages/sdk/src/query-domains/workspaceProjects.js';
import { PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS } from '../../tests/helpers/playwright-test-timeout.js';
import {
  PROJECT_LAYOUT_READINESS_TIMEOUT_MS,
  type RouteViewObservation,
  type SettledRouteViewScreen,
  waitForRouteViewTargetThrough,
} from '../../tests/helpers/route-view-readiness.js';

/**
 * The view's outcomes arrive after real elapsed time, so every fake advances the
 * clock: an unscripted wait consumes its whole budget and reports `timeout`,
 * which is what the browser adapter does too.
 */
function observation(
  screens: SettledRouteViewScreen[],
  overrides: Partial<RouteViewObservation> = {},
) {
  const queue = [...screens];
  const state = { now: 0, waits: [] as number[] };
  return {
    state,
    observation: {
      viewName: 'The Models view',
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
      failureDetail: async () => '"Something went wrong loading this view"',
      pendingDetail: async () => '"Connections"',
      now: () => state.now,
      ...overrides,
    } satisfies RouteViewObservation,
  };
}

/** Every outcome, and the sentence it produces, in one place. */
async function outcomeMessage(screen: SettledRouteViewScreen): Promise<string> {
  const { observation: port } = observation([screen]);
  try {
    const result = await waitForRouteViewTargetThrough(port, 10_000);
    return `resolved:${result.screen}`;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('waitForRouteViewTargetThrough', () => {
  test('the surface arriving is reported as the observed outcome, not as an absence of failure', async () => {
    const { observation: port, state } = observation(['ready']);

    const result = await waitForRouteViewTargetThrough(port, 10_000);

    // The core's contract is that the caller learns WHICH screen ended the
    // wait. A bare resolve would let a future branch return early for a
    // different reason and still look like success here.
    expect(result.screen).toBe('ready');
    expect(result.elapsedMs).toBe(1_000);
    expect(state.waits).toEqual([10_000]);
  });

  test('a pending observation re-observes against what is left of the deadline rather than restarting it', async () => {
    const { observation: port, state } = observation([
      'pending',
      'pending',
      'ready',
    ]);

    const result = await waitForRouteViewTargetThrough(port, 10_000);

    expect(result.screen).toBe('ready');
    // Each re-observation is offered strictly less budget. A restarted deadline
    // would offer 10_000 three times, and a wait that can be restarted by a
    // repeating pending screen has no deadline at all.
    expect(state.waits).toEqual([10_000, 9_000, 8_000]);
  });

  test("a settled failure is reported by the view's own words, immediately", async () => {
    const { observation: port, state } = observation(['failed']);

    await expect(waitForRouteViewTargetThrough(port, 10_000)).rejects.toThrow(
      /The Models view failed after 1000ms: the view settled into a failure of its own .*Something went wrong loading this view/,
    );
    // The point of watching the failure screens: this cost 1 s, not the budget.
    expect(state.now).toBe(1_000);
  });

  test('a view still rendering its pending state is reported as slow', async () => {
    const { observation: port } = observation(['timeout']);

    await expect(waitForRouteViewTargetThrough(port, 10_000)).rejects.toThrow(
      /never settled within 1000ms: it is still rendering its own pending state\. On screen: "Connections"\./,
    );
  });

  test('a view that settled without the surface is reported as absent, not as slow', async () => {
    const { observation: port } = observation(['settled-without-target']);

    await expect(waitForRouteViewTargetThrough(port, 10_000)).rejects.toThrow(
      /settled without the surface this wait was given, after 1000ms: it rendered neither a pending state nor a failure of its own, so the surface is absent rather than late/,
    );
  });

  test('the budget being spent before anything is observed reports the timeout without observing', async () => {
    const { observation: port, state } = observation(['ready']);

    await expect(waitForRouteViewTargetThrough(port, 0)).rejects.toThrow(
      /never settled within 0ms/,
    );
    // `ready` was queued and never consumed: with no budget there is nothing to
    // observe, and reporting the timeout is the only honest move.
    expect(state.waits).toEqual([]);
  });

  test('every outcome produces a distinguishable sentence', async () => {
    const messages = await Promise.all(
      (
        [
          'ready',
          'failed',
          'timeout',
          'settled-without-target',
        ] as SettledRouteViewScreen[]
      ).map(outcomeMessage),
    );

    // Four outcomes, four distinct reports. Two outcomes sharing a sentence
    // would make the wait's own diagnosis unreadable, which is the defect this
    // helper exists to remove one layer up.
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages[0]).toBe('resolved:ready');
    for (const message of messages.slice(1)) {
      expect(message).toContain('The Models view');
    }
  });

  test('a screen the loop does not model announces itself instead of spinning', async () => {
    const { observation: port } = observation([
      'invented-screen' as SettledRouteViewScreen,
    ]);

    // Reachable only by adding a variant to the union and forgetting this loop.
    // Without the exhaustiveness throw it would fall through as another
    // `continue` and be reported, much later, as a timeout that never happened.
    await expect(waitForRouteViewTargetThrough(port, 10_000)).rejects.toThrow(
      /reported a screen this wait does not model: invented-screen/,
    );
  });
});

describe('PROJECT_LAYOUT_READINESS_TIMEOUT_MS', () => {
  test('is the sum its docblock claims: one proxy answer window, the first retry delay, and the navigation allowance', () => {
    // Pinned as a literal beside the derivation so that changing any input has
    // to change this number deliberately. Deriving the expectation from the same
    // constants would assert only that addition works.
    expect(PROJECT_LAYOUT_READINESS_TIMEOUT_MS).toBe(35_000);
  });

  test("funds exactly one of the layout query's attempts, which is the coverage its docblock states", () => {
    // The docblock says `shouldRetryProjectLayout` permits exactly one retry and
    // that this budget deliberately does not fund a second full-length attempt.
    // Both halves are pinned here: the policy, so the claim cannot go stale, and
    // the arithmetic, so the deliberate choice cannot be mistaken for an
    // oversight by someone who reads only the number.
    expect(shouldRetryProjectLayout(0, new Error('socket hang up'))).toBe(true);
    expect(shouldRetryProjectLayout(1, new Error('socket hang up'))).toBe(
      false,
    );
    expect(PROJECT_LAYOUT_READINESS_TIMEOUT_MS).toBeLessThan(
      2 * 30_000 + 1_000 + 4_000,
    );
  });

  test('does not retry a layout the server has already answered with a 4xx', () => {
    // Why a 404 costs this budget nothing: it is not retried, so `LayoutView`
    // reaches its "Layout not found" state on the first answer and the wait
    // reports it there.
    expect(
      shouldRetryProjectLayout(0, new StationHttpError(404, 'Not found')),
    ).toBe(false);
  });

  test('exceeds the runner default, so a caller must fund it with test.setTimeout', () => {
    // The obligation this creates is real and is NOT enforced in code: a spec
    // that used this budget under the runner's default per-test timeout would
    // die as a bare `Test timeout of Nms exceeded`, naming neither the layout nor
    // the host — the exact nameless failure #1617 removed. The access-gate wait
    // refuses up front for this reason; this budget's only caller raises its own
    // timeout well past it, so the gap is pinned and disclosed here rather than
    // closed with a second copy of that machinery.
    expect(PROJECT_LAYOUT_READINESS_TIMEOUT_MS).toBeGreaterThan(
      PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS,
    );
  });
});
