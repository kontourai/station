import type { Page } from '@playwright/test';
import { expect, test } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';

const API = resolveE2EApiBase();

/**
 * The shell becomes visible before App's SSE effect has subscribed. Ordinary
 * notifications are intentionally not replayed by `/events`, so posting in
 * that window loses the event rather than exercising the toast journey.
 */
async function openNotificationsPage(page: Page): Promise<void> {
  const eventStream = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/events' &&
      response.request().method() === 'GET',
    { timeout: 10_000 },
  );

  await page.goto('/');
  await page.waitForSelector('[class*="app-"]', { timeout: 10_000 });
  await eventStream;
}

test.describe('Notification System', () => {
  test('UI: notification appears in toast when scheduled via API', async ({
    page,
    authenticatedRequest,
  }, testInfo) => {
    await openNotificationsPage(page);

    // Schedule a notification via API — the SSE bridge should push it to the toast UI
    const response = await authenticatedRequest.post(`${API}/notifications`, {
      data: {
        source: 'playwright-ui',
        category: 'test',
        title: 'UI Toast Test',
        body: 'Should appear in the UI',
        ttl: 15000,
      },
    });
    expect(response.status()).toBe(201);

    await expect(page.getByText('UI Toast Test')).toBeVisible({
      timeout: 10_000,
    });

    // Take a screenshot for visual verification regardless
    await page.screenshot({
      path: testInfo.outputPath('notification-toast.png'),
      fullPage: false,
    });
  });

  test('UI: notification with navigateTo shows View button', async ({
    page,
    authenticatedRequest,
  }, testInfo) => {
    await openNotificationsPage(page);

    // Fire notification with navigateTo metadata from within the page context
    const response = await authenticatedRequest.post(`${API}/notifications`, {
      data: {
        source: 'rss-plugin',
        category: 'rss-update',
        title: 'New article in Tech Feed',
        body: 'AWS announces new container service',
        priority: 'normal',
        ttl: 60000,
        metadata: {
          navigateTo: { project: 'research', layout: 'rss-reader' },
        },
      },
    });
    expect(response.status()).toBe(201);

    const notification = page.getByTestId('toast-card').filter({
      hasText: 'New article in Tech Feed',
    });
    await expect(notification).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      notification.getByRole('button', { name: 'View' }),
    ).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath('notification-with-view-button.png'),
      fullPage: false,
    });
  });

  test('UI: notification bell shows history', async ({ page }, testInfo) => {
    await openNotificationsPage(page);

    // Take a screenshot of the header area where the bell icon lives
    await page.screenshot({
      path: testInfo.outputPath('notification-header.png'),
      fullPage: false,
    });

    // Look for the notification bell button
    const bellButton = page.locator('button[title="Notifications"]');
    await expect(bellButton).toBeVisible();
    await bellButton.click();
    await expect(page.locator('.notification-history__title')).toHaveText(
      'Notifications',
    );
    await page.screenshot({
      path: testInfo.outputPath('notification-history-open.png'),
      fullPage: false,
    });
  });
});
