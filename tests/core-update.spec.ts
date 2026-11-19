/**
 * Core update flow — verifies update detection and update execution in Settings.
 * Uses page.route to mock API responses for isolation from backend state.
 *
 * Fixtures use the typed writer shapes the PR2 server now emits
 * (installKind/applyMethod/identity diagnostics); the mocked answering
 * identity matches the identity route so the correlation-gated apply offer
 * can appear exactly as it does against a real server.
 */
import { expect } from '@playwright/test';
import { routeCoreUpdateCheck } from './helpers/core-update-route';
import { test } from './helpers/fixture-audit';

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
    page.route('**/api/system/core-update/running-turns', (route) =>
      route.fulfill({ json: { turns: [], hiddenCount: 0 } }),
    ),
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
    await routeCoreUpdateCheck(page, (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: checkoutStatus(3, 'abc1234'),
        });
      }
      return r.continue();
    });

    await page.goto('/settings?view=system');
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
    // Branch and hash info are under Details.
    await serverCard.getByText('Details', { exact: true }).click();
    await expect(serverCard.getByText('Branch: main')).toBeVisible();
    await expect(serverCard.getByText('Checkout: abc1234')).toBeVisible();
    await expect(serverCard.getByText('Source ref: def5678')).toBeVisible();
  });

  for (const outcome of ['verified', 'no expectation', 'deadline'] as const) {
    test(`checkout restart verification: ${outcome}`, async ({ page }) => {
      await seedRoutes(page);
      if (outcome === 'deadline') await page.clock.install();

      let postCalled = false;
      let verify = false;
      let statusReads = 0;
      const restart = {
        expectedHash: 'def5678',
        expectedInstanceId: ANSWER_IDENTITY.instanceId,
        deadlineAt: '',
      };
      await page.route('**/api/system/core-update/restart-status', (route) => {
        statusReads += 1;
        return route.fulfill({
          json: verify
            ? {
                status: 'verified',
                ...restart,
                resolvedAt: new Date().toISOString(),
              }
            : { status: 'pending', ...restart },
        });
      });
      await routeCoreUpdateCheck(page, (route) => {
        if (route.request().method() === 'GET') {
          return route.fulfill({
            contentType: 'application/json',
            body: postCalled
              ? checkoutStatus(0, 'def5678')
              : checkoutStatus(3, 'abc1234'),
          });
        }
        if (route.request().method() === 'POST') {
          postCalled = true;
          restart.deadlineAt = new Date(Date.now() + 95_000).toISOString();
          return route.fulfill({
            json: {
              success: true,
              hash: 'def5678',
              message: 'Server update started.',
              restarting: true,
              ...(outcome === 'no expectation' ? {} : { restart }),
            },
          });
        }
        return route.continue();
      });

      await page.goto('/settings?view=system');
      await page
        .getByRole('button', { name: /Check for server updates/ })
        .click();
      await page
        .getByRole('button', { name: 'Update server checkout' })
        .click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Update and restart' })
        .click();

      const success = page.getByText('Server update verified: def5678.');
      const failure = page.getByText(
        /Could not verify the expected server after restart/,
      );
      if (outcome === 'no expectation') {
        await expect(page.getByText(/Try again in a moment/)).toBeVisible();
        expect(postCalled).toBe(true);
        expect(statusReads).toBe(0);
        await expect(success).toHaveCount(0);
        return;
      }

      await expect(
        page.getByText('Server restart started. Verifying the expected build…'),
      ).toBeVisible();
      await expect.poll(() => statusReads).toBeGreaterThan(0);
      await expect(success).toHaveCount(0);
      if (outcome === 'verified') {
        verify = true;
        await expect(success).toBeVisible();
      } else {
        await page.clock.fastForward(96_000);
        await expect(failure).toBeVisible();
        await expect(success).toHaveCount(0);
      }
    });
  }

  test('shows the checkout match when no updates', async ({ page }) => {
    await seedRoutes(page);

    await routeCoreUpdateCheck(page, (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: checkoutStatus(0, 'abc1234'),
        });
      }
      return r.continue();
    });

    await page.goto('/settings?view=system');
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

