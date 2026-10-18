import type { PersonalBoardDocument } from '@kontourai/station-contracts/personal-board';
import { expect, test } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { dismissSetupLauncher } from './helpers/orchestration';

const API = resolveE2EApiBase();

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
        page.getByRole('dialog', { name: 'New chat' }),
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
