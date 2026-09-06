/**
 * E2E: the Activity surface and its deep link (#928).
 *
 * `/?surface=activity` is the canonical deep link to Activity. What it means
 * changed with #928: it no longer opens a page at a route of its own and it no
 * longer offers a surface-owned "Dock this pane" — Activity is a REGISTERED
 * SURFACE (`REGION_SURFACE_REGISTRY`), the link is a REVEAL, and the region
 * model decides where a revealed surface lands. On a fine pointer that is
 * Activity's declared `defaultRegion`, `right`; on a coarse one the dock edges
 * fold to `bottom` and the reveal shows it alone.
 *
 * Activity is also the only surface today that declares every region
 * (`regions: REGION_IDS`), so it is the only one whose journey can cross the
 * dock/primary-area boundary: placed in `main` it is rendered by the route
 * outlet through a `PageFrame` (`ActivityRegionShell`) with no dock chrome at
 * all, and leaving `main` hands the primary area back to Home. That crossing
 * is what this spec covers that no other browser journey does; the dock's
 * slot-return journeys live in `project-architecture.spec.ts`.
 *
 * Every assertion names an affordance that must EXIST — the revealed surface,
 * its own region chrome, the primary-area heading — so the deep link silently
 * ceasing to produce the surface fails by name rather than passing on an
 * empty page.
 *
 * Read-only against the isolated temp-home instance apart from this browser
 * context's own `regionArrangement` device setting (localStorage).
 */
import { expect, test } from '@playwright/test';
import {
  chatDockShell,
  documentFitsViewportWidth,
  expectBoxWithinViewport,
  placeSurfaceThroughLayoutPicker,
  surfaceDockShell,
} from './helpers/region-placement';

/** The primary area's own heading, which only a `main` occupant renders. */
function mainHeading(page: import('@playwright/test').Page, name: string) {
  return page
    .locator('#station-main')
    .getByRole('heading', { level: 1, name, exact: true });
}

test.describe('Activity surface deep link', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?surface=activity');
    await expect(surfaceDockShell(page, 'Activity')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('reveals Activity in its own dock region, leaving Home and Chat where they were', async ({
    page,
  }) => {
    const activity = surfaceDockShell(page, 'Activity');
    // Activity's registered `defaultRegion`. Naming the region — rather than
    // just "something called Activity is on screen" — is what makes the
    // registry's declaration observable from outside.
    await expect(activity).toHaveClass(/chat-dock--right/);
    // It is a full region, with the chrome a region owns: its own resize
    // grip and its own visibility control, both named for the surface. A
    // side region's grip is a `button` (`DockShell`'s `isSidePanel` branch);
    // only the bottom region's is the `hr` that carries `separator`.
    await expect(
      activity.getByRole('button', { name: 'Resize Activity', exact: true }),
    ).toBeVisible();
    await expect(
      activity.getByRole('button', { name: 'Hide Activity', exact: true }),
    ).toBeVisible();

    // A reveal is not a takeover. Chat keeps its own region…
    await expect(chatDockShell(page)).toHaveClass(/chat-dock--bottom/);
    // …and the primary area still shows Home, because Activity was revealed
    // into a dock region and `main` is only ever handed to a surface that was
    // placed there (#928 C2a).
    await expect(
      page.locator('#station-main').getByRole('region', { name: 'Home' }),
      'the deep link must not displace the primary area',
    ).toBeVisible();
    await expect(
      mainHeading(page, 'Activity'),
      'a revealed surface must not also be rendered as the primary area',
    ).toHaveCount(0);
  });

  test('places the revealed surface in the primary area, keeps it across a reload, and gives the area back to Home', async ({
    page,
  }) => {
    await placeSurfaceThroughLayoutPicker(page, 'Activity', 'Main');

    // In `main` the surface is the page: `ActivityRegionShell` renders it
    // through a `PageFrame`, whose title is the registry's, so the primary
    // area now carries an `h1` that only a `main` occupant produces.
    await expect(mainHeading(page, 'Activity')).toBeVisible();
    await expect(
      page.locator('#station-main').getByRole('region', { name: 'Home' }),
      'the surface Activity replaced in the primary area must be gone',
    ).toHaveCount(0);
    // And it has no dock chrome, because `RegionShells` iterates the dock
    // regions only — no `DockShell` is mounted for a `main` occupant.
    await expect(
      surfaceDockShell(page, 'Activity'),
      'a surface holding the primary area must render no dock region',
    ).toHaveCount(0);
    // Taking `main` must not spawn a dock panel nobody asked for: the
    // displaced surface is UNPLACED there, never relocated (#928 C2a, owner
    // decision), and Chat — which was never displaced — is untouched.
    await expect(chatDockShell(page)).toHaveClass(/chat-dock--bottom/);

    // The arrangement is device state (#928 D), so a reload renders the same
    // placement. Read through the DOM: the record is the mechanism, and a
    // reload is the only thing that proves the mechanism ran.
    await page.reload();
    await expect(mainHeading(page, 'Activity')).toBeVisible({
      timeout: 15_000,
    });

    await placeSurfaceThroughLayoutPicker(page, 'Activity', 'Right');

    await expect(
      surfaceDockShell(page, 'Activity'),
      'returning Activity to the dock must give it a region again',
    ).toHaveClass(/chat-dock--right/);
    await expect(
      page.locator('#station-main').getByRole('region', { name: 'Home' }),
      'an emptied primary area reads as Home',
    ).toBeVisible();
    await expect(mainHeading(page, 'Activity')).toHaveCount(0);
  });
});

test.describe('Activity surface at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('reveals Activity alone in the one phone dock slot and gives that slot back to Chat', async ({
    page,
  }) => {
    await page.goto('/?surface=activity');
    const activity = surfaceDockShell(page, 'Activity');
    await expect(activity).toBeVisible({ timeout: 15_000 });

    // A coarse pointer folds every dock edge to `bottom` and `RegionShells`
    // mounts only the folded region, so the reveal does not put Activity
    // beside Chat — it shows it ALONE, in the single slot this device has.
    await expect(page.locator('.chat-dock')).toHaveCount(1);
    await expect(activity).toHaveClass(/chat-dock--bottom/);
    await expect(chatDockShell(page)).toHaveCount(0);

    expect(
      await documentFitsViewportWidth(page),
      'the Activity deep link must not push the phone document sideways',
    ).toBe(true);
    await expectBoxWithinViewport(page, activity, 'the revealed Activity pane');

    // The control that gives the slot back is the pane's own, and on a phone
    // it has to be thumb-sized.
    const hide = activity.getByRole('button', {
      name: 'Hide Activity',
      exact: true,
    });
    const hideBounds = await hide.boundingBox();
    expect(
      hideBounds?.height,
      "the pane's own visibility control must be a 44px tap target",
    ).toBeGreaterThanOrEqual(44);

    await hide.click();

    // Hiding the only visible dock region hands the slot to Chat's region:
    // `foldedDockRegion` falls back to wherever Chat is.
    await expect(page.locator('.chat-dock')).toHaveCount(1);
    await expect(
      chatDockShell(page),
      'hiding the revealed pane must return the one phone dock slot to Chat',
    ).toHaveClass(/chat-dock--bottom/);
    await expect(activity).toHaveCount(0);
    expect(
      await documentFitsViewportWidth(page),
      'returning the slot to Chat must not push the phone document sideways',
    ).toBe(true);
  });
});
