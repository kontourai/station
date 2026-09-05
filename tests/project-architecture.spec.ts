/**
 * E2E: Project Architecture
 *
 * Verifies the project-centric UI: sidebar, project CRUD, layout navigation,
 * provider settings, and coding layout rendering.
 *
 * Uses page.route to mock API responses for isolation from backend state.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  CODING_STARTER_CATALOG,
  ORGANIZATION_LAYOUT_CATALOG,
} from './fixtures/project-layout-catalog';

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

const SEED_STORAGE = `
  window.localStorage.setItem('station-connect-connections', JSON.stringify([
    { id: 'c1', name: 'Dev Server', url: window.location.origin, lastConnected: Date.now() }
  ]));
  window.localStorage.setItem('station-connect-connections-active', 'c1');
`;

const TEST_PROJECTS = [
  {
    id: 'p1',
    slug: 'alpha',
    name: 'Alpha',
    icon: '🚀',
    description: 'First project',
    hasWorkingDirectory: false,
    layoutCount: 1,
    hasKnowledge: false,
  },
];

const ALPHA_LAYOUTS = [
  {
    id: 'l1',
    slug: 'chat',
    projectSlug: 'alpha',
    type: 'chat',
    name: 'Chat',
    icon: '💬',
  },
];

const ALPHA_CONFIG = {
  id: 'p1',
  slug: 'alpha',
  name: 'Alpha',
  icon: '🚀',
  description: 'First project',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const CHAT_LAYOUT = {
  id: 'l1',
  slug: 'chat',
  projectSlug: 'alpha',
  type: 'chat',
  name: 'Chat',
  icon: '💬',
  config: {
    tabs: [{ id: 'main', label: 'Chat', component: 'chat' }],
    globalSkills: [],
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const PROVIDERS = [
  {
    id: 'prov1',
    type: 'ollama',
    name: 'Local Ollama',
    config: { baseUrl: 'http://localhost:11434' },
    enabled: true,
    capabilities: ['llm'],
  },
];

function seedRoutes(page: import('@playwright/test').Page) {
  return Promise.all([
    page.addInitScript(SEED_STORAGE),
    page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    ),
    page.route('**/api/projects', (r) => {
      if (r.request().method() === 'GET')
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: TEST_PROJECTS }),
        });
      // POST — create project
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { ...ALPHA_CONFIG, slug: 'new-project', name: 'New Project' },
        }),
      });
    }),
    page.route('**/api/projects/icon-candidates**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/projects/alpha', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: ALPHA_CONFIG }),
      }),
    ),
    page.route('**/api/projects/alpha/layouts', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: ALPHA_LAYOUTS }),
      }),
    ),
    page.route('**/api/projects/alpha/layouts/chat', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CHAT_LAYOUT }),
      }),
    ),
    page.route('**/api/providers', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: PROVIDERS }),
      }),
    ),
    page.route('**/api/agents', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/layouts', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/plugins', (r) =>
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
        body: JSON.stringify({ success: true, data: {} }),
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
    page.route('**/api/models/**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/fs/browse**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { path: '/tmp/new-project', entries: [] },
        }),
      }),
    ),
    page.route('**/api/coding/repos**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            workspace: '/tmp/new-project',
            workspaceIsRepo: false,
            repos: [],
          },
        }),
      }),
    ),
  ]);
}

/**
 * The project row also exposes an expand/collapse chevron whose own
 * accessible name contains the project name (e.g. "Expand Alpha layouts",
 * archive#1629). Target the row's project-navigation button by its full
 * accessible name (icon + name) so a non-exact match doesn't also resolve
 * that chevron.
 */
function alphaProjectButton(page: Page) {
  return page.getByRole('button', { name: '🚀 Alpha', exact: true });
}

async function openCustomizationNavigation(page: Page) {
  const navigation = page.getByRole('navigation', {
    name: 'Primary navigation',
  });
  const customize = navigation.getByRole('button', {
    name: 'Customize',
    exact: true,
  });
  if ((await customize.getAttribute('aria-expanded')) !== 'true') {
    await customize.click();
  }
  await expect(customize).toHaveAttribute('aria-expanded', 'true');
  return navigation;
}

