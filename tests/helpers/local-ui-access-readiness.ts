import type { Page } from '@playwright/test';
import {
  LOCAL_UI_SESSION_ATTEMPT_LIMIT,
  LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS,
} from '../../src-ui/src/lib/local-ui-session-retry';

/**
 * On a loaded host, one `/api/system/identity` request has been observed waiting
 * this long before the Station-owned UI proxy answered
 * `{"ready":false,"status":"unavailable"}` (station#1617). It is the slowest real
 * dependency of everything below.
 *
 * A SAMPLE, not a bound, and the name says so on purpose: the UI proxy's own
 * upstream timeout is 30 s (`proxyToBackend` in
 * `packages/cli/src/commands/lifecycle.ts`), so one request can legitimately take
 * far longer and the budget below would then under-cover by roughly 4x. #1654
 * masks that today — a proxy timeout answers 504, which the ladder classifies as
 * a refusal and exits on the first attempt — so a 30 s attempt is not reachable
 * until #1654 is fixed. #1661 owns the choice this then forces.
 */
const OBSERVED_SLOW_IDENTITY_ANSWER_MS = 6_600;
/** The navigation's module graph and the gate's first render. */
const NAVIGATION_AND_RENDER_ALLOWANCE_MS = 4_000;
/** Tearing the document down and back up for a gate-directed reload. */
const GATE_DIRECTED_RELOAD_ALLOWANCE_MS = 2_000;

/**
 * A post-navigation budget for the access gate to SETTLE, plus the reload the
 * gate itself asks for when this browser's host was momentarily away.
 *
 * Derived from the slowest real dependency, not from the UI's degraded window
 * (the previous budget was `DEGRADED_QUERY_TIMEOUT_MS + 2_000`, which measured
 * the wrong thing: the degraded window is when the UI starts EXPLAINING a slow
 * resolution, not a deadline by which the resolution must have arrived).
 *
 * `LocalUiSessionGate` no longer makes exactly one identity request per page
 * lifetime: since #1639 a resolution retries an `unavailable` answer up to
 * `LOCAL_UI_SESSION_ATTEMPT_LIMIT` attempts with backoff between them, both
 * imported here so the two cannot drift. That makes the recovery screen RARER —
 * a host that comes back during the ladder never renders it — and makes the
 * worst case, a host that stays away, take longer to reach it. Budget for the
 * worst case: a full ladder on the first page, the reload, and one more answer
 * on the reloaded page.
 *
 * NOTE FOR CALLERS: this now EXCEEDS `playwright.config.ts`'s 30 s default
 * per-test timeout, so a test that spends the whole budget dies as a bare test
 * timeout — naming nothing, which is the exact failure this helper exists to
 * replace with a sentence. Any caller must raise its own `test.setTimeout` above
 * this value plus whatever the rest of its journey needs.
 */
export const LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS =
  NAVIGATION_AND_RENDER_ALLOWANCE_MS +
  OBSERVED_SLOW_IDENTITY_ANSWER_MS * LOCAL_UI_SESSION_ATTEMPT_LIMIT +
  LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS +
  GATE_DIRECTED_RELOAD_ALLOWANCE_MS +
  OBSERVED_SLOW_IDENTITY_ANSWER_MS;

/**
 * A bound on the loop itself, not a second budget — the deadline above is what
 * actually stops this wait. Each reload costs a fresh in-page ladder of
 * `LOCAL_UI_SESSION_ATTEMPT_LIMIT` attempts, so two reloads means the host
 * answered `unavailable` three ladders running before this wait gives up. A host
 * doing that inside the deadline is not merely restarting.
 */
export const MAX_HOST_RECOVERY_RELOADS = 2;

/**
 * Every screen `LocalUiSessionGate` can put on this page, as hooks that do not
 * depend on its copy where the component gives one. Exported so that
 * `src-ui/src/__tests__/LocalUiSessionGate.readinessSelectors.test.tsx` can
 * render the real component in each resolution and prove this set is both
 * exhaustive and mutually exclusive — the mapping this wait is built on.
 */
