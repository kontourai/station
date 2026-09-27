/**
 * Desktop regression tests — verifies desktop layout is not broken by mobile-first changes.
 * Overrides the Pixel 7 viewport from the android project to a desktop width.
 */
import { expect, test } from '@playwright/test';

// Override viewport to desktop for this entire file
test.use({ viewport: { width: 1280, height: 800 } });

test.describe('Desktop Regression', () => {
  test('desktop shell shows its avatar menu with no horizontal overflow at 1280', async ({
    page,
  }) => {
    await page.goto('/');

    // The desktop route to Settings is the avatar menu, not a gear. The header
    // carries no standalone gear at any viewport (the phone-only one is gone;
    // Settings lives in the sidebar drawer's footer), so at this viewport
    // `getByTitle(/Settings/)` matches only the menu's own row. That is why
    // matching on title alone is not a safe way to ask "is the shell
    // present" (#1322). Reaching Settings through the menu is covered by
    // `openHeaderSettings` in tests/helpers/orchestration.
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
});
