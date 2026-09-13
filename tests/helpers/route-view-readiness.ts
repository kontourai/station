import type { Locator, Page } from '@playwright/test';
import {
  firstVisibleMatch,
  LAZY_BOUNDARY_ERROR_SELECTOR,
} from './lazy-surface-readiness';

/**
 * Waiting for a surface by following the settled outcomes of the VIEW that has
 * to produce it, rather than watching the surface alone (#1642).
 *
 * The failure this replaces: three independently retained Playwright captures
 * of `first-run-live.spec.ts` show the Connections route sitting in its own
 * rendered pending state — `status "Loading view"` — for the whole budget,
 * while the shell header beside it read "Can't connect". The assertion reported
 * `waiting for getByRole('button', { name: 'Add model connection' })`, which
 * names a locator and not one fact about what happened. Same shape as the
 * access-gate wait #1617 replaced, one layer further in.
 *
 * WHY THIS CHANGES WHAT A BUDGET IS FOR, and it is the whole point. A wait that
 * watches only the target has to make its budget large enough to survive a slow
 * host, which necessarily makes it large enough to hide a broken view: the two
 * are the same observation. A wait that also watches what the view renders when
 * it FAILS separates them, so the budget stops arbitrating "slow vs broken" and
 * bounds only the genuinely-pending case. Every settled failure is reported the
 * moment it renders, by name, at any budget.
 */

/**
 * What this wait can observe. `ready` and `failed` are outcomes the view itself
 * settles into; the other three describe the observation rather than the view.
 */
export type SettledRouteViewScreen =
  /** The surface this wait was given is on screen. */
  | 'ready'
  /** The view settled into a failure of its own, and rendered it. */
  | 'failed'
  /** Nothing has settled: the view is still rendering a pending state. */
  | 'pending'
  /** The budget ran out with the view's pending state still on screen. */
  | 'timeout'
  /**
   * The budget ran out with NEITHER a pending state nor a failure on screen.
   * The view is done and does not contain the surface — a different fault from
   * a slow one, so it gets a different sentence instead of being rounded down
   * into "timed out".
   *
   * Classified only once the budget is spent, never mid-flight. Some views
   * commit their content in two renders — `PageFrameActions` returns `null`
   * until the header's portal slot exists, one render after the route's chunk
   * lands — so "pending gone, target not yet here" is a legitimate instant, and
   * failing fast on it would red a working view.
   */
  | 'settled-without-target';

export type RouteViewObservation = {
  /** Names the view in every sentence this wait writes. */
  viewName: string;
  /** Resolve as soon as the view settles, or report how the budget ran out. */
  waitForSettledScreen(timeoutMs: number): Promise<SettledRouteViewScreen>;
  /** What the view's own failure state says, for the failure message. */
  failureDetail(): Promise<string>;
  /** What was on screen when the budget ran out, for the timeout message. */
  pendingDetail(): Promise<string>;
  now(): number;
};

function elapsedMilliseconds(startedAt: number, now: number): string {
  return `${Math.round(now - startedAt)}ms`;
}

async function ranOutMessage(
  observation: RouteViewObservation,
  startedAt: number,
  screen: 'timeout' | 'settled-without-target',
): Promise<string> {
  const elapsed = elapsedMilliseconds(startedAt, observation.now());
  const onScreen = await observation.pendingDetail();
  // These two must not share a sentence: one says the view is slow and the
  // other says the view is finished and wrong, and they send a reader to
  // different places.
  return screen === 'settled-without-target'
    ? `${observation.viewName} settled without the surface this wait was given, after ${elapsed}: it rendered neither a pending state nor a failure of its own, so the surface is absent rather than late. On screen: ${onScreen}.`
    : `${observation.viewName} never settled within ${elapsed}: it is still rendering its own pending state. On screen: ${onScreen}.`;
}

/**
 * Follow a view's settled outcomes until the surface arrives.
 *
 * Returns the screen it observed rather than resolving bare, so that a caller —
 * and the test driving this core — asserts WHICH outcome ended the wait instead
 * of inferring success from the absence of a throw. A wait that resolves for a
 * reason nobody checked is the defect this helper exists to remove.
 */
