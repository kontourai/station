import { expect, type Page, test } from '@playwright/test';

/**
 * #223/#332 root-route readiness regression coverage (product bucket, mocked
 * via `page.route` — mirrors `tests/knowledge-onboarding.spec.ts` /
 * `tests/project-lifecycle.spec.ts`'s all-mocked-routes style, no live
 * backend). Exercises `resolveHomeSurface`'s (`src-ui/src/app-shell/
 * resolve-home-surface.ts`) tri-state fix end-to-end: `/` must never render
 * Home actions while the projects/layouts queries are still settling,
 * whichever restore priority applies.
 *
 * Detection strategy: rather than only sampling
 * `.new-project-modal__overlay`'s count at poll intervals (the technique
 * `tests/screenshots.spec.ts`'s `assertNoStrayProjectModal` uses, which can
 * miss a flash that mounts and unmounts between two samples), this spec
 * installs a page-side `MutationObserver` (`installModalMountWatcher`
 * below) before navigation so a flash of even a single frame anywhere
 * during the pending window is caught, not just at sampled instants.
 *
 * The settled destination remains `/`; the derived project/layout is exposed
 * only as an explicit Open last project action.
 */

const STATUS_READY = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [
      {
        id: 'root-route-restore-mock-runtime',
        type: 'codex',
        enabled: true,
        capabilities: ['llm'],
      },
    ],
    detected: { ollama: false, bedrock: false },
  },
  capabilities: {
    chat: { ready: true, source: 'root-route-restore-mock-runtime' },
  },
});

interface ProjectFixture {
  id: string;
  slug: string;
  name: string;
}

interface LayoutFixture {
  id: string;
  slug: string;
  name: string;
  type: string;
}

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

/** Node-side delay for a route handler — deliberately not
 * `page.waitForTimeout` (that's a Playwright wait-primitive the repo's
 * product-bucket audit gate flags as an anti-pattern for driving
 * assertions); here it's simulating a slow backend response inside a
 * `page.route` handler, the documented technique for this exact scenario
 * (CLAUDE.md "Playwright tests", plan's AC1 evidence). */
function delay(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

/**
 * Seeds every route the app shell needs for a clean `/` load (system
 * status, agents, config, etc. — all benign empty/ready responses), plus
 * the two data points the #223 race depends on: `GET /api/projects` and
 * `GET /api/projects/:slug/layouts`, each independently delayable to
 * simulate a slow load per the plan's AC1 evidence requirement.
 */
async function mockRootRouteHarness(
  page: Page,
  options: {
    projects: ProjectFixture[];
    layoutsBySlug: Record<string, LayoutFixture[]>;
    projectsDelayMs?: number;
    layoutsDelayMs?: number;
  },
): Promise<void> {
  const {
    projects,
    layoutsBySlug,
    projectsDelayMs = 0,
    layoutsDelayMs = 0,
  } = options;

  await page.route('**/events', (route) => route.abort());
  await page.route('**/config/app', (route) =>
    route.fulfill(
      json({
        success: true,
        data: { defaultModel: 'codex-mini', region: 'us-east-1' },
      }),
    ),
  );

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/system/status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      });
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
      await route.fulfill(json({ authenticated: true }));
      return;
    }
    if (path === '/api/branding') {
      await route.fulfill(json({ success: true, data: {} }));
      return;
    }
    if (path === '/api/config/app') {
      await route.fulfill(
        json({
          success: true,
          data: { defaultModel: 'codex-mini', region: 'us-east-1' },
        }),
      );
      return;
    }
    if (path === '/api/agents') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/orchestration/providers') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }

    if (path === '/api/projects' && method === 'GET') {
      await delay(projectsDelayMs);
      await route.fulfill(json({ success: true, data: projects }));
      return;
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && method === 'GET') {
      const slug = decodeURIComponent(projectMatch[1]);
      const project = projects.find((entry) => entry.slug === slug);
      await route.fulfill(
        project
          ? json({ success: true, data: project })
          : json({ success: false, error: 'Project not found' }, 404),
      );
      return;
    }

    const layoutsMatch = path.match(/^\/api\/projects\/([^/]+)\/layouts$/);
    if (layoutsMatch && method === 'GET') {
      const slug = decodeURIComponent(layoutsMatch[1]);
      await delay(layoutsDelayMs);
      await route.fulfill(
        json({ success: true, data: layoutsBySlug[slug] ?? [] }),
      );
      return;
    }

    // Anything else the shell queries during a `/` load (models,
    // conversations, feedback, knowledge, templates, etc.) — an empty
    // success response is benign for all of these on this route's path.
    await route.fulfill(json({ success: true, data: [] }));
  });
}

/** Installs a `MutationObserver` before navigation so the New Project
 * modal overlay's presence is tracked continuously from first paint,
 * catching a single-frame mount/unmount flash that a poll-at-intervals
 * check could step over. */
async function installModalMountWatcher(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __modalMounted: boolean }).__modalMounted = false;
    const check = () => {
      if (document.querySelector('.new-project-modal__overlay')) {
        (window as unknown as { __modalMounted: boolean }).__modalMounted =
          true;
      }
    };
    const start = () => {
      check();
      new MutationObserver(check).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    };
    if (document.documentElement) {
      start();
    } else {
      document.addEventListener('DOMContentLoaded', start);
    }
  });
}

