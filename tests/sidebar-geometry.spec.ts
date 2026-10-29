import { expect, type Page, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

// Browser geometry and keyboard proof for the Quiet tree workspace map.
const CENTER_TOLERANCE_PX = 2;
const CHIP = '.sidebar__layout-chips .sidebar__layout-chip';

/**
 * Several real-length names exercise the vertical view list. Registered after `seedOrchestrationRoutes` so it wins: a later
 * `page.route` handles before an earlier one.
 */
async function seedManyLayouts(page: Page) {
  const layouts = [
    { slug: 'code', name: 'Coding', type: 'coding' },
    { slug: 'tasks', name: 'Tasks', type: 'tasks' },
    { slug: 'chat', name: 'Chat', type: 'chat' },
    { slug: 'knowledge', name: 'Knowledge', type: 'custom' },
    { slug: 'release-review', name: 'Release review', type: 'custom' },
  ].map((layout, index) => ({
    id: `l${index}`,
    projectSlug: 'dev',
    icon: '🧩',
    ...layout,
  }));
  await page.route('**/api/projects/dev/layouts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: layouts }),
    }),
  );
}

async function openDevProject(page: Page) {
  await seedManyLayouts(page);
  // Only the selected project renders its configured views.
  await page.goto('/projects/dev');
  await dismissSetupLauncher(page);
  await expect(page.locator(CHIP).first()).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Starting Station', exact: true }),
  ).toBeHidden();
}

test.describe('Sidebar layout chips and header lockup geometry (#2063)', () => {
  test.beforeEach(async ({ page }) => {
    await seedOrchestrationRoutes(page);
  });

  test('project views stack vertically without widening the rail', async ({
    page,
  }) => {
    await openDevProject(page);
    const metrics = await page.locator(CHIP).evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, right: box.right, top: box.top, bottom: box.bottom };
      }),
    );
    expect(metrics).toHaveLength(5);
    const sidebar = await page.locator('.sidebar').boundingBox();
    if (!sidebar) throw new Error('workspace map has no bounds');
    for (const [index, row] of metrics.entries()) {
      expect(row.x).toBeGreaterThan(sidebar.x);
      expect(row.right).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1);
      if (index > 0)
        expect(row.top).toBeGreaterThanOrEqual(metrics[index - 1].bottom);
    }
    await page.locator(CHIP).last().focus();
    await expect(page.locator(CHIP).last()).toBeInViewport();
  });

  test('the view list is one tab stop whose Up and Down keys move focus', async ({
    page,
  }) => {
    await openDevProject(page);

    const names = async () =>
      page.locator(CHIP).evaluateAll((elements) =>
        elements.map((element) => ({
          text: element.textContent,
          tabIndex: (element as HTMLElement).tabIndex,
        })),
      );

    // One tab stop: a keyboard reader passes the whole row in one Tab, rather
    // than the one-Tab-per-layout the nested tree charged.
    expect((await names()).filter((chip) => chip.tabIndex === 0).length).toBe(
      1,
    );

    await page.locator(CHIP).first().focus();
    const viewButton = (name: string) =>
      page
        .getByRole('toolbar', { name: 'Dev layouts' })
        .getByRole('button', { name, exact: true });
    await expect(viewButton('Coding')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(viewButton('Tasks')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(viewButton('Chat')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(viewButton('Tasks')).toBeFocused();
    await page.keyboard.press('End');
    await expect(viewButton('Release review')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(viewButton('Coding')).toBeFocused();

    // The tab stop followed the focus, so Tab re-enters where the reader left.
    expect((await names()).filter((chip) => chip.tabIndex === 0).length).toBe(
      1,
    );
  });

  // The phone drawer's own chip geometry — the 44px floor and the wrap that
  // keeps it from widening the drawer — is swept against a REAL seeded project
  // in `mobile-surface-sweep.spec.ts`, beside the other phone floors.

  test('collapsed project tiles stay centered in the rail', async ({
    page,
  }) => {
    await page.goto('/agents');
    await dismissSetupLauncher(page);
    await page.getByRole('button', { name: 'Collapse workspace map' }).click();
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toHaveClass(/sidebar--collapsed/);
    await expect(sidebar).toHaveCSS('width', '52px');
    const rail = await sidebar.boundingBox();
    const mark = await page
      .locator('.sidebar__project-row .project-icon')
      .boundingBox();
    if (!rail || !mark)
      throw new Error('collapsed project identity has no bounds');
    expect(
      Math.abs(mark.x + mark.width / 2 - (rail.x + rail.width / 2)),
    ).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
    await page.getByRole('button', { name: 'Dev views', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Dev views' })).toBeVisible();
  });

  test('the app header owns collapse and aligns with the sidebar header', async ({
    page,
  }) => {
    await page.goto('/agents');
    await dismissSetupLauncher(page);
    const toggle = page
      .getByRole('banner')
      .getByRole('button', { name: 'Collapse workspace map' });
    await expect(toggle).toBeVisible();
    const glyph = await toggle.locator('svg').boundingBox();
    if (!glyph) throw new Error('workspace map glyph has no bounds');
    expect(glyph.width).toBeGreaterThanOrEqual(16);
    expect(glyph.height).toBeGreaterThanOrEqual(16);

    await expect(
      page.getByRole('navigation').getByRole('button', {
        name: /Collapse workspace map|Collapse sidebar/,
      }),
    ).toHaveCount(0);
    const sidebarHeader = await page.locator('.sidebar__header').boundingBox();
    const header = await page.getByRole('banner').boundingBox();
    if (!sidebarHeader || !header)
      throw new Error('shell headers have no bounds');
    expect(
      Math.abs(
        sidebarHeader.y + sidebarHeader.height - (header.y + header.height),
      ),
    ).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
    await toggle.click();
    await expect(
      page.getByRole('button', { name: 'Expand workspace map' }),
    ).toBeVisible();
  });
});