export async function waitForRouteViewTargetThrough(
  observation: RouteViewObservation,
  timeoutMs: number,
): Promise<{ screen: 'ready'; elapsedMs: number }> {
  const startedAt = observation.now();
  const deadline = startedAt + timeoutMs;

  for (;;) {
    const remaining = deadline - observation.now();
    if (remaining <= 0) {
      throw new Error(await ranOutMessage(observation, startedAt, 'timeout'));
    }

    const screen = await observation.waitForSettledScreen(remaining);
    if (screen === 'ready') {
      return { screen: 'ready', elapsedMs: observation.now() - startedAt };
    }
    // Something matched but has not settled yet — re-observe against what is
    // left of the deadline, which is what actually stops this loop.
    if (screen === 'pending') continue;

    if (screen === 'failed') {
      throw new Error(
        `${observation.viewName} failed after ${elapsedMilliseconds(startedAt, observation.now())}: the view settled into a failure of its own rather than rendering the surface this wait was given (${await observation.failureDetail()}).`,
      );
    }

    if (screen === 'timeout' || screen === 'settled-without-target') {
      throw new Error(await ranOutMessage(observation, startedAt, screen));
    }

    // Exhaustiveness with a sentence: a screen added to the union above and
    // not handled here must announce itself rather than fall through this loop
    // as another `continue`, which would spin until the deadline and then
    // report a timeout that never happened.
    const unmodelled: never = screen;
    throw new Error(
      `${observation.viewName} reported a screen this wait does not model: ${String(unmodelled)}.`,
    );
  }
}

export type RouteViewScreens = {
  /** Names the view in this wait's sentences. */
  viewName: string;
  /** The surface whose arrival ends the wait. */
  target: Locator;
  /**
   * Everything this view renders when it has settled into a failure.
   *
   * These are matched page-wide, so a locator broad enough to catch a failure
   * somewhere ELSE on the page will attribute it to this view. That is the
   * deliberate trade: failing fast on a rendered failure is worth more than
   * perfect attribution, and quoting the failure's own text in the message is
   * what keeps a mis-attribution legible to whoever reads it rather than
   * misleading. `target` is always classified first, so a failure rendered
   * BESIDE a surface that did arrive never ends this wait.
   */
  failures: Locator[];
  /** Everything this view renders while it has not settled. */
  pending: Locator[];
};

/**
 * Browser adapter binding a view's screens to their real locators.
 *
 * Never navigates and never clicks: unlike the access-gate wait, no screen here
 * offers a way forward that this helper is entitled to take on the caller's
 * behalf. A `Retry` button on a settled failure is the product's offer to a
 * user, and pressing it would convert a reportable failure into a second
 * attempt the journey never asked for.
 */
