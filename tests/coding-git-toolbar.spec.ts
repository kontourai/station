import { expect, type Page, test } from '@playwright/test';
import {
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

/**
 * Coding layout git branch toolbar — verifies the UI wiring against the
 * (already proven) `/api/coding/git/*` server ops. All git responses are routed
 * deterministically with page.route so the assertions are independent of any
 * real repository state.
 */

let currentBranch = 'main';

const BRANCHES = [
  { name: 'main', sha: 'aaaaaaa', date: '1 day ago', current: true },
  { name: 'feature/x', sha: 'bbbbbbb', date: '2 hours ago', current: false },
];

function gitStatus() {
  return {
    isRepo: true,
    branch: currentBranch,
    changes: ['M src/app.ts'],
    staged: 0,
    unstaged: 1,
    untracked: 0,
    lastCommit: {
      sha: 'aaaaaaa',
      author: 'Dev',
      relativeTime: '1 day ago',
      message: 'init',
    },
    ahead: 1,
    behind: 0,
  };
}

async function seedGitRoutes(page: Page) {
  // Single-repo workspace: the workspace dir is itself the repo root, so the
  // toolbar renders a static repo label (no switcher) and operates on it.
  await page.route('**/api/coding/repos**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          workspace: '/repo',
          workspaceIsRepo: true,
          repos: [
            { root: '/repo', name: 'repo', relativePath: '.', branch: 'main' },
          ],
        },
      }),
    }),
  );
  await page.route('**/api/coding/git/status**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: gitStatus() }),
    }),
  );
  await page.route('**/api/coding/git/branches**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: BRANCHES.map((b) => ({
          ...b,
          current: b.name === currentBranch,
        })),
      }),
    }),
  );
  await page.route('**/api/coding/git/checkout', async (route) => {
    const body = route.request().postDataJSON() as { branch: string };
    currentBranch = body.branch;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { branch: body.branch } }),
    });
  });
  await page.route('**/api/coding/git/log**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  await page.route('**/api/coding/diff**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: '' }),
    }),
  );
  await page.route('**/api/projects/*/readiness**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { configured: false, reason: 'no-veritas-dir' },
      }),
    }),
  );
  await page.route('**/api/projects/*/flow/definitions**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { initialized: false, definitions: [] },
      }),
    }),
  );
  await page.route('**/api/projects/*/trust-bundles**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  await page.route('**/api/fs/browse**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
}

// ── Multi-repo fixtures ────────────────────────────────────────────────────

const REPOS = [
  {
    root: '/workspace/repo-a',
    name: 'repo-a',
    relativePath: 'repo-a',
    branch: 'main',
  },
  {
    root: '/workspace/repo-b',
    name: 'repo-b',
    relativePath: 'repo-b',
    branch: 'develop',
  },
];

/** Map a queried path to the branch of its owning repo (longest-prefix). */
function branchForPath(path: string): string {
  let best: (typeof REPOS)[number] | null = null;
  for (const repo of REPOS) {
    if (path === repo.root || path.startsWith(`${repo.root}/`)) {
      if (!best || repo.root.length > best.root.length) best = repo;
    }
  }
  return best?.branch ?? 'main';
}

/**
 * Seed routes for a NON-repo workspace that contains two nested repos. The
 * `/repos` endpoint enumerates them; `/git/status` and `/git/branches` answer
 * per-repo based on the `path` query param so the toolbar reflects whichever
 * repo is active.
 */
async function seedMultiRepoRoutes(page: Page) {
  await page.route('**/api/coding/repos**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          workspace: '/workspace',
          workspaceIsRepo: false,
          repos: REPOS,
        },
      }),
    }),
  );
  await page.route('**/api/coding/git/status**', (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '';
    const branch = branchForPath(path);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          isRepo: true,
          branch,
          repoRoot: path,
          changes: [],
          staged: 0,
          unstaged: 0,
          untracked: 0,
          lastCommit: null,
          ahead: 0,
          behind: 0,
        },
      }),
    });
  });
  await page.route('**/api/coding/git/branches**', (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '';
    const branch = branchForPath(path);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          { name: branch, sha: 'aaaaaaa', date: '1 day ago', current: true },
        ],
      }),
    });
  });
  await page.route('**/api/coding/git/log**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  await page.route('**/api/coding/diff**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: '' }),
    }),
  );
  await page.route('**/api/projects/*/readiness**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { configured: false, reason: 'no-veritas-dir' },
      }),
    }),
  );
  await page.route('**/api/projects/*/flow/definitions**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { initialized: false, definitions: [] },
      }),
    }),
  );
  await page.route('**/api/projects/*/trust-bundles**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  await page.route('**/api/fs/browse**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
}

test.describe('Coding layout git branch toolbar', () => {
  test.beforeEach(async ({ page }) => {
    currentBranch = 'main';
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await seedGitRoutes(page);
    await page.goto('/projects/dev/layouts/code');
    await page.getByRole('tab', { name: /coding:diff/ }).click();
  });

  test('shows the current branch and lists branches in the switcher', async ({
    page,
  }) => {
    const toolbar = page.locator('.branch-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByText('main', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /Switch branch/ }).click();
    const menu = page.getByRole('menu', { name: 'Branches' });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole('menuitemradio', { name: /feature\/x/ }),
    ).toBeVisible();
  });

  test('switching a branch issues checkout and reflects the new branch', async ({
    page,
  }) => {
    const checkoutRequest = page.waitForRequest(
      (req) =>
        req.url().includes('/api/coding/git/checkout') &&
        req.method() === 'POST',
    );

    await page.getByRole('button', { name: /Switch branch/ }).click();
    await page.getByRole('menuitemradio', { name: /feature\/x/ }).click();

    const req = await checkoutRequest;
    expect(req.postDataJSON()).toMatchObject({ branch: 'feature/x' });

    // Status query re-fetches after invalidation and shows the new branch.
    await expect(
      page.locator('.branch-toolbar').getByText('feature/x', { exact: true }),
    ).toBeVisible();
  });
});

test.describe('Coding layout multi-repo toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await seedMultiRepoRoutes(page);
    await page.goto('/projects/dev/layouts/code');
    await page.getByRole('tab', { name: /coding:diff/ }).click();
  });

  test('lists discovered repos and switching updates the branch', async ({
    page,
  }) => {
    const toolbar = page.locator('.branch-toolbar');
    await expect(toolbar).toBeVisible();

    // Default active repo is the first discovered repo (repo-a / main).
    const repoTrigger = page.getByRole('button', {
      name: /Switch repository/,
    });
    await expect(repoTrigger).toBeVisible();
    await expect(
      repoTrigger.getByText('repo-a', { exact: true }),
    ).toBeVisible();
    await expect(
      toolbar.getByRole('button', { name: /Current branch: main/ }),
    ).toBeVisible();

    // The switcher lists both repos with their branches.
    await repoTrigger.click();
    const menu = page.getByRole('menu', { name: 'Repositories' });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole('menuitemradio', { name: /repo-a/ }),
    ).toBeVisible();
    await expect(
      menu.getByRole('menuitemradio', { name: /repo-b/ }),
    ).toBeVisible();
    await expect(menu.getByText(/develop/)).toBeVisible();

    // Selecting repo-b pins it and the displayed branch updates to develop.
    await menu.getByRole('menuitemradio', { name: /repo-b/ }).click();
    await expect(
      repoTrigger.getByText('repo-b', { exact: true }),
    ).toBeVisible();
    await expect(
      toolbar.getByRole('button', { name: /Current branch: develop/ }),
    ).toBeVisible();
  });
});