export const AUTHENTICATED_SHELL_SELECTOR = 'main#station-main';
export const HOST_RECOVERY_SCREEN_SELECTOR = 'main.local-ui-session-recovery';
export const ACCESS_REQUIRED_REGION_NAME = 'Station access required';
/**
 * The gate's own pending output, in both its forms: the loading sentence and
 * the degraded alert that replaces it. `:not()` keeps it disjoint from the
 * recovery screen, which is also a polite live region.
 */
export const PENDING_ACCESS_CHECK_SELECTOR =
  'main[aria-live="polite"]:not(.local-ui-session-recovery)';
export const DEGRADED_ACCESS_ALERT = /taking longer than expected/i;
export const HOST_RECOVERY_RELOAD_CONTROL = 'Try again';
/**
 * `PlatformBootstrap` sits ABOVE this gate (`src-ui/src/main.tsx`) and holds
 * this full-screen loader while it has no platform profile — and keeps it, with
 * "Station couldn't finish starting", if that bootstrap failed. It is a `div`
 * with neither `main` nor `aria-live`, so it matches none of the selectors
 * above while the gate is not even mounted yet. Unqualified rather than rooted
 * at `#root`: position in that provider stack is not this wait's business, and
 * the settled screens are checked first, so a loader inside a mounted shell
 * cannot be mistaken for this one.
 */
export const PLATFORM_BOOTSTRAP_LOADER_SELECTOR = '.fs-screen';
/** Where the app mounts: a visible child means the page rendered something. */
const APP_ROOT_CHILD_SELECTOR = '#root > *';

/**
 * What this wait can observe. `ready`, `access-required` and `host-unavailable`
 * are the gate's settled resolutions; the rest describe the observation itself.
 *
 * "Taking longer than expected" is deliberately NOT here: it is a timer on top
 * of a resolution that is still pending, and `useDegradedQueryState` documents
 * that a later successful result clears it — so it reads as `pending` and must
 * not end this wait.
 */
export type SettledLocalUiAccessScreen =
  /** The protected shell mounted: the gate resolved `authenticated`. */
  | 'ready'
  /** The gate refused this browser and offers pairing. No reload fixes it. */
  | 'access-required'
  /**
   * The gate's "Reconnecting to this Station" screen: the UI proxy answered
   * but its sibling host could not, `LOCAL_UI_SESSION_ATTEMPT_LIMIT` times in a
   * row — the gate's own bounded retry (#1639) is already spent by the time
   * this screen renders. This browser keeps its access, and the gate caches the
   * resolution for the page's lifetime, so the reload the screen offers is the
   * only way forward.
   */
  | 'host-unavailable'
  /** Nothing has settled: the gate's loading sentence, or its degraded alert. */
  | 'pending'
  /** The budget ran out with nothing settled. */
  | 'timeout'
  /**
   * The page rendered something that is neither a screen named above nor any
   * of the pre-shell waits — so a screen this wait has not been taught.
   * Reported rather than waited out.
   *
   * `access-required` has a SECOND screen, `section[aria-label="Station sample
   * workspace"]`, which this set deliberately omits: it is reachable only by
   * clicking "Explore a sample", so no wait can arrive at it, and reporting it
   * here is the right answer if one ever does.
   */
  | 'unmodelled';

export type LocalUiAccessObservation = {
  /** Resolve as soon as the gate settles, or `'timeout'` within `timeoutMs`. */
  waitForSettledScreen(timeoutMs: number): Promise<SettledLocalUiAccessScreen>;
  /** Why the gate says this browser needs to pair, for the failure message. */
  accessRequiredDetail(): Promise<string>;
  /** What was on screen when the budget ran out, for the failure message. */
  pendingScreenDetail(): Promise<string>;
  /**
   * Take the recovery screen's own offered way forward. Returns once a new
   * document is up — or once `timeoutMs` is gone, leaving the deadline to
   * report what is still on screen. Rejects, with a sentence of its own, only
   * if the screen has no such control to take.
   */
  reloadAfterHostRecovery(timeoutMs: number): Promise<void>;
  now(): number;
};

function elapsedMilliseconds(startedAt: number, now: number): string {
  return `${Math.round(now - startedAt)}ms`;
}

