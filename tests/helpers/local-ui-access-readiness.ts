import type { Page } from '@playwright/test';
import { DEGRADED_QUERY_TIMEOUT_MS } from '../../src-ui/src/hooks/useDegradedQueryState';

/**
 * The access gate should settle within its product-owned degraded window.
 * Leave a small scheduling margin for the browser to render that outcome.
 */
export const LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS =
  DEGRADED_QUERY_TIMEOUT_MS + 2_000;

const AUTHENTICATED_SHELL_SELECTOR = 'main#station-main';
const DEGRADED_ACCESS_ALERT = /taking longer than expected/i;

function elapsedMilliseconds(startedAt: number): string {
  return `${Math.round(performance.now() - startedAt)}ms`;
}

/**
 * Wait for the protected shell without allowing a broken local access gate to
 * masquerade as an unrelated downstream UI timeout.
 */
export async function waitForLocalUiAccessReadiness(page: Page): Promise<void> {
  const startedAt = performance.now();
  const authenticatedShell = page.locator(AUTHENTICATED_SHELL_SELECTOR);
  const degradedAccessAlert = page
    .getByRole('alert')
    .filter({ hasText: DEGRADED_ACCESS_ALERT });

  try {
    await authenticatedShell.or(degradedAccessAlert).first().waitFor({
      state: 'visible',
      timeout: LOCAL_UI_ACCESS_READINESS_TIMEOUT_MS,
    });

    if (await degradedAccessAlert.isVisible()) {
      throw new Error(
        `Local UI access readiness failed: the access gate reported "taking longer than expected" after ${elapsedMilliseconds(startedAt)}.`,
      );
    }
    if (await authenticatedShell.isVisible()) return;
  } catch (error) {
    if (await degradedAccessAlert.isVisible()) {
      throw new Error(
        `Local UI access readiness failed: the access gate reported "taking longer than expected" after ${elapsedMilliseconds(startedAt)}.`,
      );
    }
    throw new Error(
      `Local UI access readiness timed out after ${elapsedMilliseconds(startedAt)}: neither authenticated shell ${AUTHENTICATED_SHELL_SELECTOR} nor the degraded access alert appeared.`,
      { cause: error },
    );
  }

  throw new Error(
    `Local UI access readiness timed out after ${elapsedMilliseconds(startedAt)}: neither authenticated shell ${AUTHENTICATED_SHELL_SELECTOR} nor the degraded access alert appeared.`,
  );
}