/**
 * station#4460 consolidated the old per-occupant `.dock-slot` /
 * `.dock-slot__header` markup into one shared `#chat-dock` shell
 * (`aria-label="Dock"`) — `.dock-slot` no longer renders anywhere (see
 * `DockShell.tsx` and `dock-bottom-clearance.test.ts`). The occupant is
 * identified by the header's occupant-picker trigger, whose accessible name
 * is `Docked pane: <name>` (#1046, matching dock-occupant-picker.spec.ts).
 */
function dockOccupantTrigger(page: Page, name: string) {
  return page
    .locator('#chat-dock')
    .getByRole('button', { name: `Docked pane: ${name}` });
}

test.describe('Project Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
    await page.goto('/');
    // The sidebar now ships expanded, so project names are visible immediately.
    await expect(alphaProjectButton(page)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('sidebar renders with projects and nav items', async ({ page }) => {
    await expect(alphaProjectButton(page)).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByRole('button', { name: /New Project/ }),
    ).toBeVisible();
    const navigation = await openCustomizationNavigation(page);
    await expect(
      navigation.getByRole('button', { name: 'Agents', exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole('button', {
        name: 'Connections',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('the fullscreen chat layout publishes no dock-slot clearance', async ({
    page,
  }) => {
    // archive#3972. `--dock-slot-size` is the shell's ONE clearance
    // derivation: every route reserves space for whatever it says. A
    // fullscreen chat pane is INSIDE the layout, not over it, so it has
    // nothing to clear — and when it published anyway, this route reserved
    // 320px for a dock that is not on screen.
    //
    // Asserted at the route rather than at the hook: the hook's own tests pass
    // the flag explicitly, so they cannot catch the call site passing the
    // wrong one, which is the mistake that produced the defect.
    await page.route('**/api/projects/alpha/layouts', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: ALPHA_LAYOUTS }),
      }),
    );
    await page.goto('/projects/alpha/layouts/chat');
    await expect(
      page.getByRole('button', { name: 'Switch layout' }),
    ).toBeVisible({ timeout: 10_000 });

    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--dock-slot-size')
          .trim(),
      ),
      'the fullscreen chat pane must not reserve route space for an absent dock',
    ).toBe('');
  });

  test('header shows a layout switcher on a layout view', async ({ page }) => {
    // Override the seedRoutes catch-all `**/layouts` (→ []) so the switcher's
    // project-layouts query resolves to the real list (last route wins).
    await page.route('**/api/projects/alpha/layouts', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: ALPHA_LAYOUTS }),
      }),
    );
    await page.goto('/projects/alpha/layouts/chat');
    // The breadcrumb's layout segment is now a switcher dropdown. Target it
    // directly — a layout view renders two `banner` headers (app toolbar +
    // workspace tab header), so a bare getByRole('banner') is ambiguous.
    const switcher = page.getByRole('button', { name: 'Switch layout' });
    await expect(switcher).toBeVisible({ timeout: 10_000 });
    await switcher.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Chat/ })).toBeVisible();
  });

  test('project page shows layout affordances', async ({ page }) => {
    await alphaProjectButton(page).click();
    await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
    // `+ Add` became `+ Add layout` once `+ Add pane` joined it, and both live
    // in the Open section header (`src-ui/src/views/ProjectPage.tsx`). `exact`
    // stays because these are the only two add affordances the section has:
    // #1536 E4 dropped the layouts empty state's duplicate `Add layout` button
    // when embedded, so a loose matcher would now be ambiguous only if that
    // duplicate came back.
    await expect(
      page.getByRole('button', { name: '+ Add layout', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '+ Add pane', exact: true }),
    ).toBeVisible();
  });

  test('browser Back dismisses the layout picker without leaving the project', async ({
    page,
  }) => {
    await alphaProjectButton(page).click();
    await page
      .getByRole('button', { name: '+ Add layout', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add Layout' });
    await expect(dialog).toBeVisible();
    const projectUrl = page.url();

    await page.goBack();

    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(projectUrl);
    await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
  });

  test('layout picker does not invent a starter while the catalog loads', async ({
    page,
  }) => {
    await page.route('**/api/projects/layouts/available', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      });
    });

    await alphaProjectButton(page).click();
    await page
      .getByRole('button', { name: '+ Add layout', exact: true })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Add Layout' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Coding/ })).toHaveCount(0);
    await expect(
      dialog.getByRole('status', { name: 'Loading more layouts' }),
    ).toBeVisible();
  });

  test('failed layout catalog remains stable, bounded, and recoverable', async ({
    page,
  }) => {
    let catalogRequests = 0;
    let catalogAvailable = false;
    await page.route('**/api/projects/layouts/available', (route) => {
      catalogRequests += 1;
      return catalogAvailable
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: CODING_STARTER_CATALOG,
            }),
          })
        : route.fulfill({ status: 503, body: 'catalog unavailable' });
    });
    await alphaProjectButton(page).click();

    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      if (width === 320) {
        await page
          .getByRole('button', { name: '+ Add layout', exact: true })
          .click();
      }
      const dialog = page.getByRole('dialog', { name: 'Add Layout' });
      await expect(dialog.getByRole('button', { name: /Coding/ })).toHaveCount(
        0,
      );
      await expect(dialog.getByRole('alert')).toContainText(
        "Couldn't load layouts",
        { timeout: 10_000 },
      );
      await expect(
        dialog.getByRole('button', { name: 'Retry now' }),
      ).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? width)).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }

    const dialog = page.getByRole('dialog', { name: 'Add Layout' });
    expect(catalogRequests).toBe(4);
    catalogAvailable = true;
    await dialog.getByRole('button', { name: 'Retry now' }).click();
    await expect(dialog.getByRole('button', { name: /Coding/ })).toBeVisible({
      timeout: 5_000,
    });
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    const requestsAfterClose = catalogRequests;
    // Proving the absence of the former timer-driven request requires
    // observing beyond one full legacy refresh interval. This is not used to
    // drive UI state: the recovery assertion above remains event-driven.
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect(catalogRequests).toBe(requestsAfterClose);
  });

  test('standard catalog applies the shared Coding starter in one tap', async ({
    page,
  }) => {
    let appliedLayoutBody: Record<string, unknown> | null = null;
    await page.route('**/api/projects/layouts/available', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: CODING_STARTER_CATALOG,
        }),
      }),
    );
    await page.route('**/api/projects/alpha/layouts/apply', async (route) => {
      if (route.request().method() === 'POST') {
        appliedLayoutBody = route.request().postDataJSON();
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { slug: 'coding', type: 'coding' },
          }),
        });
      }
      return route.fallback();
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/projects/alpha');
    await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
    await page
      .getByRole('button', { name: '+ Add layout', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Add Layout' })
      .getByRole('button', { name: /Coding/ })
      .click();

    await expect
      .poll(() => appliedLayoutBody)
      .toMatchObject({ layoutId: 'builtin:coding' });
    await expect(page.getByRole('dialog', { name: 'Add Layout' })).toHaveCount(
      0,
    );
  });
});

