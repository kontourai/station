import { describe, expect, test } from 'vitest';
import { LAZY_CHUNK_ALLOWANCE_MS } from '../../tests/helpers/lazy-chunk-allowance.js';
import {
  type LazySurfaceObservation,
  type SettledLazySurfaceScreen,
  waitForLazySurfaceThrough,
} from '../../tests/helpers/lazy-surface-readiness.js';

/**
 * As in the route-view core's tests: an unscripted wait consumes its whole
 * budget and reports `timeout`, matching the browser adapter.
 */
function observation(
  screens: SettledLazySurfaceScreen[],
  overrides: Partial<LazySurfaceObservation> = {},
) {
  const queue = [...screens];
  const state = { now: 0, waits: [] as number[] };
  return {
    state,
    observation: {
      surfaceName: 'The Chat actions sheet',
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
      unavailableDetail: async () => '"Unable to load this part of Station."',
      openStateDetail: async () => 'its trigger does report the surface open',
      baselineDetail: async () => undefined,
      now: () => state.now,
      ...overrides,
    } satisfies LazySurfaceObservation,
  };
}

async function outcomeMessage(
  screen: SettledLazySurfaceScreen,
): Promise<string> {
  const { observation: port } = observation([screen]);
  try {
    const result = await waitForLazySurfaceThrough(port, 10_000);
    return `resolved:${result.screen}`;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('waitForLazySurfaceThrough', () => {
  test('the surface mounting is reported as the observed outcome', async () => {
    const { observation: port, state } = observation(['ready']);

    const result = await waitForLazySurfaceThrough(port, 10_000);

    expect(result.screen).toBe('ready');
    expect(result.elapsedMs).toBe(1_000);
    expect(state.waits).toEqual([10_000]);
  });

  test('a pending observation re-observes against what is left of the deadline', async () => {
    const { observation: port, state } = observation(['pending', 'ready']);

    const result = await waitForLazySurfaceThrough(port, 10_000);

    expect(result.screen).toBe('ready');
    expect(state.waits).toEqual([10_000, 9_000]);
  });

  test("a rejected chunk is reported by the boundary's own words, immediately, and says waiting will not help", async () => {
    const { observation: port, state } = observation(['unavailable']);

    await expect(waitForLazySurfaceThrough(port, 10_000)).rejects.toThrow(
      /The Chat actions sheet is unavailable after 1000ms: its lazy chunk failed to load .*Unable to load this part of Station.*React caches a rejected `lazy` import/s,
    );
    // The whole reason for watching the boundary: a rejected import costs 1 s
    // rather than the budget, and is not reported as a slow surface.
    expect(state.now).toBe(1_000);
  });

  test('a timeout admits it cannot tell a loading chunk from one that never started', async () => {
    const { observation: port } = observation(['timeout']);

    await expect(waitForLazySurfaceThrough(port, 10_000)).rejects.toThrow(
      /did not load within 1000ms.*renders nothing while the chunk is in flight.*cannot distinguish a chunk still loading from one that never started/s,
    );
  });

  test("the timeout carries whatever the trigger's open state actually says, and admits when there is none", async () => {
    const withNoIndicator = observation(['timeout'], {
      openStateDetail: async () =>
        "this surface's trigger publishes no open state, so nothing here says whether the click was taken",
    });
    const withClosedIndicator = observation(['timeout'], {
      openStateDetail: async () =>
        'its trigger does not report the surface open, so the click may not have been taken at all',
    });

    // The three open-state readings must reach the reader, because they point at
    // three different components: the chunk, the trigger, and nothing at all.
    // A message that folded them together would be the same undiagnostic
    // sentence this helper replaces.
    await expect(
      waitForLazySurfaceThrough(withNoIndicator.observation, 10_000),
    ).rejects.toThrow(/publishes no open state/);
    await expect(
      waitForLazySurfaceThrough(withClosedIndicator.observation, 10_000),
    ).rejects.toThrow(/may not have been taken at all/);
    await expect(
      waitForLazySurfaceThrough(observation(['timeout']).observation, 10_000),
    ).rejects.toThrow(/does report the surface open/);
  });

  test('the budget being spent before anything is observed reports without observing', async () => {
    const { observation: port, state } = observation(['ready']);

    await expect(waitForLazySurfaceThrough(port, 0)).rejects.toThrow(
      /did not load within 0ms/,
    );
    expect(state.waits).toEqual([]);
  });

  test('every outcome produces a distinguishable sentence', async () => {
    const messages = await Promise.all(
      (['ready', 'unavailable', 'timeout'] as SettledLazySurfaceScreen[]).map(
        outcomeMessage,
      ),
    );

    expect(new Set(messages).size).toBe(messages.length);
    expect(messages[0]).toBe('resolved:ready');
    for (const message of messages.slice(1)) {
      expect(message).toContain('The Chat actions sheet');
    }
  });

  test('a screen the loop does not model announces itself instead of spinning', async () => {
    const { observation: port } = observation([
      'invented-screen' as SettledLazySurfaceScreen,
    ]);

    await expect(waitForLazySurfaceThrough(port, 10_000)).rejects.toThrow(
      /reported a screen this wait does not model: invented-screen/,
    );
  });
});

/**
 * What replaced a `countVisibleLazyBoundaryErrors baseline` block here.
 *
 * That block never called `countVisibleLazyBoundaryErrors`, and could not: the
 * function reads a page, and this file drives the pure core over a scripted
 * port. One of its two cases passed an `unavailableDetail` override the timeout
 * path never invokes and asserted a regex that holds for a timeout from any
 * cause; the other hand-wrote the finished sentence into the port and asserted
 * the message contained the string it had just written. Both were green under a
 * deletion of the code they were named for, which is worse than not having them
 * — they retired a question they never asked.
 *
 * The question is the ADAPTER's, and it is asked where it can be answered:
 * `src-ui/src/__tests__/RouteViewReadiness.adapterScreens.test.tsx` renders real
 * `LazyBoundary` failures in a real browser, counts them, and drives the adapter
 * with a non-zero baseline against a new failure. What stays here is the one
 * part that IS this core's: whether it plumbs the baseline sentence into the
 * timeout message at all.
 */
describe('the timeout says what it declined to attribute', () => {
  test('a baseline detail reaches the message, after the open-state sentence', async () => {
    const { observation: port } = observation(['timeout'], {
      baselineDetail: async () =>
        '2 boundary failure(s) were already visible before this interaction and are excluded from attribution.',
    });

    await expect(waitForLazySurfaceThrough(port, 10_000)).rejects.toThrow(
      /did not load within 1000ms.*does report the surface open.*2 boundary failure\(s\) were already visible before this interaction and are excluded from attribution\./s,
    );
  });

  test('and nothing is appended when nothing was excluded', async () => {
    // The default port returns `undefined`, which is the ordinary case: no
    // pre-existing failures, nothing withheld, and no sentence claiming there
    // was.
    const { observation: port } = observation(['timeout']);

    let message = '';
    await waitForLazySurfaceThrough(port, 10_000).catch((error: Error) => {
      message = error.message;
    });

    expect(message).toContain('cannot distinguish a chunk still loading');
    expect(message).not.toContain('excluded from attribution');
    expect(message.endsWith('does report the surface open.')).toBe(true);
  });
});

describe('LAZY_CHUNK_ALLOWANCE_MS', () => {
  test('lowers none of the budgets the sites using it already carried', () => {
    // The three sites this replaces carried 20_000 (the Switch task dialog),
    // 15_000 (the Chat actions menu) and the file-wide 15_000 action timeout
    // (the Connections add action). Retaining the largest is the whole claim
    // this constant makes: #1642's change at those sites is structural, and a
    // regression here would be silently REDUCING a bound while appearing to
    // tidy up.
    expect(LAZY_CHUNK_ALLOWANCE_MS).toBe(20_000);
    expect(LAZY_CHUNK_ALLOWANCE_MS).toBeGreaterThanOrEqual(
      Math.max(20_000, 15_000, 15_000),
    );
  });
});
