/**
 * Android viewport UI tests.
 * These run against the Vite dev server using a mobile viewport that matches
 * the Tauri Android WebView dimensions. Fast feedback without needing an emulator.
 */
import { expect, test } from '@playwright/test';

test.describe('Android — App Load', () => {
  test('app renders without crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForTimeout(2000);

    expect(
      errors.filter(
        (e) => !e.includes('ResizeObserver') && !e.includes('import_debug'),
      ),
    ).toHaveLength(0);
  });

  test('root element mounts', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1500);
    const root = page.locator('#root, [data-testid="app"], main, .app');
    await expect(root.first()).toBeVisible();
  });

  test('no horizontal overflow at mobile width', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() => {
      return (
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
      );
    });
    expect(overflow).toBe(false);
  });

  test('page title is set', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});
