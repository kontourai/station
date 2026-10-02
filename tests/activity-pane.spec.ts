/**
 * E2E: the Activity surface and its deep link (#928).
 *
 * `/?surface=activity` is the canonical deep link to Activity. What it means
 * changed with #928: it no longer opens a page at a route of its own and it no
 * longer offers a surface-owned "Dock this pane" — Activity is a REGISTERED
 * SURFACE (`REGION_SURFACE_REGISTRY`), the link is a REVEAL, and the region
 * model decides where a revealed surface lands. On a fine pointer that is
 * Activity's declared `defaultRegion`, `right`; on a phone it opens over Chat
 * in the one folded slot (#2549), and "‹ Chat" returns.
 *
 * The sidebar's Activity row is the other entry point, and it is a PLACE: it
 * opens Activity as the page (`main`), the way Home's row opens Home, and the
 * row is then the current page. The deep link keeps its contextual reveal.
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

import {
  LIVE_ACTIVITY_SCHEMA_VERSION,
  parseLiveActivityProjection,
} from '@kontourai/station-contracts/live-activity';
import { expect, test } from '@playwright/test';
import { test as fixtureTest } from './helpers/fixture-audit';
import {
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
} from './helpers/orchestration';
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

test.describe('The sidebar Activity row is a place', () => {
  /**
   * The panel's Activity row opens Activity as the PAGE — it takes `main`
   * the way Home does — and becomes the current page; Home's row gives that
   * state up. Every contextual producer (the `?surface=activity` link that
   * notifications and evidence mint) still reveals it in its dock beside
   * the page. Both halves are observed here in one journey so a regression
   * of either reds by name.
   */
  function primaryNav(page: import('@playwright/test').Page) {
    return page.getByRole('navigation', { name: 'Primary navigation' });
  }
  function activityRow(page: import('@playwright/test').Page) {
    return primaryNav(page).getByRole('button', {
      name: 'Activity',
      exact: true,
    });
  }
  function homeRow(page: import('@playwright/test').Page) {
    return primaryNav(page).getByRole('button', { name: 'Home', exact: true });
  }
  function homeRegion(page: import('@playwright/test').Page) {
    return page.locator('#station-main').getByRole('region', { name: 'Home' });
  }

  test('opens Activity as the page, hands it back to Home, and leaves the deep link docking right', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(homeRegion(page)).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT_MS,
    });
    await expect(homeRow(page)).toHaveAttribute('aria-current', 'page');
    await expect(activityRow(page)).not.toHaveAttribute('aria-current', /.*/);

    await activityRow(page).click();
    await expect(mainHeading(page, 'Activity')).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT_MS,
    });
    await expect(homeRegion(page)).toHaveCount(0);
    await expect(
      surfaceDockShell(page, 'Activity'),
      'the page is not also a dock region',
    ).toHaveCount(0);
    await expect(activityRow(page)).toHaveAttribute('aria-current', 'page');
    await expect(homeRow(page)).not.toHaveAttribute('aria-current', /.*/);
    await expect(page).toHaveURL(/\/$/);

    // Pressing the current page again keeps it the page.
    await activityRow(page).click();
    await expect(mainHeading(page, 'Activity')).toBeVisible();
    await expect(activityRow(page)).toHaveAttribute('aria-current', 'page');

    await homeRow(page).click();
    await expect(homeRegion(page)).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT_MS,
    });
    await expect(mainHeading(page, 'Activity')).toHaveCount(0);
    await expect(homeRow(page)).toHaveAttribute('aria-current', 'page');
    await expect(activityRow(page)).not.toHaveAttribute('aria-current', /.*/);

    // A notification-style link is a contextual reveal: Activity docks on
    // the right beside Home, and Home stays the page.
    await page.goto('/?surface=activity');
    await expect(surfaceDockShell(page, 'Activity')).toHaveClass(
      /chat-dock--right/,
      { timeout: FIRST_RENDER_TIMEOUT_MS },
    );
    await expect(homeRegion(page)).toBeVisible();
    await expect(homeRow(page)).toHaveAttribute('aria-current', 'page');
    await expect(activityRow(page)).not.toHaveAttribute('aria-current', /.*/);

    // From the dock, the row still goes to the page (the dock gives it up).
    await activityRow(page).click();
    await expect(mainHeading(page, 'Activity')).toBeVisible();
    await expect(surfaceDockShell(page, 'Activity')).toHaveCount(0);
    await expect(activityRow(page)).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('The Activity page from a maximized desktop dock', () => {
  // Review round 2: on a desktop a maximized side region hides the route
  // outlet and a maximized bottom region takes its row, so the page open
  // has to restore the dock for the page to be seen.
  for (const [label, link] of [
    ['right', '/?dock=open&maximize=true&dockSlotPlacement=right'],
    ['bottom', '/?dock=open&maximize=true'],
  ] as const) {
    test(`the row shows the Activity page from a maximized ${label} dock`, async ({
      page,
    }, testInfo) => {
      await page.goto(link);
      await expect(chatDockShell(page)).toBeVisible({
        timeout: FIRST_RENDER_TIMEOUT_MS,
      });
      await page
        .getByRole('navigation', { name: 'Primary navigation' })
        .getByRole('button', { name: 'Activity', exact: true })
        .click();
      const heading = mainHeading(page, 'Activity');
      await expect(heading).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
      await expect(heading).toBeInViewport();
      await expect(page).not.toHaveURL(/maximize=true/);
      await page.screenshot({
        path: testInfo.outputPath(`activity-page-from-${label}.png`),
      });
    });
  }
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

  // #2549 (owner decision 2026-09-24, placement.md): on a phone a revealed
  // pane opens OVER Chat, in Chat's one folded slot, and "‹ Chat" (or Back)
  // returns. The deep link is such a reveal. (Before #2549 this asserted a
  // separate Activity dock shell that replaced Chat's.)
  test('reveals Activity over Chat in the one phone dock slot, and Back to Chat returns', async ({
    page,
  }) => {
    await page.goto('/?surface=activity');
    const slot = chatDockShell(page);
    const back = slot.getByRole('button', {
      name: 'Back to Chat',
      exact: true,
    });
    await expect(back).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await expect(page.locator('.chat-dock')).toHaveCount(1);
    await expect(slot).toHaveClass(/chat-dock--bottom/);
    await expect(
      slot.getByRole('heading', { name: 'Activity', exact: true }),
    ).toBeVisible();
    // A reveal is not the page: the primary area did not become Activity.
    await expect(mainHeading(page, 'Activity')).toHaveCount(0);

    expect(
      await documentFitsViewportWidth(page),
      'the Activity deep link must not push the phone document sideways',
    ).toBe(true);
    await expectBoxWithinViewport(page, slot, 'the revealed Activity pane');
    expect(
      (await back.boundingBox())?.height,
      'the way back to Chat must be a 44px tap target',
    ).toBeGreaterThanOrEqual(44);

    await back.click();
    await expect(back).toHaveCount(0);
    await expect(page.locator('.chat-dock')).toHaveCount(1);
    await expect(
      slot.getByRole('heading', { name: 'Activity', exact: true }),
    ).toHaveCount(0);
  });

  // The sidebar row is a place on a phone too: Activity becomes the page
  // (not a layer over Chat), the row is current, and Home takes it back.
  test('the drawer Activity row opens Activity as the page, and Home takes it back', async ({
    page,
  }) => {
    await page.goto('/');
    const navigation = page.getByRole('navigation', {
      name: 'Mobile navigation',
    });
    const openDrawer = () =>
      page.getByRole('button', { name: 'Toggle menu' }).click();
    const row = (name: string) =>
      navigation.getByRole('button', { name, exact: true });

    await openDrawer();
    await row('Activity').click();
    await expect(mainHeading(page, 'Activity')).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT_MS,
    });
    await expect(
      page.getByRole('button', { name: 'Back to Chat', exact: true }),
      'a page open is not a layer over Chat',
    ).toHaveCount(0);
    await expect(
      page.locator('#station-main').getByRole('region', { name: 'Home' }),
    ).toHaveCount(0);

    await openDrawer();
    await expect(row('Activity')).toHaveAttribute('aria-current', 'page');
    await expect(row('Home')).not.toHaveAttribute('aria-current', /.*/);
    await row('Home').click();
    await expect(
      page.locator('#station-main').getByRole('region', { name: 'Home' }),
    ).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await expect(mainHeading(page, 'Activity')).toHaveCount(0);
  });

  // Review round 1: the page must be SEEN on a phone. A maximized Chat owns
  // the whole viewport (the route outlet is hidden under it), so the row has
  // to restore the dock — the assertion is the Activity heading visible in
  // the primary area, on screen, not model state. (With Activity open OVER
  // Chat the layer covers the drawer toggle, so the row is not reachable
  // there; that model path is unit-covered.)
  test('the drawer Activity row shows the page from a maximized Chat', async ({
    page,
  }) => {
    await page.goto('/?dock=open&maximize=true');
    const menu = page.getByRole('button', { name: 'Toggle menu' });
    await expect(menu).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await menu.click();
    await page
      .getByRole('navigation', { name: 'Mobile navigation' })
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    const heading = mainHeading(page, 'Activity');
    await expect(heading).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await expect(heading).toBeInViewport();
    await expect(page).not.toHaveURL(/maximize=true/);
  });
});

