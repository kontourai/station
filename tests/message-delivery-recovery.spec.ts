import type { Server } from 'node:http';
import { expect, type Page } from '@playwright/test';
import { waitForSeededAgent } from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  createAuthenticatedE2ERequest,
} from './helpers/authenticated-request';
import { test } from './helpers/fixture-audit';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

/**
 * A composer send whose app is closed before Station's answer arrives,
 * against a real Station. The browser is reloaded while the send's request is
 * still open — the page that sent it is gone, exactly as when the app is
 * killed — and the reloaded app must settle the send by asking Station what
 * became of its key (`GET …/turn-deliveries/:key`):
 *
 * - Station received and started it (the answer was lost on the way back):
 *   the lookup says `started`, nothing is sent again, and the conversation
 *   holds exactly one turn for the message.
 * - Station never received it: the lookup says `not-received`, the message
 *   is sent again with the SAME key, and Station ends with exactly one turn.
 *
 * Turns are counted from the conversation's own durable event window, not
 * from what the page renders.
 */

const FIXTURE_CONNECTION_ID = 'e2e-message-delivery-fixture';
const FIXTURE_MODEL = 'station-message-delivery:latest';
const FIXTURE_REPLY = 'Delivery fixture answered.';
const FIRST_MESSAGE = 'Start of the conversation.';

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

/** Every `turn.started` prompt in the conversation, across its Sessions. */
async function turnPrompts(
  request: AuthenticatedE2ERequest,
  conversationId: string,
): Promise<unknown[] | string> {
  const response = await request.get(
    `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/event-window?turnLimit=20`,
  );
  if (!response.ok()) return `HTTP ${response.status()}`;
  const body = (await response.json()) as {
    data: { events: Array<{ event: { method?: string; prompt?: unknown } }> };
  };
  return body.data.events
    .map((entry) => entry.event)
    .filter((event) => event.method === 'turn.started')
    .map((event) => event.prompt);
}

/** How many rows this browser's durable outbox still holds. */
async function outboxRows(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('station-outbound-queue');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('queue')) {
            database.close();
            resolve(0);
            return;
          }
          const read = database
            .transaction('queue', 'readonly')
            .objectStore('queue')
            .get('station-outbound-queue-v1');
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            database.close();
            const state = read.result as { turns?: unknown[] } | undefined;
            resolve(state?.turns?.length ?? 0);
          };
        };
      }),
  );
}

/** The chat send's request, intercepted; returns what it carried. */
async function sendHeldOpen(
  page: Page,
  text: string,
  forward: boolean,
): Promise<{ conversationId: string; clientTurnId: string }> {
  let resolveSent!: (body: {
    conversationId: string;
    clientTurnId: string;
  }) => void;
  const sent = new Promise<{ conversationId: string; clientTurnId: string }>(
    (resolve) => {
      resolveSent = resolve;
    },
  );
  await page.route('**/api/orchestration/chat', async (route) => {
    const body = route.request().postDataJSON() as {
      conversationId: string;
      clientTurnId: string;
    };
    if (forward) {
      // Station gets it and answers; the answer never reaches the page.
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
    }
    resolveSent(body);
    // Never fulfilled: the page is reloaded with this request still open.
  });
  const composer = page.getByPlaceholder(/^Type a message/);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // The intercept stays installed through the reload: removing it first
  // would let the held request continue to Station before the page dies.
  return sent;
}

test.describe('A send whose app closed before Station answered', () => {
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

  async function openFixtureChat(
    page: Page,
    authenticatedRequest: AuthenticatedE2ERequest,
    baseURL: string,
  ) {
    suspended = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, suspended, false);
    const fixture = await startOllamaFixture(
      FIXTURE_MODEL,
      () => undefined,
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
          name: 'Message delivery fixture',
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
    const agentSlug = `e2e-message-delivery-${stamp}`;
    const agentName = `E2E Message Delivery ${stamp}`;
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
    // The conversation's first turn goes in directly, so the journey starts
    // in an open chat with a bound Session; the composer sends the second.
    const conversationId = `${agentSlug}:${stamp}`;
    const firstSend = await authenticatedRequest.post(
      '/api/orchestration/chat',
      {
        data: {
          target: { environment: { kind: 'current' }, agent: agentSlug },
          message: FIRST_MESSAGE,
          conversationId,
          clientTurnId: `e2e-first-${stamp}`,
        },
      },
    );
    expect(firstSend.ok(), await firstSend.text()).toBe(true);
    await expect
      .poll(() => turnPrompts(authenticatedRequest, conversationId), {
        timeout: 60_000,
      })
      .toEqual([FIRST_MESSAGE]);
    await page.goto(
      new URL(
        `/?dock=open&maximize=true&chat=${encodeURIComponent(conversationId)}`,
        baseURL,
      ).href,
    );
    await expect(
      page
        .getByRole('log', { name: 'Conversation transcript' })
        .getByText(FIXTURE_REPLY, { exact: true }),
    ).toHaveCount(1, { timeout: 60_000 });
    return conversationId;
  }

  for (const { forward, outcome, label } of [
    {
      forward: true,
      outcome: 'started',
      label: 'Station started it: the reloaded app sends nothing again',
    },
    {
      forward: false,
      outcome: 'not-received',
      label:
        'Station never received it: the reloaded app sends it once, with the same key',
    },
  ] as const) {
    test(label, async ({ page, request, baseURL }) => {
      test.setTimeout(240_000);
      if (!baseURL) throw new Error('Playwright baseURL is required');
      const authenticatedRequest = createAuthenticatedE2ERequest(request);
      const conversationId = await openFixtureChat(
        page,
        authenticatedRequest,
        baseURL,
      );
      const text = `Deliver me exactly once ${outcome} ${Date.now()}`;

      const held = await sendHeldOpen(page, text, forward);
      expect(held.conversationId).toBe(conversationId);

      // The reloaded app asks Station about the key before sending anything.
      const lookup = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/orchestration/conversations/${encodeURIComponent(held.conversationId)}/turn-deliveries/${encodeURIComponent(held.clientTurnId)}`,
        { timeout: 60_000 },
      );
      const replays: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (
          request.method() === 'POST' &&
          path.startsWith('/api/orchestration/chat')
        ) {
          const body = request.postDataJSON() as { clientTurnId?: string };
          replays.push(body.clientTurnId ?? '');
        }
      });
      await page.reload();
      const answered = await lookup;
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      expect(answered.status()).toBe(200);
      expect(
        ((await answered.json()) as { data: { outcome: string } }).data,
      ).toMatchObject({ outcome });

      // Exactly one turn for the message, whichever way it went.
      await expect
        .poll(() => turnPrompts(authenticatedRequest, held.conversationId), {
          timeout: 90_000,
        })
        .toEqual([FIRST_MESSAGE, text]);
      // Settled, not merely not-yet-duplicated: the outbox is empty (nothing
      // left that could still be sent) before the final count.
      await expect.poll(() => outboxRows(page), { timeout: 60_000 }).toBe(0);
      await expect(
        page
          .getByRole('log', { name: 'Conversation transcript' })
          .getByText(FIXTURE_REPLY, { exact: true }),
      ).toHaveCount(2, { timeout: 60_000 });
      expect(
        await turnPrompts(authenticatedRequest, held.conversationId),
      ).toEqual([FIRST_MESSAGE, text]);
      expect(replays).toEqual(forward ? [] : [held.clientTurnId]);
    });
  }
});
