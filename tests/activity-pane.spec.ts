/**
 * E2E: Activity as a Workspace Pane (epic station#4142 M3, station#3193).
 *
 * `/activity` is the STANDALONE PLACEMENT of the Activity pane — the sessions
 * surface reached through the pane path, which is what puts a real
 * "Dock this pane" in the page header. Docking replaces the ambient Chat
 * occupant with the same pane occurrence, the choice survives a reload
 * through the persisted ambient document, and the dock-slot header's
 * occupant picker (M5) returns the slot to Chat — Chat as one entry of the
 * derived menu, not a fixed return action.
 *
 * Every assertion here names an affordance that must EXIST — an absent dock
 * action, dock slot, or restored occupant fails the spec by name, so the
 * route silently ceasing to produce the pane occurrence cannot pass.
 *
 * Read-only against the isolated temp-home instance apart from the
 * browser-local ambient dock document (this context's localStorage).
 */
import { expect, test } from '@playwright/test';

const AMBIENT_DOCK_STORAGE_KEY =
  'station:workspace-pane-host:v2:ambient:chat-dock';

test.describe('Activity pane standalone placement', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/activity');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Activity' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('the /activity route renders the sessions surface with a real dock action', async ({
    page,
  }) => {
    // The split-pane surface is present (its list region carries the
    // surface's own label), and the pane placement contributes the dock
    // action to the page header — not a stray control above the panes.
    await expect(page.locator('.chat-dock')).toBeVisible({ timeout: 10_000 });
    const dockAction = page
      .locator('#station-main')
      .getByRole('button', { name: 'Dock this pane' });
    await expect(dockAction).toBeVisible();
    expect(
      await dockAction.evaluate((button) =>
        Boolean(button.closest('.page__actions')),
      ),
      'the dock action must live in the page header actions slot',
    ).toBe(true);
  });

  test('docks Activity through the ambient document, survives reload, and returns the slot to Chat', async ({
    page,
  }) => {
    await expect(page.locator('.chat-dock')).toBeVisible({ timeout: 10_000 });
    await page
      .locator('#station-main')
      .getByRole('button', { name: 'Dock this pane' })
      .click();
    const activityDock = page.locator('.dock-slot[aria-label="Activity dock"]');
    await expect(activityDock).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          ([key]) => window.localStorage.getItem(key),
          [AMBIENT_DOCK_STORAGE_KEY],
        ),
      )
      .toContain('pane:builtin:activity');
    await page.reload();
    await expect(activityDock).toBeVisible({ timeout: 10_000 });
    // M5: the fixed header "return to Chat" action is gone — the occupant
    // picker replaces the occupant, Chat as one entry of the derived list.
    await activityDock
      .locator('.dock-slot__header')
      .getByRole('button', { name: 'Docked pane: Activity' })
      .click();
    await page
      .getByRole('menu', { name: 'Docked pane' })
      .getByRole('menuitemradio', { name: 'Chat' })
      .click();
    await expect(page.locator('.chat-dock')).toBeVisible();
    await expect(page.locator('.dock-slot')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.querySelector('.chat-dock')?.parentElement?.className,
      ),
      'returning to Chat must keep it a direct shell child',
    ).toMatch(/app__main/);
  });
});

test.describe('Activity pane at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('renders, docks and stays inside the phone viewport', async ({
    page,
  }) => {
    await page.goto('/activity');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Activity' }),
    ).toBeVisible({ timeout: 10_000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'the activity route must not push the phone document sideways',
    ).toBe(true);
    await page
      .locator('#station-main')
      .getByRole('button', { name: 'Dock this pane' })
      .click();
    const activityDock = page.locator('.dock-slot[aria-label="Activity dock"]');
    await expect(activityDock).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'a docked Activity pane must not push the phone document sideways',
    ).toBe(true);
    // M5: the header affordance is the occupant picker now.
    const trigger = activityDock
      .locator('.dock-slot__header')
      .getByRole('button', { name: 'Docked pane: Activity' });
    const bounds = await trigger.boundingBox();
    expect(
      bounds?.height,
      'the occupant picker trigger must be a 44px tap target',
    ).toBeGreaterThanOrEqual(44);
    await trigger.click();
    await page
      .getByRole('menu', { name: 'Docked pane' })
      .getByRole('menuitemradio', { name: 'Chat' })
      .click();
    await expect(page.locator('.chat-dock')).toBeVisible();
  });
});
