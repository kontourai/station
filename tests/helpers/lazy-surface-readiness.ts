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
   * How many `LazyBoundary` failures were already visible on this page BEFORE
   * the interaction that should produce this surface — from
   * `countVisibleLazyBoundaryErrors` below.
   *
   * REQUIRED, because without it this wait names the wrong component with
   * confidence. `LazyBoundary`'s failure text is a CONSTANT — every boundary in
   * the app renders the same "Unable to load this part of Station." — so the
   * mitigation the route-view helper relies on for its page-wide matching, that
   * quoting the failure's own words keeps a mis-attribution legible, does not
   * exist here at all. Nothing in the sentence would distinguish this surface's
   * failure from any other's.
   *
   * And the collision is reachable, not theoretical: the ambient dock pane host
   * is a prewarmed lazy boundary that rejects precisely when the host is
   * unreachable — the condition two of the three retained captures show — and
   * the portaled sheets always sort after it in the document. So a pre-existing
   * error would end a 20 s allowance in milliseconds, on a red naming a
   * different surface, while this surface's chunk was merely still in flight.
   *
   * Counting first and treating only an INCREASE as this surface's is the
   * cheapest honest fix. Its cost is disclosed rather than hidden: a rejection
   * that lands between the count and this call is attributed to nobody, so the
   * wait spends its budget and reports that it is unsure. That is the right way
   * round — a wait that says "I could not tell" is worth more than one that
   * names the wrong component.
   */
  baselineUnavailableCount: number;
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
 * How many `LazyBoundary` failures are visible on this page right now.
 *
 * Call it BEFORE the interaction that should produce a lazy surface, and pass the
 * result as `baselineUnavailableCount`. Visible rather than present, because a
 * boundary error that is not painted is not a failure anyone is being shown, and
 * because an unpainted one that later becomes visible should still register as
 * new.
 */
export async function countVisibleLazyBoundaryErrors(
  page: Page,
): Promise<number> {
  const candidates = await page.locator(LAZY_BOUNDARY_ERROR_SELECTOR).all();
  let visible = 0;
  for (const candidate of candidates) {
    if (await candidate.isVisible()) visible += 1;
  }
  return visible;
}

/**
 * Browser adapter. Never clicks: the boundary's failure offers Retry and Reload,
 * and taking either would turn a reportable failure into a silent second attempt.
 */
export async function waitForLazySurface(
  page: Page,
  screens: LazySurfaceScreens,
  timeoutMs: number,
): Promise<{ screen: 'ready'; elapsedMs: number }> {
  const { surfaceName, surface, openIndicator, baselineUnavailableCount } =
    screens;
  const unavailable = page.locator(LAZY_BOUNDARY_ERROR_SELECTOR);

  /** A boundary failure this interaction produced, as opposed to one already up. */
  const newUnavailableCount = async (): Promise<number> =>
    Math.max(
      0,
      (await countVisibleLazyBoundaryErrors(page)) - baselineUnavailableCount,
    );

  // Surface first: a boundary elsewhere on the page can be in its failure state
  // while this surface mounted perfectly well, and this wait is only about this
  // surface. Then only a NEW failure counts — see `baselineUnavailableCount`.
  const classifySettled = async (): Promise<SettledLazySurfaceScreen> => {
    if (await surface.first().isVisible()) return 'ready';
    if ((await newUnavailableCount()) > 0) return 'unavailable';
    return 'pending';
  };

  return waitForLazySurfaceThrough(
    {
      surfaceName,
      waitForSettledScreen: async (budgetMs) => {
        // The union gives a NEW boundary failure a fast path, but only when there
        // is no pre-existing one to confuse it with. With a baseline already
        // visible, `surface.or(unavailable)` would resolve instantly on that old
        // error every time, classify as pending, and be re-entered by the loop —
        // a hot spin burning the budget rather than waiting on anything. So with a
        // baseline, wait on the surface alone and let the catch path below
        // classify. A new failure is still reported as `unavailable`, just at the
        // deadline instead of immediately: slower, and still the right sentence.
        const settledUnion =
          baselineUnavailableCount > 0 ? surface : surface.or(unavailable);
        try {
          await settledUnion
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
        const appeared = await newUnavailableCount();
        if (appeared < 1) return 'no failure state rendered';
        // The text is the same constant at every boundary, so quoting it alone
        // identifies nothing. What makes this attributable is that it APPEARED
        // across the interaction, so say that — and say how many were already up,
        // because a reader who sees a non-zero baseline should know this page had
        // other broken surfaces before we touched it.
        const text = (await unavailable.first().innerText())
          .trim()
          .slice(0, 200);
        return (
          `${appeared} boundary failure(s) appeared across this interaction, reading "${text}"` +
          (baselineUnavailableCount > 0
            ? `; ${baselineUnavailableCount} were already visible before it, so this page had other surfaces failing already`
            : '')
        );
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
