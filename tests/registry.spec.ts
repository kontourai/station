import { expect, type Page, test } from '@playwright/test';
import { DEMO_LAYOUT_PREVIEW } from './fixtures/plugin-preview';
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

  await page.route('**/api/plugins/preview', (route) => {
    const { registryId } = route.request().postDataJSON();
    return route.fulfill({
      json:
        registryId === 'project-planner'
          ? { valid: false, code: 'registry-plugin-not-found' }
          : DEMO_LAYOUT_PREVIEW,
    });
  });
  await page.route('**/api/plugins/reload', (route) =>
    route.fulfill({ json: { success: true } }),
  );

  return { catalog, installCalls, installed, layoutStates };
}

/** The catalogue page's own title, once the app is past the onboarding gate. */
async function catalogueHeading(page: Page, title: string) {
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

// The Registry is no longer a place: the catalogue root and its Plugins tab
// are Apps › Discover, and each other catalogue is a page of its own,
// entered from where its kind is used.
test.describe('Catalogue pages', () => {
  test.beforeEach(async ({ page }) => {
    await mockStationIdentity(page);
  });

  test('each catalogue is its own page, named for what it lists, with no tabs to the others', async ({
    page,
  }) => {
    for (const [path, title, search] of [
      ['/registry/skills', 'Browse skills', 'Search skills'],
      ['/registry/integrations', 'Browse tool servers', 'Search tool servers'],
      ['/registry/layouts', 'Browse layouts', 'Search layouts'],
    ] as const) {
      await page.goto(path);
      await catalogueHeading(page, title);
      await expect(page.getByLabel(search, { exact: true })).toBeVisible();
      await expect(page.getByRole('tablist')).toHaveCount(0);
      await expect(page.getByText('Registry', { exact: true })).toHaveCount(0);
    }
    await page.goto('/registry');
    await expect(page).toHaveURL(/\/apps\/discover$/);
    // Agents arrive inside apps: the agent catalogue is gone, and its old
    // address opens Agents.
    await page.goto('/registry/agents');
    await expect(page).toHaveURL(/\/agents$/);
  });

  test('skills and tool servers are browsed from where they are used, and the eyebrow leads back', async ({
    page,
  }) => {
    await mockRegistry(page);
    await page.goto('/guidance?tab=skills');
    await page
      .getByRole('button', { name: 'Browse skills', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/registry\/skills$/);
    await catalogueHeading(page, 'Browse skills');
    await page.getByRole('link', { name: 'Skills', exact: true }).click();
    await expect(page).toHaveURL(/\/guidance/);

    await page.goto('/customize/tools');
    await page
      .getByRole('button', { name: 'Browse tool servers', exact: true })
      .click();
    await expect(page).toHaveURL(/\/registry\/integrations$/);
    await catalogueHeading(page, 'Browse tool servers');
    await page.getByRole('link', { name: 'Tools', exact: true }).click();
    await expect(page).toHaveURL(/\/customize\/tools$/);
  });

  test('Layouts shows standard Coding and Tasks starters', async ({ page }) => {
    await mockRegistry(page);
    await page.goto('/registry/layouts');
    await catalogueHeading(page, 'Browse layouts');

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
    await catalogueHeading(page, 'Browse layouts');
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

  // #2059: Registry is configuration, so it left the left panel. Its plugin
  // catalogue is Apps › Discover and installed plugins are Apps › Library.
  // Apps is not a Customize item; until it has a sidebar row the command
  // palette is its advertised control, and the old word still finds it. The
  // whole path is walked by pressing, because a fold is exactly the shape
  // that can drop a surface while every individual list still looks complete.
  test('the command palette reaches Apps, and Library steps to Discover', async ({
    page,
  }) => {
    await page.goto('/apps/library');
    const navigation = page.getByRole('navigation', {
      name: 'Primary navigation',
    });
    await expect(navigation).toBeVisible({ timeout: 10_000 });
    await expect(
      navigation.getByRole('button', { name: 'Registry', exact: true }),
    ).toHaveCount(0);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    // The real registered ⌘K shortcut, dispatched on `window` because
    // Chromium swallows a pressed Meta+K on macOS (see command-palette.spec).
    await expect(async () => {
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await expect(palette).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('Plugins');
    await page.getByRole('option', { name: /^Apps/ }).first().click();
    await expect(page).toHaveURL(/\/apps$/);
    await page.getByRole('tab', { name: 'Library', exact: true }).click();
    await expect(page).toHaveURL(/\/apps\/library$/);
    await page.getByRole('tab', { name: 'Discover', exact: true }).click();
    await expect(page).toHaveURL(/\/apps\/discover$/);
  });

  test('skill cards open preview details before explicit install', async ({
    page,
  }) => {
    const { installCalls } = await mockRegistry(page);
    await page.goto('/registry/skills');
    await catalogueHeading(page, 'Browse skills');

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

  test('catalogue pages install, remove, search, and surface action failures', async ({
    page,
  }) => {
    await mockRegistry(page);

    const cases = [
      {
        path: '/registry/skills',
        title: 'Browse skills',
        noun: 'skills',
        item: 'Prompt Toolkit',
        install: 'Install to workspace',
        remove: 'Remove from workspace',
      },
      {
        path: '/registry/integrations',
        title: 'Browse tool servers',
        noun: 'tool servers',
        item: 'Slack Notifier',
        install: 'Install',
        remove: 'Remove',
      },
    ];

    for (const entry of cases) {
      await page.goto(entry.path);
      await catalogueHeading(page, entry.title);
      await expect(page.getByTestId('registry-detail')).toContainText(
        entry.item,
      );
      await page
        .getByLabel(`Search ${entry.noun}`, { exact: true })
        .fill('no-match');
      await expect(
        page.getByText(`Nothing in ${entry.noun} matches “no-match”`),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Clear filter' }),
      ).toBeVisible();
      await page.getByLabel(`Search ${entry.noun}`, { exact: true }).fill('');
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

    await page.goto('/registry/integrations');
    await catalogueHeading(page, 'Browse tool servers');
    await page.getByRole('button', { name: /Broken Integration/ }).click();
    await page
      .getByTestId('registry-detail')
      .getByRole('button', { name: 'Install' })
      .click();
    await expect(page.getByText('Install blocked by policy')).toBeVisible();
  });

  // Registry's Plugins tab is Apps › Discover: the same preview, install and
  // removal, from the app's card.
  test('Discover reviews, installs, searches and removes an app', async ({
    page,
  }) => {
    await mockRegistry(page);
    await page.goto('/registry/plugins');
    await expect(page).toHaveURL(/\/apps\/discover$/);
    const card = page.getByRole('listitem', { name: 'Demo Layout' });
    await expect(card).toBeVisible({ timeout: 15_000 });

    await page.getByLabel('Search apps').fill('no-match');
    await expect(
      page.getByText('Nothing in apps matches “no-match”'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: 'Review Demo Layout' }).click();
    await page.getByRole('button', { name: 'Confirm Install' }).click();
    await expect(page.getByText('Installed Demo Layout')).toBeVisible();
    await expect(card.getByText('Added', { exact: true })).toBeVisible();

    // Remove asks Library's question first; nothing is removed until it is
    // confirmed, and focus lands on the card's Review afterwards.
    await card.getByRole('button', { name: 'Remove Demo Layout' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove plugin' });
    await expect(confirm).toContainText(
      'Remove “Demo Layout” from Station? This cannot be undone.',
    );
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Removed Demo Layout')).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Review Demo Layout' }),
    ).toBeFocused();
  });

  test('Discover keeps every control at the touch floor on a phone', async ({
    page,
  }) => {
    await mockRegistry(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/apps/discover');
    await dismissSetupLauncher(page);
    const moreFilters = page.getByRole('button', { name: /^More filters/ });
    await expect(moreFilters).toBeVisible({ timeout: 15_000 });
    const controls = page.locator(
      '.discover button:visible, .discover input:visible, .discover select:visible',
    );
    const shortControls = async () =>
      controls.evaluateAll(
        (elements, floor) =>
          elements
            .map((element) => ({
              name:
                element.getAttribute('aria-label') ||
                element.textContent?.trim() ||
                element.tagName,
              width: element.getBoundingClientRect().width,
              height: element.getBoundingClientRect().height,
            }))
            .filter(
              (control) => control.width < floor || control.height < floor,
            ),
        MIN_TOUCH_TARGET_PX,
      );
    expect(await shortControls()).toEqual([]);
    await moreFilters.click();
    await expect(moreFilters).toHaveAttribute('aria-expanded', 'true');
    expect(await shortControls()).toEqual([]);
  });
});

test('catalogue pages keep every card inside a phone width', async ({
  page,
}) => {
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
  for (const [path, title] of [
    ['/registry/skills', 'Browse skills'],
    ['/registry/integrations', 'Browse tool servers'],
    ['/registry/layouts', 'Browse layouts'],
  ] as const) {
    await page.goto(path);
    await dismissSetupLauncher(page);
    await catalogueHeading(page, title);
    // No tab strip is left to crowd a phone: each catalogue is its own page.
    await expect(page.getByRole('tablist')).toHaveCount(0);
    // The premise: the page lists cards from the mocked catalogue (the
    // registry routes, registered after the catch-all, answer first), so the
    // clipping check below measures real cards and buttons.
    await expect(
      page.locator('.registry-view .page__card-loose').first(),
    ).toBeVisible();
    await expect(
      page.locator('.registry-view .page__card-footer button').first(),
    ).toBeVisible();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
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
  }
});
