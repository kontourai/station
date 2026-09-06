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
 * actually stops this wait. A host that answers `unavailable` to two
 * consecutive bootstrap requests inside that window is not restarting.
 */
export const MAX_HOST_RECOVERY_RELOADS = 2;

/**
 * The screens `LocalUiSessionGate` renders once its one-per-page-lifetime
 * session resolution has SETTLED. Deliberately not a state of the wait:
 * "taking longer than expected" is a timer on top of a resolution that is
 * still pending, and `useDegradedQueryState` documents that a later successful
 * result clears it — so it must not end this wait.
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
  /** The budget ran out with the gate still pending. */
  | 'timeout'
  /** The gate settled into something this helper does not model. */
  | 'unmodelled';

export type LocalUiAccessObservation = {
  /** Resolve as soon as the gate settles, or `'timeout'` within `timeoutMs`. */
  waitForSettledScreen(timeoutMs: number): Promise<SettledLocalUiAccessScreen>;
  /** Why the gate says this browser needs to pair, for the failure message. */
  accessRequiredDetail(): Promise<string>;
  /** What was on screen when the budget ran out, for the failure message. */
  pendingScreenDetail(): Promise<string>;
  /**
   * Take the recovery screen's own offered way forward, and do not return
   * until the screen it was on can no longer be observed.
   */
  reloadAfterHostRecovery(timeoutMs: number): Promise<void>;
  now(): number;
};

function elapsedMilliseconds(startedAt: number, now: number): string {
  return `${Math.round(now - startedAt)}ms`;
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
        `Local UI access readiness timed out after ${elapsedMilliseconds(startedAt, observation.now())}: the access gate never settled. On screen: ${await observation.pendingScreenDetail()}. Recovery reloads taken: ${hostRecoveryReloads}.`,
      );
    }

    const screen = await observation.waitForSettledScreen(remaining);
    if (screen === 'ready') return { hostRecoveryReloads };

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
        `Local UI access readiness timed out after ${elapsedMilliseconds(startedAt, observation.now())}: the access gate never settled. On screen: ${await observation.pendingScreenDetail()}. Recovery reloads taken: ${hostRecoveryReloads}.`,
      );
    }

    throw new Error(
      `Local UI access readiness failed after ${elapsedMilliseconds(startedAt, observation.now())}: the access gate settled into a screen this helper does not model. On screen: ${await observation.pendingScreenDetail()}.`,
    );
  }
}

const AUTHENTICATED_SHELL_SELECTOR = 'main#station-main';
const ACCESS_REQUIRED_SECTION = 'section[aria-label="Station access required"]';
const HOST_RECOVERY_HEADING = 'Reconnecting to this Station';
const DEGRADED_ACCESS_ALERT = /taking longer than expected/i;

/** Browser adapter binding the gate's settled screens to their real locators. */
export async function waitForLocalUiAccessReadiness(
  page: Page,
  timeoutMs = LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
): Promise<{ hostRecoveryReloads: number }> {
  const authenticatedShell = page.locator(AUTHENTICATED_SHELL_SELECTOR);
  const accessRequired = page.locator(ACCESS_REQUIRED_SECTION);
  const hostRecoveryHeading = page.getByRole('heading', {
    name: HOST_RECOVERY_HEADING,
  });
  const hostRecoveryReload = page
    .locator('main', { has: hostRecoveryHeading })
    .getByRole('button', { name: 'Try again' });
  const degradedAccessAlert = page
    .getByRole('alert')
    .filter({ hasText: DEGRADED_ACCESS_ALERT });

  return waitForLocalUiAccessReadinessThrough(
    {
      waitForSettledScreen: async (budgetMs) => {
        try {
          await authenticatedShell
            .or(accessRequired)
            .or(hostRecoveryHeading)
            .first()
            .waitFor({ state: 'visible', timeout: budgetMs });
        } catch {
          return 'timeout';
        }
        // A settled screen replaces the gate's pending output and stays until
        // a reload, so this discrimination is not racing the transition.
        if (await authenticatedShell.isVisible()) return 'ready';
        if (await hostRecoveryHeading.isVisible()) return 'host-unavailable';
        if (await accessRequired.isVisible()) return 'access-required';
        return 'unmodelled';
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
        const gate = page.locator('main').first();
        if (!(await gate.isVisible())) return 'nothing the gate renders';
        return `"${(await gate.innerText()).trim().slice(0, 200)}"`;
      },
      reloadAfterHostRecovery: async (budgetMs) => {
        // Arm the navigation wait BEFORE the click. `window.location.reload()`
        // does not tear the current document down synchronously, so the screen
        // that prompted this reload keeps rendering for a moment afterwards —
        // re-observing it there spends a second reload on an answer already
        // acted on (observed live: two reloads for one unavailable host).
        const navigated = page
          .waitForEvent('framenavigated', {
            predicate: (frame) => frame === page.mainFrame(),
            timeout: Math.max(1, budgetMs),
          })
          .catch(() => undefined);
        await hostRecoveryReload.click();
        await navigated;
      },
      now: () => Date.now(),
    },
    timeoutMs,
  );
}
