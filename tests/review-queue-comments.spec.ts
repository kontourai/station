import { expect, type Page, test } from '@playwright/test';
import {
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

/**
 * Review queue — diff comments (Slice 2). Verifies the cross-project review
 * feed: the Review Queue fetches `/api/diff-comments`, lists a seeded comment,
 * and renders its detail (file/side/line/body) with a Resolve action. All
 * endpoints are routed deterministically so the test is repo-independent.
 */

const SEEDED_COMMENT = {
  id: 'rq-seed-1',
  projectId: 'dev',
  filePath: 'src/api.ts',
  side: 'additions' as const,
  lineNumber: 42,
  body: 'Needs a null guard here',
  createdAt: '2026-06-28T00:00:00.000Z',
  updatedAt: '2026-06-28T00:00:00.000Z',
};

async function seedRoutes(page: Page) {
  // No pending proposed changes — isolate the comment surface.
  await page.route('**/api/proposed-changes**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  // The cross-project comment feed the review queue consumes.
  await page.route('**/api/diff-comments**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [SEEDED_COMMENT] }),
    }),
  );
  // The comment detail resolves the project's coding layout for the
  // "Open in coding" jump; serve one deterministically.
  await page.route('**/api/projects/*/layouts**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{ type: 'coding', slug: 'coding', name: 'Coding' }],
      }),
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

test.describe('Review queue — diff comments', () => {
  test.beforeEach(async ({ page }) => {
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await seedRoutes(page);
  });

  test('surfaces a seeded diff comment and opens its detail', async ({
    page,
  }) => {
    // The view queries the cross-project feed as soon as it loads.
    const feedRequest = page.waitForRequest((req) =>
      /\/api\/diff-comments(\?|$)/.test(req.url()),
    );

    await page.goto('/review-queue');

    // station#4463 slice 1 fix round: the page is titled 'Review', matching
    // its nav item — 'Review Queue' disagreed with its own sidebar entry.
    await expect(
      page.getByRole('heading', { name: 'Review', level: 1, exact: true }),
    ).toBeVisible({ timeout: 15000 });

    // The wiring fired: the queue fetched the aggregate comment feed.
    await feedRequest;

    // The seeded comment appears in the list; open it.
    await page.getByRole('button', { name: /src\/api\.ts/ }).click();

    // The comment detail renders with its body and a Resolve action.
    const detail = page.getByTestId('review-comment-detail');
    await expect(detail).toBeVisible({ timeout: 15000 });
    await expect(detail.getByText('Needs a null guard here')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Resolve' })).toBeVisible();
    // The jump-to-coding affordance resolves from the project's coding layout.
    await expect(
      detail.getByRole('button', { name: 'Open in coding' }),
    ).toBeVisible();
  });
});