fixtureTest.describe('Live work in the sidebar footer', () => {
  fixtureTest.beforeEach(async ({ page }) => {
    await seedOrchestrationRoutes(page);
    await installMockOrchestrationSse(page);
    const observedAt = Date.now();
    const liveProjection = {
      schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
      observedAt,
      connectedClients: 4,
      participants: Array.from({ length: 4 }, (_, index) => ({
        id: (index + 1).toString(16).padStart(24, '0'),
        actor: { kind: 'human', label: `Participant ${index + 1}` },
        scope: { projectId: 'p1', projectSlug: 'demo', taskId: '77' },
        work: {
          workName: 'Reviewing work',
          workState: 'reviewing',
          startedAt: observedAt,
        },
      })),
    };
    if (!parseLiveActivityProjection(liveProjection))
      throw new Error('Invalid live presence fixture');
    await page.route('**/api/live-activity', (route) =>
      route.fulfill({ json: { success: true, data: liveProjection } }),
    );
    await page.route('**/api/orchestration/sessions/read-model*', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [1, 2].map((index) => ({
            provider: 'station',
            threadId: `station:footer-${index}`,
            status: 'busy',
            controlMode: 'station-owned',
            lifecycleState: 'running',
            hasActiveTurn: true,
            isLoaded: true,
            isPersisted: true,
            eventCount: 1,
            createdAt: new Date(observedAt).toISOString(),
            updatedAt: new Date(observedAt).toISOString(),
          })),
        },
      }),
    );
    await page.goto('/settings');
  });

  fixtureTest(
    'populated live work fits the sidebar beside its three footer actions',
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      const footer = page.locator('.sidebar__footer');
      const presence = footer.getByRole('button', {
        name: /4 participants.*2 active sessions/,
      });
      await expect(presence).toBeVisible();
      const bounds = (await footer.boundingBox())!;
      for (const name of ['Schedule', 'Customize', 'Settings']) {
        const box = (await footer
          .getByRole('button', { name, exact: true })
          .boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      }
      await page.screenshot({
        path: testInfo.outputPath('footer-populated-desktop.png'),
      });
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await expect(presence).toBeVisible();
      for (const name of ['Schedule', 'Customize', 'Settings']) {
        await expect(
          footer.getByRole('button', { name, exact: true }),
        ).toBeVisible();
      }
    },
  );

  fixtureTest(
    'opening live Activity closes mobile navigation and reveals the work',
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Toggle menu' }).click();
      const navigation = page.getByRole('navigation', {
        name: 'Mobile navigation',
      });
      const presence = navigation.getByRole('button', {
        name: /4 participants.*2 active sessions/,
      });
      await expect(presence).toBeVisible();
      await presence.click();
      await page
        .getByRole('button', { name: 'Open Activity', exact: true })
        .click();
      await expect(navigation).toBeHidden();
      await expect(
        page.getByRole('heading', { name: 'Activity', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('Running · 2', { exact: true }),
      ).toBeVisible();
      expect(await documentFitsViewportWidth(page)).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath('footer-activity-mobile.png'),
      });
    },
  );
});
