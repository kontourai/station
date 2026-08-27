import { expect, type Page, test } from '@playwright/test';
import { STARTER_CATALOG } from './fixtures/project-layout-catalog';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';
import { installVisualViewportFixture } from './helpers/visual-viewport';

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedProjectFormRoutes(page: Page) {
  const state = {
    projects: [] as Array<{
      id: string;
      slug: string;
      name: string;
      workingDirectory?: string;
      layouts: unknown[];
    }>,
  };

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/system/status') {
      await route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
        }),
      );
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

    if (path === '/api/auth/status') {
      await route.fulfill(json({ authenticated: true, user: null }));
      return;
    }

    if (path === '/api/branding') {
      await route.fulfill(json({ success: true, data: {} }));
      return;
    }

    if (path === '/api/projects' && method === 'GET') {
      await route.fulfill(json({ success: true, data: state.projects }));
      return;
    }

    if (path === '/api/projects' && method === 'POST') {
      const body = route.request().postDataJSON() as {
        name: string;
        slug: string;
        workingDirectory?: string;
      };
      const project = {
        id: `p-${body.slug}`,
        slug: body.slug,
        name: body.name,
        workingDirectory: body.workingDirectory,
        layouts: [],
      };
      state.projects.push(project);
      await route.fulfill(json({ success: true, data: project }, 201));
      return;
    }

    if (path === '/api/projects/demo' && method === 'GET') {
      await route.fulfill(
        json({
          success: true,
          data: {
            id: 'p-demo',
            slug: 'demo',
            name: 'Demo Project',
            hasWorkingDirectory: false,
            layoutCount: 0,
            hasKnowledge: false,
            createdAt: '2026-07-13T00:00:00.000Z',
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
        }),
      );
      return;
    }

    const projectDetailMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectDetailMatch && method === 'GET') {
      const project = state.projects.find(
        (entry) => entry.slug === projectDetailMatch[1],
      );
      if (!project) {
        await route.fulfill(json({ success: false, error: 'Not found' }, 404));
        return;
      }
      await route.fulfill(
        json({
          success: true,
          data: {
            ...project,
            hasWorkingDirectory: Boolean(project.workingDirectory),
            layoutCount: 0,
            hasKnowledge: false,
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-20T00:00:00.000Z',
          },
        }),
      );
      return;
    }

    if (path === '/api/templates') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }

    if (path === '/api/fs/browse') {
      await route.fulfill(
        json({
          success: true,
          data: {
            path: '/tmp',
            entries: [{ name: 'demo', isDirectory: true }],
          },
        }),
      );
      return;
    }

    if (path === '/api/coding/repos') {
      await route.fulfill(
        json({
          success: true,
          data: {
            workspace: url.searchParams.get('path') ?? '',
            workspaceIsRepo: false,
            repos: [],
          },
        }),
      );
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });
}

async function fillStable(page: Page, selector: string, value: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const locator = page.locator(selector).first();
    try {
      await locator.fill(value, { timeout: 1_000 });
      if ((await locator.inputValue().catch(() => '')) === value) {
        return;
      }
    } catch {}
    await locator.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {});
  }

  throw new Error(`Failed to fill stable input: ${selector}`);
}

