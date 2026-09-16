import { expect, type Page, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

// #2063 replaced the nested layout tree with a chip row and retired the
// expand/collapse chevron with it. The chevron-centering tests archive#1629
// left here went with the control they measured; what replaces them are the
// claims a chip row makes that jsdom cannot answer — chips WRAP rather than
// widen the rail, arrow keys really move focus in a browser, and each chip
// reaches the 44px touch floor in the phone drawer.
const CENTER_TOLERANCE_PX = 2;
const CHIP_ROW = '.sidebar__layout-chips';
const CHIP = '.sidebar__layout-chips .sidebar__layout-chip';

/**
 * Enough layouts, with real-length names, that a ~250px rail cannot hold them
 * on one line. Registered after `seedOrchestrationRoutes` so it wins: a later
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
  // The chips belong to the SELECTED project, so the route is what puts them
  // on screen — there is no expand control to click any more.
  await page.goto('/projects/dev');
  await dismissSetupLauncher(page);
  await expect(page.locator(CHIP).first()).toBeVisible();
}

test.describe('Sidebar layout chips and header lockup geometry (#2063)', () => {
  test.beforeEach(async ({ page }) => {
    await seedOrchestrationRoutes(page);
  });

  test('chips wrap inside the rail instead of widening or overflowing it', async ({
    page,
  }) => {
    await openDevProject(page);

    const row = await page.locator(CHIP_ROW).boundingBox();
    const boxes = await page.locator(CHIP).evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, right: rect.right, left: rect.left };
      }),
    );
    if (!row) throw new Error('the chip row did not render a bounding box');
    expect(boxes.length).toBe(5);

    // Not vacuous as a wrap claim: five chips this wide cannot fit one line,
    // so more than one distinct top means the row really wrapped.
    expect(
      new Set(boxes.map((box) => Math.round(box.top))).size,
    ).toBeGreaterThan(1);
    for (const box of boxes) {
      expect(box.right).toBeLessThanOrEqual(row.x + row.width + 1);
      expect(box.left).toBeGreaterThanOrEqual(row.x - 1);
    }

    // And the rail itself did not grow to accommodate them.
    const sidebar = await page.locator('.sidebar').boundingBox();
    if (!sidebar) throw new Error('the sidebar did not render a bounding box');
    expect(row.x + row.width).toBeLessThanOrEqual(
      sidebar.x + sidebar.width + 1,
    );
  });

  test('the chip row is one tab stop whose arrow keys move focus between chips', async ({
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
    const focused = () =>
      page.evaluate(() => document.activeElement?.textContent ?? null);
    expect(await focused()).toBe('Coding');

    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('Tasks');
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('Chat');
    await page.keyboard.press('ArrowLeft');
    expect(await focused()).toBe('Tasks');
    await page.keyboard.press('End');
    expect(await focused()).toBe('Release review');
    await page.keyboard.press('Home');
    expect(await focused()).toBe('Coding');

    // The tab stop followed the focus, so Tab re-enters where the reader left.
    expect((await names()).filter((chip) => chip.tabIndex === 0).length).toBe(
      1,
    );
  });

  // The phone drawer's own chip geometry — the 44px floor and the wrap that
  // keeps it from widening the drawer — is swept against a REAL seeded project
  // in `mobile-surface-sweep.spec.ts`, beside the other phone floors.

  test('keeps the collapsed-rail project accent stripe anchored after the row-main wrapper', async ({
    page,
  }) => {
    // Plan stop-short risk (archive#1629): the `.sidebar__project-row-main`
    // wrapper is the nearest `position: relative` ancestor for the
    // collapsed-rail accent stripe (`.sidebar--collapsed
    // .sidebar__project-accent { position: absolute; left: 2px; }`) instead
    // of `.sidebar__project-row` itself. Neither wrapper carries
    // padding/margin/border, so the accent should still sit 2px from the
    // row's own left edge — proving the wrapper is a no-op for this
    // pre-existing absolutely-positioned sibling.
    await page.goto('/agents');
    await dismissSetupLauncher(page);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar--collapsed/);

    const row = page.locator('.sidebar__project-row');
    const accent = page.locator('.sidebar__project-accent');
    await expect(accent).toBeVisible();

    const rowBox = await row.boundingBox();
    const accentBox = await accent.boundingBox();
    if (!rowBox || !accentBox) {
      throw new Error(
        'collapsed sidebar project row did not render a bounding box',
      );
    }
    expect(Math.abs(accentBox.x - (rowBox.x + 2))).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );
  });

  test('header lockup places the collapse button after the brand name on both the plain and macOS-inset shells', async ({
    page,
  }) => {
    await page.goto('/agents');
    await dismissSetupLauncher(page);

    const brandName = page.locator('.sidebar__brand-name');
    const collapseButton = page.locator('.sidebar__collapse-button');
    await expect(brandName).toBeVisible();
    await expect(collapseButton).toBeVisible();

    const brandBox = await brandName.boundingBox();
    const collapseBox = await collapseButton.boundingBox();
    if (!brandBox || !collapseBox) {
      throw new Error('sidebar header did not render a bounding box');
    }
    // The collapse button's own left edge sits to the right of the brand
    // name's right edge — proving the reorder pushes the *button* to the
    // header's right edge instead of pushing the name away from the logo.
    expect(collapseBox.x).toBeGreaterThan(brandBox.x + brandBox.width);

    // Repeat under the macOS overlay-title-bar shell variant (traffic-light
    // inset padding), without needing a real Tauri host.
    await page.evaluate(() => {
      document.documentElement.classList.add('is-desktop-mac');
    });
    const macBrandBox = await brandName.boundingBox();
    const macCollapseBox = await collapseButton.boundingBox();
    if (!macBrandBox || !macCollapseBox) {
      throw new Error('sidebar header did not render a bounding box');
    }
    expect(macCollapseBox.x).toBeGreaterThan(macBrandBox.x + macBrandBox.width);
  });
});
