import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from '@playwright/test';
import { waitForSeededAgent } from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  createAuthenticatedE2ERequest,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { test } from './helpers/fixture-audit';
import {
  closeFixtureServer,
  type OllamaFixtureStream,
  startOllamaFixture,
} from './helpers/ollama-fixture';
import { pairBrowser } from './live/helpers/station-instance.mjs';

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
    onStream?: Parameters<typeof startOllamaFixture>[3],
  ) {
    suspended = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, suspended, false);
    const fixture = await startOllamaFixture(
      FIXTURE_MODEL,
      () => undefined,
      FIXTURE_REPLY,
      onStream,
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

  test('a server-held follow-up hydrates in another client and after reload, then leaves both pending counts when placed', async ({
    page,
    browser,
    request,
    baseURL,
  }, testInfo) => {
    test.setTimeout(240_000);
    if (!baseURL) throw new Error('Playwright baseURL is required');
    const authenticatedRequest = createAuthenticatedE2ERequest(request);
    const stamp = Date.now();
    const runningMessage = `Hold this running turn ${stamp}`;
    const followUp = `Server-held follow-up ${stamp}`;
    const clientTurnId = `e2e-server-held-${stamp}`;
    let runningStream: OllamaFixtureStream | undefined;
    let followUpStream: OllamaFixtureStream | undefined;
    let observerContext: BrowserContext | undefined;
    const browserSends: unknown[] = [];
    try {
      const conversationId = await openFixtureChat(
        page,
        authenticatedRequest,
        baseURL,
        (stream, body) => {
          const actualRequest = JSON.stringify(body);
          if (actualRequest.includes(followUp)) {
            followUpStream = stream;
            stream.text('The placed follow-up is running.');
          } else if (actualRequest.includes(runningMessage)) {
            runningStream = stream;
            stream.text('The first turn is still running.');
          } else {
            stream.text(FIXTURE_REPLY);
            stream.finish();
          }
        },
      );
      const home = process.env.STATION_E2E_HOME;
      const apiBase = resolveE2EApiBase();
      if (process.env.STATION_E2E_RUNNER !== '1' || !home)
        throw new Error('The isolated E2E runner must own this Station home.');
      const registryDir = join(process.cwd(), '.station', 'instances');
      const instances = readdirSync(registryDir)
        .filter((name) => name.endsWith('.json'))
        .filter((name) => {
          const record: unknown = JSON.parse(
            readFileSync(join(registryDir, name), 'utf8'),
          );
          return (
            typeof record === 'object' &&
            record !== null &&
            'baseDir' in record &&
            record.baseDir === home
          );
        });
      expect(instances).toHaveLength(1);
      observerContext = await browser.newContext();
      const observer = await observerContext.newPage();
      await pairBrowser(observer, {
        root: process.cwd(),
        instance: instances[0].slice(0, -'.json'.length),
        serverPort: Number(new URL(apiBase).port),
        uiOrigin: new URL(baseURL).origin,
      });
      for (const client of [page, observer]) {
        client.on('request', (sent) => {
          if (
            sent.method() === 'POST' &&
            new URL(sent.url()).pathname === '/api/orchestration/chat'
          )
            browserSends.push(sent.postDataJSON());
        });
      }
      await observer.goto(page.url());
      await expect(
        observer.getByRole('log', { name: 'Conversation transcript' }),
      ).toBeVisible();

      const running = await authenticatedRequest.post(
        '/api/orchestration/chat',
        {
          data: {
            target: {
              environment: { kind: 'current' },
              agent: seededAgentSlug,
            },
            message: runningMessage,
            conversationId,
            clientTurnId: `e2e-running-${stamp}`,
          },
        },
      );
      expect(running.status(), await running.text()).toBe(200);
      await expect.poll(() => runningStream !== undefined).toBe(true);
      await expect
        .poll(() => turnPrompts(authenticatedRequest, conversationId))
        .toEqual([FIRST_MESSAGE, runningMessage]);

      const bound = await authenticatedRequest.get(
        `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/event-window?turnLimit=20`,
      );
      expect(bound.status()).toBe(200);
      const binding: unknown = await bound.json();
      if (
        typeof binding !== 'object' ||
        binding === null ||
        !('data' in binding) ||
        typeof binding.data !== 'object' ||
        binding.data === null ||
        !('session' in binding.data) ||
        typeof binding.data.session !== 'object' ||
        binding.data.session === null ||
        !('cwd' in binding.data.session) ||
        typeof binding.data.session.cwd !== 'string' ||
        !binding.data.session.cwd
      )
        throw new Error(
          'The real conversation must retain its directory binding.',
        );
      const queued = await authenticatedRequest.post(
        '/api/orchestration/chat',
        {
          data: {
            target: {
              environment: { kind: 'current' },
              agent: seededAgentSlug,
              workspace: { kind: 'directory', cwd: binding.data.session.cwd },
            },
            message: followUp,
            conversationId,
            clientTurnId,
            whenBusy: 'queue',
          },
        },
      );
      expect(queued.status(), await queued.text()).toBe(202);
      expect(await queued.json()).toMatchObject({
        success: true,
        data: {
          outcome: 'queued',
          clientTurnId,
          entry: { state: 'queued', message: followUp },
        },
      });
      const inboxPath = `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/inbox`;
      const inbox = await authenticatedRequest.get(inboxPath);
      expect(inbox.status()).toBe(200);
      expect(await inbox.json()).toMatchObject({
        data: {
          entries: expect.arrayContaining([
            expect.objectContaining({ clientTurnId, state: 'queued' }),
          ]),
        },
      });

      const capture = async (name: string, client: Page) => {
        await client.screenshot({
          path: testInfo.outputPath(name),
          animations: 'disabled',
        });
        await testInfo.attach(name, {
          path: testInfo.outputPath(name),
          contentType: 'image/png',
        });
      };
      // One pending surface, collapsed to its count until opened.
      const openPending = async (client: Page) => {
        const toggle = client
          .getByRole('region', { name: 'Pending messages' })
          .getByRole('button', { name: /pending message/ });
        if ((await toggle.getAttribute('aria-expanded')) !== 'true')
          await toggle.click();
        return toggle;
      };
      for (const client of [observer, page]) {
        const held = client.getByRole('region', {
          name: 'Pending messages',
        });
        await expect(held).toContainText('1 pending');
        // The list's arrival does not cover the end of the transcript.
        await expect
          .poll(() =>
            client.evaluate(() => {
              const scroller = document.querySelector('.chat-messages');
              const rows = scroller?.querySelectorAll('.message-row');
              const last = rows?.[rows.length - 1];
              if (!scroller || !last) return Number.POSITIVE_INFINITY;
              return (
                last.getBoundingClientRect().bottom -
                scroller.getBoundingClientRect().bottom
              );
            }),
          )
          .toBeLessThanOrEqual(1);
        await openPending(client);
        await expect(held).toContainText(followUp);
        await expect(held).not.toContainText('Refreshing');
      }
      await observer.reload();
      await expect(
        observer.getByRole('region', { name: 'Pending messages' }),
      ).toContainText('1 pending');
      const toggle = await openPending(observer);

      const initialViewport = observer.viewportSize();
      const initialTheme = await observer
        .locator('html')
        .getAttribute('data-theme');
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await observer.setViewportSize(viewport);
        for (const theme of ['light', 'dark']) {
          await observer.evaluate((value) => {
            document.documentElement.setAttribute('data-theme', value);
          }, theme);
          const held = observer.getByRole('region', {
            name: 'Pending messages',
          });
          await expect(held).toContainText(followUp);
          const remove = held.getByRole('button', {
            name: `Remove held message: ${followUp}`,
            exact: true,
          });
          await expect(
            held.getByRole('button', { name: 'Refresh', exact: true }),
          ).toHaveCount(0);
          await toggle.focus();
          await observer.keyboard.press('Tab');
          await expect(remove).toBeFocused();
          expect(
            await remove.evaluate((node) => node.matches(':focus-visible')),
          ).toBe(true);
          for (const button of [toggle, remove]) {
            const box = await button.boundingBox();
            if (!box)
              throw new Error(
                'A held-message action must have a visible target.',
              );
            // Touch layouts keep 44px targets; desktop matches the queue's.
            if (viewport.width <= 768) {
              expect(box.width).toBeGreaterThanOrEqual(44);
              expect(box.height).toBeGreaterThanOrEqual(44);
            }
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
          }
          expect(
            await held.evaluate(
              (node) => node.scrollWidth <= node.clientWidth + 1,
            ),
          ).toBe(true);
          const name = `server-inbox-${viewport.width}-${theme}.png`;
          await observer.screenshot({
            path: testInfo.outputPath(name),
            animations: 'disabled',
          });
          await testInfo.attach(name, {
            path: testInfo.outputPath(name),
            contentType: 'image/png',
          });
        }
      }
      if (initialViewport) await observer.setViewportSize(initialViewport);
      await observer.evaluate((value) => {
        if (value === null)
          document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', value);
      }, initialTheme);

      const retainedKey = `${clientTurnId}-second`;
      const secondQueued = await authenticatedRequest.post(
        '/api/orchestration/chat',
        {
          data: {
            target: {
              environment: { kind: 'current' },
              agent: seededAgentSlug,
              workspace: { kind: 'directory', cwd: binding.data.session.cwd },
            },
            message: followUp,
            conversationId,
            clientTurnId: retainedKey,
            whenBusy: 'queue',
          },
        },
      );
      expect(secondQueued.status(), await secondQueued.text()).toBe(202);
      expect(await secondQueued.json()).toMatchObject({
        data: {
          clientTurnId: retainedKey,
          entry: { state: 'queued', message: followUp },
        },
      });
      for (const client of [page, observer])
        await expect(
          client.getByRole('region', { name: 'Pending messages' }),
        ).toContainText('2 pending');
      await openPending(page);
      const removeButtons = page
        .getByRole('region', { name: 'Pending messages' })
        .getByRole('button', {
          name: `Remove held message: ${followUp}`,
          exact: true,
        });
      await expect(removeButtons).toHaveCount(2);
      // The list ends with the next message to be sent: the first one held.
      await removeButtons.last().click();
      await expect
        .poll(async () => {
          const answer = await authenticatedRequest.get(inboxPath);
          expect(answer.status()).toBe(200);
          return answer.json();
        })
        .toMatchObject({
          data: {
            entries: expect.arrayContaining([
              expect.objectContaining({ clientTurnId, state: 'cancelled' }),
              expect.objectContaining({
                clientTurnId: retainedKey,
                state: 'queued',
              }),
            ]),
          },
        });
      for (const client of [page, observer])
        await expect(
          client.getByRole('region', { name: 'Pending messages' }),
        ).toContainText('1 pending');
      await capture('server-inbox-after-removal.png', page);

      runningStream?.finish();
      runningStream = undefined;
      await expect.poll(() => followUpStream !== undefined).toBe(true);
      await expect
        .poll(() => turnPrompts(authenticatedRequest, conversationId))
        .toEqual([FIRST_MESSAGE, runningMessage, followUp]);
      // Nothing held: the surface is gone, not a zero count.
      for (const client of [page, observer])
        await expect(
          client.getByRole('region', { name: 'Pending messages' }),
        ).toHaveCount(0);
      await capture('server-inbox-empty.png', page);
      const delivered = await authenticatedRequest.get(inboxPath);
      expect(delivered.status()).toBe(200);
      expect(await delivered.json()).toMatchObject({
        data: {
          entries: expect.arrayContaining([
            expect.objectContaining({ clientTurnId, state: 'cancelled' }),
            expect.objectContaining({
              clientTurnId: retainedKey,
              state: 'sent',
            }),
          ]),
        },
      });
      expect(browserSends).toEqual([]);
      expect(await turnPrompts(authenticatedRequest, conversationId)).toEqual([
        FIRST_MESSAGE,
        runningMessage,
        followUp,
      ]);
    } finally {
      runningStream?.finish();
      followUpStream?.finish();
      await observerContext?.close();
    }
  });

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
