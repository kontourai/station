import { expect } from '@playwright/test';
import {
  deleteAgent,
  readAgent,
  readyAgentConnections,
  seedAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  test,
} from './helpers/authenticated-request';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * E5 — the agent editor as ONE scrolling page
 * (`reports/agents-lane/DESIGN.md` §3):
 *
 *  - Y2: nothing on the page contradicts the chosen engine. A CLI-engine agent
 *    gets §3.4 "Model options" (the knobs its own engine delivers) and must NOT
 *    get §3.3 "Model" — no model-connection picker, no "Add a model
 *    connection" repair. That repair beside a CLI agent is a fix for a problem
 *    that agent does not have.
 *  - a description edit round-trips: the PUT lands, the pending state clears,
 *    and the value survives a reload AND a fresh read of the persisted record.
 *  - on a phone the Save action is the sticky footer
 *    (`.detail-header__mobile-footer`, a shared `DetailHeader` primitive, not
 *    page CSS) and stays reachable at the BOTTOM of a long form — the case
 *    that motivated it.
 */

const SLUG = 'e2e-editor-cli';
const NAME = 'E2E Editor CLI';

async function seedCliAgent(request: AuthenticatedE2ERequest): Promise<string> {
  const ready = await readyAgentConnections(request);
  const engine = ready.find((connection) =>
    ['claude', 'codex', 'muse'].includes(connection.id),
  );
  expect(
    engine,
    'no installed CLI engine connection is ready on this host, so the CLI-engine editor cannot be observed',
  ).toBeTruthy();
  await deleteAgent(request, SLUG);
  await seedAgent(request, {
    slug: SLUG,
    name: NAME,
    prompt: 'You are the editor round-trip fixture.',
    description: 'Seeded description.',
    execution: { agentConnectionId: (engine as { id: string }).id },
  });
  return (engine as { name: string }).name;
}

test.describe('Agent editor', () => {
  test.afterEach(async ({ authenticatedRequest }) => {
    await deleteAgent(authenticatedRequest, SLUG);
  });

  test('a CLI agent has no model-connection surface anywhere on its page', async ({
    page,
    authenticatedRequest,
  }) => {
    const engineName = await seedCliAgent(authenticatedRequest);

    await page.goto(`/agents/${SLUG}`);
    const editor = page.locator('.agent-inline-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.getByText(engineName).first()).toBeVisible();

    // §3.3 does not render. Its heading, its picker and its repair are the
    // three ways it would show up, and all three are absent.
    await expect(
      page.getByRole('heading', { name: 'Model', exact: true, level: 3 }),
    ).toHaveCount(0);
    await expect(page.locator('#ae-model-connection')).toHaveCount(0);
    // station#4521 LOW-1: canonical copy is CONNECTION_SECTIONS' own
    // `addLabel` ("Add model connection").
    await expect(
      page.getByRole('button', { name: 'Add model connection' }),
    ).toHaveCount(0);

    // §3.4 is the section a CLI engine IS allowed, so its presence is what
    // proves the assertions above are about §3.3 rather than about an editor
    // that failed to render.
    await expect(
      page.getByRole('heading', { name: 'Model options', level: 3 }),
    ).toBeVisible();
  });

  test('a description edit round-trips through Save', async ({
    page,
    authenticatedRequest,
  }) => {
    await seedCliAgent(authenticatedRequest);
    const edited = `Edited by the editor round-trip at ${Date.now()}.`;

    await page.goto(`/agents/${SLUG}`);
    const save = page.getByRole('button', { name: 'Save Changes' });
    await expect(save).toBeVisible({ timeout: 20_000 });

    await page.locator('#ae-description').fill(edited);
    const put = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === `/agents/${SLUG}`,
      { timeout: 20_000 },
    );
    await save.click();
    expect((await put).ok()).toBe(true);
    // A 200 is not the claim; leaving the pending state is part of it.
    await expect(page.getByRole('button', { name: /^Saving/ })).toHaveCount(0, {
      timeout: 10_000,
    });

    await page.reload();
    await expect(page.locator('#ae-description')).toHaveValue(edited, {
      timeout: 20_000,
    });
    expect((await readAgent(authenticatedRequest, SLUG)).description).toBe(
      edited,
    );
  });
});

test.describe('Agent editor at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await deleteAgent(authenticatedRequest, SLUG);
  });

  test('Save stays reachable in the sticky footer at the bottom of the form', async ({
    page,
    authenticatedRequest,
  }) => {
    await seedCliAgent(authenticatedRequest);
    const edited = `Edited from the phone footer at ${Date.now()}.`;

    await page.goto(`/agents/${SLUG}`);
    const editor = page.locator('.agent-inline-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });

    await page.locator('#ae-description').fill(edited);

    // Scroll to the END of the form: the footer's whole reason to exist is
    // that the header's Save has scrolled away by now.
    await page
      .getByRole('heading', { name: 'Skills and tools', level: 3 })
      .scrollIntoViewIfNeeded();

    const footer = page.locator('.detail-header__mobile-footer');
    await expect(footer).toBeVisible();
    // station#4521 item 4: this footer is now the page's ONLY save
    // affordance on a touch/narrow surface (the header row's own copy no
    // longer mounts there), so it carries the header's own wording —
    // "Save Changes" here, not editing — rather than a generic "Save". The
    // dirty-dot indicator (`agent-inline-editor__dirty-dot`, an
    // `aria-label="Unsaved changes"` span) sits INSIDE the button before the
    // text, so its accessible name is "Unsaved changes Save Changes" while
    // dirty — an anchored regex keeps matching power against both the dot
    // being dropped later and a duplicate row appearing, which `exact: true`
    // against the bare string cannot (it matches zero elements whenever the
    // dot is present).
    const footerSave = footer.getByRole('button', {
      name: /Save Changes$/,
    });
    await expect(footerSave).toBeVisible();
    // The header row's own copy of this control must not ALSO be mounted.
    await expect(
      page.locator('.agent-editor__save-btn').filter({ visible: true }),
    ).toHaveCount(1);

    // Reachable means inside the viewport and big enough to hit, not merely
    // present in the DOM.
    const box = await footerSave.boundingBox();
    expect(box, 'the sticky Save has no layout box').toBeTruthy();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);

    const put = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === `/agents/${SLUG}`,
      { timeout: 20_000 },
    );
    await footerSave.click();
    expect((await put).ok()).toBe(true);
    expect((await readAgent(authenticatedRequest, SLUG)).description).toBe(
      edited,
    );

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);
  });
});
