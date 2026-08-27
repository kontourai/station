import { expect, test } from '@playwright/test';
import { dismissSetupLauncher } from '../helpers/orchestration';

/**
 * A phone in landscape is WIDER than the 768px mobile breakpoint, so a
 * width-only media query reported it as a desktop and silently dropped every
 * mobile affordance — the one-row chat header, the task switcher, the 44px
 * touch floors — on a device that is unambiguously a phone. The breakpoint is
 * now `(max-width: 768px), (max-height: 540px) and (pointer: coarse)`.
 *
 * This must run in a touch-enabled context: without `pointer: coarse` the
 * second clause cannot match and the test would prove nothing.
 */
test('mobile chrome survives landscape on a touch device', async ({ page }) => {
  await page.goto('/?dock=open');
  await dismissSetupLauncher(page);
  const mobileHeader = page.locator('.chat-dock__mobile-header');
  await expect(mobileHeader).toBeVisible({ timeout: 15_000 });

  await page.setViewportSize({ width: 915, height: 412 });
  await expect(mobileHeader).toBeVisible({ timeout: 15_000 });

  // The desktop tab bar is the thing that used to come back in landscape.
  await expect(page.locator('.chat-dock__tab-actions')).toHaveCount(0);
});
