import type { Locator, Page } from '@playwright/test';

/**
 * Follow one lazy surface and the matching visible boundary failure. The
 * boundary identifies the failing UI, which can include a child render error.
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
    'neither the surface nor its failure appeared. This cannot distinguish a chunk still loading from one that never ' +
    `started. ${await observation.openStateDetail()}.`
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
        `${observation.surfaceName} is unavailable after ${elapsedMilliseconds(startedAt, observation.now())}: its boundary reported ${await observation.unavailableDetail()}. Station offers Retry or Reload.`,
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
  surfaceName: string;
  surfaceId: string;
  surface: Locator;
  openIndicator?: Locator;
};

/** Shared class for consumers that look for any failure, such as Gallery. */
export const LAZY_BOUNDARY_ERROR_SELECTOR = '.lazy-boundary__error';

/** Read the first visible candidate, preserving the caller's locator order. */
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
  const { surfaceName, surfaceId, surface, openIndicator } = screens;
  const ready = surface.filter({ visible: true }).first();
  const unavailable = page
    .locator(
      `${LAZY_BOUNDARY_ERROR_SELECTOR}[data-lazy-surface=${JSON.stringify(surfaceId)}]`,
    )
    .filter({ visible: true })
    .first();
  const settled = ready.or(unavailable).first();

  return waitForLazySurfaceThrough(
    {
      surfaceName,
      waitForSettledScreen: async (budgetMs) => {
        let timedOut = false;
        try {
          await settled.waitFor({ state: 'visible', timeout: budgetMs });
        } catch {
          timedOut = true;
        }
        if (await ready.isVisible()) return 'ready';
        if (await unavailable.isVisible()) return 'unavailable';
        return timedOut ? 'timeout' : 'pending';
      },
      unavailableDetail: async () => {
        const text = (
          await unavailable.textContent({ timeout: 500 }).catch(() => null)
        )
          ?.trim()
          .slice(0, 200);
        return text
          ? `"${text}"`
          : 'a failure that cleared before its text was read';
      },
      openStateDetail: async () => {
        if (!openIndicator)
          return "This surface's trigger publishes no open state";
        return (await firstVisibleMatch([openIndicator]))
          ? 'Its trigger does report the surface open'
          : 'Its trigger does not report the surface open';
      },
      now: () => Date.now(),
    },
    timeoutMs,
  );
}
