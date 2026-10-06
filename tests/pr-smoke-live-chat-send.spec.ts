import type { Server } from 'node:http';
import {
  ensureChatDockOpen,
  waitForAgentRemoved,
  waitForDispatchThroughCapacityRetries,
  waitForSeededAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { monitorBrowserHealth } from './helpers/browser-health';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

/**
 * archive#4537 item 2: a real chat send inside pr-smoke's own gate.
 *
 * `orchestration-chat-flow.spec.ts` and `cross-runtime-chat-switching.spec.ts`
 * — the two "canonical chat" specs pr-smoke already runs — both fake
 * `POST /api/orchestration/chat` via `page.route`, so no PR-gating run has
 * ever dispatched a real turn (archive#4537). This is a dedicated, lean spec
 * so the merge gate proves at least one real send/receive without touching
 * those two specs' existing mocked SSE-render-state coverage (which is
 * legitimately component-level: it proves the transcript/approval UI reacts
 * to canonical events, not that the network layer is real).
 *
 * Kept intentionally small for pr-smoke's 10-minute/1-worker/0-retry budget:
 * one seeded connection, one seeded agent, one turn.
 */

const FIXTURE_CONNECTION_ID = 'e2e-pr-smoke-live-chat-fixture';
const FIXTURE_MODEL = 'station-pr-smoke-live-chat:latest';
const FIXTURE_REPLY = 'pr-smoke live fixture answered the composer.';

interface LlmConnection extends Record<string, unknown> {
  id: string;
  enabled?: boolean;
  capabilities?: string[];
}

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

test.describe('pr-smoke live chat send', () => {
  let fixtureServer: Server | null = null;
  let suspended: LlmConnection[] = [];
  let seededAgentSlug = '';

  test.afterEach(async ({ authenticatedRequest }) => {
    const removedSlug = seededAgentSlug;
    try {
      if (removedSlug) {
        const removal = await authenticatedRequest.delete(
          `/agents/${encodeURIComponent(removedSlug)}`,
        );
        expect(removal.ok() || removal.status() === 404).toBe(true);
      }
      const connectionRemoval = await authenticatedRequest.delete(
        `/api/connections/${FIXTURE_CONNECTION_ID}`,
      );
      expect(connectionRemoval.ok() || connectionRemoval.status() === 404).toBe(
        true,
      );
      await setConnectionsEnabled(
        authenticatedRequest,
        suspended.splice(0),
        true,
      );
      // Accepted writes can precede catalog reconciliation. Settle this owned
      // fixture before the next live-UI test inherits the shared Station.
      if (removedSlug)
        await waitForAgentRemoved(authenticatedRequest, removedSlug);
    } finally {
      seededAgentSlug = '';
      await closeFixtureServer(fixtureServer);
      fixtureServer = null;
    }
  });

  test('a real turn round-trips through POST /api/orchestration/chat into a real model server', async ({
    page,
    authenticatedRequest,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    if (!baseURL) throw new Error('Playwright baseURL is required');
    const browserHealth = await monitorBrowserHealth(page);

    suspended = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, suspended, false);
    const chatRequests: unknown[] = [];
    const fixture = await startOllamaFixture(
      FIXTURE_MODEL,
      (body) => chatRequests.push(body),
      FIXTURE_REPLY,
    );
    fixtureServer = fixture.server;
    const connectionCreated = await authenticatedRequest.post(
      '/api/connections',
      {
        data: {
          id: FIXTURE_CONNECTION_ID,
          kind: 'model',
          type: 'ollama',
          name: 'pr-smoke live chat fixture',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: fixture.origin, defaultModel: FIXTURE_MODEL },
          status: 'ready',
          prerequisites: [],
        },
      },
    );
    expect(connectionCreated.ok()).toBe(true);

    const agentSlug = `e2e-pr-smoke-live-chat-${Date.now()}`;
    const agentCreated = await authenticatedRequest.post('/agents', {
      data: {
        slug: agentSlug,
        name: `E2E pr-smoke Live Chat ${Date.now()}`,
        prompt: 'Answer in one short sentence.',
      },
    });
    expect(agentCreated.ok()).toBe(true);
    seededAgentSlug = agentSlug;
    await waitForSeededAgent(authenticatedRequest, agentSlug);

    const statusReady = page.waitForResponse(
      (response) =>
        response.url().includes('/api/system/status') &&
        response.status() === 200,
      { timeout: 20_000 },
    );
    await page.goto(baseURL);
    await expect(
      page.getByRole('button', { name: 'Station home' }),
    ).toBeVisible({ timeout: 20_000 });
    await statusReady;
    // Home's start composer is the one way to start a chat: choose the
    // Agent on its chip, then Start sends through the dock.
    const draft = page.getByRole('form', { name: 'Start work' });
    await draft.getByRole('button', { name: /^Agent:/ }).click({
      timeout: 20_000,
    });
    const agentRow = page
      .getByRole('dialog', { name: 'Choose agent' })
      .locator(`.new-chat-modal__agent[data-agent-slug="${agentSlug}"]`);
    await expect(agentRow).toBeVisible({ timeout: 20_000 });
    await agentRow.click();
    await expect(
      page.getByRole('dialog', { name: 'Choose agent' }),
    ).toHaveCount(0);
    await draft
      .getByRole('textbox', { name: 'What would you like done?', exact: true })
      .fill('pr-smoke real send.');
    expect(chatRequests).toHaveLength(0);
    await draft.getByRole('button', { name: 'Start', exact: true }).click();
    await ensureChatDockOpen(page);
    // This is pr-smoke's own merge-gate spec
    // (retries:0, fail-and-fix) — a bare `expect.poll` here reads a real
    // "Host is at capacity" refusal (a genuine, disclosed shared-host
    // condition — see AGENTS.md and journey 3's own use of this same
    // helper) as an indistinguishable chat regression instead of naming
    // itself. Retries through the product's own `Retry` control exactly
    // like journey 3 does.
    await waitForDispatchThroughCapacityRetries(page, chatRequests, 1);
    await expect(
      page
        .locator('#chat-dock, #chat-workspace-pane')
        .getByText(FIXTURE_REPLY, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    expect(chatRequests).toHaveLength(1);
    browserHealth.assertHealthy();
  });
});
