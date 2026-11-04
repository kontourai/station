import type { PersonalBoardDocument } from '@kontourai/station-contracts/personal-board';
import { mergeTests } from '@playwright/test';
import {
  test as authenticatedTest,
  expect,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { test as fixtureTest } from './helpers/fixture-audit';
import { dismissSetupLauncher } from './helpers/orchestration';

const test = mergeTests(authenticatedTest, fixtureTest);
const API = resolveE2EApiBase();

for (const width of [390, 1440]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`retries the Project list without losing a Board draft at ${width}px in ${colorScheme}`, async ({
      page,
      authenticatedRequest,
    }, testInfo) => {
      const slug = `board-project-retry-${width}-${colorScheme}-${Date.now()}`;
      expect(
        (
          await authenticatedRequest.post(`${API}/api/me/layouts`, {
            data: { slug, name: 'Project retry Board' },
          })
        ).status(),
      ).toBe(201);
      expect(
        (
          await authenticatedRequest.post(`${API}/api/projects`, {
            data: { slug, name: 'Recovered Project' },
          })
        ).status(),
      ).toBe(201);
      let failProjects = true;
      let failedReads = 0;
      await page.route(
        (url) => url.pathname === '/api/projects',
        async (route) => {
          if (route.request().method() !== 'GET' || !failProjects) {
            await route.continue();
            return;
          }
          failedReads += 1;
          await route.fulfill({
            status: 503,
            json: {
              success: false,
              error: 'Project list temporarily unavailable',
            },
          });
        },
      );
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await page.goto(`/boards/${slug}`);
        await dismissSetupLauncher(page);
        const workspace = page.locator('.personal-board-workspace');
        await expect(workspace).toBeVisible({ timeout: 30_000 });
        await expect(
          workspace.getByRole('button', { name: /Project watch/ }),
        ).toBeDisabled();
        await expect.poll(() => failedReads).toBeGreaterThan(0);
        const retryProjects = workspace.getByRole('button', {
          name: 'Retry Projects',
        });
        await expect(retryProjects).toBeVisible();
        const retryBox = await retryProjects.boundingBox();
        expect(retryBox).not.toBeNull();
        expect(retryBox!.height).toBeGreaterThanOrEqual(44);
        expect(retryBox!.x).toBeGreaterThanOrEqual(0);
        expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: testInfo.outputPath('projects-read-failed.png'),
          fullPage: true,
        });
        await workspace.getByRole('button', { name: /Start blank/ }).click();
        await page.getByLabel('Board name').fill('Keep my Board draft');
        await workspace
          .getByRole('button', { name: 'Note', exact: true })
          .click();
        await page
          .getByRole('textbox', { name: 'Note', exact: true })
          .fill('Keep this note through retry.');
        await workspace
          .getByRole('button', { name: 'Tasks', exact: true })
          .click();
        const projectSelect = page.getByRole('combobox', {
          name: 'Project',
          exact: true,
        });
        await expect(projectSelect).toHaveValue('');
        failProjects = false;
        const retry = workspace.getByRole('button', { name: 'Retry Projects' });
        await retry.focus();
        await page.keyboard.press('Enter');
        await expect(
          projectSelect.getByRole('option', {
            name: 'Recovered Project',
            exact: true,
          }),
        ).toBeAttached();
        await expect(retry).toHaveCount(0);
        await expect(page.getByLabel('Board name')).toHaveValue(
          'Keep my Board draft',
        );
        await expect(
          page.getByRole('textbox', { name: 'Note', exact: true }),
        ).toHaveValue('Keep this note through retry.');
        await expect(projectSelect).toHaveValue('');
        await projectSelect.selectOption(slug);
        await expect(page).toHaveURL(new RegExp(`/boards/${slug}$`));
        if (width === 390)
          await page
            .getByRole('button', { name: 'Toggle menu', exact: true })
            .click();
        await page
          .getByRole('navigation', {
            name: width === 390 ? 'Mobile navigation' : 'Primary navigation',
          })
          .getByRole('button', { name: 'Home', exact: true })
          .click();
        const discard = page.getByRole('dialog', { name: 'Unsaved Changes' });
        await discard
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        await expect(page).toHaveURL(new RegExp(`/boards/${slug}$`));
        await expect(projectSelect).toHaveValue(slug);
        await expect(
          page.getByRole('textbox', { name: 'Note', exact: true }),
        ).toHaveValue('Keep this note through retry.');
        await page.screenshot({
          path: testInfo.outputPath('projects-recovered-draft.png'),
          fullPage: true,
        });
        await workspace
          .getByRole('button', { name: 'Save Board', exact: true })
          .click();
        await expect(
          workspace.getByRole('button', { name: 'Edit Board', exact: true }),
        ).toBeVisible();
        const saved = await authenticatedRequest.get(
          `${API}/api/me/boards/${slug}`,
        );
        expect(saved.status()).toBe(200);
        const document = (await saved.json()).data as PersonalBoardDocument;
        expect(document.definition).toMatchObject({
          name: 'Keep my Board draft',
          sections: [
            { kind: 'note', body: 'Keep this note through retry.' },
            { kind: 'tasks', projectSlug: slug },
          ],
        });
        await page.reload();
        await expect(workspace).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByRole('heading', {
            name: 'Keep my Board draft',
            exact: true,
          }),
        ).toBeVisible();
        await workspace
          .getByRole('button', { name: 'Edit Board', exact: true })
          .click();
        await expect(
          page.getByRole('combobox', { name: 'Project', exact: true }),
        ).toHaveValue(slug);
        await expect(
          page.getByRole('textbox', { name: 'Note', exact: true }),
        ).toHaveValue('Keep this note through retry.');
      } finally {
        expect(
          (
            await authenticatedRequest.delete(`${API}/api/me/layouts/${slug}`)
          ).status(),
        ).toBe(200);
        expect(
          (
            await authenticatedRequest.delete(`${API}/api/projects/${slug}`)
          ).status(),
        ).toBe(200);
      }
    });
  }
}

