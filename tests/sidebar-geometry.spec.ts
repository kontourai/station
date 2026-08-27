import { expect, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

// Chevron centering (#1629): the chevron's containing block used to be
// `.sidebar__project-row`, which also held the Chats pill and the expanded
// `.sidebar__layouts` list as siblings — either one inflated the row's height
// and pushed the chevron (`position: absolute; top: 50%`) off-center from the
// project button it belongs to. The fix scopes the chevron's containing block
// to a new `.sidebar__project-row-main` wrapper around only the button +
// chevron. jsdom cannot compute real layout, so this positioning claim can
// only be proven here, in a real browser, via getBoundingClientRect() reads.
const PROJECT_BTN = '.sidebar__project-row-main .sidebar__project-btn';
const CHEVRON = '.sidebar__project-row-main .sidebar__chevron';
const CENTER_TOLERANCE_PX = 2;

async function chevronOffsetFromButtonCenter(
  page: import('@playwright/test').Page,
) {
  const chevronBox = await page.locator(CHEVRON).boundingBox();
  const btnBox = await page.locator(PROJECT_BTN).boundingBox();
  if (!chevronBox || !btnBox) {
    throw new Error('sidebar project row did not render a bounding box');
  }
  const chevronCenter = chevronBox.y + chevronBox.height / 2;
  const btnCenter = btnBox.y + btnBox.height / 2;
  return Math.abs(chevronCenter - btnCenter);
}

test.describe('Sidebar chevron and header lockup geometry (#1629)', () => {
  test.beforeEach(async ({ page }) => {
    await seedOrchestrationRoutes(page);
  });

  test('chevron centers on the project button in the default (non-expanded) row', async ({
    page,
  }) => {
    // A route with no active project keeps the "Dev" row's `expanded` state
    // at its default (false) — proving the collapsed-by-default case
    // separately from the expanded case below.
    await page.goto('/agents');
    await dismissSetupLauncher(page);

    const chevron = page.locator(CHEVRON);
    await expect(chevron).toBeVisible();
    await expect(chevron).not.toHaveClass(/sidebar__chevron--open/);

    expect(await chevronOffsetFromButtonCenter(page)).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );
  });

  test('chevron still centers on the project button when the row is expanded to show layouts', async ({
    page,
  }) => {
    await page.goto('/agents');
    await dismissSetupLauncher(page);

    await page.getByRole('button', { name: 'Expand Dev layouts' }).click();
    await expect(page.locator('.sidebar__layouts')).toBeVisible();
    await expect(
      page.locator('.sidebar__layouts .sidebar__layout-btn').first(),
    ).toBeVisible();

    expect(await chevronOffsetFromButtonCenter(page)).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );
  });

  test('chevron centering holds on the mobile sheet in both default and expanded states', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/agents');
    await dismissSetupLauncher(page);

    await page.getByRole('button', { name: 'Toggle menu' }).click();
    await expect(page.locator(CHEVRON)).toBeVisible();

    expect(await chevronOffsetFromButtonCenter(page)).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );

    await page.getByRole('button', { name: 'Expand Dev layouts' }).click();
    await expect(page.locator('.sidebar__layouts')).toBeVisible();

    expect(await chevronOffsetFromButtonCenter(page)).toBeLessThanOrEqual(
      CENTER_TOLERANCE_PX,
    );
  });

  test('keeps the collapsed-rail project accent stripe anchored after the row-main wrapper', async ({
    page,
  }) => {
    // Plan stop-short risk (#1629): the new `.sidebar__project-row-main`
    // wrapper becomes the nearest `position: relative` ancestor for the
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