async function timedOutMessage(
  observation: LocalUiAccessObservation,
  startedAt: number,
  hostRecoveryReloads: number,
): Promise<string> {
  const elapsed = elapsedMilliseconds(startedAt, observation.now());
  const onScreen = await observation.pendingScreenDetail();
  // A run that reloaded DID settle — into the recovery screen, that many times
  // — so saying it never settled would contradict the excerpt beside it.
  return hostRecoveryReloads > 0
    ? `Local UI access readiness timed out after ${elapsed}: the access gate settled into its host-recovery screen ${hostRecoveryReloads} time(s) and the deadline expired with no protected shell. On screen: ${onScreen}.`
    : `Local UI access readiness timed out after ${elapsed}: the access gate never settled. On screen: ${onScreen}.`;
}

/**
 * Wait for the protected shell by following the access gate's own settled
 * outcomes, so that neither a broken gate nor a momentarily absent host
 * masquerades as an unrelated downstream UI timeout.
 */
export async function waitForLocalUiAccessReadinessThrough(
  observation: LocalUiAccessObservation,
  timeoutMs = LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
): Promise<{ hostRecoveryReloads: number }> {
  const startedAt = observation.now();
  const deadline = startedAt + timeoutMs;
  let hostRecoveryReloads = 0;

  for (;;) {
    const remaining = deadline - observation.now();
    if (remaining <= 0) {
      throw new Error(
        await timedOutMessage(observation, startedAt, hostRecoveryReloads),
      );
    }

    const screen = await observation.waitForSettledScreen(remaining);
    if (screen === 'ready') return { hostRecoveryReloads };
    if (screen === 'pending') continue;

    if (screen === 'access-required') {
      throw new Error(
        `Local UI access readiness failed after ${elapsedMilliseconds(startedAt, observation.now())}: the access gate refused this browser and asked it to pair (${await observation.accessRequiredDetail()}).`,
      );
    }

    if (screen === 'host-unavailable') {
      if (hostRecoveryReloads >= MAX_HOST_RECOVERY_RELOADS) {
        throw new Error(
          `Local UI access readiness failed after ${elapsedMilliseconds(startedAt, observation.now())}: the access gate reported this Station's host process down or recovering after ${hostRecoveryReloads} recovery reload(s).`,
        );
      }
      hostRecoveryReloads += 1;
      await observation.reloadAfterHostRecovery(deadline - observation.now());
      continue;
    }

    if (screen === 'timeout') {
      throw new Error(
        await timedOutMessage(observation, startedAt, hostRecoveryReloads),
      );
    }

    throw new Error(
      `Local UI access readiness failed after ${elapsedMilliseconds(startedAt, observation.now())}: the page rendered a screen this wait does not model. On screen: ${await observation.pendingScreenDetail()}.`,
    );
  }
}

/**
 * Browser adapter binding the gate's screens to their real locators.
 *
 * MAY NAVIGATE: when the gate reports its host away, this follows the recovery
 * screen's own instruction and reloads — which would be unsafe for a caller
 * that entered on a one-shot `#station-ui-bootstrap` fragment. It cannot
 * happen: `host-unavailable` is reachable only after `bootstrapLocalUiSession`
 * returned false, which it does only when no such token was in the address. A
 * token that is present and accepted resolves `authenticated` before the
 * identity request is made, and one that is refused throws to
 * `access-required`. Either way this reload is unreachable.
 */
