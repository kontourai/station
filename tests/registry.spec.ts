import { expect, type Page, test } from '@playwright/test';
import { E2E_STATION_COMPATIBILITY } from './helpers/current-station-contract';
import { dismissSetupLauncher } from './helpers/orchestration';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';

async function mockStationIdentity(page: Page) {
  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        environmentId: ENVIRONMENT_ID,
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: E2E_STATION_COMPATIBILITY,
      },
    }),
  );
  await page.route('**/api/system/identity', (route) =>
    route.fulfill({
      json: {
        environmentId: ENVIRONMENT_ID,
        instanceId: 'registry-fixture',
        bootId: 'registry-boot',
        sha: '2222222222222222222222222222222222222222',
      },
    }),
  );
}

async function forceClick(page: Page, selector: string) {
  await page
    .locator(selector)
    .evaluate((el) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
}

async function mockRegistry(page: Page) {
  const installCalls: string[] = [];
  const layoutStates = new Map<
    string,
    'installed' | 'installable' | 'disabled'
  >([
    ['builtin:coding', 'installed'],
    ['builtin:tasks', 'installed'],
  ]);
  const installed = {
    agents: new Set<string>(),
    skills: new Set<string>(),
    integrations: new Set<string>(),
    plugins: new Set<string>(),
    layouts: new Set<string>(['builtin:coding', 'builtin:tasks']),
  };
  const catalog = {
    agents: [
      {
        id: 'project-planner',
        displayName: 'Project Planner',
        description: 'Planning-focused agent',
        source: 'registry',
        version: '2.0.0',
      },
    ],
    skills: [
      {
        id: 'prompt-toolkit',
        displayName: 'Prompt Toolkit',
        description: 'Starter prompts and helpers',
        source: 'registry',
        version: '1.2.0',
      },
    ],
    integrations: [
      {
        id: 'slack-notifier',
        displayName: 'Slack Notifier',
        description: 'Post updates to Slack',
        source: 'registry',
        version: '0.9.0',
      },
      {
        id: 'broken-integration',
        displayName: 'Broken Integration',
        description: 'Fails install for policy coverage',
        source: 'registry',
        version: '0.1.0',
      },
    ],
    plugins: [
      {
        id: 'demo-layout',
        displayName: 'Demo Layout',
        description: 'Starter plugin',
        source: '../demo-layout',
        version: '1.0.0',
      },
    ],
    layouts: [
      {
        id: 'builtin:coding',
        name: 'Coding',
        description: 'Files, changes, terminal, and chat',
        source: 'builtin',
        lifecycle: { state: 'installed' },
        enabled: true,
      },
      {
        id: 'builtin:tasks',
        name: 'Tasks',
        description: 'Project tasks and workflow status',
        source: 'builtin',
        lifecycle: { state: 'installed' },
        enabled: true,
      },
    ],
  };

  function itemWithInstallState(tab: keyof typeof catalog) {
    if (tab === 'layouts') {
      return catalog.layouts.map((item) => {
        const state = layoutStates.get(item.id) ?? 'installable';
        return {
          ...item,
          lifecycle: { state },
          enabled: state === 'installed',
          installable: state === 'installable',
          installed: state !== 'installable',
        };
      });
    }
    return catalog[tab].map((item) => ({
      ...item,
      installed: installed[tab].has(item.id),
    }));
  }

  function installedItems(tab: keyof typeof catalog) {
    return itemWithInstallState(tab).filter((item) => item.installed);
  }

  for (const tab of Object.keys(catalog) as Array<keyof typeof catalog>) {
    const actionPattern =
      tab === 'layouts'
        ? '**/api/registry/layouts/**'
        : `**/api/registry/${tab}/*`;
    await page.route(actionPattern, async (route) => {
      const path = new URL(route.request().url()).pathname.split('/');
      if (tab === 'layouts' && route.request().method() === 'GET') {
        await route.fallback();
        return;
      }
      if (tab === 'layouts' && route.request().method() !== 'GET') {
        const action =
          route.request().method() === 'DELETE' ? 'remove' : path.pop();
        const id = decodeURIComponent(path.pop() ?? '');
        const next =
          action === 'disable'
            ? 'disabled'
            : action === 'remove'
              ? 'installable'
              : 'installed';
        layoutStates.set(id, next);
        if (next === 'installable') installed.layouts.delete(id);
        else installed.layouts.add(id);
        const item = itemWithInstallState('layouts').find(
          (candidate) => candidate.id === id,
        );
        await route.fulfill({ json: { success: true, data: item } });
        return;
      }
      const id = decodeURIComponent(path.pop() ?? '');
      installed[tab].delete(id);
      await route.fulfill({
        json: { success: true, action: 'uninstall', id },
      });
    });
    await page.route(`**/api/registry/${tab}`, (route) =>
      route.fulfill({
        json: { success: true, data: itemWithInstallState(tab) },
      }),
    );
    await page.route(`**/api/registry/${tab}/installed`, (route) =>
      route.fulfill({ json: { success: true, data: installedItems(tab) } }),
    );
    await page.route(`**/api/registry/${tab}/install`, async (route) => {
      const body = route.request().postDataJSON();
      if (body.id === 'broken-integration') {
        await route.fulfill({
          status: 500,
          json: { success: false, error: 'Install blocked by policy' },
        });
        return;
      }
      installed[tab].add(body.id);
      installCalls.push(`${tab}/install`);
      await route.fulfill({
        json: { success: true, action: 'install', id: body.id },
      });
    });
  }

  return { catalog, installCalls, installed, layoutStates };
}

test.describe('Registry page', () => {
  test.beforeEach(async ({ page }) => {
    await mockStationIdentity(page);
    await page.goto('/registry');
    // Wait for the app to load past the onboarding gate
    await page.waitForSelector('.page__tab', { timeout: 15_000 });
  });

  test('registry page loads with tabs', async ({ page }) => {
    const tabs = page.locator('.page__tab');
    await expect(tabs).toHaveCount(6);
    await expect(tabs.nth(0)).toHaveText('Agents');
    await expect(tabs.nth(1)).toHaveText('Skills');
    await expect(tabs.nth(2)).toHaveText('Integrations');
    await expect(tabs.nth(3)).toHaveText('Plugins');
    await expect(tabs.nth(4)).toHaveText('Layouts');
    await expect(tabs.nth(5)).toHaveText('Kits');
  });

  test('switching tabs works', async ({ page }) => {
    // Click Skills tab
    await page.locator('.page__tab', { hasText: 'Skills' }).click();

    // Verify Skills tab is active
    await expect(page.locator('.page__tab--active')).toHaveText('Skills');

    // Click Plugins tab
    await page.locator('.page__tab', { hasText: 'Plugins' }).click();

    await expect(page.locator('.page__tab--active')).toHaveText('Plugins');
  });

  test('Layouts shows standard Coding and Tasks starters', async ({ page }) => {
    await mockRegistry(page);
    await page.goto('/registry/layouts');
    await page.waitForSelector('.page__tab', { timeout: 15_000 });

    await expect(page.getByTestId('registry-detail')).toContainText('Coding');
    await page.getByRole('button', { name: /Tasks/ }).click();
    await expect(page.getByTestId('registry-detail')).toContainText('Tasks');
    await expect(
      page.getByTestId('registry-detail').getByRole('button', { name: 'Use' }),
    ).toBeVisible();
  });

  test('Layouts exposes an honest install, enable, disable, remove lifecycle', async ({
    page,
  }) => {
    await mockRegistry(page);
    await page.goto('/registry/layouts');
    await page.waitForSelector('.page__tab', { timeout: 15_000 });
    await page.getByRole('button', { name: /Tasks/ }).click();
    const detail = page.getByTestId('registry-detail');

    await detail.getByRole('button', { name: 'Disable' }).click();
    await expect(page.getByText('Disabled Tasks')).toBeVisible();
    await expect(detail.getByText('disabled')).toBeVisible();
    await detail.getByRole('button', { name: 'Enable' }).click();
    await expect(page.getByText('Enabled Tasks')).toBeVisible();
    await detail.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Removed Tasks')).toBeVisible();
    await expect(detail.getByText('installable')).toBeVisible();
    await detail.getByRole('button', { name: 'Install' }).click();
    await expect(page.getByText('Installed Tasks')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Use' })).toBeVisible();
  });

  test('sidebar shows Registry nav item', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Registry' })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('skill cards open preview details before explicit install', async ({
    page,
  }) => {
    const { installCalls } = await mockRegistry(page);
    await page.goto('/registry');
    await page.waitForSelector('.page__tab', { timeout: 15_000 });

    await forceClick(page, '.page__tab:has-text("Skills")');
    await page.getByRole('button', { name: /Prompt Toolkit/i }).click();

    await expect(page.getByTestId('registry-detail')).toContainText(
      'Prompt Toolkit',
    );
    await expect(page.getByTestId('registry-detail')).toContainText(
      'Starter prompts and helpers',
    );
    await expect(installCalls).toHaveLength(0);

    await page
      .getByTestId('registry-detail')
      .getByRole('button', { name: /Install to workspace/i })
      .click();
    await expect.poll(() => installCalls.length).toBe(1);
  });

  test('registry tabs install, remove, search, and surface action failures', async ({
    page,
  }) => {
    await mockRegistry(page);
    await page.goto('/registry');
    await page.waitForSelector('.page__tab', { timeout: 15_000 });

    const cases = [
      {
        tab: 'Agents',
        item: 'Project Planner',
        install: 'Install',
        remove: 'Remove',
      },
      {
        tab: 'Skills',
        item: 'Prompt Toolkit',
        install: 'Install to workspace',
        remove: 'Remove from workspace',
      },
      {
        tab: 'Integrations',
        item: 'Slack Notifier',
        install: 'Install',
        remove: 'Remove',
      },
      {
        tab: 'Plugins',
        item: 'Demo Layout',
        install: 'Install',
        remove: 'Remove',
      },
    ];

    for (const entry of cases) {
      await page.locator('.page__tab', { hasText: entry.tab }).click();
      await expect(page.getByTestId('registry-detail')).toContainText(
        entry.item,
      );
      await page
        .getByLabel(new RegExp(`Search ${entry.tab.toLowerCase()}`))
        .fill('no-match');
      await expect(
        page.getByText(
          `Nothing in ${entry.tab.toLowerCase()} matches “no-match”`,
        ),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Clear filter' }),
      ).toBeVisible();
      await page
        .getByLabel(new RegExp(`Search ${entry.tab.toLowerCase()}`))
        .fill('');
      await expect(page.getByTestId('registry-detail')).toContainText(
        entry.item,
      );

      await page
        .getByTestId('registry-detail')
        .getByRole('button', { name: entry.install })
        .click();
      await expect(page.getByText(`Installed ${entry.item}`)).toBeVisible();
      await expect(
        page
          .getByTestId('registry-detail')
          .getByText('Installed', { exact: true }),
      ).toBeVisible();
      await page
        .getByTestId('registry-detail')
        .getByRole('button', { name: entry.remove })
        .click();
      await expect(page.getByText(`Removed ${entry.item}`)).toBeVisible();
      await expect(
        page.getByTestId('registry-detail').getByText('Available'),
      ).toBeVisible();
    }

    await page.locator('.page__tab', { hasText: 'Integrations' }).click();
    await page.getByRole('button', { name: /Broken Integration/ }).click();
    await page
      .getByTestId('registry-detail')
      .getByRole('button', { name: 'Install' })
      .click();
    await expect(page.getByText('Install blocked by policy')).toBeVisible();
  });
});

