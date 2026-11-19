import { writeFile } from 'node:fs/promises';
import type { PersonalBoardDocument } from '@kontourai/station-contracts/personal-board';
import { type Locator, mergeTests } from '@playwright/test';
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
        await page.setViewportSize({ width, height: 844 });
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
        const revealTemplate = async (target: Locator, label: string) => {
          const initialPath = testInfo.outputPath(
            `${label}-initial-state.json`,
          );
          const eligibility = await Promise.all(
            ['Project watch', 'Review desk'].map(async (name) => ({
              name,
              enabled: await workspace
                .getByRole('button', { name: new RegExp(name) })
                .isEnabled(),
            })),
          );
          const initialState = await workspace
            .locator('.personal-board__templates')
            .evaluate((templates) => {
              const doc = templates.ownerDocument;
              const view = doc.defaultView!;
              const rect = (node: Element) =>
                node.getBoundingClientRect().toJSON();
              const identity = (node: Element) => ({
                tag: node.tagName,
                role: node.getAttribute('role'),
                testId: node.getAttribute('data-testid'),
                class: Array.from(node.classList),
                ariaLabel: node.getAttribute('aria-label'),
              });
              return {
                viewport: {
                  width: view.innerWidth,
                  height: view.innerHeight,
                  scrollX: view.scrollX,
                  scrollY: view.scrollY,
                },
                projectSelection: doc.querySelector<HTMLSelectElement>(
                  '.personal-board__setup select',
                )!.value,
                projectsErrorPresent: !!doc.querySelector(
                  '.personal-board-workspace [role="alert"]',
                ),
                dock: Array.from(doc.querySelectorAll('.chat-dock')).map(
                  (node) => ({ identity: identity(node), rect: rect(node) }),
                ),
                targets: Array.from(templates.querySelectorAll('button'))
                  .filter((button) =>
                    ['Project watch', 'Review desk'].includes(
                      button.querySelector('strong')!.textContent!,
                    ),
                  )
                  .map((button) => {
                    const bounds = button.getBoundingClientRect();
                    const ancestors = [];
                    for (
                      let node = button.parentElement;
                      node;
                      node = node.parentElement
                    ) {
                      const style = view.getComputedStyle(node);
                      ancestors.push({
                        identity: identity(node),
                        rect: rect(node),
                        clientTop: node.clientTop,
                        clientLeft: node.clientLeft,
                        clientWidth: node.clientWidth,
                        clientHeight: node.clientHeight,
                        scrollWidth: node.scrollWidth,
                        scrollHeight: node.scrollHeight,
                        scrollLeft: node.scrollLeft,
                        scrollTop: node.scrollTop,
                        remainingX: Math.max(
                          0,
                          node.scrollWidth - node.clientWidth - node.scrollLeft,
                        ),
                        remainingY: Math.max(
                          0,
                          node.scrollHeight -
                            node.clientHeight -
                            node.scrollTop,
                        ),
                        overflowX: style.overflowX,
                        overflowY: style.overflowY,
                        height: style.height,
                        minHeight: style.minHeight,
                        maxHeight: style.maxHeight,
                        flexBasis: style.flexBasis,
                        flexGrow: style.flexGrow,
                        flexShrink: style.flexShrink,
                        scrollPaddingBottom: style.scrollPaddingBottom,
                        paddingBottom: style.paddingBottom,
                      });
                    }
                    const points = [
                      {
                        name: 'center',
                        x: bounds.left + bounds.width / 2,
                        y: bounds.top + bounds.height / 2,
                      },
                      {
                        name: 'top',
                        x: bounds.left + bounds.width / 2,
                        y: bounds.top + 8,
                      },
                      {
                        name: 'bottom',
                        x: bounds.left + bounds.width / 2,
                        y: bounds.bottom - 8,
                      },
                      {
                        name: 'left',
                        x: bounds.left + 8,
                        y: bounds.top + bounds.height / 2,
                      },
                      {
                        name: 'right',
                        x: bounds.right - 8,
                        y: bounds.top + bounds.height / 2,
                      },
                    ].map((point) => {
                      const owner = doc.elementFromPoint(point.x, point.y);
                      return {
                        ...point,
                        inViewport:
                          point.x >= 0 &&
                          point.x < view.innerWidth &&
                          point.y >= 0 &&
                          point.y < view.innerHeight,
                        owner: owner
                          ? {
                              identity: identity(owner),
                              belongsToTarget: button.contains(owner),
                            }
                          : null,
                        stack: doc
                          .elementsFromPoint(point.x, point.y)
                          .slice(0, 8)
                          .map((node) => ({
                            identity: identity(node),
                            belongsToTarget: button.contains(node),
                          })),
                      };
                    });
                    return {
                      name: button.querySelector('strong')!.textContent,
                      disabled: button.matches(':disabled'),
                      ariaDisabled: button.getAttribute('aria-disabled'),
                      inertAncestor: !!button.closest('[inert]'),
                      rect: rect(button),
                      ancestors,
                      points,
                    };
                  }),
              };
            });
          await writeFile(
            initialPath,
            JSON.stringify({ eligibility, ...initialState }, null, 2),
          );
          await testInfo.attach(`${label}-initial-state`, {
            contentType: 'application/json',
            path: initialPath,
          });
          await page.screenshot({
            path: testInfo.outputPath(`${label}-initial-state.png`),
          });
          const featureScroll = initialState.targets[0].ancestors.find((node) =>
            node.identity.class.includes('personal-board-workspace'),
          )!;
          const outerScroll = initialState.targets[0].ancestors.find((node) =>
            node.identity.class.includes('content-view'),
          )!;
          const bottomDock = initialState.dock.find((node) =>
            node.identity.class.includes('chat-dock--bottom'),
          );
          expect(
            bottomDock,
            'The journey has a visible bottom Dock',
          ).toBeDefined();
          expect(
            featureScroll.rect.bottom,
            'The Board scrollport ends above the bottom Dock',
          ).toBeLessThanOrEqual(bottomDock!.rect.top + 1);
          expect(
            outerScroll.scrollHeight - outerScroll.clientHeight,
            'The outer route does not add a second vertical scroll range',
          ).toBeLessThanOrEqual(1);
          if (width === 390) {
            expect(
              featureScroll.scrollHeight,
              'The tall Board content scrolls inside its bounded viewport',
            ).toBeGreaterThan(featureScroll.clientHeight);
          }
          for (const initialTarget of initialState.targets.filter(
            (node) => !node.disabled,
          )) {
            for (const point of initialTarget.points.filter(
              (sample) =>
                sample.inViewport &&
                sample.x >=
                  featureScroll.rect.left + featureScroll.clientLeft &&
                sample.x <
                  featureScroll.rect.left +
                    featureScroll.clientLeft +
                    featureScroll.clientWidth &&
                sample.y >= featureScroll.rect.top + featureScroll.clientTop &&
                sample.y <
                  featureScroll.rect.top +
                    featureScroll.clientTop +
                    featureScroll.clientHeight,
            )) {
              expect(
                point.owner?.belongsToTarget,
                `${initialTarget.name} ${point.name} owns its visible initial point`,
              ).toBe(true);
            }
          }
          await page.mouse.move(width / 2, 400);
          await page.mouse.wheel(0, 1200);
          try {
            if (width === 390) {
              await expect
                .poll(() => workspace.evaluate((node) => node.scrollTop))
                .toBeGreaterThan(featureScroll.scrollTop);
            }
            await expect
              .poll(() =>
                page
                  .locator('.content-view')
                  .evaluate((node) => node.scrollTop),
              )
              .toBe(0);
            await expect
              .poll(() =>
                target.evaluate((element) => {
                  const rect = element.getBoundingClientRect();
                  return [
                    [rect.left + rect.width / 2, rect.top + 8],
                    [rect.left + rect.width / 2, rect.bottom - 8],
                    [rect.left + 8, rect.top + rect.height / 2],
                    [rect.right - 8, rect.top + rect.height / 2],
                  ].every(([x, y]) =>
                    element.contains(
                      element.ownerDocument.elementFromPoint(x, y),
                    ),
                  );
                }),
              )
              .toBe(true);
          } finally {
            const metricsPath = testInfo.outputPath(
              `${label}-scroll-boundaries.json`,
            );
            await writeFile(
              metricsPath,
              JSON.stringify(
                await target.evaluate((element) => {
                  const rect = (node: Element) =>
                    node.getBoundingClientRect().toJSON();
                  return {
                    target: rect(element),
                    scrollers: [
                      '.personal-board-workspace',
                      '.content-view',
                    ].map((selector) => {
                      const node =
                        element.ownerDocument.querySelector<HTMLElement>(
                          selector,
                        )!;
                      return {
                        selector,
                        clientHeight: node.clientHeight,
                        scrollHeight: node.scrollHeight,
                        scrollTop: node.scrollTop,
                        rect: rect(node),
                      };
                    }),
                    dock: Array.from(
                      element.ownerDocument.querySelectorAll('.chat-dock'),
                    ).map(rect),
                  };
                }),
                null,
                2,
              ),
            );
            await testInfo.attach(`${label}-scroll-boundaries`, {
              contentType: 'application/json',
              path: metricsPath,
            });
            await page.screenshot({
              path: testInfo.outputPath(`${label}-revealed.png`),
            });
          }
          await target.click();
          await expect(
            page.getByRole('region', { name: 'Edit Board' }),
          ).toBeVisible();
        };
        const cancelTemplate = async () => {
          await workspace
            .getByRole('button', { name: 'Cancel', exact: true })
            .click();
          await page
            .getByRole('dialog', { name: 'Unsaved Changes' })
            .getByRole('button', { name: 'Discard', exact: true })
            .click();
        };
        await revealTemplate(
          workspace.getByRole('button', { name: /Review desk/ }),
          'review-desk',
        );
        await cancelTemplate();
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
        await workspace
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        const templateSlug = `${slug}-template`;
        expect(
          (
            await authenticatedRequest.post(`${API}/api/me/layouts`, {
              data: { slug: templateSlug, name: 'Project watch scroll Board' },
            })
          ).status(),
        ).toBe(201);
        try {
          await page.goto(`/boards/${templateSlug}`);
          const setupProject = workspace.getByRole('combobox', {
            name: 'Project for a Project watch',
          });
          await setupProject.selectOption(slug);
          const projectWatch = workspace.getByRole('button', {
            name: /Project watch/,
          });
          await expect(projectWatch).toBeEnabled();
          await revealTemplate(projectWatch, 'project-watch');
          await expect(
            page
              .getByRole('group', { name: 'Tasks', exact: true })
              .getByRole('combobox', { name: 'Project', exact: true }),
          ).toHaveValue(slug);
          await cancelTemplate();
        } finally {
          expect(
            (
              await authenticatedRequest.delete(
                `${API}/api/me/layouts/${templateSlug}`,
              )
            ).status(),
          ).toBe(200);
        }
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

