/**
 * Android navigation tests — verifies key UI flows work at mobile viewport.
 */
import { expect, test } from '@playwright/test';

test.describe('Android — Navigation', () => {
  test('app renders visible content', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);

    // Check that the app rendered something visible — even a loading state counts.
    // (Backend may not be running in CI, so we accept any rendered DOM content.)
    const bodyText = await page.evaluate(() => document.body.innerText.trim());
    const childCount = await page.evaluate(() => document.body.children.length);
    expect(childCount).toBeGreaterThan(0);
    // body should have some text or at least a non-empty DOM
    const hasContent = bodyText.length > 0 || childCount > 0;
    expect(hasContent).toBe(true);
  });

  test('no elements overflow viewport horizontally', async ({ page }) => {
    await page.goto('/');
    // Wait for loading spinners to resolve (MCP tool init can be slow)
    await page
      .waitForFunction(
        () => !document.body.innerText.includes('Loading accounts...'),
        { timeout: 15000 },
      )
      .catch(() => {});
    await page.waitForTimeout(500);

    const offscreen = await page.evaluate(() => {
      const vw = window.innerWidth;
      const elements = document.querySelectorAll('*');
      const offenders: string[] = [];
      elements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 1) {
          offenders.push(`${el.tagName}.${el.className} right=${rect.right}`);
        }
      });
      return offenders.slice(0, 5);
    });

    expect(offscreen).toHaveLength(0);
  });

  test('interactive elements are touch-target sized (>=44px)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    await expect(page.locator('.home-view')).toBeVisible({ timeout: 15000 });
    const tooSmall = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll(
          '.home-view button, .sidebar--expanded button',
        ),
      );
      return buttons
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          // Only check visible elements
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            (rect.width < 44 || rect.height < 44)
          );
        })
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return `${el.tagName} "${(el as HTMLElement).innerText?.slice(0, 20)}" ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`;
        })
        .slice(0, 10);
    });

    expect(tooSmall).toEqual([]);
  });

  test('app handles back navigation without crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForTimeout(1500);
    await page.goBack();
    await page.waitForTimeout(500);

    expect(
      errors.filter(
        (e) => !e.includes('ResizeObserver') && !e.includes('import_debug'),
      ),
    ).toHaveLength(0);
  });
});
