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
  /**
   * What this wait EXCLUDED from attribution, for the timeout message, or
   * `undefined` when it excluded nothing.
   *
   * The timeout sentence otherwise says "its lazy chunk neither resolved nor
   * reported a failure" on a page that may be RENDERING a boundary failure —
   * one this wait deliberately did not attribute to this surface because it was
   * already visible before the interaction. Saying only the first half is the
   * confident-sentence problem again, one level quieter: a reader is told
   * nothing failed while a failure is on screen. Whatever a wait declines to
   * attribute, it has to name.
   */
  baselineDetail(): Promise<string | undefined>;
  now(): number;
};

function elapsedMilliseconds(startedAt: number, now: number): string {
  return `${Math.round(now - startedAt)}ms`;
}

async function ranOutMessage(
  observation: LazySurfaceObservation,
  startedAt: number,
): Promise<string> {
  const excluded = await observation.baselineDetail();
  return (
    `${observation.surfaceName} did not load within ${elapsedMilliseconds(startedAt, observation.now())}: ` +
    'its lazy chunk neither resolved nor reported a failure. Its boundary renders nothing while the ' +
    'chunk is in flight (#1692), so this cannot distinguish a chunk still loading from one that never ' +
    `started — ${await observation.openStateDetail()}.` +
    (excluded ? ` ${excluded}` : '')
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
   * cheapest available fix. It does NOT make attribution correct, and its two
   * residual directions run opposite ways. An earlier version of this comment
   * described only one of them, and described the wrong one as the cost — which
   * reads as a promise that the confident wrong name is gone. It is narrowed,
   * not gone.
   *
   * THE SAFE DIRECTION, a false NEGATIVE. If this surface's own boundary fails
   * while the visible count stays FLAT, there is no increase, the wait
   * classifies pending, spends its budget and says it could not tell. Holding
   * the count flat takes a pre-existing failure clearing — an unmount, or a hide
   * — in the same window as this one appearing. It costs time and it never names
   * the wrong component, and `ranOutMessage`'s baseline clause is what stops it
   * reading as "nothing failed" on a page that is rendering a failure.
   *
   * THE RESIDUAL, a false POSITIVE, and this is the unsafe one. The baseline is
   * read BEFORE the interaction, so it excludes only what was already visible
   * THEN. Any boundary failure that becomes visible afterwards — anywhere on the
   * page, from any cause, at any point up to the deadline — raises the count
   * above the baseline and is reported as THIS surface being unavailable.
   * Concretely, and by the same mechanism described above: the host becomes
   * unreachable partway through the journey rather than before it, the dock's
   * prewarmed boundary rejects inside this allowance, and the wait names this
   * surface for it while this surface's chunk was merely still in flight. The
   * window is narrower than the whole page's history, which is the improvement;
   * it is not closed.
   *
   * Closing it needs a failure this wait can tell apart from any other's.
   * `LazyBoundary` publishes no per-boundary identity — no name, no owning
   * surface, one constant string — so nothing here can do it, and the fix
   * belongs in the component rather than in a wait that reads it.
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
 * The first VISIBLE match across every candidate, filtering rather than sampling
 * index zero.
 *
 * `locator.first()` picks the first match in document order and says nothing
 * about whether it is visible, so a hidden earlier match masks a visible later
 * one. Wherever a read DECIDES an outcome, that masking produces a sentence
 * contradicting the page — the failure both of these waits exist to remove — so
 * every deciding read in both adapters goes through here instead.
 *
 * SHARED rather than written twice. `route-view-readiness.ts` already imports
 * this module for `LAZY_BOUNDARY_ERROR_SELECTOR`, and two copies of one
 * filtering rule is how two adapters come to disagree about what "visible"
 * means — the divergence this branch's own subject matter argues against.
 *
 * NOT for every `.first()`. The union pre-waits in both adapters sample index
 * zero too, and stay that way deliberately: a masked union costs the budget and
 * never a wrong sentence, and replacing an event-driven wait with a filtered
 * poll would reintroduce the spin the lazy adapter's ternary exists to prevent.
 * Presence questions (`anyPresent`) are not visibility questions and do not
 * belong here either. Each of those is documented where it sits.
 */
export async function firstVisibleMatch(
  locators: Locator[],
): Promise<Locator | undefined> {
  for (const locator of locators) {
    for (const candidate of await locator.all()) {
      if (await candidate.isVisible()) return candidate;
    }
  }
  return undefined;
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
  //
  // Both reads here are visibility decisions and neither samples index zero. The
  // surface goes through `firstVisibleMatch`; the failure count goes through
  // `countVisibleLazyBoundaryErrors`, which tests every match rather than the
  // first. A `surface.first()` here masked a visible surface behind a hidden
  // earlier match and reported the timeout sentence — "its lazy chunk neither
  // resolved nor reported a failure" — with the surface on screen.
  const classifySettled = async (): Promise<SettledLazySurfaceScreen> => {
    if (await firstVisibleMatch([surface])) return 'ready';
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
        //
        // GUARDED, because this ternary reads like something to simplify away and
        // an elapsed-time assertion cannot tell waiting from spinning — both
        // versions end at the deadline with the same message. The harness's
        // pre-existing-baseline arrangement drives this adapter through a `Page`
        // that COUNTS `locator()` calls and pins that count at a handful: one
        // blocking wait, one classification. Restore the union here and the count
        // becomes one per re-entry for the whole budget, which is what a spin is.
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
        // Quote a VISIBLE failure, not index zero. `unavailable` is page-wide,
        // so `.first()` could quote a HIDDEN boundary's words inside a sentence
        // attributing one that APPEARED. That is invisible today only because
        // every boundary renders the same constant string; #1712 is the change
        // that would give the text identity, and this is the read that would
        // then be quoting the wrong component by name.
        const visibleFailure = await firstVisibleMatch([unavailable]);
        const text = ((await visibleFailure?.innerText()) ?? '')
          .trim()
          .slice(0, 200);
        return (
          `${appeared} boundary failure(s) appeared across this interaction, reading "${text}"` +
          (baselineUnavailableCount > 0
            ? `; ${baselineUnavailableCount} were already visible before it, so this page had other surfaces failing already`
            : '')
        );
      },
      baselineDetail: async () => {
        if (baselineUnavailableCount < 1) return undefined;
        // The sentence this trade was made to be able to say, stated to exactly
        // what the count establishes and no further. This number was captured
        // BEFORE the interaction and is never re-read, so it cannot claim those
        // failures are still on screen — the SAFE DIRECTION above is built on
        // the case where one of them has cleared, which is precisely where such
        // a claim would be false. What it can say is what was subtracted, that
        // the subtraction holds for the whole wait, and that the subtraction is
        // what makes the flat-count case unreadable.
        return (
          `${baselineUnavailableCount} boundary failure(s) were visible before this interaction ` +
          'and are excluded from attribution for the whole wait; if one of them cleared while ' +
          "this surface's own boundary failed, the count stayed flat and this wait cannot tell."
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
