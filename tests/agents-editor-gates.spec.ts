import type { Server } from 'node:http';
import type { AuthenticatedE2ERequest } from './helpers/authenticated-request';
import { expect, test } from './helpers/authenticated-request';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

/**
 * The gates on `/agents/new` and the agent editor's own chrome, driven against
 * the REAL API rather than mocked routes.
 *
 * Every defect covered here is invisible to a mocked suite:
 *
 *  - archive#3743 — the §3.3 model picker listed a connection as Ready while
 *    Create Agent stayed disabled and nothing said why, because the gate tested
 *    an id captured into form state when the starting point was pressed and the
 *    picker read the live list. It is state-dependent, so the reproduction here
 *    delays `GET /api/connections/models` past that click.
 *  - archive#3741 — Create refused "System prompt is required" for a field
 *    carrying no required marker.
 *  - archive#3742 — the readiness sentence named a connection id.
 *
 * Deliberately narrow. `agents-new-model-turn` owns "Create waits on a ready
 * model connection and offers the repair inline", `agents-editor-roundtrip`
 * owns the mobile sticky footer, and `agents-readiness-board` owns the rail's
 * readiness sentence; what is left here is what none of them can see.
 */

const STUB_MODEL_ID = 'gates-stub-model';
const STUB_MODEL_NAME = 'Gates Stub';

let fixtureServer: Server | null = null;
/** Connections this spec turned off, to be turned back on. */
let disabledConnections: Array<Record<string, unknown>> = [];

test.afterEach(async ({ authenticatedRequest }) => {
  // Delete the connection BEFORE its endpoint goes away. A connection left
  // pointing at a closed fixture is a slow, unready row in the shared model
  // inventory every later spec reads.
  await authenticatedRequest
    .delete(`/api/connections/${STUB_MODEL_ID}`)
    .catch(() => undefined);
  // ...and put back the ones it turned off. Proving the empty case means
  // emptying the home's model inventory; leaving it empty makes every later
  // journey on this instance read "no enabled LLM provider connection is
  // configured", which is how this teardown came to exist.
  for (const connection of disabledConnections) {
    await authenticatedRequest
      .put(`/api/connections/${encodeURIComponent(String(connection.id))}`, {
        data: { ...connection, enabled: true },
      })
      .catch(() => undefined);
  }
  disabledConnections = [];
  await closeFixtureServer(fixtureServer);
  fixtureServer = null;
});

async function seedReadyModelConnection(
  authenticatedRequest: AuthenticatedE2ERequest,
) {
  const existing = await authenticatedRequest.get('/api/connections/models');
  const body = (await existing.json()) as {
    data?: Array<{
      id: string;
      kind: string;
      type: string;
      name: string;
      capabilities: string[];
      config: Record<string, unknown>;
    }>;
  };
  for (const connection of body.data ?? []) {
    if (!connection.capabilities.includes('llm')) continue;
    await authenticatedRequest.put(
      `/api/connections/${encodeURIComponent(connection.id)}`,
      { data: { ...connection, enabled: false } },
    );
    disabledConnections.push(connection as Record<string, unknown>);
  }
  // A REACHABLE endpoint, the way `ui-crud-smoke` seeds one. A connection
  // pointed at a dead URL reads `ready` when it is written and re-probes to
  // something else moments later, which makes "the picker says Ready" a race
  // rather than a fact.
  const fixture = await startOllamaFixture('gates-stub:latest');
  fixtureServer = fixture.server;
  const created = await authenticatedRequest.post('/api/connections', {
    data: {
      id: STUB_MODEL_ID,
      kind: 'model',
      type: 'ollama',
      name: STUB_MODEL_NAME,
      enabled: true,
      capabilities: ['llm'],
      config: { baseUrl: fixture.origin },
      status: 'ready',
      prerequisites: [],
    },
  });
  expect(created.ok()).toBe(true);
}

/**
 * The server's own answer to "is there a ready model connection", polled
 * before the page is opened.
 *
 * These tests share one instance with each other and with whatever ran
 * before them, and the readiness they assert on is server state. Reading it
 * back is what makes each case independent of the order it ran in.
 */
async function readyLlmConnectionIds(
  authenticatedRequest: AuthenticatedE2ERequest,
): Promise<string[]> {
  const response = await authenticatedRequest.get('/api/connections/models');
  const body = (await response.json()) as {
    data?: Array<{
      id: string;
      enabled: boolean;
      status: string;
      capabilities: string[];
    }>;
  };
  return (body.data ?? [])
    .filter(
      (connection) =>
        connection.enabled &&
        connection.status === 'ready' &&
        connection.capabilities.includes('llm'),
    )
    .map((connection) => connection.id);
}

