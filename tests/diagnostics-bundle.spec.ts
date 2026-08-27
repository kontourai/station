import { expect, test } from '@playwright/test';

async function seedSettingsRoutes(page: import('@playwright/test').Page) {
  await Promise.all([
    page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
        }),
      }),
    ),
    page.route('**/api/agents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/branding', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      }),
    ),
    page.route('**/api/auth/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true }),
      }),
    ),
    page.route('**/config/app', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { defaultModel: 'test-model', region: 'us-east-1' },
        }),
      }),
    ),
    page.route('**/api/system/capabilities', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runtime: 'voltagent',
          voice: { stt: [], tts: [] },
        }),
      }),
    ),
  ]);
}

test.describe('Diagnostics bundle', () => {
  test('downloads the redacted JSON bundle with a dated filename', async ({
    page,
  }) => {
    await seedSettingsRoutes(page);
    await page.route('**/api/diagnostics/bundle', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-07-20T12:34:56.000Z',
          doctor: { checks: [] },
          app: { version: '0.1.0', nodeVersion: 'v24.0.0', platform: 'darwin' },
          config: { apiKey: '[REDACTED]' },
        }),
      }),
    );

    await page.goto('/settings');
    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download diagnostics bundle' })
      .click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(
      /^station-diagnostics-\d{4}-\d{2}-\d{2}\.json$/,
    );
    await expect(
      page.locator('a[download^="station-diagnostics-"]'),
    ).toHaveCount(0);
  });

  test('shows the canonical error state and retries a failed request', async ({
    page,
  }) => {
    await seedSettingsRoutes(page);
    let attempts = 0;
    await page.route('**/api/diagnostics/bundle', (route) => {
      attempts += 1;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'failed' }),
      });
    });

    await page.goto('/settings');
    await page
      .getByRole('button', { name: 'Download diagnostics bundle' })
      .click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Diagnostics bundle failed' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Retry download' }).click();

    await expect.poll(() => attempts).toBe(2);
  });
});
