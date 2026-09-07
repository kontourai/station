import type { Locator, Page } from '@playwright/test';

/**
 * Waiting for a code-split surface by watching its boundary's outcomes, not the
 * surface alone (#1642).
 *
 * `LazyBoundary` (`src-ui/src/components/LazyBoundary.tsx`) has three states: the
 * surface, a `pending` node while the chunk is in flight, and a failure —
 * `role="alert"`, "Unable to load this part of Station." — when the import
 * rejects. A wait that watches only the surface conflates the last two: a
 * rejected chunk spends the whole budget and is then reported as if the surface
 * were merely slow, which sends a reader to the wrong component.
 *
 * The pending state is NOT observable at the two sites this was written for.
 * Both pass `pending={null}` (#1692), so nothing at all is rendered while the
 * chunk loads — the reason this wait's timeout sentence says plainly that it
 * cannot distinguish a chunk still loading from one that never started, and
 * quotes whatever open-state signal the trigger publishes instead of implying a
 * certainty it does not have.
 */

/**
 * What this wait can observe. `ready` and `unavailable` are the boundary's own
 * settled outcomes; the other two describe the observation.
 */
export type SettledLazySurfaceScreen =
  /** The surface mounted: its chunk resolved and it rendered. */
  | 'ready'
  /** The boundary's failure state: the import rejected. */
  | 'unavailable'
  /** Neither is up yet. */
  | 'pending'
  /** The budget ran out with neither the surface nor the boundary's failure. */
  | 'timeout';

export type LazySurfaceObservation = {
  /** Names the surface in every sentence this wait writes. */
  surfaceName: string;
  waitForSettledScreen(timeoutMs: number): Promise<SettledLazySurfaceScreen>;
  /** What the boundary's failure state says, for the failure message. */
  unavailableDetail(): Promise<string>;
  /** What the trigger says about being open, for the timeout message. */
  openStateDetail(): Promise<string>;
  now(): number;
};

function elapsedMilliseconds(startedAt: number, now: number): string {
  return `${Math.round(now - startedAt)}ms`;
}

async function ranOutMessage(
  observation: LazySurfaceObservation,
  startedAt: number,
): Promise<string> {
  return (
    `${observation.surfaceName} did not load within ${elapsedMilliseconds(startedAt, observation.now())}: ` +
    'its lazy chunk neither resolved nor reported a failure. Its boundary renders nothing while the ' +
    'chunk is in flight (#1692), so this cannot distinguish a chunk still loading from one that never ' +
    `started — ${await observation.openStateDetail()}.`
  );
}

/**
 * Follow a lazy boundary's outcomes until its surface mounts.
 *
 * Returns the observed screen rather than resolving bare, so the outcome that
 * ended the wait is asserted rather than inferred from the absence of a throw.
 */
export async function waitForLazySurfaceThrough(
  observation: LazySurfaceObservation,
  timeoutMs: number,
): Promise<{ screen: 'ready'; elapsedMs: number }> {
  const startedAt = observation.now();
  const deadline = startedAt + timeoutMs;

  for (;;) {
    const remaining = deadline - observation.now();
    if (remaining <= 0)
      throw new Error(await ranOutMessage(observation, startedAt));

    const screen = await observation.waitForSettledScreen(remaining);
    if (screen === 'ready') {
      return { screen: 'ready', elapsedMs: observation.now() - startedAt };
    }
    if (screen === 'pending') continue;

    if (screen === 'unavailable') {
      throw new Error(
        `${observation.surfaceName} is unavailable after ${elapsedMilliseconds(startedAt, observation.now())}: its lazy chunk failed to load and its boundary said so (${await observation.unavailableDetail()}). React caches a rejected \`lazy\` import, so this does not get better by waiting.`,
      );
    }

    if (screen === 'timeout') {
      throw new Error(await ranOutMessage(observation, startedAt));
    }

    // Exhaustiveness with a sentence: an unhandled screen must announce itself
    // rather than fall through as another `continue` and be reported later as a
    // timeout that did not happen.
    const unmodelled: never = screen;
    throw new Error(
      `${observation.surfaceName} reported a screen this wait does not model: ${String(unmodelled)}.`,
    );
  }
}

export type LazySurfaceScreens = {
  /** Names the surface in this wait's sentences. */
  surfaceName: string;
  /** The surface itself, by the role and name it publishes. */
  surface: Locator;
  /**
   * The trigger's own open state, when it publishes one. Read only for the
   * timeout message — a trigger reporting itself expanded over an empty sheet
   * is the difference between "the chunk is in flight" and "the control never
   * took the click", and one of the two sites here has no such signal at all.
   */
  openIndicator?: Locator;
};

/** `LazyBoundary`'s default failure state, shared by every code-split surface. */
export const LAZY_BOUNDARY_ERROR_SELECTOR = '.lazy-boundary__error';

/**
 * Browser adapter. Never clicks: the boundary's failure offers Retry and Reload,
 * and taking either would turn a reportable failure into a silent second attempt.
 */
export async function waitForLazySurface(
  page: Page,
  screens: LazySurfaceScreens,
  timeoutMs: number,
): Promise<{ screen: 'ready'; elapsedMs: number }> {
  const { surfaceName, surface, openIndicator } = screens;
  const unavailable = page.locator(LAZY_BOUNDARY_ERROR_SELECTOR);

  // Surface first: a boundary elsewhere on the page can be in its failure state
  // while this surface mounted perfectly well, and this wait is only about this
  // surface.
  const classifySettled = async (): Promise<SettledLazySurfaceScreen> => {
    if (await surface.first().isVisible()) return 'ready';
    if (await unavailable.first().isVisible()) return 'unavailable';
    return 'pending';
  };

  return waitForLazySurfaceThrough(
    {
      surfaceName,
      waitForSettledScreen: async (budgetMs) => {
        try {
          await surface
            .or(unavailable)
            .first()
            .waitFor({ state: 'visible', timeout: budgetMs });
        } catch {
          // One can have arrived while the union was giving up.
          const settled = await classifySettled();
          return settled === 'pending' ? 'timeout' : settled;
        }
        return classifySettled();
      },
      unavailableDetail: async () => {
        if (!(await unavailable.first().isVisible())) {
          return 'no failure state rendered';
        }
        return `"${(await unavailable.first().innerText()).trim().slice(0, 200)}"`;
      },
      openStateDetail: async () => {
        if (!openIndicator) {
          return "this surface's trigger publishes no open state, so nothing here says whether the click was taken";
        }
        return (await openIndicator.first().isVisible())
          ? 'its trigger does report the surface open, so the click was taken and the chunk is what did not arrive'
          : 'its trigger does not report the surface open, so the click may not have been taken at all';
      },
      now: () => Date.now(),
    },
    timeoutMs,
  );
}
