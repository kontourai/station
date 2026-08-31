/**
 * E2E: the dock occupant picker and the routes' away state
 * (archive#4090 design decision, epic archive#4142 M5).
 *
 * Dock side: the dock header's fixed "return to Chat" action is gone. The
 * header names the CURRENT occupant and opens a menu of every pane the
 * ambient slot admits — the derivation, currently {Chat, Home, Activity} —
 * with the current occupant checked. Choosing replaces the occupant through
 * the existing ambient document path; Chat is one of the list, not special.
 *
 * The shell that hosts every occupant is one persistent element
 * (`#chat-dock` / `.chat-dock`, `aria-label="Dock"` — station#4460
 * consolidated the old per-occupant `.dock-slot`/`.dock-slot__header`
 * markup into this single shared shell; `.dock-slot` no longer renders
 * anywhere, see `useDockShellChrome`/`DockShell.tsx` and
 * `dock-bottom-clearance.test.ts`). The occupant is identified by the
 * header's occupant-picker trigger, whose accessible name is
 * `Docked pane: <Occupant>` — never a raw id (archive#3971) — so every
 * assertion that used to key on a per-occupant `.dock-slot[aria-label]`
 * here keys on that trigger's accessible name instead.
 *
 * Route side: while a route's pane occupies the dock, the route renders an
 * AWAY STATE instead of a second live copy of the pane, derived from the
 * host's published occupant. The transition most likely to be wrong is
 * pinned: choosing ANOTHER occupant clears the first route's away state.
 *
 * Every assertion names an affordance that must exist — an absent picker,
 * menu entry, or away state fails by name (no conditional greens).
 */
import { expect, type Page, test } from '@playwright/test';

/** Pin the server-side first-run fact so `/` renders Home deterministically. */
async function pinFirstRunSkipped(page: Page) {
  await page.route('**/config/app', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          builtinAgentEngineConnectionId: null,
          firstRun: { status: 'skipped' },
        },
      }),
    }),
  );
}

/**
 * The occupant-picker trigger names the current occupant by descriptor name
 * (`Docked pane: <name>`), scoped to the one persistent dock shell — the
 * shipped equivalent of the old `.dock-slot[aria-label="<name> dock"]`.
 */
function dockOccupantTrigger(page: Page, name: string) {
  return page
    .locator('#chat-dock')
    .getByRole('button', { name: `Docked pane: ${name}` });
}

/**
 * Desktop-only: `WorkspacePaneDockAction`'s "Dock this pane" button
 * (`.home-view__top-actions`) is hidden by `HomeView.css` at
 * `max-width: 1024px` by design ("the ambient dock already owns the mobile
 * pane picker/maximize contract" there) — every caller of this helper runs
 * at a viewport wider than that. The phone-width test docks Home through
 * the mobile overflow sheet instead; see `dockHomeViaMobileOverflow`.
 */
async function dockHomeFromRoot(page: Page) {
  await page.goto('/');
  const dockAction = page
    .locator('#station-main')
    .getByRole('button', { name: 'Dock this pane' });
  await expect(dockAction).toBeVisible({ timeout: 10_000 });
  await dockAction.click();
  await expect(dockOccupantTrigger(page, 'Home')).toBeVisible();
}

