import type { Server } from 'node:http';
import {
  ensureChatDockOpen,
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
    if (seededAgentSlug) {
      await authenticatedRequest.delete(
        `/agents/${encodeURIComponent(seededAgentSlug)}`,
      );
      seededAgentSlug = '';
    }
    await authenticatedRequest.delete(
      `/api/connections/${FIXTURE_CONNECTION_ID}`,
    );
    await setConnectionsEnabled(
      authenticatedRequest,
      suspended.splice(0),
      true,
    );
    await closeFixtureServer(fixtureServer);
    fixtureServer = null;
  });

  test('a real turn round-trips through POST /api/orchestration/chat into a real model server', async ({
    page,
    authenticatedRequest,
    baseURL,
  }) => {
    test.setTimeout(60_000);
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
    // The compact header "New chat" icon only mounts inside a project/coding
    // layout; Home shows a big "Start direct chat" card instead, which is a
    // one-click path to whatever agent Home suggests, not necessarily the one
    // seeded here. Dispatch the same global event ChatDock.tsx listens for
    // everywhere once the shell has mounted.
    await expect(
      page.getByRole('button', { name: 'Station home' }),
    ).toBeVisible({ timeout: 20_000 });
    // Deterministic settle: wait for one real authenticated round trip to
    // succeed before touching the picker. On a freshly-navigated page the
    // SDK's credential-vault hydration is async, and opening a chat and
    // sending too quickly can race ahead of it — the very first chat POST
    // then carries no Authorization header and the server correctly (if
    // confusingly) reports `principal_unresolved`, the exact archive#4518 error
    // shape, from a client that never actually lost its credential.
    await statusReady;
    await page.evaluate(() =>
      window.dispatchEvent(new Event('station:open-new-chat')),
    );
    const agentRow = page.locator(
      `.new-chat-modal__agent[data-agent-slug="${agentSlug}"]`,
    );
    await expect(agentRow).toBeVisible({ timeout: 20_000 });
    await agentRow.click();

    // The picker leaves the dock exactly as the user last set it — expand it
    // if it started collapsed (see `ensureChatDockOpen`'s own doc for what
    // is and is not diagnosed about why).
    await ensureChatDockOpen(page);

    const composer = page.getByPlaceholder('Type a message...');
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill('pr-smoke real send.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
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