test('registry actions do not overlap at phone widths', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );
  await mockRegistry(page);
  await page.route('**/api/system/status', (route) =>
    route.fulfill({
      json: {
        ready: true,
        acp: { connected: false, connections: [] },
        providers: { configuredChatReady: true, configured: [], detected: {} },
        capabilities: {
          chat: { ready: true },
          runtime: { ready: false },
          knowledge: { ready: false },
          acp: { ready: false },
        },
      },
    }),
  );
  await page.goto('/registry');
  await dismissSetupLauncher(page);

  const tabs = page.locator('.registry-view .page__tab');
  await expect(tabs).toHaveCount(6);
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const boxes = await tabs.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
        };
      }),
    );
    for (const box of boxes)
      expect(box.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        const a = boxes[left];
        const b = boxes[right];
        const overlaps =
          a.left < b.right &&
          a.right > b.left &&
          a.top < b.bottom &&
          a.bottom > b.top;
        expect(overlaps).toBe(false);
      }
    }
    const clippedCatalogElements = await page
      .locator(
        '.registry-view .page__card-loose, .registry-view .page__card-footer button',
      )
      .evaluateAll(
        (elements) =>
          elements.filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left < 0 || rect.right > window.innerWidth;
          }).length,
      );
    expect(clippedCatalogElements).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});
