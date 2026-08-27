import { expect, test } from '@playwright/test';

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
 * and the absence of the retired global knowledge overlay.
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

// Mirrors tests/first-run-zero-provider.spec.ts's ZERO_PROVIDER_STATUS.
const UNCONFIGURED_STATUS = JSON.stringify({
  ready: false,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: false,
    configured: [],
    detected: { ollama: false, bedrock: false },
  },
  recommendation: {
    code: 'unconfigured',
    type: 'connections',
    actionLabel: 'Open Connections',
    title: 'No usable AI path is configured yet',
    detail:
      'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
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
  test("Obsidian vault connect renders the adapter's real reason text on validation failure, not a generic message", async ({
    page,
  }) => {
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

    await page.goto('/settings');
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
  });

  test('an empty knowledge registry does not mount a global overlay or block the app toolbar', async ({
    page,
  }) => {
    await mockKnowledgeReadRoutes(page, {
      status: CHAT_READY_STATUS,
      roots: [],
    });

    await page.goto('/');

    await expect(page.getByTestId('knowledge-nudge')).toHaveCount(0);
    const settings = page.getByTitle(/Settings/);
    await expect(settings).toBeVisible({ timeout: 10_000 });
    const bounds = await settings.boundingBox();
    expect(bounds).not.toBeNull();
    expect(
      await page.evaluate(
        ({ x, y }) =>
          Boolean(
            document.elementFromPoint(x, y)?.closest('[title*="Settings"]'),
          ),
        {
          x: (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
          y: (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
        },
      ),
    ).toBe(true);
    await settings.click();
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

  test('Settings shows an existing personal root while the global overlay stays absent', async ({
    page,
  }) => {
    await mockKnowledgeReadRoutes(page, {
      status: CHAT_READY_STATUS,
      roots: [PERSONAL_ROOT],
    });

    await page.goto('/settings?section=knowledge');

    await expect(page.getByTestId('knowledge-nudge')).toHaveCount(0);
    await expect(page.getByText('/mock/knowledge/personal')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/Personal knowledge is on/)).toBeVisible();
  });

  test('removing the knowledge overlay does not remove the chat-rescue setup launcher', async ({
    page,
  }) => {
    await mockKnowledgeReadRoutes(page, {
      status: UNCONFIGURED_STATUS,
      roots: [],
    });

    await page.goto('/');

    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('knowledge-nudge')).toHaveCount(0);
  });
});
