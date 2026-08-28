import type { AuthenticatedE2ERequest } from './helpers/authenticated-request';
import { expect, test } from './helpers/authenticated-request';

/**
 * What happens to the app once a skill is runnable as a slash command, driven
 * against the REAL skills API.
 *
 * archive#3736: enabling the first command skill took out every route with
 * React error #185. `tests/skills.spec.ts` performs the same toggle and stays
 * green throughout, because it mocks both `**` + `/api/system/skills` and
 * `**` + `/api/skills**` — the registrar never saw a command skill, so the
 * loop it triggers never ran. Nothing here is mocked.
 *
 * `skills-command-surface` owns the composer and the refused command word.
 * What it cannot see is the rest of the app: the loop took out every ROUTE,
 * which is what this covers, desktop and at 390x844.
 */

const SKILL_NAME = 'e2e-command-route-probe';

async function createCommandSkill(request: AuthenticatedE2ERequest) {
  const created = await request.post('/api/skills/local', {
    data: {
      name: SKILL_NAME,
      description: 'Probe for the command-skill route regression.',
      body: 'Probe body.',
    },
  });
  expect(created.ok()).toBe(true);
  const enabled = await request.put(`/api/skills/${SKILL_NAME}`, {
    data: {
      description: 'Probe for the command-skill route regression.',
      body: 'Probe body.',
      command: { enabled: true, global: true },
    },
  });
  expect(enabled.ok()).toBe(true);
}

/**
 * Each route and the element ITS OWN view renders.
 *
 * Not a heading, and not the absence of the boundary's text: the page frame
 * renders the eyebrow and the `page__title` for every route, so under the
 * loop `/agents` still says "Agents" while the view underneath it is the
 * error boundary. Both weaker landmarks pass
 * against a genuinely broken build (verified against archive#3736's defect).
 */
const ROUTES: Array<{ path: string; view: string }> = [
  { path: '/agents', view: '.split-pane' },
  { path: '/connections', view: '.connections-section-frame' },
  { path: '/guidance?tab=commands', view: '.commands-view' },
];

/**
 * Wait until the route has decided — its own view, or the boundary that
 * replaced it — then say which it was. Asserting the boundary's absence alone
 * is satisfied by a route that has not rendered anything yet.
 */
async function expectRouteRendered(
  page: import('@playwright/test').Page,
  route: { path: string; view: string },
) {
  const boundary = page.getByText('This view stopped working.');
  const view = page.locator(route.view).first();
  await expect(boundary.first().or(view)).toBeVisible({ timeout: 20_000 });
  await expect(boundary).toHaveCount(0);
  await expect(view).toBeVisible();
}

test.describe('a skill runnable as a slash command', () => {
  test('leaves every route working (station#3736)', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(90_000);
    await createCommandSkill(authenticatedRequest);
    try {
      for (const route of ROUTES) {
        await page.goto(route.path);
        await expectRouteRendered(page, route);
      }
    } finally {
      await authenticatedRequest.delete(`/api/skills/${SKILL_NAME}`);
    }
  });
});

test.describe('a skill runnable as a slash command, on a phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('leaves every route working (station#3736)', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(90_000);
    await createCommandSkill(authenticatedRequest);
    try {
      for (const route of ROUTES) {
        await page.goto(route.path);
        await expectRouteRendered(page, route);
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
      }
    } finally {
      await authenticatedRequest.delete(`/api/skills/${SKILL_NAME}`);
    }
  });
});
