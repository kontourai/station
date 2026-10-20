import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { expect, type Page } from '@playwright/test';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

function summary(index: number): OrchestrationSessionSummary {
  const time = new Date(Date.now() - index * 60_000).toISOString();
  return {
    threadId: `external:claude:activity-review-${index}`,
    provider: 'claude',
    controlMode: 'read-only-attached',
    displayTitle: `${index === 2 ? 'Other' : 'Review'} activity ${String(index).padStart(2, '0')}`,
    projectSlug: 'dev',
    attachedSource: {
      kind: 'claude-transcript',
      externalSessionId: `activity-review-${index}`,
      affinity: { kind: 'fixture-home', ref: 'activity-review' },
    },
    status: 'ready',
    lifecycleState: 'completed',
    hasActiveTurn: false,
    isLoaded: false,
    isPersisted: true,
    eventCount: 0,
    createdAt: time,
    updatedAt: time,
    answerability: {
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'activity-review-fixture',
      observedAt: time,
    },
  };
}

async function reviewItem(page: Page, title: string) {
  const row = page
    .locator('#station-main .split-pane__item-row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await row.getByRole('button', { name: 'More actions', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Quick review', exact: true })
    .click();
}

test('Activity reviews filtered siblings in Related with Main preserved, and uses one real phone child history entry', async ({
  page,
}, testInfo) => {
  await seedOrchestrationRoutes(page);
  await installMockOrchestrationSse(page);
  let sessions = Array.from({ length: 16 }, (_, index) => summary(index + 1));
  await page.route('**/api/orchestration/sessions/read-model*', (route) =>
    route.fulfill({ json: { success: true, data: sessions } }),
  );
  await page.route(
    /\/api\/orchestration\/sessions\/external%3Aclaude%3Aactivity-review-\d+$/,
    (route) => {
      const id = decodeURIComponent(
        new URL(route.request().url()).pathname.split('/').at(-1) ?? '',
      );
      const session = sessions.find((item) => item.threadId === id);
      if (!session || route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      return route.fulfill({
        json: { success: true, data: { session, events: [] } },
      });
    },
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .locator('.sidebar')
    .getByRole('button', { name: 'Activity', exact: true })
    .click();
  const main = page.locator('#station-main');
  await expect(
    main.getByRole('heading', { name: 'Activity', exact: true }),
  ).toBeVisible();
  await main
    .getByRole('button', { name: 'Review activity 01', exact: true })
    .click();
  const search = main.getByPlaceholder('Search activity…');
  await search.fill('Review');
  const list = main.locator('.split-pane__list');
  await expect(
    main.getByRole('button', { name: 'Other activity 02', exact: true }),
  ).toHaveCount(0);
  await list.hover();
  await page.mouse.wheel(0, 200);
  const scrollBefore = await list.evaluate((element) => element.scrollTop);
  await reviewItem(page, 'Review activity 04');
  const review = page.getByRole('region', {
    name: 'Activity quick review',
    exact: true,
  });
  await expect(
    review.getByRole('heading', { name: 'Review activity 04', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.chat-dock--right .activity-review'),
  ).toBeVisible();
  expect(await main.locator('.activity-review').count()).toBe(0);
  await expect(
    main.getByRole('button', { name: 'Review activity 01', exact: true }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(search).toHaveValue('Review');
  expect(await list.evaluate((element) => element.scrollTop)).toBe(
    scrollBefore,
  );
  await review.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(
    review.getByRole('heading', { name: 'Review activity 03', exact: true }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(
    review.getByRole('heading', { name: 'Review activity 01', exact: true }),
  ).toBeVisible();
  await expect(
    review.getByRole('button', { name: 'Previous', exact: true }),
  ).toBeDisabled();
  await review.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    review.getByRole('heading', { name: 'Review activity 03', exact: true }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(
    review.getByRole('button', { name: 'Opened', exact: true }),
  ).toBeDisabled();
  const kept = await page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem('station:pane-relations:v1') ?? '{}',
      ).entries.find((entry: { kept: boolean }) => entry.kept)?.instanceId,
  );
  expect(kept).toMatch(/^activity-review:/);
  await review.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    review.getByRole('heading', { name: 'Review activity 04', exact: true }),
  ).toBeVisible();
  await reviewItem(page, 'Review activity 03');
  await expect(
    review.getByRole('heading', { name: 'Review activity 03', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (id) =>
        JSON.parse(
          localStorage.getItem('station:pane-relations:v1') ?? '{}',
        ).entries.filter(
          (entry: { instanceId: string }) => entry.instanceId === id,
        ).length,
      kept,
    ),
  ).toBe(1);
  sessions = sessions.filter((item) => item.threadId !== summary(1).threadId);
  await expect(
    main.getByRole('button', { name: 'Review activity 01', exact: true }),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(
    review.getByRole('button', { name: 'Previous', exact: true }),
  ).toBeDisabled();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    );
    await page.screenshot({
      path: testInfo.outputPath(`activity-review-${theme}.png`),
    });
  }
  await review
    .getByRole('button', { name: 'Close review', exact: true })
    .click();
  await expect(search).toHaveValue('Review');
  await page.setViewportSize({ width: 390, height: 844 });
  await reviewItem(page, 'Review activity 04');
  await expect(
    review.getByRole('heading', { name: 'Review activity 04', exact: true }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    review.getByRole('heading', { name: 'Review activity 05', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(review).toHaveCount(0);
  await expect(search).toBeVisible();
  await expect(search).toHaveValue('Review');
  await reviewItem(page, 'Review activity 04');
  await expect(
    review.getByRole('heading', { name: 'Review activity 04', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('activity-review-phone.png'),
  });
  await review
    .getByRole('button', { name: 'Up to Activity', exact: true })
    .click();
  await expect(review).toHaveCount(0);
  await expect(search).toBeVisible();
});
