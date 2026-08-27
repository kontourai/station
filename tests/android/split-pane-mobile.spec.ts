/**
 * SplitPaneLayout mobile behavior tests.
 * On mobile: shows list first, then a skeleton-owned detail sheet.
 * Back button dismisses the sheet and returns to list.
 * CSS classes: .split-pane__left--visible / .split-pane__right--visible control visibility.
 */
import { expect, type Page, test } from '@playwright/test';

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedToolServerRoutes(page: Page) {
  const integrations = [
    {
      id: 'station-control',
      kind: 'mcp',
      transport: 'stdio',
      command: 'station-control',
      args: [],
      env: {},
      displayName: 'Station Control',
      description: 'Built-in Station control tool server',
      connected: true,
      renderAllowed: true,
    },
  ];

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/system/status') {
      await route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: true,
            configured: [
              {
                id: 'e2e-model',
                type: 'codex',
                enabled: true,
                capabilities: ['llm'],
              },
            ],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: { chat: { ready: true, source: 'codex' } },
          recommendation: {
            code: 'configured-chat-ready',
            type: 'providers',
            actionLabel: 'Review model connections',
            title: 'A chat-capable model connection is already configured',
            detail:
              'E2E uses a deterministic configured model so this fixture exercises the product-ready path.',
          },
        }),
      );
      return;
    }

    if (path === '/api/auth/status') {
      await route.fulfill(json({ authenticated: true, user: null }));
      return;
    }

    if (path === '/api/branding') {
      await route.fulfill(json({ success: true, data: {} }));
      return;
    }

    if (path === '/api/system/capabilities') {
      await route.fulfill(
        json({
          runtime: 'voltagent',
          voice: { stt: [], tts: [] },
          context: { providers: [] },
          scheduler: true,
        }),
      );
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route('**/config/app', async (route) => {
    await route.fulfill(json({ success: true, data: {} }));
  });

  await page.route('**/integrations**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/integrations') {
      await route.fulfill(json({ success: true, data: integrations }));
      return;
    }

    const match = path.match(/^\/integrations\/([^/]+)$/);
    if (match) {
      const integration = integrations.find(
        (entry) => entry.id === decodeURIComponent(match[1]),
      );
      await route.fulfill(
        integration
          ? json({ success: true, data: integration })
          : json({ success: false, error: 'Not found' }, 404),
      );
      return;
    }

    await route.fallback();
  });
}

test.describe('Android — SplitPaneLayout Mobile', () => {
  test.beforeEach(async ({ page }) => {
    await seedToolServerRoutes(page);
  });

  test('split pane shows list panel by default', async ({ page }) => {
    await page.goto('/connections/tools');

    const left = page.locator('.split-pane__left');
    const items = page.locator('.split-pane__item');

    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
    await expect(left).toHaveCount(1);
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Station Control');

    // On mobile, left panel is visible by default before item selection.
    const leftVisible = await left.evaluate(
      (el) => getComputedStyle(el).display !== 'none',
    );
    expect(leftVisible).toBe(true);
  });

  test('list rows keep a 44px minimum touch target', async ({ page }) => {
    await page.goto('/connections/tools');

    const item = page.locator('.split-pane__item').first();
    await expect(item).toContainText('Station Control');
    const minHeight = await item.evaluate(
      (element) => getComputedStyle(element).minHeight,
    );
    expect(Number.parseFloat(minHeight)).toBeGreaterThanOrEqual(44);
  });

  test('detail opens as a sheet when item is selected', async ({ page }) => {
    await page.goto('/connections/tools');

    const items = page.locator('.split-pane__item');
    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Station Control');
    await items.first().click();

    const backBtn = page.locator('.split-pane__back');

    await expect(backBtn).toBeVisible();
    await expect(page.locator('.split-pane__right--sheet')).toBeVisible();

    const left = page.locator('.split-pane__left');
    const leftVisible = await left.evaluate(
      (el) => getComputedStyle(el).display !== 'none',
    );
    expect(leftVisible).toBe(false);
  });

  test('back button returns to list view', async ({ page }) => {
    await page.goto('/connections/tools');

    const items = page.locator('.split-pane__item');
    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Station Control');
    await items.first().click();

    const backBtn = page.locator('.split-pane__back');
    await expect(backBtn).toBeVisible();
    await backBtn.click();

    const left = page.locator('.split-pane__left');
    const leftVisible = await left.evaluate(
      (el) => getComputedStyle(el).display !== 'none',
    );
    expect(leftVisible).toBe(true);
    await expect(page.locator('.split-pane__right--sheet')).toHaveCount(0);
  });
});