for (const width of [390, 1440]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`Apps library creates, edits, launches and deletes a Board at ${width}px in ${colorScheme}`, async ({
      page,
      authenticatedRequest,
    }, testInfo) => {
      const name = `Release desk ${width} ${colorScheme} ${Date.now()}`;
      const catalogResponse = await authenticatedRequest.get(
        `${API}/api/feature-previews`,
      );
      expect(catalogResponse.ok()).toBe(true);
      const catalog = await catalogResponse.json();
      const preview = catalog.data.find(
        (entry: { id: string }) => entry.id === 'apps-library',
      );
      expect(preview).toBeDefined();
      let slug: string | undefined;
      let returnSlug: string | undefined;
      const openLibrary = async () => {
        if (width === 390)
          await page
            .getByRole('button', { name: 'Toggle menu', exact: true })
            .click();
        await page
          .getByRole('button', { name: 'Browse apps', exact: true })
          .click();
        await expect(
          page.getByRole('dialog', { name: 'Apps', exact: true }),
        ).toBeVisible();
      };
      try {
        expect(
          (
            await authenticatedRequest.put(
              `${API}/api/feature-previews/apps-library`,
              {
                data: { enabled: true },
              },
            )
          ).ok(),
        ).toBe(true);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await page.goto('/');
        await dismissSetupLauncher(page);
        await openLibrary();
        const library = page.getByRole('dialog', { name: 'Apps', exact: true });
        await expect(
          library.getByText('Make room for your work', { exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath('apps-library-before-create.png'),
          fullPage: true,
        });
        await library
          .getByRole('button', { name: 'New Board', exact: true })
          .click();
        await page.keyboard.press('Escape');
        await expect(library).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(library).toBeHidden();
        const launcher = page.getByRole('button', {
          name: 'Browse apps',
          exact: true,
        });
        await expect(launcher).toBeFocused();
        await launcher.click();
        await library
          .getByRole('button', { name: 'New Board', exact: true })
          .click();
        const details = page.getByRole('dialog', {
          name: 'New Board',
          exact: true,
        });
        await details.getByLabel('Name', { exact: true }).fill(name);
        await details.getByLabel('Icon', { exact: true }).fill('🌿');
        await details
          .getByRole('textbox', { name: 'Description', exact: true })
          .fill('Release decisions and useful links.');
        const createdResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/me/layouts' &&
            response.request().method() === 'POST',
        );
        await details
          .getByRole('button', { name: 'Create Board', exact: true })
          .click();
        const created = await createdResponse;
        expect(created.status()).toBe(201);
        slug = (await created.json()).data.slug;
        expect(slug).toBeTruthy();
        await expect(page).toHaveURL(new RegExp(`/boards/${slug}$`));
        await expect(
          page.getByRole('button', { name: /Daily brief/ }),
        ).toBeVisible();
        await expect(
          page.getByRole('dialog', { name: 'Unsaved Changes' }),
        ).toHaveCount(0);
        const projectPicker = page.getByRole('combobox', {
          name: 'Project for a Project watch',
          exact: true,
        });
        await expect(projectPicker).toHaveCSS('color-scheme', colorScheme);
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === 'running' &&
                  animation.effect?.getTiming().iterations !== Infinity &&
                  animation.timeline === document.timeline,
              )
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        const pickerBox = await projectPicker.boundingBox();
        expect(pickerBox).not.toBeNull();
        expect(pickerBox!.height).toBeGreaterThanOrEqual(44);
        expect(pickerBox!.x).toBeGreaterThanOrEqual(0);
        expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: testInfo.outputPath('apps-board-host.png'),
          fullPage: true,
          animations: 'disabled',
        });
        await openLibrary();
        await library.getByLabel('Search apps').fill(name);
        let launch = library.getByRole('button', {
          name: `${name} Personal Board Release decisions and useful links.`,
          exact: true,
        });
        await expect(launch).toContainText(
          'Release decisions and useful links.',
        );
        await expect(launch).toContainText('🌿');
        const box = await launch.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: testInfo.outputPath('apps-library-populated.png'),
          fullPage: true,
        });
        await library
          .getByRole('button', { name: `Edit ${name} details`, exact: true })
          .click();
        const edit = page.getByRole('dialog', {
          name: 'Edit app details',
          exact: true,
        });
        await edit
          .getByRole('textbox', { name: 'Description', exact: true })
          .fill('Release watch, ready to open.');
        if (width === 1440 && colorScheme === 'light') {
          await page.setViewportSize({ width: 390, height: 900 });
          await expect(
            edit.getByRole('textbox', { name: 'Description', exact: true }),
          ).toHaveValue('Release watch, ready to open.');
          await page.setViewportSize({ width, height: 900 });
          await expect(
            edit.getByRole('textbox', { name: 'Description', exact: true }),
          ).toHaveValue('Release watch, ready to open.');
        }
        await edit
          .getByRole('button', { name: 'Save details', exact: true })
          .click();
        launch = library.getByRole('button', {
          name: `${name} Personal Board Release watch, ready to open.`,
          exact: true,
        });
        await expect(launch).toContainText('Release watch, ready to open.');
        await launch.click();
        await expect(page).toHaveURL(new RegExp(`/boards/${slug}$`));
        await page.goto(`/boards/${slug}${width === 390 ? '/' : ''}`);
        await page.getByRole('button', { name: /Daily brief/ }).click();
        await page
          .getByLabel('Board name', { exact: true })
          .fill('Unsaved release desk');
        await openLibrary();
        await library.getByLabel('Search apps').fill(name);
        await expect(
          library.getByRole('button', {
            name: `${name} Personal Board Release watch, ready to open.`,
            exact: true,
          }),
        ).toContainText('Release watch, ready to open.');
        await library
          .getByRole('button', { name: `Delete ${name}`, exact: true })
          .click();
        const confirm = page.getByRole('alertdialog', {
          name: 'Delete Board?',
          exact: true,
        });
        await confirm
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        await expect(
          library.getByRole('button', {
            name: `${name} Personal Board Release watch, ready to open.`,
            exact: true,
          }),
        ).toBeVisible();
        await library
          .getByRole('button', { name: `Delete ${name}`, exact: true })
          .click();
        await confirm
          .getByRole('button', { name: 'Delete Board', exact: true })
          .click();
        const discard = page.getByRole('dialog', {
          name: 'Unsaved Changes',
          exact: true,
        });
        await expect(discard).toBeVisible();
        expect(
          (
            await authenticatedRequest.get(`${API}/api/me/layouts/${slug}`)
          ).status(),
        ).toBe(200);
        await discard
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        await expect(page).toHaveURL(new RegExp(`/boards/${slug}/?$`));
        await expect(
          page.getByLabel('Board name', { exact: true }),
        ).toHaveValue('Unsaved release desk');
        await expect(confirm).toBeVisible();
        await confirm
          .getByRole('button', { name: 'Delete Board', exact: true })
          .click();
        await expect(discard).toBeVisible();
        await discard
          .getByRole('button', { name: 'Discard', exact: true })
          .click();
        await expect(page).toHaveURL(/\/$/);
        await expect(
          library.getByRole('button', {
            name: `${name} Personal Board Release watch, ready to open.`,
            exact: true,
          }),
        ).toHaveCount(0);
        expect(
          (
            await authenticatedRequest.get(`${API}/api/me/layouts/${slug}`)
          ).status(),
        ).toBe(404);
        slug = undefined;

        const raceSlug = `response-race-${width}-${colorScheme}-${Date.now()}`;
        const raceName = `Response race ${width} ${colorScheme}`;
        returnSlug = `response-return-${width}-${colorScheme}-${Date.now()}`;
        expect(
          (
            await authenticatedRequest.post(`${API}/api/me/layouts`, {
              data: { slug: returnSlug, name: 'Return destination' },
            })
          ).status(),
        ).toBe(201);
        slug = raceSlug;
        expect(
          (
            await authenticatedRequest.post(`${API}/api/me/layouts`, {
              data: { slug: raceSlug, name: raceName },
            })
          ).status(),
        ).toBe(201);
        await page.goto(`/boards/${returnSlug}`);
        await expect(page).toHaveURL(new RegExp(`/boards/${returnSlug}$`));
        await openLibrary();
        await library
          .getByRole('button', {
            name: `${raceName} Personal Board`,
            exact: true,
          })
          .click();
        await expect(page).toHaveURL(new RegExp(`/boards/${raceSlug}$`));
        await openLibrary();
        await library
          .getByRole('button', { name: `Delete ${raceName}`, exact: true })
          .click();
        let release!: () => void;
        let responseStatus: number | undefined;
        const deliverResponse = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route(`**/api/me/layouts/${raceSlug}`, async (route) => {
          if (route.request().method() !== 'DELETE') {
            await route.continue();
            return;
          }
          const response = await route.fetch();
          const body = await response.body();
          responseStatus = response.status();
          await deliverResponse;
          await route.fulfill({ response, body });
        });
        try {
          await confirm
            .getByRole('button', { name: 'Delete Board', exact: true })
            .click();
          await expect.poll(() => responseStatus).toBe(200);
          expect(
            (
              await authenticatedRequest.get(
                `${API}/api/me/layouts/${raceSlug}`,
              )
            ).status(),
          ).toBe(404);
          await page.goBack();
          await expect(page).toHaveURL(new RegExp(`/boards/${returnSlug}$`));
          release();
          await expect(confirm).toBeHidden();
          await expect(library).toBeVisible();
          await expect(page).toHaveURL(new RegExp(`/boards/${returnSlug}$`));
          await expect(
            library.getByRole('button', {
              name: `${raceName} Personal Board`,
              exact: true,
            }),
          ).toHaveCount(0);
          expect(
            (
              await authenticatedRequest.get(
                `${API}/api/me/layouts/${returnSlug}`,
              )
            ).status(),
          ).toBe(200);
          slug = undefined;
        } finally {
          release();
          await page.unrouteAll({ behavior: 'wait' });
        }
      } finally {
        if (slug) {
          const cleanup = await authenticatedRequest.delete(
            `${API}/api/me/layouts/${slug}`,
          );
          expect([200, 404]).toContain(cleanup.status());
        }
        if (returnSlug) {
          const cleanup = await authenticatedRequest.delete(
            `${API}/api/me/layouts/${returnSlug}`,
          );
          expect([200, 404]).toContain(cleanup.status());
        }
        expect(
          (
            await authenticatedRequest.put(
              `${API}/api/feature-previews/apps-library`,
              {
                data: { enabled: preview.enabled },
              },
            )
          ).ok(),
        ).toBe(true);
      }
    });
  }
}
