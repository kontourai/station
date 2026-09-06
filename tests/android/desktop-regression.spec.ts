/**
 * Desktop regression tests — verifies desktop layout is not broken by mobile-first changes.
 * Overrides the Pixel 7 viewport from the android project to a desktop width.
 */
import { expect, test } from '@playwright/test';
import { mockEmptyKnowledgeRegistry } from '../helpers/knowledge-setup';

// Override viewport to desktop for this entire file
test.use({ viewport: { width: 1280, height: 800 } });

test.describe('Desktop Regression', () => {
  test('optional knowledge setup does not overlay the desktop shell', async ({
    page,
  }) => {
    await mockEmptyKnowledgeRegistry(page, 'desktop-knowledge-runtime');

    await page.goto('/');

    await expect(page.getByTestId('knowledge-nudge')).toHaveCount(0);
    // The desktop route to Settings is the avatar menu, not a gear. #1552 D1
    // made the standalone gear `.app-toolbar__action--compact-only`, so at this
    // viewport `getByTitle(/Settings/)` still RESOLVES -- to the phone-only gear
    // and to the menu's own row -- while every match is `display: none`. That is
    // why this failed as `Received: hidden` rather than as a missing element,
    // and why matching on title alone is not a safe way to ask "is the shell
    // present" any more (#1322).
    //
    // Asserting the avatar keeps what this test is for: that the knowledge nudge
    // does not overlay the desktop shell's controls. Reaching Settings through
    // the menu is covered by `openHeaderSettings` in tests/helpers/orchestration.
    await expect(
      page.getByRole('button', { name: 'Profile and settings' }),
    ).toBeVisible({ timeout: 10_000 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  });

  test('mobile top bar is hidden on desktop', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const mobileBar = page.locator('.sidebar-mobile-bar');
    if ((await mobileBar.count()) > 0) {
      const isVisible = await mobileBar.evaluate(
        (el) => getComputedStyle(el).display !== 'none',
      );
      expect(isVisible).toBe(false);
    }
  });

  test('header nav is visible on desktop', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const nav = page.locator('.header-nav');
    if ((await nav.count()) > 0) {
      const display = await nav.evaluate((el) => getComputedStyle(el).display);
      expect(display).not.toBe('none');
    }
  });

  test('split pane shows both panels on desktop', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(2000);
    const left = page.locator('.split-pane__left');
    const right = page.locator('.split-pane__right');
    if ((await left.count()) > 0) {
      await expect(left).toBeVisible();
      await expect(right).toBeVisible();
    }
  });

  test('project sidebar is not an overlay on desktop', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const sidebar = page.locator('.sidebar');
    if ((await sidebar.count()) > 0) {
      const position = await sidebar.evaluate(
        (el) => getComputedStyle(el).position,
      );
      expect(position).not.toBe('fixed');
    }
  });

  test('no horizontal overflow on desktop', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });

  test('coding layout uses grid columns on desktop', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const codingLayout = page.locator('.coding-layout');
    if ((await codingLayout.count()) > 0) {
      const gridCols = await codingLayout.evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns,
      );
      // Should have multiple columns (not just '1fr' which would be mobile)
      expect(gridCols).toContain('px');
    }
  });
});
