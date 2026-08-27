import type { Server } from 'node:http';
import { expect, type Page } from '@playwright/test';
import {
  createButton,
  deleteAgent,
  openChatWithAgent,
  sendComposerTurn,
  startingPoint,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  test,
} from './helpers/authenticated-request';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

/**
 * E2 — "Chat with a model" end to end, on a real engine
 * (`reports/agents-lane/DESIGN.md` §4).
 *
 * Two halves, and the first is the one the redesign exists for: DESIGN §4 says
 * "Create is disabled until the engine choice is made AND that engine is
 * Ready", replacing shot 17's failure mode — a form that accepted a name and a
 * template and then answered its only button with a requirement it had never
 * mentioned. So the disabled Create AND the inline repair beside it are
 * asserted with no ready model connection on the host, and only then is one
 * provisioned and the journey run to a real assistant turn.
 *
 * `smoke-live`: the second half dispatches a genuine turn through
 * `POST /api/orchestration/chat` into a local model fixture, so it needs a
 * running Station and a running model server, not a mocked route.
 */

const FIXTURE_CONNECTION_ID = 'e2e-model-turn-fixture';
const FIXTURE_MODEL = 'station-model-turn:latest';
const FIXTURE_REPLY = 'Model fixture answered the composer.';

let fixtureServer: Server | null = null;
let suspended: LlmConnection[] = [];
const createdSlugs: string[] = [];

test.afterEach(async ({ authenticatedRequest }) => {
  for (const slug of createdSlugs.splice(0)) {
    await deleteAgent(authenticatedRequest, slug);
  }
  await authenticatedRequest.delete(
    `/api/connections/${FIXTURE_CONNECTION_ID}`,
  );
  await setConnectionsEnabled(authenticatedRequest, suspended.splice(0), true);
  await closeFixtureServer(fixtureServer);
  fixtureServer = null;
});

interface LlmConnection extends Record<string, unknown> {
  id: string;
  enabled?: boolean;
  capabilities?: string[];
}

/** Every enabled connection the Create gate would accept as "a ready model". */
async function enabledLlmConnections(
  request: AuthenticatedE2ERequest,
): Promise<LlmConnection[]> {
  const response = await request.get('/api/connections/models');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { data?: LlmConnection[] };
  return (body.data ?? []).filter(
    (connection) =>
      connection.enabled !== false &&
      (connection.capabilities ?? []).includes('llm'),
  );
}

async function setConnectionsEnabled(
  request: AuthenticatedE2ERequest,
  connections: LlmConnection[],
  enabled: boolean,
): Promise<void> {
  for (const connection of connections) {
    const response = await request.put(
      `/api/connections/${encodeURIComponent(connection.id)}`,
      { data: { ...connection, enabled } },
    );
    expect(response.ok()).toBe(true);
  }
}

/**
 * Make the fixture the ONLY enabled LLM connection, then register it.
 *
 * Suspending the host's other model connections is not tidiness. Station
 * refuses a Station-engine turn with "Multiple enabled LLM provider
 * connections require an application default" when more than one is enabled
 * and no application default is set — observed live in this lane, and it
 * refuses even for an agent that names one connection explicitly. Owning the
 * model landscape for the length of the test is what makes the turn below a
 * statement about the create journey rather than about the host's ambient
 * connection list. Everything is restored in `afterEach`.
 */
async function provisionFixtureConnection(
  request: AuthenticatedE2ERequest,
): Promise<void> {
  suspended = await enabledLlmConnections(request);
  await setConnectionsEnabled(request, suspended, false);
  const fixture = await startOllamaFixture(
    FIXTURE_MODEL,
    () => undefined,
    FIXTURE_REPLY,
  );
  fixtureServer = fixture.server;
  const created = await request.post('/api/connections', {
    data: {
      id: FIXTURE_CONNECTION_ID,
      kind: 'model',
      type: 'ollama',
      name: 'Model turn fixture',
      enabled: true,
      capabilities: ['llm'],
      config: { baseUrl: fixture.origin, defaultModel: FIXTURE_MODEL },
      status: 'ready',
      prerequisites: [],
    },
  });
  expect(created.ok()).toBe(true);
  const body = (await created.json()) as { success?: boolean; error?: string };
  expect(
    body.success,
    `the model fixture connection was refused: ${body.error ?? 'no reason given'}`,
  ).toBe(true);
}

