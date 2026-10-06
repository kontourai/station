import { expect, type Page } from '@playwright/test';
import { APP_DESTINATION_REGISTRY } from '../src-ui/src/app-shell/destination-registry';
import { deleteAgent, seedAgent } from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  test,
} from './helpers/authenticated-request';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * E8 — one parametrised sweep over the surface registry at 390x844.
 *
 * Two claims, for EVERY registered route rather than for the handful a lane
 * happened to touch:
 *
 *  1. no horizontal document scroll (`scrollWidth <= innerWidth`), the standing
 *     mobile floor;
 *  2. the split-pane surfaces open their detail as the shared SHEET with
 *     "← Back to list", and Back returns to the list — the one mobile
 *     detail contract (`SplitPaneLayout`), never a second mobile layout.
 *
 * The explicit visit list is checked against the runtime registry, including
 * computed routes, so adding a surface requires a phone coverage decision.
 */

const ROUTES: readonly string[] = [
  '/',
  '/agents',
  '/connections',
  '/developer',
  '/developer/telemetry',
  '/guidance',
  '/notifications',
  '/plugins',
  '/profile',
  '/registry',
  '/schedule',
  '/?surface=activity',
  '/settings',
];

/**
 * Registry routes that resolve to a `SplitPaneLayout`, with a seed that
 * guarantees the list is non-empty. An empty list has no detail to open, and a
 * sweep that skipped empty lists would pass on a surface whose rows stopped
 * rendering entirely.
 */
const SPLIT_PANE_ROUTES: ReadonlyArray<{ path: string; item: string }> = [
  { path: '/agents', item: 'E2E Sweep Agent' },
  { path: '/guidance?tab=skills', item: 'e2e-sweep-skill' },
  // The built-in tool server every runtime registers, so no seed is needed.
  { path: '/connections/tools', item: 'Station Control' },
];

const SWEEP_AGENT_SLUG = 'e2e-sweep-agent';
const SWEEP_SKILL = 'e2e-sweep-skill';

/**
 * #2063: the panel is chrome on every route above, and its project rows now
 * carry a wrapping row of layout chips. A wrapping band of touch-floor
 * controls is exactly the shape that widens a drawer, so it is swept here
 * with the rest of the phone's floors rather than asserted only in jsdom,
 * which computes no layout and so cannot see a wrap or a 44px box at all.
 *
 * Real project, real layouts: the chips are what the server returns, and
 * enough of them, with real-length names, that a ~250px drawer column cannot
 * hold them on one line.
 */
const SWEEP_PROJECT_SLUG = 'e2e-sweep-chips';
const SWEEP_PROJECT_NAME = 'E2E Sweep Chips';
const SWEEP_LAYOUTS = [
  { slug: 'coding', name: 'Coding', type: 'custom' },
  { slug: 'tasks', name: 'Tasks', type: 'custom' },
  { slug: 'chat', name: 'Chat', type: 'chat' },
  { slug: 'knowledge', name: 'Knowledge', type: 'custom' },
  { slug: 'release-review', name: 'Release review', type: 'custom' },
];

async function seedSweepItems(request: AuthenticatedE2ERequest): Promise<void> {
  await deleteAgent(request, SWEEP_AGENT_SLUG);
  await seedAgent(request, {
    slug: SWEEP_AGENT_SLUG,
    name: 'E2E Sweep Agent',
    description: 'Guarantees the Agents rail has a row to open.',
  });
  await request.delete(`/api/skills/${SWEEP_SKILL}`);
  const skill = await request.post('/api/skills/local', {
    data: {
      name: SWEEP_SKILL,
      description: 'Guarantees the Skills rail has a row to open.',
      body: 'Sweep body',
    },
  });
  expect(skill.ok()).toBe(true);

  await request.delete(`/api/projects/${SWEEP_PROJECT_SLUG}`);
  const project = await request.post('/api/projects', {
    data: { name: SWEEP_PROJECT_NAME, slug: SWEEP_PROJECT_SLUG },
  });
  expect(project.status(), 'seeding the chip-row project').toBe(201);
  for (const layout of SWEEP_LAYOUTS) {
    const created = await request.post(
      `/api/projects/${SWEEP_PROJECT_SLUG}/layouts`,
      { data: layout },
    );
    expect(created.status(), `seeding layout ${layout.slug}`).toBe(201);
  }
}

async function tearDownSweepItems(
  request: AuthenticatedE2ERequest,
): Promise<void> {
  await deleteAgent(request, SWEEP_AGENT_SLUG);
  await request.delete(`/api/skills/${SWEEP_SKILL}`);
  await request.delete(`/api/projects/${SWEEP_PROJECT_SLUG}`);
}

async function assertNoHorizontalScroll(
  page: Page,
  route: string,
): Promise<void> {
  const measurement = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    measurement.scrollWidth,
    `${route} scrolls horizontally at 390 (${measurement.scrollWidth} > ${measurement.innerWidth})`,
  ).toBeLessThanOrEqual(measurement.innerWidth);
}

