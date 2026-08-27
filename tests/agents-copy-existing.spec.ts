import { expect, type Page } from '@playwright/test';
import {
  createButton,
  deleteAgent,
  readAgent,
  readyAgentConnections,
  seedAgent,
  startingPoint,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  test,
} from './helpers/authenticated-request';

/**
 * E4 — "Copy an existing agent" (`reports/agents-lane/DESIGN.md` §4):
 * "pick one → everything pre-filled, name '<original> copy'".
 *
 * The load-bearing half is what is NOT copied. `cloneableAgentFields`
 * (`src-ui/src/views/agent-editor/agentsViewUtils.ts`) whitelists the fields a
 * clone inherits, and `execution.credentialProfileRef` — which account of the
 * bound engine the agent runs on (station#3530) — is deliberately outside it.
 * A copy that inherited it would silently run on somebody else's enrolled
 * account, which is exactly the kind of thing a green "the form pre-filled"
 * assertion would not notice. So the proof is a read of the PERSISTED record
 * through `GET /api/agents/:slug` after the create, not a read of the form.
 */

const SOURCE_SLUG = 'e2e-copy-source';
const SOURCE_NAME = 'E2E Copy Source';
const SOURCE_PROMPT = 'You are the copy source agent.';
const SOURCE_DESCRIPTION = 'Seeded source for the copy journey.';
const CREDENTIAL_REF = 'e2e-credential-profile-must-not-copy';
const COPY_SLUG = `${SOURCE_SLUG}-copy`;

async function seedSource(request: AuthenticatedE2ERequest): Promise<void> {
  // Bind the source to an engine the SERVER reports ready. The copy inherits
  // the binding, and §4's Create gate refuses an engine that is not ready — so
  // a source on an engine this host does not have would block the create for a
  // reason that has nothing to do with the claim under test.
  const ready = await readyAgentConnections(request);
  const engine = ready.find((connection) =>
    ['claude', 'codex', 'muse'].includes(connection.id),
  );
  expect(
    engine,
    'no installed CLI engine connection is ready on this host, so the copy journey has no ready engine to inherit',
  ).toBeTruthy();

  await deleteAgent(request, COPY_SLUG);
  await deleteAgent(request, SOURCE_SLUG);
  await seedAgent(request, {
    slug: SOURCE_SLUG,
    name: SOURCE_NAME,
    prompt: SOURCE_PROMPT,
    description: SOURCE_DESCRIPTION,
    execution: {
      agentConnectionId: (engine as { id: string }).id,
      credentialProfileRef: CREDENTIAL_REF,
    },
  });
  // The seed only counts if the server actually persisted the credential
  // binding: a source without one cannot prove the copy dropped it.
  const source = await readAgent(request, SOURCE_SLUG);
  expect(
    source.execution?.credentialProfileRef,
    'the source agent did not persist a credential profile, so this journey cannot prove a copy drops it',
  ).toBe(CREDENTIAL_REF);
}

async function pickCopySource(page: Page): Promise<void> {
  await page.goto('/agents/new');
  const copyCard = startingPoint(page, 'copy');
  await expect(copyCard).toBeEnabled({ timeout: 20_000 });
  await copyCard.click();

  await expect(
    page.getByRole('heading', { name: 'Copy an existing agent', level: 3 }),
  ).toBeVisible();
  // EXACT text: a previous run's clone is named "<source> copy", which
  // contains the source's whole name — a substring match picks the clone and
  // the journey then copies a copy.
  await page
    .locator('.agent-editor__copy-row')
    .filter({ has: page.getByText(SOURCE_NAME, { exact: true }) })
    .locator('.agent-editor__copy-pick')
    .click();
}

test.describe('New agent — Copy an existing agent', () => {
  test.beforeEach(async ({ authenticatedRequest }) => {
    await seedSource(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await deleteAgent(authenticatedRequest, COPY_SLUG);
    await deleteAgent(authenticatedRequest, SOURCE_SLUG);
  });

  test('the clone is named "<original> copy", carries the authored fields, and carries no credential binding', async ({
    page,
    authenticatedRequest,
  }) => {
    await pickCopySource(page);

    await expect(page.locator('#ae-name')).toHaveValue(`${SOURCE_NAME} copy`);
    await expect(page.locator('#ae-prompt')).toHaveValue(SOURCE_PROMPT);
    await expect(page.locator('#ae-description')).toHaveValue(
      SOURCE_DESCRIPTION,
    );

    await createButton(page).click();
    await page.waitForURL(new RegExp(`/agents/${COPY_SLUG}\\?created=1$`), {
      timeout: 30_000,
    });

    const clone = await readAgent(authenticatedRequest, COPY_SLUG);
    expect(clone.name).toBe(`${SOURCE_NAME} copy`);
    expect(clone.prompt).toBe(SOURCE_PROMPT);
    expect(clone.description).toBe(SOURCE_DESCRIPTION);
    expect(clone.execution?.credentialProfileRef).toBeUndefined();

    // And the source is untouched — a copy that moved the binding instead of
    // dropping it would satisfy the assertion above.
    const source = await readAgent(authenticatedRequest, SOURCE_SLUG);
    expect(source.execution?.credentialProfileRef).toBe(CREDENTIAL_REF);
  });
});

test.describe('New agent — Copy an existing agent at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ authenticatedRequest }) => {
    await seedSource(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await deleteAgent(authenticatedRequest, COPY_SLUG);
    await deleteAgent(authenticatedRequest, SOURCE_SLUG);
  });

  test('the copy picker and the named clone survive the phone', async ({
    page,
    authenticatedRequest,
  }) => {
    await pickCopySource(page);

    await expect(page.locator('#ae-name')).toHaveValue(`${SOURCE_NAME} copy`);
    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);

    await createButton(page).click();
    await page.waitForURL(new RegExp(`/agents/${COPY_SLUG}\\?created=1$`), {
      timeout: 30_000,
    });

    const clone = await readAgent(authenticatedRequest, COPY_SLUG);
    expect(clone.name).toBe(`${SOURCE_NAME} copy`);
    expect(clone.execution?.credentialProfileRef).toBeUndefined();
  });
});