export async function waitForRouteViewTarget(
  screens: RouteViewScreens,
  timeoutMs: number,
): Promise<{ screen: 'ready'; elapsedMs: number }> {
  const { viewName, target, failures, pending } = screens;
  // The same locators the union waits on, so the two cannot disagree about
  // whether something has settled.
  const settledUnion = failures.reduce(
    (union, failure) => union.or(failure),
    target,
  );

  /**
   * WHICH DECISIONS FILTER FOR VISIBILITY HERE, written out because an earlier
   * version of this comment said "both of this adapter's decisions" and the
   * adapter has three.
   *
   * The two VISIBILITY decisions do — `target` becoming `ready` and `failures`
   * becoming `failed`, both in `classifySettled` — and so does the quote in
   * `failureDetail`. Each goes through `firstVisibleMatch`, shared with the lazy
   * adapter rather than reimplemented here. The PENDING decision does not, and
   * must not: it is a presence question, and it goes through `anyPresent` below
   * for the reason that function documents.
   *
   * On the failures side the masking produced a real false sentence: a visible
   * failure behind a hidden earlier one was reported as "rendered neither a
   * pending state nor a failure", contradicting the page. `target` is filtered
   * for the same shape rather than for an observed failure — no route read while
   * writing this renders a hidden earlier match for a target locator, and the
   * harness arrangement that pins it is constructed for the check rather than
   * taken from a real page, so this half is REASONED, not reproduced from the
   * product, and should not be read as a defect anyone has seen. It is
   * nonetheless the same masking at the same decision point, and leaving one of
   * two visibility decisions sampling index zero would be keeping the defect in
   * whichever half nobody had happened to hit. The harness pins both halves, the
   * `target` one with an arrangement that fails under `first()` and under
   * `last()` alike.
   */

  /**
   * Whether any candidate is PRESENT in the document, visible or not.
   *
   * Presence, deliberately, and not visibility — this is the question "is the
   * view still telling us it is working?", and painting is incidental to that.
   * The concrete reason: `SkeletonList` renders empty `div`s whose every
   * dimension comes from the stylesheet, so a visibility check here depends on
   * the stylesheet resolving a box. If that ever went zero-size, a view that was
   * merely SLOW would be reported as one whose surface is ABSENT — the two
   * sentences this helper works hardest to keep apart — silently, through a
   * stylesheet edit nobody would connect to a test helper, and invisibly to both
   * this code and its unit tests.
   *
   * A visibility check reads more naturally here and is what someone will
   * "simplify" this back to. The suppressed-sizing arrangement in
   * `RouteViewReadiness.adapterScreens.test.tsx` is what CATCHES that: it renders
   * the real skeleton with its sizing removed and asserts this still classifies
   * pending. Removing the coupling and catching its return are different
   * guarantees, and this change carries both on purpose.
   *
   * Visibility stays correct for `target` and `failures`, where it is
   * load-bearing: a surface the user cannot see has not arrived, and a failure
   * that is not painted is not being shown to anyone.
   */
  const anyPresent = async (
    locators: Locator[],
  ): Promise<Locator | undefined> => {
    for (const locator of locators) {
      if ((await locator.count()) > 0) return locator;
    }
    return undefined;
  };

  // Target first, deliberately. A view can render a failure BESIDE the surface
  // — Connections puts its add action in the page frame and its list error in
  // the body — and in that case the surface is genuinely there and the wait is
  // over. Checking failures first would fail a view that had already succeeded
  // at what this wait is for.
  const classifySettled = async (): Promise<SettledRouteViewScreen> => {
    if (await firstVisibleMatch([target])) return 'ready';
    if (await firstVisibleMatch(failures)) return 'failed';
    return 'pending';
  };

  return waitForRouteViewTargetThrough(
    {
      viewName,
      waitForSettledScreen: async (budgetMs) => {
        try {
          await settledUnion
            .first()
            .waitFor({ state: 'visible', timeout: budgetMs });
        } catch {
          // The union cannot see a screen it does not name, so its timeout is
          // ambiguous on its own. Re-read the settled screens first — one can
          // have arrived while the union was giving up — and only then decide
          // which kind of running-out this was.
          //
          // This `.first()` samples index zero and is therefore maskable in the
          // same way `firstVisibleMatch` exists to prevent, but only as an
          // optimisation: a hidden earlier match makes the union wait out the
          // budget instead of resolving early, and this catch path then
          // classifies correctly. It costs time; it never produces a WRONG
          // sentence — this catch is in fact where every timeout sentence is
          // written, and it writes them off a correctly classified screen.
          // Filtering it would mean replacing an event-driven wait with a poll,
          // which is the spin the lazy adapter's ternary exists to prevent.
          const settled = await classifySettled();
          if (settled !== 'pending') return settled;
          return (await anyPresent(pending))
            ? 'timeout'
            : 'settled-without-target';
        }
        return classifySettled();
      },
      failureDetail: async () => {
        const failed = await firstVisibleMatch(failures);
        if (!failed) return 'no failure state rendered';
        return `"${(await failed.first().innerText()).trim().slice(0, 200)}"`;
      },
      pendingDetail: async () => {
        // The VIEW's pending state, not the shell's first child: quoting
        // `#root > *` returned the whole application chrome — header, dock,
        // sidebar — in which the one thing a reader needed was buried or absent.
        // The pending locator is present by construction whenever a `timeout` is
        // reported, since that classification is what `anyPresent(pending)`
        // decides, so this is the accurate thing to quote and the only case where
        // it is empty is the one that reports `settled-without-target` instead.
        const pendingUp = await anyPresent(pending);
        if (!pendingUp) return 'no pending state of its own';
        const text = (await pendingUp.first().innerText()).trim();
        // A skeleton is deliberately textless, so say what it IS rather than
        // quoting an empty string and reading as if nothing were there.
        return text
          ? `its pending state, reading "${text.slice(0, 200)}"`
          : 'its pending state, which renders no text of its own';
      },
      now: () => Date.now(),
    },
    timeoutMs,
  );
}

/* ── The screens the two views this file is built for actually render ── */

/**
 * `RouteViewBoundary`'s Suspense fallback, for any route whose view is a lazy
 * chunk. `SkeletonList`/`SkeletonBlock` publish it as a named live region
 * (`src-ui/src/components/Skeleton.tsx`), and the copy is the `route.loading`
 * catalog entry rather than a literal transcribed here.
 */
export const ROUTE_PENDING_STATUS_NAME = 'Loading view';
/**
 * `ErrorState`'s root, which is a `role="alert"` (`packages/sdk/src/components/
 * ErrorState.tsx`). Matched by class rather than by role because `LazyBoundary`
 * publishes its own failure as an alert too, and a route failure and a failed
 * chunk INSIDE a mounted route are different findings.
 */
export const SETTLED_ERROR_STATE_SELECTOR = '.error-state';
/**
 * `LazyBoundary`'s own failure, for a code-split surface within a view.
 * Re-exported from the lazy-surface wait rather than restated, so the two
 * helpers cannot come to disagree about what that failure looks like.
 */
export { LAZY_BOUNDARY_ERROR_SELECTOR };
/**
 * `FullScreenError`'s root — `FullScreenLoader`'s sibling, distinguished from it
 * by the `--error` modifier alone (`packages/sdk/src/components/Loading.tsx`).
 */
