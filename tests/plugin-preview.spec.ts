/** Plugin preview modal journey. Route and lifecycle contracts live below UI. */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_DIR = join(dirname(__filename), '..');
const DEMO_DIR = join(PROJECT_DIR, 'examples', 'demo-layout');
test.describe('Plugin Preview Modal (UI)', () => {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
  test.beforeAll(({}, testInfo) => {
    testInfo.setTimeout(90_000);
    execSync('npx tsx ../../packages/cli/src/cli.ts plugin build', {
      cwd: DEMO_DIR,
      timeout: 60_000,
    });
  });

  test('preview modal appears when installing from plugins page', async ({
    page,
  }, testInfo) => {
    await page.goto('/plugins');
    await page
      .getByRole('button', { name: 'Install plugin', exact: true })
      .click();

    // Find the install input
    const installInput = page.locator('.plugins__install-input');
    await expect(installInput).toBeVisible({ timeout: 5000 });

    // Type a local path
    await installInput.fill(DEMO_DIR);

    // Click install — should trigger preview
    await page.locator('.plugins__install-btn').click();

    // Wait for the preview modal
    await expect(page.locator('.plugins__modal-overlay')).toBeVisible({
      timeout: 10000,
    });

    // Should show the plugin name
    await expect(page.locator('.plugins__modal strong')).toContainText('Demo');

    // Should have component checkboxes
    expect(
      await page.locator('.plugins__modal input[type="checkbox"]').count(),
    ).toBeGreaterThan(0);

    // Should have confirm and cancel buttons
    await expect(
      page.locator('.plugins__modal >> text=Confirm Install'),
    ).toBeVisible();

    // Take screenshot of the preview modal
    await page.screenshot({
      path: testInfo.outputPath('plugin-preview-modal.png'),
    });

    // Close without installing
    await page.locator('.plugins__modal >> text=Cancel').click();
    await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
  });
});
