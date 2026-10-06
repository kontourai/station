import { expect, type Locator, type Page } from '@playwright/test';

/** Hold beyond Station's 500ms gesture threshold; the caller verifies before and after release. */
export async function pressAndHold(
  page: Page,
  control: Locator,
): Promise<() => Promise<void>> {
  const box = await control.boundingBox();
  expect(box, 'the held control needs a rendered box').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  return () => page.mouse.up();
}