for (const width of [1280, 390]) {
  test(`authors, previews and persists a Personal Board at ${width}px`, async ({
    page,
    authenticatedRequest,
  }, testInfo) => {
    const slug = `personal-author-${width}-${Date.now()}.v2`;
    const created = await authenticatedRequest.post(`${API}/api/me/layouts`, {
      data: { slug, name: 'My morning' },
    });
    expect(created.status()).toBe(201);
    let taskId: string | undefined;
    try {
      const project = await authenticatedRequest.post(`${API}/api/projects`, {
        data: { slug, name: 'Board authoring Project' },
      });
      expect(project.status()).toBe(201);
      const task = await authenticatedRequest.post(`${API}/api/tasks`, {
        data: { projectId: slug, title: `Live task ${width}` },
      });
      expect(task.status()).toBe(201);
      taskId = (await task.json()).data.id;

      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/boards/${slug}`);
      await dismissSetupLauncher(page);
      await expect(
        page.getByRole('dialog', { name: 'Starting Station', exact: true }),
      ).toBeHidden();
      await expect(
        page.getByRole('heading', { name: 'Build your Board' }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`setup-${width}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: /Daily brief/ }).click();
      await page.getByLabel('Board name').fill('Morning desk');
      await page
        .getByLabel('Note', { exact: true })
        .fill('Review pending decisions before starting new work.');
      await page.getByRole('button', { name: 'Move Note up' }).click();
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Morning desk' }),
      ).toBeVisible();
      await expect(
        page.getByText('Review pending decisions before starting new work.'),
      ).toBeVisible();
      let read = await authenticatedRequest.get(`${API}/api/me/boards/${slug}`);
      expect(read.status()).toBe(200);
      expect(
        ((await read.json()).data as PersonalBoardDocument).definition,
      ).toBeNull();
      await page.getByRole('button', { name: 'Save Board' }).click();
      await expect(
        page.getByRole('button', { name: 'Edit Board' }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: `Live task ${width}` }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Morning desk' }),
      ).toHaveCount(1);
      const toolbar = page.locator('.personal-board__toolbar');
      for (const button of await toolbar.getByRole('button').all()) {
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        await expect
          .poll(async () => (await button.boundingBox())?.height ?? 0)
          .toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      const cards = await page
        .locator('.personal-board__card')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const { x, y, width } = element.getBoundingClientRect();
            return { x, y, width };
          }),
        );
      if (width === 390) {
        expect(cards[1].x).toBeCloseTo(cards[0].x, 0);
        expect(cards[1].y).toBeGreaterThan(cards[0].y);
      } else {
        expect(cards[1].y).toBeCloseTo(cards[0].y, 0);
        expect(cards[1].x).toBeGreaterThan(cards[0].x);
      }
      await expect(
        page.getByRole('link', { name: `Live task ${width}` }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`daily-${width}.png`),
        fullPage: true,
      });
      await page.evaluate(() =>
        document.documentElement.setAttribute('data-theme', 'light'),
      );
      await page.screenshot({
        path: testInfo.outputPath(`daily-light-${width}.png`),
        animations: 'disabled',
        fullPage: true,
      });
      await page.evaluate(() =>
        document.documentElement.setAttribute('data-theme', 'dark'),
      );
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Morning desk' }),
      ).toBeVisible();
      read = await authenticatedRequest.get(`${API}/api/me/boards/${slug}`);
      const saved = (await read.json()).data as PersonalBoardDocument;
      expect(saved.definition?.sections.map((section) => section.kind)).toEqual(
        ['attention', 'tasks', 'note', 'recent-work'],
      );
      const proposal = {
        ...saved.definition!,
        name: 'Proposed desk',
        sections: [
          {
            id: 'note',
            title: 'Plan',
            kind: 'note',
            width: 'full',
            body: 'Proposed through the chat authoring API.',
          },
        ],
      };
      const proposed = await authenticatedRequest.post(
        `${API}/api/me/boards/${slug}/proposal`,
        { data: { revision: saved.revision, definition: proposal } },
      );
      expect(proposed.status()).toBe(200);
      await expect(
        page.getByRole('button', { name: 'Review proposal' }),
      ).toBeVisible({ timeout: 15000 });
      await expect(
        page.getByRole('heading', { name: 'Morning desk' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Review proposal' }).click();
      await expect(
        page.getByRole('heading', { name: 'Proposed desk' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Apply Board' }).click();
      await expect(
        page.getByRole('button', { name: 'Edit Board' }),
      ).toBeVisible();
      await expect(
        page.getByText('Proposed through the chat authoring API.'),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`board-${width}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Build with chat' }).click();
      await expect(
        page.getByRole('region', { name: 'New chat' }),
      ).toBeVisible();
    } finally {
      if (taskId)
        expect(
          (
            await authenticatedRequest.patch(
              `${API}/api/tasks/${taskId}/status`,
              { data: { status: 'canceled' } },
            )
          ).status(),
        ).toBe(200);
      expect(
        (
          await authenticatedRequest.delete(`${API}/api/projects/${slug}`)
        ).status(),
      ).toBe(200);

      const deleted = await authenticatedRequest.delete(
        `${API}/api/me/layouts/${slug}`,
      );
      expect(deleted.status(), 'remove authored Board').toBe(200);
    }
  });
}

test('legacy Board tabs retain their active fallback when entering authoring and switching Boards', async ({
  page,
  authenticatedRequest,
}) => {
  const suffix = Date.now();
  const first = `legacy-a-${suffix}`;
  const second = `legacy-b-${suffix}`;
  for (const [slug, name, tabs] of [
    [
      first,
      'Legacy A',
      [
        { id: 'a1', label: 'First pane', component: 'standard' },
        { id: 'a2', label: 'Second pane', component: 'standard' },
      ],
    ],
    [
      second,
      'Legacy B',
      [{ id: 'b1', label: 'Only pane', component: 'standard' }],
    ],
  ] as const) {
    const created = await authenticatedRequest.post(`${API}/api/me/layouts`, {
      data: { slug, name, config: { tabs } },
    });
    expect(created.status()).toBe(201);
  }
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/boards/${first}`);
    await dismissSetupLauncher(page);
    await expect(
      page.getByRole('dialog', { name: 'Starting Station', exact: true }),
    ).toBeHidden();
    await page
      .getByRole('button', { name: 'Second pane', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Second pane', exact: true }),
    ).toHaveClass(/workspace-tabs__tab--active/);
    await page.getByRole('button', { name: 'Build dashboard' }).click();
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Legacy B', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Only pane', exact: true }),
    ).toHaveClass(/workspace-tabs__tab--active/);
  } finally {
    for (const slug of [first, second])
      expect(
        (
          await authenticatedRequest.delete(`${API}/api/me/layouts/${slug}`)
        ).status(),
      ).toBe(200);
  }
});
