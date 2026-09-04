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
 * archive#4537 item 3: multi-turn context retention, UNCOVERED anywhere per
 * the flow-coverage audit.
 *
 * Sends message 1, then message 2, through the REAL
 * `POST /api/orchestration/chat`, and reads the ollama-fixture's `onChat`
 * capture hook to prove turn 2's REQUEST carried turn 1's exchange (context
 * actually retained SERVER-side, not merely rendered client-side) — the
 * fixture always answers with the same fixed reply, so the discriminating
 * evidence is the captured request body, not the response text. Both turns'
 * distinct prompts and the (identical) reply render in the transcript too.
 *
 * RED BY DESIGN, proving #574: turn 2's captured request is missing
 * turn 1's exchange entirely for this Station/model-engine agent. Quarantined
 * in tests/e2e-manifest.mjs so this doesn't red
 * verify:e2e:full — it re-enters a running bucket once #574 is fixed.
 *
 * The mechanism: `conversation-lineage.ts`'s
 * `continuationLaunchContext` — it OMITS `transcriptSeed` (the prior-turn
 * text a resumed session would otherwise be re-primed with) whenever the
 * session already carries a `resumeCursor` for the SAME execution identity,
 * on the assumption that the provider's own resume mechanism remembers the
 * prior turns via that cursor instead. For this Station/model-engine agent
 * path, that assumption doesn't hold: VoltAgent's own memory is keyed on the
 * SESSION id, and turn 2 dispatches under a NEWLY MINTED session id (not the
 * one the cursor/history belongs to) — so VoltAgent's memory lookup for that
 * new id finds nothing, and neither mechanism (the omitted transcriptSeed,
 * nor VoltAgent's session-keyed memory) actually carries turn 1's exchange
 * into turn 2's request. #574 has the full trace.
 */

const FIXTURE_CONNECTION_ID = 'e2e-multi-turn-context-fixture';
const FIXTURE_MODEL = 'station-multi-turn-context:latest';
const FIXTURE_REPLY = 'Multi-turn context fixture answered the composer.';
const TURN_1_TEXT = 'Remember the exact token GRAPHITE-77.';
const TURN_2_TEXT = 'What token did I just ask you to remember?';

interface LlmConnection extends Record<string, unknown> {
  id: string;
  enabled?: boolean;
  capabilities?: string[];
}

interface CapturedChatMessage {
  role?: string;
  content?: unknown;
}

interface CapturedChatBody {
  messages?: CapturedChatMessage[];
}

function messageText(message: CapturedChatMessage | undefined): string {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('\n');
  }
  return '';
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

test.describe('Multi-turn context retention', () => {
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

  test('a second real turn carries the first turn as context in its request body', async ({
    page,
    authenticatedRequest,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    if (!baseURL) throw new Error('Playwright baseURL is required');
    const browserHealth = await monitorBrowserHealth(page);

    suspended = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, suspended, false);
    const chatRequests: CapturedChatBody[] = [];
    const fixture = await startOllamaFixture(
      FIXTURE_MODEL,
      (body) => chatRequests.push(body as CapturedChatBody),
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
          name: 'Multi-turn context fixture',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: fixture.origin, defaultModel: FIXTURE_MODEL },
          status: 'ready',
          prerequisites: [],
        },
      },
    );
    expect(connectionCreated.ok()).toBe(true);

    const agentSlug = `e2e-multi-turn-context-${Date.now()}`;
    const agentCreated = await authenticatedRequest.post('/agents', {
      data: {
        slug: agentSlug,
        name: `E2E Multi-turn Context ${Date.now()}`,
        prompt: 'Answer in one short sentence.',
      },
    });
    expect(agentCreated.ok()).toBe(true);
    seededAgentSlug = agentSlug;
    await waitForSeededAgent(authenticatedRequest, agentSlug);

    await page.goto(baseURL);
    await expect(
      page.getByRole('button', { name: 'Station home' }),
    ).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() =>
      window.dispatchEvent(new Event('station:open-new-chat')),
    );
    const agentRow = page.locator(
      `.new-chat-modal__agent[data-agent-slug="${agentSlug}"]`,
    );
    await expect(agentRow).toBeVisible({ timeout: 20_000 });
    await agentRow.click();

    await ensureChatDockOpen(page);

    const composer = page.getByPlaceholder('Type a message...');
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });

    // Turn 1.
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill(TURN_1_TEXT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waitForDispatchThroughCapacityRetries(page, chatRequests, 1);
    await expect(
      transcript.getByText(FIXTURE_REPLY, { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 });
    // Deterministic settle: the reply TEXT can paint before the turn's
    // server-side completion/persistence settles (the read a second turn's
    // context assembly depends on) — wait for the per-turn provenance
    // control that only renders once the turn is fully finalized, not just
    // streamed, before sending the next turn.
    await expect(
      transcript.getByRole('button', { name: /^Share this answer/ }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Turn 2.
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill(TURN_2_TEXT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waitForDispatchThroughCapacityRetries(page, chatRequests, 2);

    // Both turns render.
    await expect(
      transcript.getByText(TURN_1_TEXT, { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText(TURN_2_TEXT, { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText(FIXTURE_REPLY, { exact: true }),
    ).toHaveCount(2);

    // The load-bearing proof: turn 2's OWN request body carried turn 1's
    // exchange — a live server-side context read, not a client-side replay.
    const secondTurnBody = chatRequests[1];
    expect(
      secondTurnBody,
      'a second turn request must have been captured',
    ).toBeTruthy();
    const secondTurnMessages = secondTurnBody?.messages ?? [];
    expect(
      secondTurnMessages.some((message) =>
        messageText(message).includes(TURN_1_TEXT),
      ),
      `turn 2's request body must retain turn 1's prompt: ${JSON.stringify(secondTurnMessages)}`,
    ).toBe(true);
    expect(
      secondTurnMessages.some(
        (message) =>
          message.role === 'assistant' &&
          messageText(message).includes(FIXTURE_REPLY),
      ),
      `turn 2's request body must retain turn 1's assistant reply: ${JSON.stringify(secondTurnMessages)}`,
    ).toBe(true);
    expect(
      secondTurnMessages.some((message) =>
        messageText(message).includes(TURN_2_TEXT),
      ),
    ).toBe(true);

    browserHealth.assertHealthy();
  });
});
