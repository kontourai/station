import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from '@playwright/test';
import { waitForSeededAgent } from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  createAuthenticatedE2ERequest,
} from './helpers/authenticated-request';
import { test } from './helpers/fixture-audit';
import { closeFixtureServer } from './helpers/ollama-fixture';

/**
 * #3112: "Send again" on a stored failure card, against a real Station and a
 * model server that fails every turn with HTTP 500.
 *
 * The resend must read exactly as the original prompt did, so its
 * `turn.started` prompt carries no ambient context prefix. A failed
 * Station-agent turn ends its Session's binding, so the resend runs in a
 * successor Session; the conversation read covers the whole lineage, so it
 * gains the resent prompt and its failure marker. Stored user turns are the
 * typed text alone — the ambient context (`[Timezone: …]`) reaches only the
 * model.
 */

const FIXTURE_CONNECTION_ID = 'e2e-send-again-failure-fixture';
const FIXTURE_MODEL = 'station-send-again-failure:latest';
const PROMPT = 'Summarize the quarterly ledger, please.';
const AMBIENT_CONTEXT = '[Timezone: Pacific/Chatham]';

interface LlmConnection extends Record<string, unknown> {
  id: string;
  enabled?: boolean;
  capabilities?: string[];
}

interface RuntimeEvent {
  method?: string;
  turnId?: string;
  prompt?: unknown;
}

interface StoredMessage {
  role?: string;
  content?: unknown;
  parts?: Array<{ type?: string; text?: string }>;
}