/**
 * Walk §4's "Chat with a model" beat to a created agent and return its slug.
 *
 * The System Instructions field is filled because a Station-engine agent must
 * author one. station#3741 landed the other half — the field says so, and
 * Create is disabled until it is filled rather than refusing after submit — so
 * the enabled assertion below sits after the fields rather than before them.
 * This journey still covers the engine gate §4 rebuilt; the marker itself is
 * pinned by `agents-editor-gates`.
 */
async function createModelAgent(page: Page, name: string): Promise<string> {
  await page.goto('/agents/new');
  await startingPoint(page, 'model').click();

  const create = createButton(page);

  await page.locator('#ae-name').fill(name);
  await page.locator('#ae-prompt').fill('Answer in one short sentence.');

  // Asserted AFTER the required fields, not before: since station#3741 Create
  // is disabled while the form is incomplete as well as while the engine is
  // unready, so an empty form is legitimately refused here.
  await expect(create).toBeEnabled({ timeout: 20_000 });

  // §3.3 renders only for this starting point. Choose the fixture explicitly
  // rather than asserting whatever the form pre-selected: which connection is
  // first depends on what else this Station has, and the claim under test is
  // that the picker binds the chosen connection to the agent.
  const modelConnection = page.locator('#ae-model-connection');
  await expect(modelConnection).toBeVisible();
  await modelConnection.selectOption(FIXTURE_CONNECTION_ID);
  await expect(modelConnection).toHaveValue(FIXTURE_CONNECTION_ID);

  await create.click();
  await page.waitForURL(/\/agents\/[^/]+\?created=1$/, { timeout: 30_000 });
  const slug = decodeURIComponent(
    new URL(page.url()).pathname.split('/').pop() ?? '',
  );
  expect(slug.length).toBeGreaterThan(0);
  createdSlugs.push(slug);
  return slug;
}

test.describe('New agent — Chat with a model', () => {
  test('Create waits on a ready model connection and offers the repair inline', async ({
    page,
    authenticatedRequest,
  }) => {
    const enabled = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, enabled, false);
    try {
      await page.goto('/agents/new');
      await startingPoint(page, 'model').click();

      // The gate: the engine is chosen, and it is not Ready.
      await expect(createButton(page)).toBeDisabled({ timeout: 20_000 });

      // §4: "the fixing action is shown inline instead of a validation error
      // after submit". The repair is what makes the disabled button honest.
      // station#4521 LOW-1: canonical copy is CONNECTION_SECTIONS' own
      // `addLabel` ("Add model connection"), not this file's prior wording.
      await expect(
        page.getByRole('button', { name: 'Add model connection' }),
      ).toBeVisible();
    } finally {
      await setConnectionsEnabled(authenticatedRequest, enabled, true);
    }
  });

  test('a created model agent answers a real turn through the composer', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(150_000);
    await provisionFixtureConnection(authenticatedRequest);

    const name = `E2E Model Turn ${Date.now()}`;
    await createModelAgent(page, name);

    await openChatWithAgent(page, name);
    await sendComposerTurn(page, 'ping', new RegExp(FIXTURE_REPLY));
  });
});

test.describe('New agent — Chat with a model at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('the same journey completes on a phone with no horizontal scroll', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(150_000);
    await provisionFixtureConnection(authenticatedRequest);

    const name = `E2E Model Turn Mobile ${Date.now()}`;
    await createModelAgent(page, name);

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);

    await openChatWithAgent(page, name);
    await sendComposerTurn(page, 'ping', new RegExp(FIXTURE_REPLY));
  });
});
