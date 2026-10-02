import { expect, test } from '@playwright/test';
import { openHeaderSettings } from './helpers/orchestration';
import { fulfillStationShellRead } from './helpers/station-shell-fixtures';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('station:onboarding-setup-dismissed');
  });
});

/**
 * K4 product coverage (`product` bucket, mocked via `page.route` — mirrors
 * `tests/first-run-zero-provider.spec.ts`'s style): the Obsidian-vault-connect
 * honest-validation-failure path (`ErrorState` rendering the adapter's own
 * `reason` string verbatim, never a generic message), Settings-owned creation,
 * and an empty registry leaving the app toolbar usable.
 */

const CHAT_READY_STATUS = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [
      {
        id: 'knowledge-onboarding-mock-runtime',
        type: 'codex',
        enabled: true,
        capabilities: ['llm'],
      },
    ],
    detected: { ollama: false, bedrock: false },
  },
  capabilities: {
    chat: {
      ready: true,
      source: 'knowledge-onboarding-mock-runtime',
    },
  },
});

const ADAPTERS_BODY = JSON.stringify({
  success: true,
  data: [
    { id: 'kit-default-store', displayName: 'Default File Store' },
    { id: 'kit-obsidian-store', displayName: 'Obsidian Vault Store' },
  ],
});

function rootsBody(roots: unknown[]): string {
  return JSON.stringify({ success: true, data: roots });
}

const PERSONAL_ROOT = {
  id: 'root:personal',
  scope: { kind: 'personal' },
  adapterId: 'kit-default-store',
  storeRoot: '/mock/knowledge/personal',
  displayName: 'Personal knowledge store',
  createdAt: '2026-01-01T00:00:00Z',
};

async function mockKnowledgeReadRoutes(
  page: import('@playwright/test').Page,
  options: { status: string; roots: unknown[] },
): Promise<void> {
  await page.route('**/api/**', async (route) => {
    if (await fulfillStationShellRead(route)) return;
    await route.fallback();
  });
  await page.route('**/api/system/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: options.status,
    }),
  );
  await page.route('**/api/knowledge/roots', (route) => {
    if (route.request().method() !== 'GET') {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: rootsBody(options.roots),
    });
  });
  await page.route('**/api/knowledge/adapters', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: ADAPTERS_BODY,
    }),
  );
}

test.describe('Knowledge onboarding (product, mocked)', () => {
  test('Obsidian validation reports adapter rejection and failed requests without an unhandled error', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await mockKnowledgeReadRoutes(page, {
      status: CHAT_READY_STATUS,
      roots: [],
    });
    const MOCK_REASON =
      'mock-adapter-reason: this path has no .obsidian/ marker and is not a real vault';
    await page.route('**/api/knowledge/roots/validate', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { ok: false, reason: MOCK_REASON },
        }),
      }),
    );

    await page.goto('/settings?view=knowledge');
    await page.waitForSelector('#section-knowledge', { timeout: 15_000 });
    const section = page.locator('#section-knowledge');

    await section
      .getByRole('button', {
        name: 'Connect an existing Obsidian vault instead',
      })
      .click();
    await section.getByPlaceholder('/path/to/vault').fill('/mock/not-a-vault');
    await section.getByRole('button', { name: 'Validate' }).click();

    // The adapter's own reason, verbatim — never a generic error message.
    await expect(section.getByText(MOCK_REASON)).toBeVisible({
      timeout: 10_000,
    });
    await expect(section.getByText('Something went wrong.')).toHaveCount(0);
    await expect(
      section.getByRole('button', { name: 'Connect' }),
    ).toBeDisabled();

    const requestFailure = 'The knowledge adapter is temporarily unavailable';
    await page.route('**/api/knowledge/roots/validate', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: requestFailure }),
      }),
    );
    await section.getByRole('button', { name: 'Validate' }).click();
    await expect(
      section.getByText('Vault validation could not be completed'),
    ).toBeVisible();
    await expect(section.getByText(requestFailure)).toBeVisible();
    await expect(section.getByText(MOCK_REASON)).toHaveCount(0);
    await expect(
      section.getByRole('button', { name: 'Connect' }),
    ).toBeDisabled();
    expect(pageErrors).toEqual([]);
  });

  test('an empty knowledge registry does not block the app toolbar', async ({
    page,
  }) => {
    await mockKnowledgeReadRoutes(page, {
      status: CHAT_READY_STATUS,
      roots: [],
    });

    await page.goto('/');

    await openHeaderSettings(page);
    await expect(page).toHaveURL(/\/settings/);
  });

  test('Settings creates the recommended personal store with one click', async ({
    page,
  }) => {
    await mockKnowledgeReadRoutes(page, {
      status: CHAT_READY_STATUS,
      roots: [],
    });

    let createBody: unknown;
    await page.route('**/api/knowledge/roots', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      createBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: PERSONAL_ROOT }),
      });
    });

    await page.goto('/settings?section=knowledge');
    const section = page.locator('#section-knowledge');
    await expect(section.getByText(/^Optional\./)).toBeVisible({
      timeout: 10_000,
    });
    await section
      .getByRole('button', { name: 'Create recommended store' })
      .click();
    await expect
      .poll(() => createBody)
      .toEqual({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
      });
  });

  test('Settings shows an existing personal root', async ({ page }) => {
    await mockKnowledgeReadRoutes(page, {
      status: CHAT_READY_STATUS,
      roots: [PERSONAL_ROOT],
    });

    await page.goto('/settings?section=knowledge');

    await expect(page.getByText('/mock/knowledge/personal')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/Personal knowledge is on/)).toBeVisible();
  });
});
