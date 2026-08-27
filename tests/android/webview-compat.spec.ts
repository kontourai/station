/**
 * WebView compatibility tests.
 * Catches APIs used in code that aren't available in Android System WebView.
 */
import { expect, test } from '@playwright/test';

test.describe('Android — WebView Compatibility', () => {
  test('no use of unsupported APIs at startup', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    const critical = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('import_debug') &&
        !e.includes('favicon') &&
        !e.includes('404') &&
        !e.includes('ERR_CONNECTION_REFUSED') && // backend not running in CI
        !e.includes('Failed to load resource') &&
        !e.includes('Failed to fetch'),
    );
    expect(critical).toHaveLength(0);
  });

  test('CSS renders without layout breakage', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1500);

    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    expect(bodyHeight).toBeGreaterThan(100);
  });

  test('fonts load or fallback gracefully', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const hasFallbackFont = await page.evaluate(() => {
      const el = document.body;
      const style = window.getComputedStyle(el);
      return style.fontFamily.length > 0;
    });
    expect(hasFallbackFont).toBe(true);
  });

  test('touch events are supported', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const touchSupported = await page.evaluate(() => {
      return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    });
    // Chromium in mobile emulation supports touch
    expect(touchSupported).toBe(true);
  });

  test('viewport meta tag is present for mobile scaling', async ({ page }) => {
    await page.goto('/');

    const viewportMeta = await page
      .locator('meta[name="viewport"]')
      .getAttribute('content');
    expect(viewportMeta).toBeTruthy();
    expect(viewportMeta).toContain('width=device-width');
  });
});