test.describe('Mobile surface sweep at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ authenticatedRequest }) => {
    await seedSweepItems(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await tearDownSweepItems(authenticatedRequest);
  });

  test('the swept route list is exactly what the surface registry declares', () => {
    // Membership, not order: the guarantee this test exists for (see the
    // header comment) is that every DECLARED route gets swept, which is a
    // set-equality question. The registry set sorts alphabetically while
    // `ROUTES` is ordered to match the nav for readability, so the two lists
    // legitimately disagree on position while agreeing on membership —
    // compare sorted copies so the sweep's own iteration order can't fail a
    // check it was never testing.
    expect(
      [
        ...new Set(
          APP_DESTINATION_REGISTRY.getRegistered().map(
            (destination) => destination.route,
          ),
        ),
      ].sort(),
    ).toEqual([...ROUTES].sort());
  });

  test('every registered route fits the phone', async ({ page }) => {
    test.setTimeout(180_000);
    for (const route of ROUTES) {
      await page.goto(route);
      // The shell paints its own frame before a lazy route chunk resolves, so
      // wait for the route's own heading before measuring. Activity opens as
      // a dock pane titled by an h2, and Home's h1 stays in the DOM under it,
      // hidden; every other route is a page with its own h1.
      const heading =
        route === '/?surface=activity'
          ? page.getByRole('heading', { level: 2, name: 'Activity' })
          : page.locator('h1').filter({ visible: true }).first();
      await expect(heading).toBeVisible({
        timeout: 30_000,
      });
      await assertNoHorizontalScroll(page, route);
    }
  });

  test('the project layout chips scroll in one row inside the drawer and keep the 44px floor', async ({
    page,
  }) => {
    await page.goto(`/projects/${SWEEP_PROJECT_SLUG}`);
    await page.getByRole('button', { name: 'Toggle menu' }).click();

    const row = page.locator('.sidebar__layout-chips');
    const chips = row.locator('.sidebar__layout-chip');
    await expect(chips.first()).toBeVisible({ timeout: 30_000 });
    const boxes = await chips.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          width: rect.width,
          height: rect.height,
          text: element.textContent ?? '',
        };
      }),
    );
    expect(boxes.length).toBe(SWEEP_LAYOUTS.length);

    // One line that scrolls sideways, not a wrap (#2150): every chip on one
    // row, and the row itself inside the drawer rather than the page.
    expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
    const undersized = boxes
      .filter((box) => box.width < 44 || box.height < 44)
      .map(
        (box) => `${box.text} ${box.width.toFixed(0)}x${box.height.toFixed(0)}`,
      );
    expect(undersized, 'layout chips below the 44px touch floor').toEqual([]);
    const rowBox = await row.boundingBox();
    const drawerBox = await page.locator('#mobile-navigation').boundingBox();
    expect(drawerBox).not.toBeNull();
    const drawerRight = drawerBox!.x + drawerBox!.width;
    expect(drawerRight).toBeLessThan(390);
    expect(rowBox).not.toBeNull();
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(drawerRight + 0.5);

    // The seeded layouts overflow the drawer, so the row really scrolls, and
    // the chips past its edge are reachable: scrolling brings the last one
    // inside the row's own box.
    const overflows = await row.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(overflows, 'the seeded chips no longer overflow the row').toBe(true);
    const last = chips.last();
    await last.scrollIntoViewIfNeeded();
    const lastBox = await last.boundingBox();
    expect(lastBox).not.toBeNull();
    expect(lastBox!.x + lastBox!.width).toBeLessThanOrEqual(
      rowBox!.x + rowBox!.width + 0.5,
    );

    await assertNoHorizontalScroll(page, `/projects/${SWEEP_PROJECT_SLUG}`);
  });

  test('split-pane surfaces open the shared detail sheet and come back', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    for (const surface of SPLIT_PANE_ROUTES) {
      await page.goto(surface.path);
      await page.waitForSelector('.split-pane', { timeout: 30_000 });

      const left = page.locator('.split-pane__left');
      const item = page
        .locator('.split-pane__item')
        .filter({ hasText: surface.item })
        .first();
      await expect(item).toBeVisible({ timeout: 30_000 });
      // The rendered row, not its computed min-height: a clipped or
      // `display: contents` row can declare 44px and still paint smaller.
      const row = await item.boundingBox();
      expect(
        row?.height ?? 0,
        `${surface.path} list row is below the touch floor`,
      ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      await item.click();

      const back = page.locator('.split-pane__back');
      await expect(
        back,
        `${surface.path} did not open the shared mobile detail sheet`,
      ).toBeVisible();
      await expect(back).toHaveText('← Back to list');
      await expect(page.locator('.split-pane__right--sheet')).toBeVisible();
      expect(
        await left.evaluate((el) => getComputedStyle(el).display !== 'none'),
      ).toBe(false);

      await assertNoHorizontalScroll(page, `${surface.path} (detail sheet)`);

      await back.click();
      await expect(page.locator('.split-pane__right--sheet')).toHaveCount(0);
      expect(
        await left.evaluate((el) => getComputedStyle(el).display !== 'none'),
      ).toBe(true);
    }
  });
});