test.describe('Project forms', () => {
  test.beforeEach(async ({ page }) => {
    await seedProjectFormRoutes(page);
  });

  test('new project prioritizes working directory and derives the name from the path leaf', async ({
    page,
  }) => {
    const nonexistentProjectRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/projects/new') {
        nonexistentProjectRequests.push(request.url());
      }
    });
    await page.goto('/projects/new');

    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeVisible();
    await expect.poll(() => nonexistentProjectRequests).toEqual([]);

    await fillStable(page, 'input[placeholder="/path/to/project"]', '/tmp');

    const nameInput = page.locator('input[placeholder="My Project"]');
    await expect(nameInput).toHaveValue('Tmp');

    await fillStable(page, 'input[placeholder="My Project"]', 'Launchpad');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(page).toHaveURL(/\/projects\/launchpad$/);
    expect(nonexistentProjectRequests).toEqual([]);
  });

  test('project detail and edit routes retain the intended project context', async ({
    page,
  }) => {
    const projectRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.match(/^\/api\/projects\/[^/]+$/)) {
        projectRequests.push(path);
      }
    });

    await page.goto('/projects/demo');
    await expect(
      page.getByRole('heading', { name: 'Demo Project' }),
    ).toBeVisible();
    await page.goto('/projects/demo/edit');
    await expect(page.locator('.project-settings__name-input')).toHaveValue(
      'Demo Project',
    );

    expect(projectRequests.length).toBeGreaterThanOrEqual(2);
    expect(projectRequests.every((path) => path === '/api/projects/demo')).toBe(
      true,
    );
  });

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    test(`new project keeps actions reachable with a mobile keyboard at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.emulateMedia({
        colorScheme: viewport.width === 320 ? 'light' : 'dark',
        reducedMotion: viewport.width === 320 ? 'reduce' : 'no-preference',
      });
      await page.setViewportSize(viewport);
      await installVisualViewportFixture(page);
      await page.addInitScript(() => {
        localStorage.setItem(
          'recentLayouts',
          JSON.stringify(['plugin:planning-board']),
        );
      });
      await page.route('**/api/projects/layouts/available', (route) =>
        route.fulfill(json({ success: true, data: STARTER_CATALOG })),
      );
      await page.goto('/projects/new');

      await page.evaluate(() => {
        (
          window as Window & {
            __setTestVisualViewport?: (height: number) => void;
          }
        ).__setTestVisualViewport?.(360);
      });

      const overlay = page.locator('.responsive-surface-overlay');
      await expect(overlay).toHaveCSS('height', '360px');
      await expect(overlay).toHaveCSS('overflow', 'hidden');

      await page.getByPlaceholder('My Project').fill('Keyboard-safe project');
      await page
        .getByPlaceholder('/path/to/project')
        .fill('/tmp/keyboard-safe');
      await expect(page.getByText('Recent on this device')).toBeVisible();
      await page.getByRole('button', { name: 'Browse all' }).click();
      const browser = page.getByRole('dialog', {
        name: 'Browse installed layouts',
      });
      await expect(browser).toBeVisible();
      const browserBox = await browser.boundingBox();
      expect(browserBox?.height).toBeLessThanOrEqual(360);
      expect(browserBox?.x).toBeGreaterThanOrEqual(0);
      expect(
        (browserBox?.x ?? 0) + (browserBox?.width ?? 0),
      ).toBeLessThanOrEqual(viewport.width);
      await browser.getByRole('button', { name: /Planning board/ }).click();
      await expect(browser).toHaveCount(0);
      await expect(page.getByPlaceholder('My Project')).toHaveValue(
        'Keyboard-safe project',
      );
      await expect(page.getByPlaceholder('/path/to/project')).toHaveValue(
        '/tmp/keyboard-safe',
      );

      if (viewport.width === 390) {
        const directory = page.getByPlaceholder('/path/to/project');
        await directory.fill('/tmp/d');
        const option = page.locator('.path-autocomplete__option', {
          hasText: 'demo',
        });
        await expect(option).toBeVisible();
        expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
        await page.getByPlaceholder('My Project').click();
        await expect(option).toBeHidden();
      }

      const create = page.getByRole('button', {
        name: 'Create',
        exact: true,
      });
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport();

      const panelBox = await page
        .getByRole('dialog', { name: 'New Project' })
        .boundingBox();
      expect(panelBox?.height).toBeLessThanOrEqual(360);
      expect(panelBox?.x).toBeGreaterThanOrEqual(0);
      expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width,
      );

      await page.setViewportSize({
        width: viewport.height,
        height: viewport.width,
      });
      await page.evaluate(() => {
        (
          window as Window & {
            __setTestVisualViewport?: (height: number) => void;
          }
        ).__setTestVisualViewport?.(280);
      });
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });
  }
});
