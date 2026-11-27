import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import type { TaskCodeReviewView } from '../packages/contracts/src/task-review';
import { execGit } from '../src-server/utils/git-exec';
import { contrastRatio } from './helpers/color-contrast';
import { test } from './helpers/fixture-audit';
import {
  apiJson,
  createProject,
  createRepository,
} from './helpers/live-station-task';

test('repo-free Tasks keep human review available without showing code-specific controls', async ({
  page,
}) => {
  await page.goto('/');
  const slug = `document-task-${Date.now()}`;
  const preview = await apiJson<{ success: boolean }>(
    page,
    '/api/feature-previews/task-review',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    },
  );
  expect(preview.success).toBe(true);
  const project = await apiJson<{ success: boolean }>(page, '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Shared document work', slug }),
  });
  expect(project.success).toBe(true);
  const task = await apiJson<{ success: boolean; data: { id: string } }>(
    page,
    '/api/tasks',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: slug,
        title: 'Discuss an analysis brief',
        description: 'Agree on the research question.',
      }),
    },
  );
  expect(task.success).toBe(true);
  const [graph] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/tasks/${task.data.id}/graph` &&
        response.request().method() === 'GET',
      { timeout: 15_000 },
    ),
    page.goto(`/tasks/${task.data.id}?taskView=overview`),
  ]);
  expect(graph.ok()).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Edit plan', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Review', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Code review', exact: true }),
  ).toHaveCount(0);
});

async function fixture(page: Page, info: TestInfo) {
  const directory = info.outputPath('repository');
  await createRepository(directory, 'main');
  await writeFile(`${directory}/README.md`, 'Committed feature\n');
  await execGit(['commit', '-am', 'feature'], {
    cwd: directory,
    timeout: 5000,
  });
  await page.goto('/');
  const preview = await apiJson<{ success: boolean }>(
    page,
    '/api/feature-previews/task-review',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    },
  );
  expect(preview.success).toBe(true);
  const slug = `code-review-${Date.now()}`;
  await createProject(page, slug, directory);
  const result = await apiJson<{
    success: boolean;
    data: { id: string; createdAt: string };
  }>(page, '/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: slug,
      title: 'Review the committed feature',
      agentId: 'station',
      createdBy: 'user',
      workspaceBinding: {
        workingDirectory: directory,
        repoRoot: directory,
        worktreePath: directory,
        branch: 'main',
        sourceSurface: 'api',
      },
    }),
  }).catch((error) => {
    console.error('Task fixture browser state after setup failure', {
      pageClosed: page.isClosed(),
      browserConnected: page.context().browser()?.isConnected() ?? null,
    });
    throw error;
  });
  expect(result.success).toBe(true);
  const task = result.data;
  const endpoint = `/api/tasks/${task.id}/review/code?taskCreatedAt=${encodeURIComponent(task.createdAt)}`;
  const response = await apiJson<{
    success: boolean;
    data: TaskCodeReviewView;
  }>(page, endpoint);
  expect(response.success).toBe(true);
  expect(response.data).toMatchObject({
    version: 'station.task-code-review/v1',
    requestsUnavailable: false,
    workspace: {
      state: 'available',
      kind: 'project-checkout',
      branch: 'main',
      dirty: false,
    },
  });
  await openReviewTask(page, task.id, `/tasks/${task.id}?taskView=overview`);
  const panel = page.getByRole('region', { name: 'Code review', exact: true });
  await expect(panel).toBeVisible();
  return { panel, task, view: response.data, endpoint, directory };
}

async function openReviewTask(
  page: Page,
  taskId: string,
  url: string,
  reviewStatus = 200,
) {
  const [graph, review] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/tasks/${taskId}/graph` &&
        response.request().method() === 'GET',
      { timeout: 15_000 },
    ),
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/tasks/${taskId}/review/code` &&
        response.request().method() === 'GET',
      { timeout: 15_000 },
    ),
    page.goto(url),
  ]);
  expect(graph.ok()).toBe(true);
  await graph.finished();
  expect(review.status()).toBe(reviewStatus);
  await review.finished();
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  taskId: string,
  name: string,
  unavailable = false,
) {
  for (const theme of ['dark', 'light'] as const) {
    const url = page.url();
    await page.goto('/appearance');
    const mode = page.getByRole('radiogroup', { name: 'Mode', exact: true });
    const radio = mode.getByRole('radio', {
      name: theme === 'dark' ? 'Dark' : 'Light',
      exact: true,
    });
    if (!(await radio.isChecked())) {
      const [saved] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/me/preferences' &&
            response.request().method() === 'PATCH' &&
            response.request().postDataJSON()?.theme === theme,
        ),
        mode
          .getByText(theme === 'dark' ? 'Dark' : 'Light', { exact: true })
          .click(),
      ]);
      expect(saved.ok()).toBe(true);
      await saved.finished();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await openReviewTask(page, taskId, url, unavailable ? 403 : 200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const panel = unavailable
      ? page.getByText('Code review unavailable', { exact: true })
      : page.getByRole('region', { name: 'Code review', exact: true });
    await expect(panel).toBeVisible();
    await expect(
      page.getByText('Add the goal to the plan.', { exact: true }),
    ).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await panel.scrollIntoViewIfNeeded();
      if (!unavailable) {
        for (const button of await panel.getByRole('button').all()) {
          expect(await contrastRatio(button)).toBeGreaterThanOrEqual(4.5);
          if (width === 390)
            expect(
              await button.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const hitArea = getComputedStyle(element, '::after');
                return Math.max(
                  rect.height,
                  hitArea.content !== 'none'
                    ? Number.parseFloat(hitArea.height) || 0
                    : 0,
                );
              }),
            ).toBeGreaterThanOrEqual(44);
        }
        if (width === 390)
          for (const field of await panel.getByRole('combobox').all()) {
            expect(
              Number.parseFloat(
                await field.evaluate(
                  (element) => getComputedStyle(element).fontSize,
                ),
              ),
            ).toBeGreaterThanOrEqual(16);
          }
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${theme}-${width}.png`),
      });
      const exportRoot = process.env.STATION_TASK_CODE_REVIEW_SHOTS;
      if (exportRoot) {
        await mkdir(exportRoot, { recursive: true });
        await copyFile(
          testInfo.outputPath(`${name}-${theme}-${width}.png`),
          join(exportRoot, `${name}-${theme}-${width}.png`),
        );
      }
    }
  }
}