test.describe('Dock occupant picker', () => {
  test.beforeEach(async ({ page }) => {
    await pinFirstRunSkipped(page);
  });

  test('docking Home leaves `/` in the away state, and the picker lists the derived panes with Home checked', async ({
    page,
  }) => {
    await dockHomeFromRoot(page);

    // Route side: the away state REPLACES the pane — one live placement.
    const main = page.locator('#station-main');
    await expect(main.getByText('Home is in the dock')).toBeVisible();
    await expect(
      main.getByRole('button', { name: 'Bring it back here' }),
    ).toBeVisible();
    await expect(
      main.getByRole('button', { name: 'Dock this pane' }),
      'the away state must not co-mount a second Home pane',
    ).toHaveCount(0);

    // Dock side: the header names the occupant; no fixed Chat return action.
    const header = page.locator('.chat-dock__header');
    await expect(
      header.getByRole('button', { name: 'Dock this pane' }),
      'the fixed return-to-Chat header action is deleted (M5)',
    ).toHaveCount(0);
    await dockOccupantTrigger(page, 'Home').click();
    const menu = page.getByRole('menu', { name: 'Docked pane' });
    await expect(menu).toBeVisible();
    // The derivation, by NAME (never a raw id), current occupant checked.
    await expect(menu.getByRole('menuitemradio')).toHaveText([
      'Chat',
      'Home',
      'Activity',
    ]);
    await expect(
      menu.getByRole('menuitemradio', { name: 'Home' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('choosing Activity replaces the occupant AND clears the Home away state on `/`', async ({
    page,
  }) => {
    await dockHomeFromRoot(page);
    const main = page.locator('#station-main');
    await expect(main.getByText('Home is in the dock')).toBeVisible();

    await dockOccupantTrigger(page, 'Home').click();
    await page
      .getByRole('menu', { name: 'Docked pane' })
      .getByRole('menuitemradio', { name: 'Activity' })
      .click();

    await expect(dockOccupantTrigger(page, 'Activity')).toBeVisible();
    // The case most likely to be wrong (M5 acceptance 1): Home is no longer
    // docked, so `/` must CLEAR its away state and render Home again.
    await expect(main.getByText('Home is in the dock')).toHaveCount(0);
    await expect(
      main.getByRole('button', { name: 'Dock this pane' }),
      'Home must render on `/` again the moment it stops being the occupant',
    ).toBeVisible();
  });

  test('"Bring it back here" returns the pane to the route and the dock to Chat', async ({
    page,
  }) => {
    await dockHomeFromRoot(page);
    const main = page.locator('#station-main');
    await main.getByRole('button', { name: 'Bring it back here' }).click();

    await expect(page.locator('.chat-dock')).toBeVisible();
    await expect(
      dockOccupantTrigger(page, 'Chat'),
      'undocking Home must return the ambient slot to Chat',
    ).toBeVisible();
    await expect(main.getByText('Home is in the dock')).toHaveCount(0);
    await expect(
      main.getByRole('button', { name: 'Dock this pane' }),
    ).toBeVisible();
  });

  test('the occupant menu opens within the window on a BOTTOM dock', async ({
    page,
  }) => {
    // The S4 lesson: the dock IS the bottom of the viewport, and Playwright
    // calls an off-screen menu with a non-empty box "visible" — so measure.
    await page.setViewportSize({ width: 1440, height: 900 });
    await dockHomeFromRoot(page);
    await dockOccupantTrigger(page, 'Home').click();
    const menu = page.getByRole('menu', { name: 'Docked pane' });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box, 'the occupant menu must be measurable').not.toBeNull();
    expect(
      box!.y,
      'the occupant menu must not open above the window',
    ).toBeGreaterThanOrEqual(0);
    expect(
      box!.y + box!.height,
      'the occupant menu must open UPWARD, within the window — not below it',
    ).toBeLessThanOrEqual(900);
  });

  test('the /activity route shows its own away state while Activity is docked', async ({
    page,
  }) => {
    await page.goto('/activity');
    const dockAction = page
      .locator('#station-main')
      .getByRole('button', { name: 'Dock this pane' });
    await expect(dockAction).toBeVisible({ timeout: 10_000 });
    await dockAction.click();
    await expect(dockOccupantTrigger(page, 'Activity')).toBeVisible();
    const main = page.locator('#station-main');
    await expect(main.getByText('Activity is in the dock')).toBeVisible();
    await main.getByRole('button', { name: 'Bring it back here' }).click();
    await expect(page.locator('.chat-dock')).toBeVisible();
    await expect(main.getByText('Activity is in the dock')).toHaveCount(0);
    await expect(
      main.getByRole('button', { name: 'Dock this pane' }),
    ).toBeVisible();
  });
});

/**
 * Docks Home at phone width through the surface that actually offers it
 * there. `HomeView.css` hides `.home-view__top-actions` (the
 * `WorkspacePaneDockAction` "Dock this pane" button `dockHomeFromRoot`
 * drives) at `max-width: 1024px` BY DESIGN — its own comment: "Docking is
 * desktop composition. At phone/tablet widths the ambient dock already owns
 * the mobile pane picker/maximize contract, so this second in-content
 * control is both redundant and visually stranded." At phone width the
 * mobile Chat header's "⋯" (`Chat actions`) overflow sheet is that contract
 * (`ChatDockMobileOverflowSheet`, station#520/#524) — "Switch to Home" is
 * one of its `otherAmbientOccupants()` entries, reading the SAME
 * `chooseAmbientOccupant` derivation the header picker uses.
 */
async function dockHomeViaMobileOverflow(page: Page) {
  await page.goto('/');
  const overflowTrigger = page.getByRole('button', { name: 'Chat actions' });
  await expect(overflowTrigger).toBeVisible({ timeout: 15_000 });
  await overflowTrigger.click();
  await page.getByRole('menuitem', { name: 'Switch to Home' }).click();
  await expect(dockOccupantTrigger(page, 'Home')).toBeVisible();
}

test.describe('Dock occupant picker at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('picks occupants within the phone viewport with 44px targets', async ({
    page,
  }) => {
    await pinFirstRunSkipped(page);
    await dockHomeViaMobileOverflow(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'a docked pane with the picker must not push the phone document sideways',
    ).toBe(true);

    const trigger = dockOccupantTrigger(page, 'Home');
    const triggerBox = await trigger.boundingBox();
    expect(
      triggerBox?.height,
      'the picker trigger must be a 44px tap target',
    ).toBeGreaterThanOrEqual(44);
    await trigger.click();

    const menu = page.getByRole('menu', { name: 'Docked pane' });
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox, 'the occupant menu must be measurable').not.toBeNull();
    expect(menuBox!.y).toBeGreaterThanOrEqual(0);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(844);
    const itemBox = await menu
      .getByRole('menuitemradio', { name: 'Chat' })
      .boundingBox();
    expect(
      itemBox?.height,
      'menu entries must be 44px tap targets on touch',
    ).toBeGreaterThanOrEqual(44);

    await menu.getByRole('menuitemradio', { name: 'Chat' }).click();
    await expect(page.locator('.chat-dock')).toBeVisible();
    await expect(
      page.locator('#station-main').getByText('Home is in the dock'),
    ).toHaveCount(0);
  });
});