export async function waitForLocalUiAccessReadiness(
  page: Page,
  timeoutMs = LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
): Promise<{ hostRecoveryReloads: number }> {
  const authenticatedShell = page.locator(AUTHENTICATED_SHELL_SELECTOR);
  const accessRequired = page.getByRole('region', {
    name: ACCESS_REQUIRED_REGION_NAME,
  });
  const hostRecovery = page.locator(HOST_RECOVERY_SCREEN_SELECTOR);
  const hostRecoveryReload = hostRecovery.getByRole('button', {
    name: HOST_RECOVERY_RELOAD_CONTROL,
  });
  const pendingAccessCheck = page.locator(PENDING_ACCESS_CHECK_SELECTOR);
  const platformBootstrapLoader = page.locator(
    PLATFORM_BOOTSTRAP_LOADER_SELECTOR,
  );
  const degradedAccessAlert = page
    .getByRole('alert')
    .filter({ hasText: DEGRADED_ACCESS_ALERT });

  // The same three locators the union below waits on, so the two can never
  // disagree about whether something has settled.
  const classifySettled = async (): Promise<SettledLocalUiAccessScreen> => {
    if (await authenticatedShell.isVisible()) return 'ready';
    if (await hostRecovery.isVisible()) return 'host-unavailable';
    if (await accessRequired.isVisible()) return 'access-required';
    return 'pending';
  };

  const result = await waitForLocalUiAccessReadinessThrough(
    {
      waitForSettledScreen: async (budgetMs) => {
        try {
          await authenticatedShell
            .or(accessRequired)
            .or(hostRecovery)
            .first()
            .waitFor({ state: 'visible', timeout: budgetMs });
        } catch {
          // The union cannot see a screen it does not name, so a timeout is
          // ambiguous on its own. Enumerate everything the PAGE legitimately
          // shows before the shell — the gate's loading sentence, its degraded
          // alert, and `PlatformBootstrap`'s loader above it — and only if none
          // of those is up while the app root has rendered SOMETHING is a
          // screen this wait has not been taught on display. The budget is
          // already gone here, so the pre-shell cases report as the timeout
          // they are.
          const settled = await classifySettled();
          if (settled !== 'pending') return settled;
          if (await pendingAccessCheck.isVisible()) return 'timeout';
          if (await platformBootstrapLoader.isVisible()) return 'timeout';
          if (
            !(await page.locator(APP_ROOT_CHILD_SELECTOR).first().isVisible())
          )
            return 'timeout';
          return 'unmodelled';
        }
        return classifySettled();
      },
      accessRequiredDetail: async () => {
        const message = accessRequired.getByRole('alert');
        if (!(await message.isVisible())) return 'no reason rendered';
        return (await message.innerText()).trim();
      },
      pendingScreenDetail: async () => {
        if (await degradedAccessAlert.isVisible()) {
          return 'the gate’s "taking longer than expected" alert';
        }
        const rendered = page.locator(APP_ROOT_CHILD_SELECTOR).first();
        if (!(await rendered.isVisible())) return 'nothing the gate rendered';
        return `"${(await rendered.innerText()).trim().slice(0, 200)}"`;
      },
      reloadAfterHostRecovery: async (budgetMs) => {
        // A non-throwing visibility read, as `capacity-retry.ts` does: a
        // missing control must become this helper's own sentence, not a bare
        // `locator.waitFor: Timeout 1ms exceeded` naming neither the gate nor
        // the host — which is what a `waitFor` here produced whenever the
        // recovery screen arrived with the deadline already spent.
        if (!(await hostRecoveryReload.isVisible())) {
          throw new Error(
            `Local UI access readiness failed: the access gate's host-recovery screen offered no "${HOST_RECOVERY_RELOAD_CONTROL}" control, so the way forward it promises could not be taken.`,
          );
        }
        // `page.reload()` rather than clicking it: `window.location.reload()`
        // does not tear the current document down synchronously, so the click
        // returns while the screen that prompted it is still rendered, and
        // re-observing there spends a second reload on an answer already acted
        // on (observed live: two reloads for one unavailable host, twice — the
        // second time even after arming `framenavigated`, which this SPA also
        // fires for its own same-document `replaceState`). This resolves only
        // once a NEW document has loaded, so a reload that completes leaves no
        // stale screen to re-read.
        await page
          .reload({
            waitUntil: 'domcontentloaded',
            timeout: Math.max(1, budgetMs),
          })
          // A reload that overran the budget is not this helper's message to
          // write: fall through and let the deadline report what is on screen.
          .catch(() => undefined);
      },
      now: () => Date.now(),
    },
    timeoutMs,
  );

  if (result.hostRecoveryReloads > 0) {
    // A green run that reloaded mid-journey navigated behind the caller's
    // back. A log line rather than a `test.info().annotations` entry, which
    // would also work from here: this wants to be visible in the run output
    // beside the step it happened at, not filed in the report.
    console.log(
      `[local-ui-access-readiness] followed the gate's host-recovery reload ${result.hostRecoveryReloads} time(s) before the shell mounted`,
    );
  }
  return result;
}
