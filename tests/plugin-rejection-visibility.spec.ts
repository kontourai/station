/** Browser proof for the rejected-manifest row and its repair/reload journey. */
import { expect, type Page, test } from '@playwright/test';

const rejected = {
  status: 'rejected',
  name: 'Legacy_Plugin',
  displayName: 'Legacy_Plugin',
  rejection: {
    code: 'invalid-plugin-name',
    reason: "Plugin manifest name 'Legacy_Plugin' is not a canonical plugin id",
    recovery: {
      kind: 'repair-manifest',
      instruction:
        'Use a lowercase plugin name containing only letters, digits, and hyphens, then choose Reload plugins.',
    },
  },
};

async function seedRoutes(page: Page) {
  let repaired = false;
  await Promise.all([
    page.addInitScript(() => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
    }),
    page.route('**/api/plugins/reload', (route) => {
      repaired = true;
      return route.fulfill({ json: { success: true, loaded: 1 } });
    }),
    page.route('**/api/plugins', (route) =>
      route.fulfill({
        json: {
          plugins: repaired
            ? [
                {
                  name: 'legacy-plugin',
                  displayName: 'Legacy Plugin',
                  version: '2.0.0',
                  hasBundle: false,
                  permissions: {
                    declared: [],
                    granted: [],
                    missing: [],
                  },
                },
              ]
            : [rejected],
        },
      }),
    ),
    page.route('**/api/plugins/check-updates', (route) =>
      route.fulfill({ json: { updates: [] } }),
    ),
    page.route('**/api/projects', (route) =>
      route.fulfill({ json: { success: true, data: [] } }),
    ),
    page.route('**/api/agents', (route) =>
      route.fulfill({ json: { success: true, data: [] } }),
    ),
    page.route('**/api/connections/agents', (route) =>
      route.fulfill({ json: { success: true, data: [] } }),
    ),
    page.route('**/api/connections/models', (route) =>
      route.fulfill({ json: { success: true, data: [] } }),
    ),
  ]);
}

test('keeps a rejected installed plugin visible and recovers after repair', async ({
  page,
}) => {
  await seedRoutes(page);
  await page.goto('/plugins');

  await page.getByRole('button', { name: /Legacy_Plugin Rejected/ }).click();
  await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'not a canonical plugin id',
  );
  await expect(
    page.getByText(rejected.rejection.recovery.instruction),
  ).toBeVisible();
  await expect(
    page.locator('.detail-panel').getByRole('button', { name: 'Remove' }),
  ).toHaveCount(0);

  await page.getByRole('button', { name: 'Reload plugins' }).click();

  await expect(page.getByText('Legacy Plugin', { exact: true })).toBeVisible();
  await expect(page.getByText(/v2\.0\.0/)).toBeVisible();
  await expect(page.getByText('Rejected', { exact: true })).toHaveCount(0);
});