test.describe('Project Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
    await page.goto('/');
    // The sidebar now ships expanded, so project names are visible immediately.
    await expect(alphaProjectButton(page)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('clicking project navigates to project view', async ({ page }) => {
    await alphaProjectButton(page).click();
    await expect(page).toHaveURL(/\/projects\/alpha/);
    await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
  });

  test('clicking layout navigates to layout view', async ({ page }) => {
    await page.goto('/projects/alpha/layouts/chat');
    await expect(page).toHaveURL(/\/projects\/alpha\/layouts\/chat/);
    await expect(page.locator('.chat-dock')).toBeVisible();
  });

  test('new project form renders', async ({ page }) => {
    await page
      .getByRole('button', { name: /New Project/ })
      .dispatchEvent('click');
    await expect(page).toHaveURL(/\/projects\/new/);
    await expect(page.getByPlaceholder('My Project')).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.getByRole('button', { name: 'Create', exact: true }),
    ).toBeVisible();
  });

  test('layout browser preserves the draft, supports back and close, and restores focus', async ({
    page,
  }) => {
    await page.route('**/api/projects/layouts/available', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: ORGANIZATION_LAYOUT_CATALOG,
        }),
      }),
    );

    await page.goto('/projects/new');
    await page.getByPlaceholder('My Project').fill('Delivery notes');
    await page.getByPlaceholder('/path/to/project').fill('/tmp/delivery-notes');
    const browse = page.getByRole('button', { name: 'Browse all' });
    await browse.click();
    const browser = page.getByRole('dialog', {
      name: 'Browse installed layouts',
    });
    await expect(browser).toBeVisible();
    await expect(
      browser.getByText('Organization delivery receipt layout.'),
    ).toBeVisible();

    await browser.getByRole('button', { name: 'Back to project' }).click();
    await expect(browser).toHaveCount(0);
    await expect(page.getByPlaceholder('My Project')).toHaveValue(
      'Delivery notes',
    );
    await expect(page.getByPlaceholder('/path/to/project')).toHaveValue(
      '/tmp/delivery-notes',
    );
    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeFocused();

    await browse.click();
    await browser.getByRole('button', { name: 'Close layout browser' }).click();
    await expect(browser).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeFocused();
  });

  test('creating a project applies the recommended server-owned Coding layout', async ({
    page,
  }) => {
    let createdLayoutBody: unknown = null;
    await page.route('**/api/projects/layouts/available', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CODING_STARTER_CATALOG }),
      }),
    );
    await page.route('**/api/coding/repos**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            workspace: '/tmp/new-project',
            workspaceIsRepo: true,
            repos: [{ root: '/tmp/new-project', name: 'new-project' }],
          },
        }),
      }),
    );
    await page.route('**/api/projects/new-project/layouts/apply', (route) => {
      createdLayoutBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { slug: 'coding' } }),
      });
    });

    await page.goto('/projects/new');
    await page.getByPlaceholder('My Project').fill('New Project');
    await page.getByPlaceholder('/path/to/project').fill('/tmp/new-project/');
    await expect(
      page.getByText('Recommended for this Git directory'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Coding/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect
      .poll(() => createdLayoutBody)
      .toMatchObject({ layoutId: 'builtin:coding' });
  });

  test('Git-aware coding setup stays contained on phone and preserves an explicit opt-out', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let layoutPosts = 0;
    await page.route('**/api/projects/layouts/available', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CODING_STARTER_CATALOG }),
      }),
    );
    await page.route('**/api/coding/repos**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            workspace: '/tmp/git-workspace',
            workspaceIsRepo: true,
            repos: [{ root: '/tmp/git-workspace', name: 'git-workspace' }],
          },
        }),
      }),
    );
    await page.route('**/api/projects/new-project/layouts/apply', (route) => {
      layoutPosts += 1;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { slug: 'coding' } }),
      });
    });

    await page.goto('/projects/new');
    await page.getByPlaceholder('My Project').fill('New Project');
    await page.getByPlaceholder('/path/to/project').fill('/tmp/git-workspace/');
    const identityIcon = page.getByRole('button', {
      name: 'Choose project icon',
    });
    const identityName = page.getByLabel('Project identity');
    await expect(identityIcon).toBeVisible();
    await expect(identityName).toBeVisible();
    await expect
      .poll(async () => (await identityIcon.boundingBox())?.width ?? 0)
      .toBe(44);
    await expect
      .poll(async () => (await identityName.boundingBox())?.width ?? 0)
      .toBeGreaterThan(240);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    const noLayout = page.getByRole('button', {
      name: /Start without a layout/,
    });
    await noLayout.click();
    await expect(noLayout).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/new-project$/);
    expect(layoutPosts).toBe(0);
  });

  /**
   * #1536 E4. This used to type a path with no trailing slash and assert that
   * Coding was applied — while the modal still showed "Start without a layout"
   * as the pressed option, because the recommendation was resolved at SUBMIT
   * and never rendered. Repo discovery is now gated on the SHAPE of the typed
   * path (idle-settled), so the recommendation appears first and Create applies
   * exactly what the picker shows.
   */
  test('a manually typed path shows the Git recommendation, and Create applies what is shown', async ({
    page,
  }) => {
    let createdLayoutBody: unknown = null;
    await page.route('**/api/projects/layouts/available', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CODING_STARTER_CATALOG }),
      }),
    );
    await page.route('**/api/coding/repos**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            workspace: '/tmp/typed-workspace',
            workspaceIsRepo: true,
            repos: [{ root: '/tmp/typed-workspace', name: 'typed-workspace' }],
          },
        }),
      }),
    );
    // `seedRoutes`' POST /api/projects answers `slug: 'new-project'` whatever
    // the body says, and the submission applies the starter to the slug the
    // SERVER returned (`useNewProjectSubmit` uses `created.slug`, because a
    // server may suffix a colliding slug). Routing this at the typed name would
    // never match, and `createdLayoutBody` would stay null for a submission
    // that applied the layout correctly.
    await page.route('**/api/projects/new-project/layouts/apply', (route) => {
      createdLayoutBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { slug: 'coding' } }),
      });
    });

    await page.goto('/projects/new');
    await page.getByPlaceholder('My Project').fill('Typed Workspace');
    // No trailing slash: the shape a user who pastes a path actually types.
    await page
      .getByPlaceholder('/path/to/project')
      .fill('/tmp/typed-workspace');

    // The recommendation is ON SCREEN before anything is created.
    await expect(
      page.getByText('Recommended for this Git directory'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Coding/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.getByRole('button', { name: /Start without a layout/ }),
    ).toHaveAttribute('aria-pressed', 'false');

    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect
      .poll(() => createdLayoutBody)
      .toMatchObject({ layoutId: 'builtin:coding' });
  });

  /**
   * The other half of the same contract, and the E4 report itself: declining
   * the recommendation that is now visible must create no layout at all.
   */
  test('declining the recommendation for a typed path creates no layout', async ({
    page,
  }) => {
    let layoutPosts = 0;
    await page.route('**/api/projects/layouts/available', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CODING_STARTER_CATALOG }),
      }),
    );
    await page.route('**/api/coding/repos**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            workspace: '/tmp/typed-workspace',
            workspaceIsRepo: true,
            repos: [{ root: '/tmp/typed-workspace', name: 'typed-workspace' }],
          },
        }),
      }),
    );
    // The slug the seeded create route returns — see the note in the test
    // above. Pointed anywhere else, `layoutPosts` counts a route that can
    // never be hit and the assertion below passes without proving anything.
    await page.route('**/api/projects/new-project/layouts/apply', (route) => {
      layoutPosts += 1;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { slug: 'coding' } }),
      });
    });

    await page.goto('/projects/new');
    await page.getByPlaceholder('My Project').fill('Typed Workspace');
    await page
      .getByPlaceholder('/path/to/project')
      .fill('/tmp/typed-workspace');

    const noLayout = page.getByRole('button', {
      name: /Start without a layout/,
    });
    // Wait for the recommendation to arrive before declining it, so this
    // cannot pass merely by racing the discovery it is meant to override.
    await expect(page.getByRole('button', { name: /Coding/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await noLayout.click();
    await expect(noLayout).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Create', exact: true }).click();
    // Created, navigated, and no starter applied. The slug is the server's.
    await expect(page).toHaveURL(/\/projects\/new-project$/);
    expect(layoutPosts).toBe(0);
  });
});