test.describe('agent editor gates', () => {
  test('the Create gate and the model picker give one answer (station#3743)', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(90_000);
    await seedReadyModelConnection(authenticatedRequest);
    await expect
      .poll(() => readyLlmConnectionIds(authenticatedRequest), {
        timeout: 20_000,
      })
      .toEqual([STUB_MODEL_ID]);

    // The failing state: the starting point is pressed before the connections
    // query resolves. The captured-id gate read that as "no engine" for the
    // rest of the session while the picker went on listing the connection.
    await page.route('**/api/connections/models', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.continue();
    });

    await page.goto('/agents/new');
    await page
      .getByRole('button', { name: /Chat with a model/i })
      .first()
      .click({ timeout: 20_000 });
    await expect(page.locator('#ae-name')).toBeVisible({ timeout: 20_000 });
    await page.locator('#ae-name').fill('Gate Agreement Agent');
    await page.locator('#ae-prompt').fill('You are a gate-agreement agent.');

    const picker = page.locator('#ae-model-connection');
    await expect(picker).toBeVisible();
    // What the picker says it will run on, once the slow query has landed.
    await expect(
      picker.getByRole('option', { name: /Gates Stub — Ready/ }),
    ).toHaveCount(1, { timeout: 20_000 });

    // ...and the button agrees. Before the fix this stayed disabled with no
    // banner anywhere on the screen.
    await expect(
      page.getByRole('button', { name: 'Create Agent' }),
    ).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator('.agent-editor__capability-banner')).toHaveCount(
      0,
    );
  });

  test('a required system prompt is marked, and gates Create (station#3741)', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(90_000);
    await seedReadyModelConnection(authenticatedRequest);
    await expect
      .poll(() => readyLlmConnectionIds(authenticatedRequest), {
        timeout: 20_000,
      })
      .toEqual([STUB_MODEL_ID]);

    await page.goto('/agents/new');
    await page
      .getByRole('button', { name: /Chat with a model/i })
      .first()
      .click({ timeout: 20_000 });
    await expect(page.locator('#ae-name')).toBeVisible({ timeout: 20_000 });
    await page.locator('#ae-name').fill('Required Prompt Agent');

    const promptLabel = page.locator('label[for="ae-prompt"]');
    await expect(promptLabel).toContainText('*');
    await expect(page.locator('#ae-prompt')).toHaveAttribute(
      'aria-required',
      'true',
    );
    const create = page.getByRole('button', { name: 'Create Agent' });
    await expect(create).toBeDisabled();

    await page.locator('#ae-prompt').fill('You are a required-prompt agent.');
    await expect(create).toBeEnabled({ timeout: 20_000 });
  });

  test('an unready engine is named, never identified by its id (station#3742)', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(90_000);
    const slug = `gates-broken-engine-${Date.now()}`;
    const created = await authenticatedRequest.post('/agents', {
      data: {
        slug,
        name: 'Gates Broken Engine',
        prompt: 'x',
        execution: { agentConnectionId: 'gates-nonexistent-engine' },
      },
    });
    expect(created.ok()).toBe(true);
    try {
      await page.goto('/agents');
      const rail = page.locator('.split-pane');
      await expect(rail).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText('Gates Broken Engine', { exact: false }).first(),
      ).toBeVisible({ timeout: 20_000 });

      // Wait for the SENTENCE, not just the row. On a freshly started
      // instance the managed runtime has not registered its engine agents
      // yet, and for that window the rail answers from a different readiness
      // source — every engine reads "not ready yet" and this agent reads
      // Ready. Reading the rail's text before it settles asserted against the
      // warmup state — observable when this file runs first against a
      // just-started instance.
      await expect(
        page
          .getByText(/the engine this agent runs on is no longer connected/i)
          .first(),
      ).toBeVisible({ timeout: 30_000 });

      // `innerText` reflects the badge's own text-transform, so match the
      // sentence rather than its casing.
      const shell = (await page.locator('body').innerText()).toLowerCase();
      expect(shell).toContain('needs');
      expect(shell).not.toContain('gates-nonexistent-engine');
      expect(shell).not.toContain('engine connection');
    } finally {
      await authenticatedRequest.delete(`/agents/${slug}`);
    }
  });
});