export const FULL_SCREEN_ERROR_SELECTOR = '.fs-screen--error';
/**
 * `FullScreenLoader`'s label line, which is how a caller says WHICH full-screen
 * loader it means. `.fs-screen` alone is shared with `PlatformBootstrap`'s
 * loader — the access-gate wait matches on exactly that — so a bare `.fs-screen`
 * pending marker would read "the platform is still booting" as "this view is
 * still loading" and blame the wrong thing.
 */
export function fullScreenLoaderLabel(page: Page, label: string): Locator {
  return page.locator('.fs-screen:not(.fs-screen--error) .fs-label', {
    hasText: new RegExp(`^${label}$`),
  });
}

/* ── The one budget in this file that is derived rather than allowed ── */

/**
 * The navigation's module graph and the view's first render.
 *
 * A restatement, not a measurement: it is the value the access-gate wait's own
 * `NAVIGATION_AND_RENDER_ALLOWANCE_MS` uses for the same span
 * (`tests/helpers/local-ui-access-readiness.ts`), cited here as this repository's
 * existing allowance for it. That module does not export it, so it cannot be
 * imported; if it changes there, this should be reconsidered rather than assumed
 * to have followed.
 */
const NAVIGATION_AND_RENDER_ALLOWANCE_MS = 4_000;

/**
 * One answer from the Station-owned UI proxy, at the longest the proxy itself
 * permits.
 *
 * A DOCUMENTED UPSTREAM TIMEOUT, not a sample: `proxyToBackend` sets
 * `PROXY_UPSTREAM_TIMEOUT_MS = 30_000` as an idle timeout on the upstream socket
 * and answers 504 when it fires (`packages/cli/src/commands/lifecycle.ts`). It
 * stays armed through the response body for a non-streaming answer like this one
 * — it is disarmed only once a streaming content type is confirmed — so it bounds
 * the whole read rather than just its connection and header phase, which is what
 * an earlier version of this comment said. The number and the 504 were right; the
 * phrase described a narrower timer than the code arms. The e2e runner serves the page from
 * that proxy on its own port, so every `/api` read the browser makes — including
 * the layout read below — is bounded by it and by nothing tighter.
 */
const PROXY_UPSTREAM_ANSWER_ALLOWANCE_MS = 30_000;

/**
 * The gap before a retried query's second attempt starts.
 *
 * TanStack Query's documented default `retryDelay` is
 * `min(1000 * 2 ** attemptIndex, 30_000)`, so the first retry waits 1 s.
 * `useProjectLayoutQuery` overrides `retry` but not `retryDelay`
 * (`packages/sdk/src/query-domains/workspaceProjects.ts`), so the default is what
 * applies. Included so that a first attempt which fails FAST and a prompt retry
 * both fit inside this budget instead of expiring in the gap between them.
 */
const QUERY_FIRST_RETRY_DELAY_MS = 1_000;

/**
 * A post-navigation budget for a project layout route to resolve the layout its
 * whole surface tree hangs off.
 *
 * WHAT IT WAITS FOR. On `/projects/<slug>/layouts/<layout>` the chat dock does
 * not exist until this query answers: `showAmbientChatDock` gates `RegionShells`
 * on `!selectedLayoutLoading` (`src-ui/src/App.tsx`), and `LayoutView` renders
 * `FullScreenLoader label="layout"` over the same fact. Seeing that loader and
 * finding no `Chat dock` region are two readings of one state, which is why the
 * loader is this view's pending marker rather than a second thing to wait on.
 *
 * DERIVED, with no sample anywhere in it: one full proxy answer window, plus the
 * query library's documented first-retry delay, plus the navigation and render
 * allowance. Deliberately NOT multiplied by the attempt limit, even though
 * `shouldRetryProjectLayout` permits exactly one retry (the pin in
 * `scripts/__tests__/route-view-readiness.test.ts` holds that fact so this
 * sentence cannot go stale): a first attempt that consumed the proxy's entire
 * idle window means the host was silent for thirty seconds, and at that point
 * saying so is more useful than waiting a second thirty for the same answer. So
 * this budget covers a loaded host, and states rather than hides that it does
 * not cover a wedged one.
 *
 * WHAT IT CANNOT HIDE, which is the reason it is allowed to be this large. Every
 * way this view fails is a screen it renders — "Layout not found", "Failed to
 * load layout", and its settled-but-unrenderable state — and `waitForRouteViewTarget`
 * reports each the moment it appears, at any budget. A layout that resolves and
 * still produces no dock is `settled-without-target`, also immediate. The only
 * run that spends this whole allowance is one where the layout read is genuinely
 * still in flight, and no shorter number makes that run more informative.
 */
export const PROJECT_LAYOUT_READINESS_TIMEOUT_MS =
  NAVIGATION_AND_RENDER_ALLOWANCE_MS +
  PROXY_UPSTREAM_ANSWER_ALLOWANCE_MS +
  QUERY_FIRST_RETRY_DELAY_MS;
