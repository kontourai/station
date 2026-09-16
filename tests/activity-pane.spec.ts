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
  chooseSurfaceInEmptyRegion,
  documentFitsViewportWidth,
  expectBoxWithinViewport,
  FIRST_RENDER_TIMEOUT_MS,
  moveLonePaneToRegion,
  openChooserFromToggle,
  showSurfaceInEmptyRegion,
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
      timeout: FIRST_RENDER_TIMEOUT_MS,
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
    ).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await expect(
      mainHeading(page, 'Activity'),
      'a revealed surface must not also be rendered as the primary area',
    ).toHaveCount(0);
  });

  test('places the revealed surface in the primary area, keeps it across a reload, and gives the area back to Home', async ({
    page,
  }) => {
    // #2160: Activity is alone in `right`, so it renders no tab strip — and
    // the bar's own "Move Activity" button opens the same menu a tab would,
    // with Main among its rows. That is the whole route: no detour through
    // another region to acquire a tab first, and no ⋮⋮ grab, which moves the
    // region and offers dock edges only.
    await moveLonePaneToRegion(page, 'Activity', 'Main');

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
    // reload is the only thing that proves the mechanism ran. It still
    // discriminates despite the `?surface=activity` the reload replays: an
    // unplaced reveal lands in Activity's `defaultRegion` `right`, never in
    // `main`, so only a persisted record can put it back in the primary area.
    await page.reload();
    await expect(mainHeading(page, 'Activity')).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT_MS,
    });

    // The way back from `main` is the empty Right region: its toolbar toggle
    // opens the region, and the chooser in its body offers Activity because
    // it declares that region (#2143, #2154, #2155).
    await showSurfaceInEmptyRegion(page, 'Activity', 'Right');

    await expect(
      surfaceDockShell(page, 'Activity'),
      'returning Activity to the dock must give it a region again',
    ).toHaveClass(/chat-dock--right/);
    await expect(
      page.locator('#station-main').getByRole('region', { name: 'Home' }),
      'an emptied primary area reads as Home',
    ).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await expect(mainHeading(page, 'Activity')).toHaveCount(0);
  });
});

test.describe('An empty region is a chooser', () => {
  /**
   * #2154: a VISIBLE, EMPTY dock region renders a chooser in its body —
   * every registry surface declaring the region, the coding rows disabled
   * with the reason while the dock has no project — and choosing Activity
   * places it there through the model. No control produces the visible-empty
   * state before #2155 (a region's last tab has no close; the toolbar button
   * on an empty region opens its offer menu), so the arrangement is seeded
   * the way a returning device's is: through the `regionArrangement` device
   * setting, the record the model reads on boot (#2153 pins the shape).
   */
  /**
   * #2155: the chooser's other route — a HOLD on the region's toolbar toggle,
   * which is the only route a coarse pointer has to it.
   *
   * THE SECOND HOLD IS THE TEST (review B1). A hold opens the panel from a
   * timer while the pointer is still DOWN, so the panel's dismiss backdrop is
   * on screen before the release — and a backdrop that dismissed on any
   * release would eat the gesture that opened it. On the FIRST hold the lazy
   * chunk's fetch hides that: the panel arrives late enough that the release
   * beats it. Once the module registry is warm the backdrop is up within a
   * frame of the 500ms mark, which is the real ordering and the one this
   * asserts.
   */
  test('a hold on the Right toggle opens the chooser, and again with the module warm', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(chatDockShell(page)).toHaveClass(/chat-dock--bottom/, {
      timeout: FIRST_RENDER_TIMEOUT_MS,
    });
    const toggle = page.getByRole('button', {
      name: 'Right region',
      exact: true,
    });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Cold chunk.
    const first = await openChooserFromToggle(page, 'Right');
    await expect(
      first.getByRole('menuitem', { name: /^Activity/ }),
    ).toBeVisible();
    // The hold must not ALSO have toggled the region under its own panel.
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    await expect(first).toBeHidden();

    // Warm chunk: the panel is up before the release lands.
    const second = await openChooserFromToggle(page, 'Right');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await second.getByRole('menuitem', { name: /^Activity/ }).click();
    await expect(second).toBeHidden();
    await expect(
      surfaceDockShell(page, 'Activity'),
      'choosing through the held-open panel must place Activity in Right',
    ).toHaveClass(/chat-dock--right/);
  });

  test('a visible empty Right region lists what can go there and places Activity on choice', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-device-settings-v1',
        JSON.stringify({
          version: 2,
          values: {
            regionArrangement: {
              version: 1,
              regions: {
                main: {
                  visible: true,
                  size: 0,
                  occupant: { kind: 'surface', id: 'home' },
                },
                left: { visible: false, size: 400, occupant: null },
                right: { visible: true, size: 400, occupant: null },
                bottom: {
                  visible: true,
                  size: 320,
                  occupant: { kind: 'surface', id: 'chat' },
                },
              },
            },
          },
        }),
      );
    });
    await page.goto('/');
    await expect(chatDockShell(page)).toHaveClass(/chat-dock--bottom/, {
      timeout: FIRST_RENDER_TIMEOUT_MS,
    });

    // The region is on screen with no pane, named for itself, and its body
    // is the chooser: the seven dock surfaces in registry order. The coding
    // rows are disabled with the dock's own sentence — this instance binds
    // no project to its dock — and stay in the tab order (`aria-disabled`).
    const right = page.locator('.chat-dock[aria-label="Right region"]');
    await expect(right).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    const list = right.getByRole('list', { name: 'Add to Right region' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('button')).toHaveText([
      /^Chat/,
      /^Activity/,
      /^Agents/,
      /^Device/,
      /^Terminal/,
      /^Diff/,
      /^Files/,
    ]);
    await expect(
      list.getByRole('button', { name: /^Terminal Choose a project/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    // Chat is held at the bottom, so its row is a move, not hidden.
    await expect(
      list.getByRole('button', { name: 'Chat Move here from Bottom' }),
    ).toBeVisible();
    // The bar's "+" is the same chooser as a menu, offered without a project.
    const add = right.getByRole('button', { name: 'Add pane to Right' });
    await expect(add).toHaveAttribute('aria-haspopup', 'menu');

    await chooseSurfaceInEmptyRegion(page, 'Activity', 'Right');
    await expect(
      surfaceDockShell(page, 'Activity').getByRole('button', {
        name: 'Hide Activity',
        exact: true,
      }),
    ).toBeVisible();
    // Chat's region is untouched by a placement into another region.
    await expect(chatDockShell(page)).toHaveClass(/chat-dock--bottom/);
    await expect(right).toHaveCount(0);
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
    await expect(activity).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

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
