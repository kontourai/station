import { expect, test } from '@playwright/test';

test.describe('Registry plugin install flow', () => {
  test('installs and removes a plugin from the registry page', async ({
    page,
  }) => {
    let installed = false;

    await page.route('**/api/registry/plugins/installed', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: installed
            ? [{ id: 'demo-layout', displayName: 'Demo Layout' }]
            : [],
        },
      }),
    );
    await page.route('**/api/registry/plugins/install', async (route) => {
      installed = true;
      await route.fulfill({
        json: { success: true, action: 'install', id: 'demo-layout' },
      });
    });
    await page.route('**/api/registry/plugins/demo-layout', async (route) => {
      installed = false;
      await route.fulfill({
        json: { success: true, action: 'uninstall', id: 'demo-layout' },
      });
    });
    await page.route('**/api/registry/plugins', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'demo-layout',
              displayName: 'Demo Layout',
              description: 'Starter workspace plugin',
              version: '1.0.0',
              source: '../demo-layout',
              installed,
            },
          ],
        },
      }),
    );

    await page.goto('/registry');
    await page.waitForSelector('.page__tab', { timeout: 15_000 });
    await page.locator('.page__tab', { hasText: 'Plugins' }).click();

    const detailInstall = page
      .getByTestId('registry-detail')
      .getByRole('button', { name: 'Install' });
    await expect(detailInstall).toBeVisible();
    await detailInstall.click();

    await expect(page.getByText('Installed Demo Layout')).toBeVisible();
    const detailRemove = page
      .getByTestId('registry-detail')
      .getByRole('button', { name: 'Remove' });
    await expect(detailRemove).toBeVisible();

    await detailRemove.click();

    await expect(page.getByText('Removed Demo Layout')).toBeVisible();
    await expect(detailInstall).toBeVisible();
  });
});