test('actual Task checkout and dirty-file disclosure stay distinct from review outcome', async ({
  page,
}, info) => {
  info.setTimeout(120_000);
  const f = await fixture(page, info);
  await expect(
    f.panel.getByText('Project checkout', { exact: true }),
  ).toBeVisible();
  await f.panel
    .getByRole('button', { name: 'Checkout and comparison' })
    .press('Enter');
  await expect(
    f.panel.getByRole('button', { name: 'Checkout and comparison' }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(f.panel.getByText(f.directory, { exact: true })).toBeVisible();
  await writeFile(`${f.directory}/README.md`, 'Uncommitted work\n');
  await f.panel
    .getByRole('button', { name: 'Refresh code review', exact: true })
    .click();
  await expect(
    f.panel.getByText('Uncommitted changes are outside this review.', {
      exact: true,
    }),
  ).toBeVisible();
  await apiJson(page, '/api/feature-previews/task-review', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  for (const method of ['GET', 'POST']) {
    const refusal = await page.evaluate(
      async ({ endpoint, method }) => {
        const response = await fetch(endpoint, {
          method,
          ...(method === 'POST'
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: '{invalid',
              }
            : {}),
        });
        return { status: response.status, body: await response.json() };
      },
      { endpoint: f.endpoint, method },
    );
    expect(refusal).toMatchObject({
      status: 404,
      body: {
        success: false,
        code: 'feature_preview_disabled',
        previewId: 'task-review',
        settingsPath:
          '/settings?view=feature-previews&highlight=feature-previews',
      },
    });
  }
  await apiJson(page, '/api/feature-previews/task-review', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  await capture(page, info, f.task.id, 'pass-1-location');
  await f.panel
    .getByRole('button', { name: 'Open Agents', exact: true })
    .press('Enter');
  await expect(page).toHaveURL(/\/agents(?:\?|$)/);
});

test('controlled review transport loss never automatically starts another review and retains freshness and failure states', async ({
  page,
}, info) => {
  info.setTimeout(120_000);
  const f = await fixture(page, info);
  const view: TaskCodeReviewView = {
    ...f.view,
    reviewers: [{ slug: 'reviewer-fixture', name: 'Independent reviewer' }],
  };
  let submissions = 0;
  let submittedRequest: Record<string, string> | undefined;
  await page.route(`**/api/tasks/${f.task.id}/review/code*`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { success: true, data: view } });
      return;
    }
    submissions++;
    const body = route.request().postDataJSON();
    if (submittedRequest) expect(body).toEqual(submittedRequest);
    submittedRequest = body;
    if (submissions === 1) {
      await route.abort('failed');
      return;
    }
    view.requests = [
      {
        requestId: body.requestId,
        state: 'running',
        startedAt: '2026-11-06T00:00:00Z',
        updatedAt: '2026-11-06T00:00:00Z',
        freshness: 'unavailable',
        findings: [],
        omittedFindings: 0,
        reviewers: [],
      },
    ];
    await route.abort('failed');
  });
  await f.panel
    .getByRole('button', { name: 'Refresh code review', exact: true })
    .click();
  const request = f.panel.getByRole('button', {
    name: 'Request review',
    exact: true,
  });
  await expect(request).toBeEnabled();
  await request.press('Enter');
  await expect(
    f.panel.getByText('Request outcome unknown', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    f.panel.getByRole('button', { name: 'Retry request', exact: true }),
  ).toBeEnabled();
  expect(submissions).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const retry = f.panel.getByRole('button', {
    name: 'Retry request',
    exact: true,
  });
  await retry.scrollIntoViewIfNeeded();
  const retryBounds = await retry.boundingBox();
  expect(retryBounds).not.toBeNull();
  const touch = await page.context().newCDPSession(page);
  try {
    await touch.send('Input.synthesizeTapGesture', {
      x: retryBounds!.x + retryBounds!.width / 2,
      y: retryBounds!.y + retryBounds!.height / 2,
      gestureSourceType: 'touch',
    });
  } finally {
    await touch.detach();
  }
  await expect(f.panel.getByText('Running', { exact: true })).toBeVisible();
  expect(submissions).toBe(2);
  view.requests[0] = {
    ...view.requests[0],
    state: 'completed',
    baseSha: f.view.workspace.baseSha,
    headSha: f.view.workspace.headSha,
    freshness: 'different-revision',
    reviewers: [{ name: 'Independent reviewer', status: 'failed' }],
  };
  await f.panel
    .getByRole('button', { name: 'Refresh code review', exact: true })
    .click();
  await expect(
    f.panel.getByText('Checkout revision changed', { exact: false }),
  ).toBeVisible();
  await expect(
    f.panel.getByText('Reviewer execution did not complete.', { exact: true }),
  ).toBeVisible();
  await capture(page, info, f.task.id, 'pass-2-review');
  expect(submissions).toBe(2);
  view.requests = [];
  view.requestsUnavailable = true;
  await f.panel
    .getByRole('button', { name: 'Refresh code review', exact: true })
    .click();
  await expect(
    f.panel.getByText('Some review history is unavailable', { exact: true }),
  ).toBeVisible();
  await expect(
    f.panel.getByText(
      'Request a review of the committed changes in this checkout.',
      { exact: true },
    ),
  ).toHaveCount(0);
  view.requestsUnavailable = false;
  await f.panel
    .getByRole('button', { name: 'Refresh code review', exact: true })
    .click();
  await expect(
    f.panel.getByText(
      'Request a review of the committed changes in this checkout.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.unroute(`**/api/tasks/${f.task.id}/review/code*`);
});

test('controlled denied refresh removes cached findings and recovers through the visible action', async ({
  page,
}, info) => {
  info.setTimeout(120_000);
  const f = await fixture(page, info);
  let denied = false;
  const summary = 'A late save overwrites the current draft.';
  const view: TaskCodeReviewView = {
    ...f.view,
    requests: [
      {
        requestId: 'review-with-findings',
        state: 'completed',
        startedAt: '2026-11-06T00:00:00Z',
        updatedAt: '2026-11-06T00:00:01Z',
        headSha: f.view.workspace.headSha,
        baseSha: f.view.workspace.baseSha,
        receiptId: 'a'.repeat(64),
        freshness: 'same-revision',
        omittedFindings: 0,
        reviewers: [{ name: 'Independent reviewer', status: 'completed' }],
        findings: [
          {
            findingId: 'finding-1',
            reviewerId: 'reviewer-1',
            lensId: 'correctness',
            severity: 'high',
            confidence: 'high',
            basis: 'reasoned-from-code',
            summary,
            location: { file: 'src/editor/save.ts', line: 42 },
            scenario: {
              stateOrInput: 'An older save finishes after a newer edit.',
              wrongOutcome: 'The newer draft is replaced with older text.',
            },
          },
        ],
      },
    ],
  };
  await page.route(`**/api/tasks/${f.task.id}/review/code*`, (route) =>
    route.fulfill(
      denied
        ? {
            status: 403,
            json: {
              success: false,
              error: 'Task access changed. Reopen this Task.',
              code: 'forbidden',
            },
          }
        : { json: { success: true, data: view } },
    ),
  );
  await f.panel
    .getByRole('button', { name: 'Refresh code review', exact: true })
    .click();
  await f.panel
    .getByRole('button', { name: '1 finding · Details', exact: true })
    .press('Enter');
  await expect(f.panel.getByText(summary, { exact: true })).toBeVisible();
  denied = true;
  await f.panel
    .getByRole('button', { name: 'Refresh code review', exact: true })
    .click();
  await expect(
    page.getByText('Code review unavailable', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(summary, { exact: true })).toHaveCount(0);
  await capture(page, info, f.task.id, 'pass-4-denied', true);
  denied = false;
  await page
    .getByRole('button', { name: 'Reload review data', exact: true })
    .click();
  await expect(f.panel).toBeVisible();
  await expect(
    f.panel.getByText('Review recorded', { exact: true }),
  ).toBeVisible();
  await page.unroute(`**/api/tasks/${f.task.id}/review/code*`);
});
