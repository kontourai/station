import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';

const API = resolveE2EApiBase();
const slug = 'work-board-live';
const name = 'Work Board live project';
let directory = '';

type Project = { id: string };
type BoardPin = {
  reference: { kind?: string; id?: string };
  x: number;
  y: number;
  width: number;
  height: number;
};
type Board = { revision: number; pins: BoardPin[] };
type Task = { id: string; projectId: string; title: string };

test.describe
  .serial('Work Board real product journey', () => {
    test.beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), 'station-work-board-'));
    });

    test.beforeEach(async ({ authenticatedRequest }) => {
      await authenticatedRequest.delete(`${API}/api/projects/${slug}`);
      const created = await authenticatedRequest.post(`${API}/api/projects`, {
        data: { name, slug, workingDirectory: directory },
      });
      expect(created.status(), 'create real Work Board project').toBe(201);
    });

    test.afterAll(() => {
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    test('opens from a Project and persists pins, geometry, title, camera, cleanup, and undo', async ({
      page,
      authenticatedRequest,
    }) => {
      const projectResponse = await authenticatedRequest.get(
        `${API}/api/projects/${slug}`,
      );
      expect(projectResponse.status(), 'read exact project identity').toBe(200);
      const project = (await projectResponse.json()).data as Project;
      expect(project.id).toBeTruthy();

      await page.goto(`/projects/${slug}`);
      await page.getByRole('button', { name: /Add pane/i }).click();
      const picker = page.getByRole('dialog', { name: 'Add workspace pane' });
      await expect(picker).toBeVisible({ timeout: 20_000 });
      await picker.getByRole('button', { name: /Open Work Board/i }).click();
      await expect(
        page.getByRole('region', { name: 'Personal Work Board' }),
      ).toBeVisible({ timeout: 20_000 });

      const kind = page.getByLabel('Reference kind');
      const id = page.getByLabel('Exact reference ID');
      const pin = page.getByRole('button', { name: 'Pin work' });
      const initialBoardResponse = await authenticatedRequest.get(
        `${API}/api/spatial-board`,
      );
      expect(initialBoardResponse.status(), 'read initial Board revision').toBe(
        200,
      );
      let expectedBoardRevision = (
        (await initialBoardResponse.json()).data as Board
      ).revision;
      const submitPin = async () => {
        await pin.click();
        expectedBoardRevision += 1;
        await expect(
          page.getByText(`Personal layout · revision ${expectedBoardRevision}`),
        ).toBeVisible();
      };
      await kind.selectOption('project');
      await id.fill(project.id);
      await submitPin();
      await kind.selectOption('task');
      await id.fill('missing-task');
      await page.getByLabel('Exact Task Project slug').fill(slug);
      await submitPin();
      await kind.selectOption('flow-run');
      await id.fill('missing-run');
      await page.getByLabel('Exact Project ID').fill(project.id);
      await page.getByLabel('Exact gate ID (optional)').fill('missing-gate');
      await submitPin();
      await kind.selectOption('artifact');
      await id.fill('missing-artifact');
      await page.getByLabel('Exact run ID').fill('missing-run');
      await submitPin();
      await kind.selectOption('session');
      await id.fill('missing-session');
      await submitPin();
      await kind.selectOption('approval');
      await id.fill('missing-approval');
      await submitPin();
      await kind.selectOption('scheduler-receipt');
      await id.fill('missing-scheduled-outcome');
      await submitPin();
      await kind.selectOption('review-receipt');
      await id.fill('missing-receipt');
      await page.getByLabel('Exact Project slug').fill(slug);
      await submitPin();
      await kind.selectOption('agent');
      await id.fill('missing-agent');
      await submitPin();

      const boardBeforeMoveResponse = await authenticatedRequest.get(
        `${API}/api/spatial-board`,
      );
      expect(
        boardBeforeMoveResponse.status(),
        'read the revision after every pin mutation',
      ).toBe(200);
      const boardBeforeMove = (await boardBeforeMoveResponse.json())
        .data as Board;
      expect(boardBeforeMove.pins).toHaveLength(9);
      await expect(
        page.getByText(
          `Personal layout · revision ${boardBeforeMove.revision}`,
        ),
      ).toBeVisible();

      const canvas = page.getByRole('region', { name: 'Spatial canvas' });
      await canvas.scrollIntoViewIfNeeded();
      const canvasBox = await canvas.boundingBox();
      if (!canvasBox) throw new Error('Work Board canvas has no box');
      // Hit the materialised plane, not a card: the plane owns empty-space pan.
      await page.mouse.move(canvasBox.x + 12, canvasBox.y + 230);
      await page.mouse.down();
      await page.mouse.move(canvasBox.x + 32, canvasBox.y + 245);
      await page.mouse.up();
      expectedBoardRevision += 1;
      await expect(
        page.getByText(`Personal layout · revision ${expectedBoardRevision}`),
      ).toBeVisible();

      const move = page.getByRole('button', {
        name: /Move project .*Arrow keys move/i,
      });
      const moveBox = await move.boundingBox();
      if (!moveBox) throw new Error('Work Board move handle has no box');
      await page.mouse.move(
        moveBox.x + moveBox.width / 2,
        moveBox.y + moveBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        moveBox.x + moveBox.width / 2 + 40,
        moveBox.y + moveBox.height / 2 + 30,
      );
      await page.mouse.up();
      expectedBoardRevision += 1;
      await expect(
        page.getByText(`Personal layout · revision ${expectedBoardRevision}`),
      ).toBeVisible();
      const projectCard = move.locator('xpath=ancestor::article');
      await expect(projectCard).toHaveCSS('left', '64px');
      await expect(projectCard).toHaveCSS('top', '54px');
      const resize = page.getByRole('button', {
        name: `Resize project ${project.id}`,
      });
      await expect(resize).toBeEnabled();
      const resizeBox = await resize.boundingBox();
      if (!resizeBox) throw new Error('Work Board resize handle has no box');
      await page.mouse.move(
        resizeBox.x + resizeBox.width / 2,
        resizeBox.y + resizeBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        resizeBox.x + resizeBox.width / 2 + 60,
        resizeBox.y + resizeBox.height / 2 + 60,
      );
      await page.mouse.up();
      expectedBoardRevision += 1;
      await expect(
        page.getByText(`Personal layout · revision ${expectedBoardRevision}`),
      ).toBeVisible();
      await expect(projectCard).toHaveCSS('width', '260px');
      await expect(move).toBeEnabled();
      await move.press('Shift+ArrowRight');
      expectedBoardRevision += 1;
      await expect(
        page.getByText(`Personal layout · revision ${expectedBoardRevision}`),
      ).toBeVisible();
      await expect(projectCard).toHaveCSS('width', '280px');

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByRole('button', { name: 'Open canvas' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Open canvas' }).click();
      const removeProject = page.getByRole('button', {
        name: `Remove project ${project.id} from canvas`,
      });
      await removeProject.scrollIntoViewIfNeeded();
      const flowCard = page.getByRole('article', { name: /Flow run pin/i });
      await flowCard.scrollIntoViewIfNeeded();
      for (const width of [152, 200]) {
        const bounds = await flowCard.evaluate((card, cardWidth) => {
          card.style.width = `${cardWidth}px`;
          const badge = card.querySelector('.badge');
          const title = card.querySelector('.spatial-board__pin-title');
          const identity = card.querySelector('code');
          if (badge) badge.textContent = 'Multiple matches';
          if (title)
            title.textContent =
              'Flow run with the longest resolved work title that can fit in this card';
          if (identity)
            identity.textContent =
              'flow run project-identity-with-a-long-realistic-slug/run-identity-with-a-long-realistic-suffix/gate-identity';
          const content = card.querySelector('.spatial-board__pin-content');
          const footer = card.querySelector('.spatial-board__pin-actions');
          const resize = card.querySelector('.spatial-board__resize');
          const remove = card.querySelector('[aria-label*="from canvas"]');
          if (!content || !footer || !resize || !remove)
            throw new Error('expected Flow card anatomy');
          const contentBox = content.getBoundingClientRect();
          const footerBox = footer.getBoundingClientRect();
          const resizeBox = resize.getBoundingClientRect();
          const removeBox = remove.getBoundingClientRect();
          return {
            contentBottom: contentBox.bottom,
            footerTop: footerBox.top,
            resizeRight: resizeBox.right,
            removeLeft: removeBox.left,
          };
        }, width);
        expect(bounds.footerTop).toBeGreaterThanOrEqual(bounds.contentBottom);
        expect(bounds.resizeRight).toBeLessThanOrEqual(bounds.removeLeft);
      }
      await canvas.evaluate((element) => {
        element.scrollLeft = 0;
        element.scrollTop = 0;
      });
      await canvas.scrollIntoViewIfNeeded();
      await expect(removeProject).toBeInViewport();
      const removeBox = await removeProject.boundingBox();
      if (!removeBox) throw new Error('Work Board remove action has no box');
      expect(removeBox.x).toBeGreaterThanOrEqual(0);
      expect(removeBox.x + removeBox.width).toBeLessThanOrEqual(390);
      expect(removeBox.y).toBeGreaterThan(0);
      expect(removeBox.y + removeBox.height).toBeLessThan(760);
      expect(
        await removeProject.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return document
            .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.closest('button')
            ?.getAttribute('aria-label');
        }),
      ).toBe(`Remove project ${project.id} from canvas`);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      await page.getByLabel('Board title').fill('Persisted Work Board');
      await page.getByRole('button', { name: 'Save title' }).click();
      await expect(
        page.getByRole('heading', { name: 'Persisted Work Board' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await expect(page.getByLabel('Zoom level')).toHaveText('125%');
      await expect(page.getByText('Not found').first()).toBeVisible({
        timeout: 20_000,
      });
      const cleanup = page.getByRole('button', {
        name: /Remove \d+ confirmed missing pins/,
      });
      await expect(cleanup).toBeVisible();
      await cleanup.click();
      await expect(cleanup).toBeHidden();
      await expect(
        page.getByText(`project ${project.id}`).first(),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(cleanup).toBeVisible();

      const beforeReload = await authenticatedRequest.get(
        `${API}/api/spatial-board`,
      );
      expect(beforeReload.status(), 'read real persisted Work Board').toBe(200);
      const persisted = (await beforeReload.json()).data as Board;
      expect(persisted.pins.length).toBeGreaterThanOrEqual(2);
      const projectPin = persisted.pins.find(
        (candidate) =>
          candidate.reference.kind === 'project' &&
          candidate.reference.id === project.id,
      );
      expect(projectPin).toMatchObject({
        x: 64,
        y: 54,
        width: 280,
        height: 300,
      });
      await page.reload();
      await expect(page.getByLabel('Board title')).toHaveValue(
        'Persisted Work Board',
      );
      await expect(page.getByLabel('Zoom level')).toHaveText('125%');
    });

    test('pins a current Task through its exact Project slug without owner repair', async ({
      page,
      authenticatedRequest,
    }) => {
      const taskResponse = await authenticatedRequest.post(`${API}/api/tasks`, {
        data: {
          projectId: slug,
          title: 'Current Work Board task',
        },
      });
      expect(taskResponse.status(), 'create current Task').toBe(201);
      const task = (await taskResponse.json()).data as Task;
      expect(task).toMatchObject({
        projectId: slug,
        title: 'Current Work Board task',
      });

      await page.goto(`/projects/${slug}`);
      await page.getByRole('button', { name: /Add pane/i }).click();
      const picker = page.getByRole('dialog', { name: 'Add workspace pane' });
      await expect(picker).toBeVisible({ timeout: 20_000 });
      await picker.getByRole('button', { name: /Open Work Board/i }).click();
      await expect(
        page.getByRole('region', { name: 'Personal Work Board' }),
      ).toBeVisible({ timeout: 20_000 });
      await page.getByLabel('Reference kind').selectOption('task');
      await page.getByLabel('Exact reference ID').fill(task.id);
      await page.getByLabel('Exact Task Project slug').fill(slug);
      await page.getByRole('button', { name: 'Pin work' }).click();

      await expect(
        page.getByText('Current Work Board task').first(),
      ).toBeVisible({
        timeout: 20_000,
      });
      const resolved = await authenticatedRequest.get(
        `${API}/api/spatial-board/resolved`,
      );
      expect(resolved.status(), 'resolve current Task pin').toBe(200);
      expect((await resolved.json()).data.pins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reference: { kind: 'task', id: task.id, projectId: slug },
            state: 'current',
            title: 'Current Work Board task',
          }),
        ]),
      );
    });
  });