function storedText(message: StoredMessage): string {
  const fromParts = (message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
  if (fromParts) return fromParts;
  return typeof message.content === 'string' ? message.content : '';
}

/** A model server whose every chat completion fails with HTTP 500. */
function startFailingModelFixture(model: string): Promise<{
  server: Server;
  origin: string;
}> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (request.method === 'GET' && url.pathname === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: model }] }));
        return;
      }
      request.resume();
      request.on('end', () => {
        response.writeHead(500, {
          'content-type': 'application/json',
          connection: 'close',
        });
        response.end(
          JSON.stringify({ error: { message: 'fixture model failure' } }),
        );
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
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

test.describe('Send again on a stored failed turn (#3112)', () => {
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

  test('the resend reads exactly as the original prompt', async ({
    page,
    request,
    baseURL,
  }) => {
    const authenticatedRequest = createAuthenticatedE2ERequest(request);
    test.setTimeout(300_000);
    if (!baseURL) throw new Error('Playwright baseURL is required');

    suspended = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, suspended, false);
    const fixture = await startFailingModelFixture(FIXTURE_MODEL);
    fixtureServer = fixture.server;
    const connectionCreated = await authenticatedRequest.post(
      '/api/connections',
      {
        data: {
          id: FIXTURE_CONNECTION_ID,
          kind: 'model',
          type: 'ollama',
          name: 'Send again failure fixture',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: fixture.origin, defaultModel: FIXTURE_MODEL },
          status: 'ready',
          prerequisites: [],
        },
      },
    );
    expect(connectionCreated.ok()).toBe(true);

    const stamp = Date.now();
    const agentSlug = `e2e-send-again-${stamp}`;
    const agentName = `E2E Send Again ${stamp}`;
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

    // The first turn is sent the way the composer sends one: typed text, with
    // the ambient context out-of-band.
    const threadId = `${agentSlug}:${stamp}`;
    const firstSend = await authenticatedRequest.post(
      '/api/orchestration/chat',
      {
        data: {
          target: { environment: { kind: 'current' }, agent: agentSlug },
          message: PROMPT,
          conversationId: threadId,
          ambientContext: AMBIENT_CONTEXT,
          clientTurnId: `e2e-first-${stamp}`,
        },
      },
    );
    expect(
      firstSend.ok(),
      `first send refused: ${await firstSend.text()}`,
    ).toBe(true);
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });

    // The conversation's event window spans every execution Session in its
    // lineage, so a resend that runs in a successor Session is still read.
    // Every turn.started prompt in the window, or the HTTP status a read that
    // is not (yet) answerable returned, so the poll below can wait it out.
    const readTurnPrompts = async (): Promise<unknown[] | string> => {
      const response = await authenticatedRequest.get(
        `/api/orchestration/conversations/${encodeURIComponent(threadId)}/event-window?turnLimit=20`,
      );
      if (!response.ok()) return `HTTP ${response.status()}`;
      const body = (await response.json()) as {
        data: { events: Array<{ event: RuntimeEvent }> };
      };
      return body.data.events
        .map((entry) => entry.event)
        .filter((event) => event.method === 'turn.started')
        .map((event) => event.prompt);
    };
    const readMessages = async (): Promise<StoredMessage[]> => {
      const response = await authenticatedRequest.get(
        `/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(threadId)}/messages`,
      );
      expect(response.ok()).toBe(true);
      return ((await response.json()) as { data: StoredMessage[] }).data;
    };
    const failureMarkers = (messages: StoredMessage[]) =>
      messages.filter((message) =>
        storedText(message).startsWith('[SYSTEM_EVENT] [CHAT_ERROR]'),
      );

    // The first turn fails and its prompt and marker are stored.
    await expect
      .poll(async () => failureMarkers(await readMessages()).length, {
        timeout: 60_000,
      })
      .toBe(1);

    // Open the chat from its stored record, as a reload does.
    await page.goto(
      new URL(
        `/?dock=open&maximize=true&chat=${encodeURIComponent(threadId)}`,
        baseURL,
      ).href,
    );
    const sendAgain = transcript.getByRole('button', { name: 'Send again' });
    await expect(sendAgain).toHaveCount(1, { timeout: 30_000 });
    await sendAgain.click();

    // The resend starts its own turn with exactly the original prompt.
    await expect
      .poll(readTurnPrompts, { timeout: 90_000 })
      .toEqual([PROMPT, PROMPT]);

    // The conversation read gains the resent prompt and its failure marker.
    await expect
      .poll(async () => failureMarkers(await readMessages()).length, {
        timeout: 60_000,
      })
      .toBe(2);
    const stored = await readMessages();
    const texts = stored.map(storedText);
    const markerIndexes = texts.flatMap((text, index) =>
      text.startsWith('[SYSTEM_EVENT] [CHAT_ERROR]') ? [index] : [],
    );
    expect(
      texts.slice(markerIndexes[0]! + 1, markerIndexes[1]!),
      'the resent prompt is stored between the two failure markers',
    ).toContain(PROMPT);
    // Every stored user turn is the typed text alone, and each failed turn
    // is exactly its prompt and its marker.
    for (const message of stored.filter((entry) => entry.role === 'user'))
      expect(storedText(message)).not.toContain('[Timezone:');
    expect(
      stored.map((message) =>
        storedText(message).startsWith('[SYSTEM_EVENT] [CHAT_ERROR]')
          ? 'marker'
          : `${message.role}:${storedText(message)}`,
      ),
    ).toEqual([`user:${PROMPT}`, 'marker', `user:${PROMPT}`, 'marker']);

    // The successor Session the resend ran in is not a conversation of its
    // own.
    const listed = await authenticatedRequest.get(
      `/agents/${encodeURIComponent(agentSlug)}/conversations`,
    );
    expect(listed.ok()).toBe(true);
    const listedIds = (
      (await listed.json()) as { data: { items: Array<{ id: string }> } }
    ).data.items.map((item) => item.id);
    expect(listedIds).toEqual([threadId]);

    // A runtime conversation is read-only to the file-store delete, so its
    // lineage is never left half-deleted.
    const deleted = await authenticatedRequest.delete(
      `/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(threadId)}`,
    );
    expect(deleted.status()).toBe(409);
    expect(failureMarkers(await readMessages())).toHaveLength(2);
  });
});
