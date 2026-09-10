import type { Page } from '@playwright/test';
import {
  AUTHORED_BAND_LABEL,
  agentRow,
  agentRowAction,
  agentRowStatus,
  type CatalogAgent,
  deleteAgent,
  ENGINE_BAND_LABEL,
  FIX_VERBS,
  readAgentCatalog,
  seedAgent,
  waitForAgentRemoved,
  waitForAgentsRail,
  waitForSeededAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * E1 — the Agents list is a READINESS BOARD (`reports/agents-lane/DESIGN.md`
 * §2), not a directory:
 *
 *  - two bands, engines on this machine first, the user's own agents second
 *    (`src-ui/src/components/agent-provenance.ts`);
 *  - a Ready row's action is Chat, and it opens a chat with that agent through
 *    the same picker §5 describes;
 *  - a non-ready row offers exactly ONE fixing verb, mapped from the server's
 *    `unavailableFix.kind`, and details preserve its `unavailableReason`
 *    by `src-ui/src/components/AgentReadinessCell.tsx`.
 *
 * Nothing in the browser is mocked. The non-ready row is seeded through the
 * live API by binding an agent to an engine connection that does not exist,
 * and the Ready row is whichever row the SERVER'S catalog reports as available
 * — read from `/api/agents`, never inferred from the page. That is what makes
 * each assertion an observation rather than a fixture: if the client ever went
 * back to deriving readiness itself (the P4 defect this band was rebuilt to
 * remove), the reason string below stops matching the one the API reports.
 */

const BROKEN_SLUG = 'e2e-readiness-broken';
const BROKEN_NAME = 'E2E Readiness Broken';
const MISSING_ENGINE_ID = 'e2e-nonexistent-engine';

async function seedBrokenAgent(
  request: AuthenticatedE2ERequest,
): Promise<void> {
  await deleteAgent(request, BROKEN_SLUG);
  await waitForAgentRemoved(request, BROKEN_SLUG);
  await seedAgent(request, {
    slug: BROKEN_SLUG,
    name: BROKEN_NAME,
    description: 'Bound to an engine connection that is not configured.',
    execution: { agentConnectionId: MISSING_ENGINE_ID },
  });
  // The seed is not OBSERVABLE until `/api/agents` answers from a stable read:
  // while the runtime's configuration revision is moving — which the agent
  // specs running before this one keep it doing, since create/delete defer
  // activation — the route serves the snapshot it captured before this spec
  // began, and the rail renders that. This is the residue: not another spec's
  // row surviving, but this spec's row not yet existing in the answer.
  await waitForSeededAgent(request, BROKEN_SLUG);
}

/** The server's own record for one slug, so the DOM can be held to it. */
async function readCatalogRecord(
  request: AuthenticatedE2ERequest,
  slug: string,
): Promise<CatalogAgent> {
  const record = (await readAgentCatalog(request)).find(
    (agent) => agent.slug === slug,
  );
  expect(record, `${slug} is missing from /api/agents`).toBeTruthy();
  return record as CatalogAgent;
}

/**
 * A row the SERVER calls runnable. `agentRunnability` is `available !== false`
 * and nothing else, so this is the same question the badge answers — asked of
 * the API rather than of the page it is meant to be checking.
 *
 * A board with no runnable row at all fails here, loudly: a Station with no
 * usable engine and no usable model connection cannot demonstrate §2's Ready
 * half, and silently passing would be a conditional green.
 */
async function firstRunnableAgent(
  request: AuthenticatedE2ERequest,
): Promise<CatalogAgent> {
  const runnable = (await readAgentCatalog(request)).filter(
    (agent) => agent.available !== false,
  );
  expect(
    runnable.length,
    'no agent in /api/agents is runnable, so the Ready half of the readiness board cannot be observed on this host',
  ).toBeGreaterThan(0);
  return runnable[0];
}

/**
 * The one row action, asserted as a COUNT and as a WORD.
 *
 * The count is DESIGN §2's "exactly one fixing verb": a row that offered both
 * Chat and a repair would let a user start a conversation the server has
 * already said cannot run. The word is the claim a person acts on, and it must
 * be one of the four `agentFixLabel` can speak — a fifth verb means someone
 * invented a repair the derivation does not know about.
 */
async function expectOneFixingVerb(page: Page, name: string): Promise<string> {
  const actions = agentRowAction(page, name);
  await expect(actions).toHaveCount(1);
  const verb = ((await actions.first().textContent()) ?? '').trim();
  expect(FIX_VERBS as readonly string[]).toContain(verb);
  return verb;
}

test.describe('Agents readiness board', () => {
  test.beforeEach(async ({ authenticatedRequest }) => {
    await seedBrokenAgent(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await deleteAgent(authenticatedRequest, BROKEN_SLUG);
    await waitForAgentRemoved(authenticatedRequest, BROKEN_SLUG);
  });

  test('the rail uses a compact status and preserves the server reason in details', async ({
    page,
    authenticatedRequest,
  }) => {
    await page.goto('/agents');
    await waitForAgentsRail(page);

    // Both bands render, engines first — the array order IS the band order
    // (`buildAgentsViewItems`), so a regression that interleaves them prints
    // one heading twice instead of two headings once.
    const bands = page.locator('.split-pane__section-header');
    await expect(bands.first()).toHaveText(ENGINE_BAND_LABEL);
    await expect(bands.filter({ hasText: AUTHORED_BAND_LABEL })).toHaveCount(1);
    await expect(agentRow(page, BROKEN_NAME)).toBeVisible();

    // The compact badge names the state; opening the agent preserves the
    // server's exact reason rather than inventing a different diagnosis.
    const record = await readCatalogRecord(authenticatedRequest, BROKEN_SLUG);
    expect(record.available).toBe(false);
    const reason = record.unavailableReason ?? '';
    expect(reason.length).toBeGreaterThan(0);
    await expect(agentRowStatus(page, BROKEN_NAME)).toHaveText('Not set up');

    // `connection-broken` is what the server reports for an engine binding it
    // cannot resolve, and `agentFixRoute` maps that to the engines page — so
    // the verb is "Set up". Asserting the mapping, not merely "some verb",
    // is what makes this fail if the routing table is rewired.
    expect(record.unavailableFix?.kind).toBe('connection-broken');
    expect(await expectOneFixingVerb(page, BROKEN_NAME)).toBe('Set up');

    // The broken row is emphatically NOT offered a chat: one action, and it
    // is the repair.
    await expect(
      agentRowAction(page, BROKEN_NAME).filter({ hasText: 'Chat' }),
    ).toHaveCount(0);
    await agentRow(page, BROKEN_NAME).click();
    await expect(
      page.getByText(`Not set up: ${reason}`, { exact: true }),
    ).toBeVisible();
  });

  test("a Ready row's Chat action opens a chat with that agent", async ({
    page,
    authenticatedRequest,
  }) => {
    const runnable = await firstRunnableAgent(authenticatedRequest);

    await page.goto('/agents');
    await waitForAgentsRail(page);

    await expect(agentRowStatus(page, runnable.name)).toHaveText('Ready');
    const action = agentRowAction(page, runnable.name);
    await expect(action).toHaveCount(1);
    await expect(action).toHaveText('Chat');
    await action.click();

    // §5: the same rows, in a picker. The agent whose Chat was pressed is in
    // it and selectable, and choosing it lands on a real composer.
    const picker = page.getByRole('dialog');
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await picker
      .getByRole('button', { name: new RegExp(runnable.name) })
      .first()
      .click();
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe('Agents readiness board at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ authenticatedRequest }) => {
    await seedBrokenAgent(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await deleteAgent(authenticatedRequest, BROKEN_SLUG);
    await waitForAgentRemoved(authenticatedRequest, BROKEN_SLUG);
  });

  test('the last agent action remains reachable above an open empty chat dock', async ({
    page,
  }) => {
    await page.goto('/agents?dock=open');
    await waitForAgentsRail(page);
    const dock = page.locator('#chat-dock');
    await expect(dock).toBeVisible();
    const expanded = await dock.boundingBox();
    expect(expanded!.height).toBeGreaterThan(200);
    const action = agentRowAction(page, BROKEN_NAME).first();
    // Exercise the reader's scroll path, rather than CDP's nearest-edge
    // alignment, which can leave a fractional border at the clipping edge.
    const list = await page.locator('.split-pane__list').first().boundingBox();
    await page.mouse.move(
      list!.x + list!.width / 2,
      list!.y + list!.height / 2,
    );
    await page.mouse.wheel(0, 2000);
    await expect
      .poll(async () => {
        const row = await action.boundingBox();
        const dock = await page.locator('#chat-dock').boundingBox();
        return row!.y + row!.height <= dock!.y;
      })
      .toBe(true);
    const box = await action.boundingBox();
    const dockBox = await dock.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(dockBox!.y);
    expect(
      await action.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return hit === element || element.contains(hit);
      }),
    ).toBe(true);
    await page
      .getByRole('button', { name: 'Collapse chat', exact: true })
      .click();
    await expect
      .poll(async () => (await dock.boundingBox())!.height)
      .toBeLessThan(expanded!.height / 2);
  });

  test('both bands, the one fixing verb, and a 44px action survive the phone', async ({
    page,
    authenticatedRequest,
  }) => {
    await page.goto('/agents');
    await waitForAgentsRail(page);

    const bands = page.locator('.split-pane__section-header');
    await expect(bands.first()).toHaveText(ENGINE_BAND_LABEL);
    await expect(bands.filter({ hasText: AUTHORED_BAND_LABEL })).toHaveCount(1);

    const record = await readCatalogRecord(authenticatedRequest, BROKEN_SLUG);
    await expect(agentRowStatus(page, BROKEN_NAME)).toHaveText('Not set up');
    expect(await expectOneFixingVerb(page, BROKEN_NAME)).toBe('Set up');

    const box = await agentRowAction(page, BROKEN_NAME).first().boundingBox();
    expect(box, 'the repair action has no layout box at 390').toBeTruthy();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 - 16);
    const heading = await page.locator('.page-frame__header').boundingBox();
    expect(heading!.height).toBeLessThanOrEqual(160);
    const search = await page
      .getByPlaceholder('Search agents...')
      .boundingBox();
    expect(search!.x).toBe(16);

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);
    await agentRow(page, BROKEN_NAME).click();
    await expect(
      page.getByText(`Not set up: ${record.unavailableReason}`, {
        exact: true,
      }),
    ).toBeVisible();
  });
});
