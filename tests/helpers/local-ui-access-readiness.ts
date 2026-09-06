import type { Page } from '@playwright/test';

/**
 * A post-navigation budget for the access gate to SETTLE, plus the reload the
 * gate itself asks for when this browser's host was momentarily away.
 *
 * Derived from the slowest real dependency, not from the UI's degraded window.
 * `LocalUiSessionGate` resolves this browser's device session with exactly one
 * `/api/system/identity` request per page lifetime, and on a loaded host that
 * request has been observed waiting 6.6 s before the Station-owned UI proxy
 * answered `{"ready":false,"status":"unavailable"}` (station#1617). This budget
 * covers the navigation's module graph, that request, the gate-directed reload
 * when it answers `unavailable`, and a second request — which is also this
 * journey's established budget for "a UI surface appears after a goto".
 *
 * The previous budget was `DEGRADED_QUERY_TIMEOUT_MS + 2_000`, which measured
 * the wrong thing: the degraded window is when the UI starts EXPLAINING a slow
 * resolution, not a deadline by which the resolution must have arrived.
 */
export const LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS = 20_000;

/**
 * A bound on the loop itself, not a second budget — the deadline above is what
 * actually stops this wait. Two reloads means three consecutive `unavailable`
 * answers are needed before this wait gives up, and a host answering that way
 * three times inside the deadline is not merely restarting.
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
export const ACCESS_REQUIRED_SELECTOR = `section[aria-label="${ACCESS_REQUIRED_REGION_NAME}"]`;
/**
 * The gate's own pending output, in both its forms: the loading sentence and
 * the degraded alert that replaces it. `:not()` keeps it disjoint from the
 * recovery screen, which is also a polite live region.
 */
export const PENDING_ACCESS_CHECK_SELECTOR =
  'main[aria-live="polite"]:not(.local-ui-session-recovery)';
export const DEGRADED_ACCESS_ALERT = /taking longer than expected/i;
export const HOST_RECOVERY_RELOAD_CONTROL = 'Try again';
/** Where the app mounts: a visible child means the gate rendered something. */
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
   * but its sibling host could not. This browser keeps its access, and the
   * gate caches the resolution for the page's lifetime, so the reload the
   * screen offers is the only way forward.
   */
  | 'host-unavailable'
  /** Nothing has settled: the gate's loading sentence, or its degraded alert. */
  | 'pending'
  /** The budget ran out with nothing settled. */
  | 'timeout'
  /**
   * The gate rendered something that is neither its pending output nor a
   * screen named above — a fourth settled screen this helper has not been
   * taught. Reported rather than waited out.
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
      `Local UI access readiness failed after ${elapsedMilliseconds(startedAt, observation.now())}: the access gate settled into a screen this helper does not model. On screen: ${await observation.pendingScreenDetail()}.`,
    );
  }
}

/**
 * Browser adapter binding the gate's screens to their real locators.
 *
 * MAY NAVIGATE: when the gate reports its host away, this follows the recovery
 * screen's own instruction and reloads. That is safe for a caller that reached
 * the page by URL, and unsafe for one that entered on a one-shot
 * `#station-ui-bootstrap` fragment, which `captureLocalUiBootstrapToken`
 * consumes and strips from the address before this wait ever runs. No caller
 * does that today.
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
          // ambiguous on its own. The gate's pending output is the only other
          // thing it renders: if that is absent while the app root has
          // rendered SOMETHING, a fourth settled screen is up, and reporting
          // it beats spending the rest of the budget on a screen that will
          // never change.
          const settled = await classifySettled();
          if (settled !== 'pending') return settled;
          if (await pendingAccessCheck.isVisible()) return 'timeout';
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
    // back. Say so where it happened rather than only in a failure message.
    console.log(
      `[local-ui-access-readiness] followed the gate's host-recovery reload ${result.hostRecoveryReloads} time(s) before the shell mounted`,
    );
  }
  return result;
}