test.describe('Release archive run by the service launcher (#2675 D3)', () => {
  const REQUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const archiveStatus = (serviceUpdate: unknown) =>
    JSON.stringify({
      installKind: 'archive-service',
      applyMethod: 'service-update',
      channel: 'preview',
      currentVersion: '0.8.0-preview.1',
      latestVersion: '0.8.0-preview.2',
      releaseCheck: 'verified',
      updateAvailable: true,
      serverIdentity: ANSWER_IDENTITY,
      provenanceIssue: null,
      technicalDetail: null,
      selfUpdateUnavailableReason: null,
      selfUpdateUnavailableCode: null,
      serviceUpdate,
    });

  test('offers the verified release, follows the service update, and shows its rollback', async ({
    page,
  }, testInfo) => {
    await seedRoutes(page);
    let progress: unknown = { state: 'idle' };
    await page.route('**/api/system/core-update/service-update?staged=1', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(progress),
      }),
    );
    await routeCoreUpdateCheck(page, (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: archiveStatus(progress),
        });
      }
      if (r.request().method() === 'POST') {
        progress = {
          state: 'updating',
          requestId: REQUEST_ID,
          phase: 'trial',
          fromVersion: '0.8.0-preview.1',
          targetVersion: '0.8.0-preview.2',
          attempts: 1,
        };
        return r.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            serviceUpdate: { requestId: REQUEST_ID },
            message: 'Update requested.',
          }),
        });
      }
      return r.continue();
    });

    await page.goto('/settings?view=system');
    await page
      .getByRole('button', { name: /Check for server updates/ })
      .click();
    const serverCard = page.locator('[data-catalog-id="core-app-updates"]');
    const apply = serverCard.getByRole('button', {
      name: 'Update server',
      exact: true,
    });
    await expect(apply).toBeVisible({ timeout: 10000 });
    await apply.hover();
    const hoveredOfferBackground = await apply.evaluate(async (button) => {
      await Promise.all(
        button.getAnimations().map((animation) => animation.finished),
      );
      return getComputedStyle(button).backgroundColor;
    });
    // The header carries the comparison: one badge, "current → latest".
    await expect(serverCard.getByRole('status')).toHaveText('Update available');
    await expect(serverCard.locator('.status-summary__version')).toHaveText(
      /0\.8\.0-preview\.1\s*→\s*to 0\.8\.0-preview\.2/,
    );
    await expect(serverCard.getByText(/Source update/)).toHaveCount(0);
    // The status names the install, so the connection-only guess is gone,
    // and a prebuilt release has no source installation to disclose.
    await expect(
      serverCard.getByText('Server update method unknown.'),
    ).toHaveCount(0);
    await expect(
      serverCard.getByText('Source installation details'),
    ).toHaveCount(0);
    await serverCard.scrollIntoViewIfNeeded();
    await serverCard.screenshot({
      path: testInfo.outputPath('archive-update-offer.png'),
    });

    await apply.click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Update and restart' })
      .click();
    await expect(
      serverCard.getByText(
        'Trying Station 0.8.0-preview.2 (attempt 1). The server restarts during the trial.',
      ),
    ).toBeVisible({ timeout: 10000 });
    await serverCard.screenshot({
      path: testInfo.outputPath('archive-update-trial.png'),
    });

    progress = {
      state: 'rolled-back',
      requestId: REQUEST_ID,
      fromVersion: '0.8.0-preview.1',
      targetVersion: '0.8.0-preview.2',
      reason: 'prepared-timeout',
      finishedAt: new Date().toISOString(),
    };
    await expect(
      serverCard.getByText(
        /The update to 0\.8\.0-preview\.2 was rolled back: the new version did not become ready in time\. The server runs 0\.8\.0-preview\.1/,
      ),
    ).toBeVisible({ timeout: 10000 });
    // After the outcome the offer is either absent (until the re-check
    // answers) or live again: never a disabled leftover of the accepted POST.
    const offers = serverCard.getByRole('button', {
      name: 'Update server',
      exact: true,
    });
    await expect(offers).toBeEnabled({ timeout: 10000 });
    // The recovered offer uses the same hover treatment as the original.
    await offers.hover();
    await expect(offers).toHaveCSS('background-color', hoveredOfferBackground);
    await serverCard.screenshot({
      path: testInfo.outputPath('archive-update-rolled-back.png'),
    });
  });
});