async function wasModalEverMounted(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __modalMounted: boolean }).__modalMounted,
  );
}

/** Tracks every `history.pushState` target's pathname, so a test can assert
 * `/projects/new` was never pushed onto history — a stronger check than
 * final-URL alone, since it also rules out a transient push-then-replace. */
async function trackPushedPaths(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __pushedPaths: string[] }).__pushedPaths = [];
    const original = window.history.pushState.bind(window.history);
    window.history.pushState = function patchedPushState(
      ...args: Parameters<typeof window.history.pushState>
    ) {
      original(...args);
      (window as unknown as { __pushedPaths: string[] }).__pushedPaths.push(
        window.location.pathname,
      );
    };
  });
}

async function getPushedPaths(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __pushedPaths: string[] }).__pushedPaths ?? [],
  );
}

function homeRouteSkeleton(page: Page) {
  return page.locator('.home-route-skeleton');
}

function newProjectModalOverlay(page: Page) {
  return page.locator('.new-project-modal__overlay');
}

const DEV_PROJECT: ProjectFixture = { id: 'p1', slug: 'dev', name: 'Dev' };
const DEV_LAYOUTS: LayoutFixture[] = [
  { id: 'l1', slug: 'code', name: 'Code', type: 'coding' },
];

test.describe('Root route restore (#223, product, mocked)', () => {
  test('restorable project: no modal flash under a slow load, settles on Home with an explicit continuation', async ({
    page,
  }) => {
    await installModalMountWatcher(page);
    await trackPushedPaths(page);
    await page.addInitScript(() => {
      window.localStorage.setItem('lastProject', 'dev');
      window.localStorage.setItem('lastProjectLayout', 'code');
    });
    await mockRootRouteHarness(page, {
      projects: [DEV_PROJECT],
      layoutsBySlug: { dev: DEV_LAYOUTS },
      projectsDelayMs: 900,
      layoutsDelayMs: 900,
    });

    await page.goto('/');

    // Pending window: the layout-shaped skeleton is shown, never the modal.
    await expect(homeRouteSkeleton(page)).toBeVisible({ timeout: 5000 });
    await expect(newProjectModalOverlay(page)).toHaveCount(0);

    await expect(
      page.getByRole('heading', { name: 'What do you want to work on?' }),
    ).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole('button', { name: /Open last project/i }),
    ).toBeVisible();

    expect(await wasModalEverMounted(page)).toBe(false);
    expect(await getPushedPaths(page)).not.toContain('/projects/new');

    // Back navigation never lands on the transient new-project prompt.
    await page.goBack();
    expect(new URL(page.url()).pathname).not.toBe('/projects/new');
  });

  test('no persisted lastProject, projects exist: no modal flash, stays on Home with first-project continuation', async ({
    page,
  }) => {
    await installModalMountWatcher(page);
    await trackPushedPaths(page);
    // No lastProject/lastProjectLayout seeded — first-ever visit on a
    // browser profile that already has projects (e.g. a shared/imported
    // install).
    await mockRootRouteHarness(page, {
      projects: [DEV_PROJECT],
      layoutsBySlug: { dev: DEV_LAYOUTS },
      projectsDelayMs: 200,
      layoutsDelayMs: 900,
    });

    await page.goto('/');

    await expect(homeRouteSkeleton(page)).toBeVisible({ timeout: 5000 });
    await expect(newProjectModalOverlay(page)).toHaveCount(0);

    await expect(
      page.getByRole('heading', { name: 'What do you want to work on?' }),
    ).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/\/$/);

    expect(await wasModalEverMounted(page)).toBe(false);
    expect(await getPushedPaths(page)).not.toContain('/projects/new');
  });

  test('stale lastProject (deleted project): falls through to priority 2, no modal flash, never resolves to project-new while other projects exist', async ({
    page,
  }) => {
    await installModalMountWatcher(page);
    await trackPushedPaths(page);
    await page.addInitScript(() => {
      window.localStorage.setItem('lastProject', 'ghost-project');
      window.localStorage.setItem('lastProjectLayout', 'ghost-layout');
    });
    await mockRootRouteHarness(page, {
      projects: [DEV_PROJECT],
      layoutsBySlug: { dev: DEV_LAYOUTS },
      projectsDelayMs: 200,
      layoutsDelayMs: 900,
    });

    await page.goto('/');

    await expect(homeRouteSkeleton(page)).toBeVisible({ timeout: 5000 });
    await expect(newProjectModalOverlay(page)).toHaveCount(0);

    // Falls through to priority 2 (the first remaining project's first
    // layout) rather than resolving to project-new — the stale slug is
    // never a match in the loaded `projects` list.
    await expect(
      page.getByRole('heading', { name: 'What do you want to work on?' }),
    ).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/\/$/);

    expect(await wasModalEverMounted(page)).toBe(false);
    expect(await getPushedPaths(page)).not.toContain('/projects/new');
  });
});