test.describe('Provider Settings', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
    await page.goto('/');
    // The sidebar now ships expanded, so project names are visible immediately.
    await expect(alphaProjectButton(page)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('connections view renders', async ({ page }) => {
    const navigation = await openCustomizationNavigation(page);
    await navigation
      .getByRole('button', { name: 'Connections', exact: true })
      .click();
    await expect(page).toHaveURL(/\/connections/);
    await expect(
      page.getByRole('heading', { name: 'Connections', exact: true }),
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe('ChatDock', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
    await page.goto('/');
    // archive#1064 removed the "Chat Dock" label; the dock is identified by its own
    // container now, which is what these tests actually care about.
    await expect(page.locator('.chat-dock')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('chat dock is visible at bottom', async ({ page }) => {
    await expect(page.locator('.chat-dock')).toBeVisible();
    // The dock counter shows a session count, or invites a chat when empty.
    // Scoped to the dock: the Home empty state carries similar copy, which
    // made the unscoped matcher ambiguous under strict mode.
    await expect(
      page.locator('.chat-dock').getByText(/Start a chat|\d+ session/),
    ).toBeVisible();
  });

  test('the ambient dock host adds no element between the shell and the dock', async ({
    page,
  }) => {
    // archive#3973. The dock renders THROUGH a chromeless WorkspacePaneHost
    // now, and the whole point of chromeless is that you cannot tell from the
    // DOM: the shell positions the dock with child combinators
    // (`.app__main > [data-region="left"]`, `:has(> [data-region])`), so one
    // wrapper node is enough to un-place it — which is exactly what happened,
    // and the desktop dock measured x=0.
    await expect(
      page.locator('.workspace-pane-host', { has: page.locator('.chat-dock') }),
      'the chromeless host must contribute no element around the dock',
    ).toHaveCount(0);
    await expect(
      page.locator('.chat-dock').getByRole('tablist'),
      'a chromeless host has no tab strip',
    ).toHaveCount(0);
    // And the dock is still where the shell put it: a DIRECT child of the
    // main region, which is what those combinators require.
    expect(
      await page.evaluate(() => {
        const dock = document.querySelector('.chat-dock');
        return dock?.parentElement?.className ?? null;
      }),
      'the dock must remain a direct child of the shell main region',
    ).toMatch(/app__main/);
  });

  // Removed in archive#3929 (the affordance had nowhere to appear and the
  // spec timed out); back with archive#4090 / epic archive#4142 M2: `/` is
  // the standalone placement of the Home pane occurrence, so
  // `#station-main` now carries a real 'Dock this pane'.
  test('docks Home through the ambient document and returns the same dock slot to Chat', async ({
    page,
  }) => {
    await page
      .locator('#station-main')
      .getByRole('button', { name: 'Dock this pane' })
      .click();
    await expect(dockOccupantTrigger(page, 'Home')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem(
            'station:workspace-pane-host:v2:ambient:chat-dock',
          ),
        ),
      )
      .toContain('pane:builtin:home');
    await page.reload();
    await expect(dockOccupantTrigger(page, 'Home')).toBeVisible();
    // M5: the fixed header "return to Chat" action is gone — the header's
    // occupant picker replaces the occupant, Chat as one entry of the list.
    await dockOccupantTrigger(page, 'Home').click();
    await page
      .getByRole('menu', { name: 'Docked pane' })
      .getByRole('menuitemradio', { name: 'Chat' })
      .click();
    await expect(page.locator('.chat-dock')).toBeVisible();
    await expect(
      dockOccupantTrigger(page, 'Chat'),
      'returning to Chat must restore the ambient slot to the Chat occupant',
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.querySelector('.chat-dock')?.parentElement?.className,
      ),
      'returning to Chat must keep it a direct shell child',
    ).toMatch(/app__main/);
  });
});

test.describe('Ambient chat dock host at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
    await page.goto('/');
    await expect(page.locator('.chat-dock')).toBeVisible({ timeout: 10_000 });
  });

  test('keeps the hosted dock reachable without horizontal scroll', async ({
    page,
  }) => {
    await expect(
      page.locator('.workspace-pane-host', { has: page.locator('.chat-dock') }),
      'the chromeless host must contribute no element around the dock',
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'the ambient dock host must not push the phone document sideways',
    ).toBe(true);
    const header = page.locator('[data-testid="chat-dock-mobile-header"]');
    await expect(header).toBeVisible();
    const bounds = await header.boundingBox();
    expect(
      bounds?.height,
      'the dock header remains the touched primary control',
    ).toBeGreaterThanOrEqual(44);
  });

  // The phone half of the same journey — removed in archive#3929, back with
  // archive#4090 / epic archive#4142 M2 for the same reason as the desktop
  // half above.
  //
  // `#station-main`'s "Dock this pane" button (`WorkspacePaneDockAction`,
  // `.home-view__top-actions`) is hidden by `HomeView.css` at
  // `max-width: 1024px` by design — "Docking is desktop composition. At
  // phone/tablet widths the ambient dock already owns the mobile pane
  // picker/maximize contract" — so at 390x844 it never appears, at any load
  // (proven 6/6 at 10s and 20s timeouts in dock-occupant-picker.spec.ts,
  // #1046/#1060). Dock Home through that mobile contract instead: the Chat
  // mobile header's "⋯" overflow sheet (station#520/#524).
  test('keeps a docked Home pane within the phone viewport', async ({
    page,
  }) => {
    const overflowTrigger = page.getByRole('button', { name: 'Chat actions' });
    await expect(overflowTrigger).toBeVisible({ timeout: 15_000 });
    await overflowTrigger.click();
    await page.getByRole('menuitem', { name: 'Switch to Home' }).click();
    await expect(dockOccupantTrigger(page, 'Home')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'a docked non-chat pane must not push the phone document sideways',
    ).toBe(true);
    // M5: the header affordance is the occupant picker now.
    const action = dockOccupantTrigger(page, 'Home');
    const bounds = await action.boundingBox();
    expect(
      bounds?.height,
      'the occupant picker trigger must be a 44px tap target',
    ).toBeGreaterThanOrEqual(44);
  });
});
