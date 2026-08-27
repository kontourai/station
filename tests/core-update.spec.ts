/**
 * Core update flow — verifies update detection and update execution in Settings.
 * Uses page.route to mock API responses for isolation from backend state.
 */
import { expect, test } from '@playwright/test';

const STATUS_READY = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [],
    detected: { ollama: false, bedrock: false },
  },
});

function seedRoutes(page: import('@playwright/test').Page) {
  return Promise.all([
    page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    ),
    page.route('**/api/agents', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/projects', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/branding', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      }),
    ),
    page.route('**/api/auth/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true }),
      }),
    ),
    page.route('**/api/config/app', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { defaultModel: 'claude-sonnet', region: 'us-east-1' },
        }),
      }),
    ),
    page.route('**/api/system/capabilities', (r) =>
      r.fulfill({
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

test.describe('Core Update Flow', () => {
  test('shows update button when behind remote', async ({ page }) => {
    await seedRoutes(page);

    // Mock the check to return updateAvailable
    await page.route('**/api/system/core-update', (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            currentHash: 'abc1234',
            remoteHash: 'def5678',
            branch: 'main',
            behind: 3,
            ahead: 0,
            updateAvailable: true,
          }),
        });
      }
      return r.continue();
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: /Check for Updates/ }).click();

    // Should show the update button with commit count
    await expect(
      page.getByRole('button', { name: /Update \(3 commits behind\)/ }),
    ).toBeVisible({ timeout: 10000 });
    // Should show branch and hash info
    await expect(page.getByText('Branch: main')).toBeVisible();
    await expect(page.getByText('Current: abc1234')).toBeVisible();
    await expect(page.getByText('Latest: def5678')).toBeVisible();
  });

  test('executes core update and shows success', async ({ page }) => {
    await seedRoutes(page);

    let postCalled = false;
    const restart = {
      expectedHash: 'def5678',
      expectedInstanceId: 'e2e-instance',
      deadlineAt: new Date(Date.now() + 95_000).toISOString(),
    };
    await page.route('**/api/system/core-update/restart-status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending', ...restart }),
      }),
    );
    await page.route('**/api/system/core-update', (r) => {
      if (r.request().method() === 'GET') {
        // After update, return up-to-date
        if (postCalled) {
          return r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              currentHash: 'def5678',
              branch: 'main',
              behind: 0,
              ahead: 0,
              updateAvailable: false,
            }),
          });
        }
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            currentHash: 'abc1234',
            remoteHash: 'def5678',
            branch: 'main',
            behind: 3,
            ahead: 0,
            updateAvailable: true,
          }),
        });
      }
      if (r.request().method() === 'POST') {
        postCalled = true;
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            hash: 'def5678',
            message: 'Updated to def5678. Server restarting…',
            restarting: true,
            restart,
          }),
        });
      }
      return r.continue();
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: /Check for Updates/ }).click();
    await expect(
      page.getByRole('button', { name: /Update \(3 commits behind\)/ }),
    ).toBeVisible({ timeout: 10000 });

    await page
      .getByRole('button', { name: /Update \(3 commits behind\)/ })
      .click();

    // Should show restarting message — station#1903: the client no longer
    // claims the update itself succeeded before the new server is verified.
    await expect(
      page.getByText('Restarting — verifying the new server…'),
    ).toBeVisible({
      timeout: 10000,
    });
  });

  test('shows up-to-date when no updates', async ({ page }) => {
    await seedRoutes(page);

    await page.route('**/api/system/core-update', (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            currentHash: 'abc1234',
            branch: 'main',
            behind: 0,
            ahead: 0,
            updateAvailable: false,
          }),
        });
      }
      return r.continue();
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: /Check for Updates/ }).click();
    await expect(page.getByText('Up to date')).toBeVisible({
      timeout: 10000,
    });
  });
});
