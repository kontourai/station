/**
 * Core update flow — verifies update detection and update execution in Settings.
 * Uses page.route to mock API responses for isolation from backend state.
 *
 * Fixtures use the typed writer shapes the PR2 server now emits
 * (installKind/applyMethod/identity diagnostics); the mocked answering
 * identity matches the identity route so the correlation-gated apply offer
 * can appear exactly as it does against a real server.
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

const SHA = 'a'.repeat(40);
const ANSWER_IDENTITY = {
  instanceId: 'e2e-instance',
  bootId: '11111111-1111-4111-8111-111111111111',
  sha: SHA,
};

function checkoutStatus(behind: number, currentHash: string): string {
  return JSON.stringify({
    installKind: 'source-checkout',
    applyMethod: 'git-pull',
    branch: 'main',
    currentHash,
    remoteHash: 'def5678',
    behind,
    ahead: 0,
    updateAvailable: behind > 0,
    serverIdentity: ANSWER_IDENTITY,
    provenanceIssue: null,
    technicalDetail: null,
    selfUpdateUnavailableReason: null,
  });
}

function seedRoutes(page: import('@playwright/test').Page) {
  return Promise.all([
    page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    ),
    page.route('**/api/system/identity', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ANSWER_IDENTITY),
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
  test('shows the checkout apply offer when behind its upstream', async ({
    page,
  }) => {
    await seedRoutes(page);

    // Mock the check to return updateAvailable
    await page.route('**/api/system/core-update', (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: checkoutStatus(3, 'abc1234'),
        });
      }
      return r.continue();
    });

    await page.goto('/settings');
    await page
      .getByRole('button', { name: /Check for server updates/ })
      .click();

    // The launch banner AND the settings card both present the derived
    // source wording (correct: two surfaces, one fact) — scope to the server
    // updates card to keep the locator strict-mode clean.
    const serverCard = page.locator('[data-catalog-id="core-app-updates"]');
    // The checkout apply offer, with the behind count on the derived line.
    await expect(
      serverCard.getByRole('button', { name: 'Update server checkout' }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      serverCard.getByText(
        'Server checkout is 3 commits behind its configured upstream.',
      ),
    ).toBeVisible();
    // Branch and hash info under the source-metadata labels.
    await expect(serverCard.getByText('Branch: main')).toBeVisible();
    await expect(serverCard.getByText('Checkout: abc1234')).toBeVisible();
    await expect(serverCard.getByText('Source ref: def5678')).toBeVisible();
  });

  test('executes core update and shows the restart verification', async ({
    page,
  }) => {
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
            body: checkoutStatus(0, 'def5678'),
          });
        }
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: checkoutStatus(3, 'abc1234'),
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
            message: 'Server update started.',
            restarting: true,
            restart,
          }),
        });
      }
      return r.continue();
    });

    await page.goto('/settings');
    await page
      .getByRole('button', { name: /Check for server updates/ })
      .click();
    const apply = page.getByRole('button', { name: 'Update server checkout' });
    await expect(apply).toBeVisible({ timeout: 10000 });

    await apply.click();

    // The restart line claims a START, never a verified success — archive#1903:
    // only the detached server watchdog's correlated verdict can confirm the
    // new server, so the client must not either.
    await expect(
      page.getByText('Server restart started. Verifying the expected build…'),
    ).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText(/Server update verified/)).toHaveCount(0);
  });

  test('shows the checkout match when no updates', async ({ page }) => {
    await seedRoutes(page);

    await page.route('**/api/system/core-update', (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: checkoutStatus(0, 'abc1234'),
        });
      }
      return r.continue();
    });

    await page.goto('/settings');
    await page
      .getByRole('button', { name: /Check for server updates/ })
      .click();
    await expect(
      page.getByText('Server checkout matches its configured upstream.'),
    ).toBeVisible({
      timeout: 10000,
    });
  });
});
