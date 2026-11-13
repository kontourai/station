import type { GitStatusResult } from '@kontourai/station-sdk';
import { expect, type Page } from '@playwright/test';
import { selectCodingPane } from './helpers/coding-stack';
import { test } from './helpers/fixture-audit';
import {
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

/**
 * Diff review annotations — verifies the DiffPanel ↔ diff-comments wiring in a
 * real browser: the panel renders a parsed diff, fetches the project's comments,
 * and renders a seeded comment inline via @pierre/diffs' annotation slot.
 * All endpoints are routed deterministically so the test is repo-independent.
 */

const SAMPLE_PATCH = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

const SEEDED_COMMENT = {
  id: 'seed-1',
  projectId: 'dev',
  filePath: 'foo.ts',
  side: 'additions' as const,
  lineNumber: 2,
  body: 'Needs a null guard here',
  createdAt: '2026-06-28T00:00:00.000Z',
  updatedAt: '2026-06-28T00:00:00.000Z',
};

async function seedRoutes(page: Page) {
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
      body: JSON.stringify({
        success: true,
        data: {
          isRepo: true,
          branch: 'main',
          changes: [' M foo.ts'],
          staged: 0,
          unstaged: 1,
          untracked: 0,
          lastCommit: null,
          ahead: 0,
          behind: 0,
          remote: 'present',
          repoRoot: '/repo',
        } satisfies GitStatusResult,
      }),
    }),
  );
  await page.route('**/api/coding/git/branches**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{ name: 'main', sha: 'aaaaaaa', current: true }],
      }),
    }),
  );
  await page.route('**/api/coding/git/log**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  // The diff the panel renders (real endpoint is /api/coding/git/diff).
  await page.route('**/api/coding/git/diff**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: SAMPLE_PATCH }),
    }),
  );
  // One pre-existing review comment anchored to the changed line.
  await page.route('**/api/projects/*/diff-comments**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [SEEDED_COMMENT] }),
    }),
  );
  for (const pattern of [
    '**/api/projects/*/readiness**',
    '**/api/projects/*/flow/definitions**',
    '**/api/projects/*/trust-bundles**',
    '**/api/fs/browse**',
  ]) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
  }
}

test.describe('Diff review annotations', () => {
  test.beforeEach(async ({ page }) => {
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await seedRoutes(page);
  });

  for (const width of [390, 1440]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`renders the diff and a seeded comment inline at ${width}px in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await page.emulateMedia({ colorScheme: theme });
        // DiffPanel queries the project's comments as soon as the coding layout loads.
        const commentsRequest = page.waitForRequest((req) =>
          /\/api\/projects\/[^/]+\/diff-comments/.test(req.url()),
        );

        await page.goto('/projects/dev/layouts/code');
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        await selectCodingPane(page, 'Diff');

        // The pane head names the pane; the toolbar is counts and icon tools.
        await expect(page.getByText('Git Diff')).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: 'Wrap lines' }),
        ).toBeVisible();
        await expect(
          page.getByRole('textbox', { name: 'Commit message', exact: true }),
        ).toHaveAttribute('placeholder', 'Commit message (1)');

        // The wiring fired: DiffPanel fetched the project's comments.
        await commentsRequest;

        // The parsed diff rendered: @pierre/diffs mounts its <diffs-container>
        // custom element (the line text itself is split across Shiki token spans,
        // so assert on the container rather than a full-line string).
        await expect(page.locator('diffs-container').first()).toBeVisible({
          timeout: 15000,
        });

        // The seeded comment renders inline via the annotation slot.
        await expect(page.getByText('Needs a null guard here')).toBeVisible({
          timeout: 15000,
        });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: testInfo.outputPath(`diff-review-${width}-${theme}.png`),
          fullPage: true,
        });
      });
    }
  }
});
