import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { basename, resolve } from 'node:path';
import { expect } from '@playwright/test';
import {
  openChatWithAgent,
  waitForSeededAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  createAuthenticatedE2ERequest,
} from './helpers/authenticated-request';
import { monitorBrowserHealth } from './helpers/browser-health';
import { test } from './helpers/fixture-audit';
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
 * Regression for #574: Station's metadata-only resume cursor cannot stand
 * in for prompt history when the next turn owns a new execution Session.
 * Native history must reach the model through its authorized memory owner;
 * prior user/assistant roles and structured native records stay intact.
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

  test.afterEach(async ({ request }) => {
    const authenticatedRequest = createAuthenticatedE2ERequest(request);
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
    request,
    baseURL,
  }) => {
    const authenticatedRequest = createAuthenticatedE2ERequest(request);
    test.setTimeout(300_000);
    if (!baseURL) throw new Error('Playwright baseURL is required');
    const browserHealth = await monitorBrowserHealth(page);

    suspended = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, suspended, false);
    const chatRequests: CapturedChatBody[] = [];
    const evidenceRoot = resolve(
      '.kontourai/native-context-browser',
      basename(process.env.STATION_E2E_OUTPUT_DIR ?? 'manual'),
    );
    mkdirSync(evidenceRoot, { recursive: true });
    const fixture = await startOllamaFixture(
      FIXTURE_MODEL,
      (body) => {
        chatRequests.push(body as CapturedChatBody);
        writeFileSync(
          resolve(evidenceRoot, 'model-requests.json'),
          JSON.stringify(chatRequests, null, 2),
        );
      },
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
    const agentName = `E2E Multi-turn Context ${Date.now()}`;
    const agentCreated = await authenticatedRequest.post('/agents', {
      data: {
        slug: agentSlug,
        name: agentName,
        prompt: 'Answer in one short sentence.',
      },
    });
    expect(agentCreated.ok()).toBe(true);
    seededAgentSlug = agentSlug;
    await waitForSeededAgent(authenticatedRequest, agentSlug);

    await page.goto(new URL(`/agents/${agentSlug}`, baseURL).href);
    await openChatWithAgent(page, agentName);

    const composer = page.getByPlaceholder('Type a message...');
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });

    // Turn 1.
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill(TURN_1_TEXT);
    const firstDispatch = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orchestration/chat' &&
        response.request().method() === 'POST' &&
        response.status() === 200,
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const firstHandle = (await (await firstDispatch).json()).data;
    expect(typeof firstHandle?.sessionId).toBe('string');
    expect(typeof firstHandle?.providerTurnId).toBe('string');
    await expect(
      transcript.getByText(FIXTURE_REPLY, { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 });
    // A rendered response or menu control is not terminal evidence.
    // Read the exact persisted provider turn before asking its follow-up.
    await expect
      .poll(
        async () => {
          const response = await authenticatedRequest.get(
            `/api/orchestration/sessions/${encodeURIComponent(firstHandle.sessionId)}/events`,
          );
          expect(response.ok()).toBe(true);
          const body = await response.json();
          return body.data.some(
            (event: { method?: string; turnId?: string }) =>
              event.method === 'turn.completed' &&
              event.turnId === firstHandle.providerTurnId,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // Turn 2.
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.fill(TURN_2_TEXT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(
        () =>
          chatRequests.some((body) => {
            const lastUser = body.messages
              ?.filter((message) => message.role === 'user')
              .at(-1);
            return messageText(lastUser).trim().endsWith(TURN_2_TEXT);
          }),
        { timeout: 30_000 },
      )
      .toBe(true);

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
    const secondTurnBody = chatRequests.find((body) =>
      messageText(
        body.messages?.filter((message) => message.role === 'user').at(-1),
      )
        .trim()
        .endsWith(TURN_2_TEXT),
    );
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
