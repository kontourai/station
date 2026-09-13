import { expect, type Page } from '@playwright/test';
import { APP_DESTINATION_REGISTRY } from '../src-ui/src/app-shell/destination-registry';
import { deleteAgent, seedAgent } from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  test,
} from './helpers/authenticated-request';

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
  '/review-queue',
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
];

const SWEEP_AGENT_SLUG = 'e2e-sweep-agent';
const SWEEP_SKILL = 'e2e-sweep-skill';

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
}

async function tearDownSweepItems(
  request: AuthenticatedE2ERequest,
): Promise<void> {
  await deleteAgent(request, SWEEP_AGENT_SLUG);
  await request.delete(`/api/skills/${SWEEP_SKILL}`);
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
      // wait for the route's own heading before measuring.
      await expect(page.locator('h1').first()).toBeVisible({
        timeout: 30_000,
      });
      await assertNoHorizontalScroll(page, route);
    }
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
