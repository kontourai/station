import type { Server } from 'node:http';
import {
  ensureChatDockOpen,
  waitForSeededAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { monitorBrowserHealth } from './helpers/browser-health';
import { requireE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { pairBrowserDevice } from './helpers/live-station-task';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';
import { dismissSetupLauncher } from './helpers/orchestration';

/**
 * The archive#4518 journey: the merge-gating suite never actually sent a real chat
 * message from a paired device. This proves the whole round trip — pair a
 * real device (the same public handshake `device-pairing-mobile.spec.ts`
 * proves: access-request -> operator confirm -> exchange -> a real
 * `station-device` cookie, via `pairBrowserDevice`, never a mocked route),
 * the paired context opens a chat, sends a real message through the REAL
 * `POST /api/orchestration/chat`, and observes a streamed reply from a real
 * local HTTP model server (`tests/helpers/ollama-fixture.ts`).
 *
 * The load-bearing assertion is the one archive#4518 broke: the paired context's
 * principal must resolve.
 *
 * The raw `PrincipalUnresolvedError` text ("Unable to resolve a principal…")
 * never reaches this UI by design — `chatErrorTranslation.ts`
 * deliberately replaced it with a CANNED,
 * human-facing message ("This Station couldn't verify who's asking" /
 * "isn't authorized to chat on this Station yet…") specifically so the raw
 * engineering string can never leak as a headline. Only the canned copy
 * renders, never the
 * raw pattern, so a race against the raw pattern alone silently falls back to
 * a 60s timeout instead of naming the cause. `PRINCIPAL_UNRESOLVED_PATTERN`
 * is kept as a defense-in-depth negative (the raw string leaking would
 * itself be a regression of that translation decision), and
 * `PRINCIPAL_UNRESOLVED_CANNED_COPY_PATTERN` is the one that actually
 * appears and drives the race below.
 */

const FIXTURE_CONNECTION_ID = 'e2e-paired-device-chat-fixture';
const FIXTURE_MODEL = 'station-paired-device-chat:latest';
const FIXTURE_REPLY = 'Paired device chat fixture answered the composer.';
const PRINCIPAL_UNRESOLVED_PATTERN = /Unable to resolve a principal/i;
// `chatErrorTranslation.ts`'s actual rendered copy for PRINCIPAL_UNRESOLVED_CODE
// (archive#4518) — see the file docblock above for why this, not the
// raw pattern above, is what an injected regression actually shows.
const PRINCIPAL_UNRESOLVED_CANNED_COPY_PATTERN =
  /isn't authorized to chat on this Station yet/i;

interface LlmConnection extends Record<string, unknown> {
  id: string;
  enabled?: boolean;
  capabilities?: string[];
}

/** Every enabled connection the create/turn path would treat as "a ready model" — see agents-new-model-turn.spec.ts. */
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

test.describe('Paired-device chat round trip', () => {
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

  test('a paired device sends a real message and receives a real streamed reply, with the principal resolved', async ({
    page,
    browser,
    authenticatedRequest,
    baseURL,
  }) => {
    test.setTimeout(150_000);
    if (!baseURL) throw new Error('Playwright baseURL is required');

    // 1. Provision a real model connection + agent as the ONLY ready model —
    // same "own the model landscape" reasoning as agents-new-model-turn.spec.ts.
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
          name: 'Paired device chat fixture',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: fixture.origin, defaultModel: FIXTURE_MODEL },
          status: 'ready',
          prerequisites: [],
        },
      },
    );
    expect(connectionCreated.ok()).toBe(true);

    const agentSlug = `e2e-paired-device-chat-${Date.now()}`;
    const agentName = `E2E Paired Device Chat ${Date.now()}`;
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

    // 2. Pair a real device against the SAME running suite server — the exact
    // public handshake device-pairing-mobile.spec.ts proves, reused rather
    // than re-driven through the UI so this journey stays about the chat
    // round trip.
    const operatorCredential = requireE2EOperatorCredential(
      process.env.STATION_E2E_HOST_CREDENTIAL,
    );
    const paired = await pairBrowserDevice(
      { api: resolveE2EApiBase(), ui: baseURL },
      operatorCredential,
      'Paired Device Chat E2E',
    );

    // 3. Build the paired context: the host page's own established-user
    // storage state, with the stored operator credential removed and the
    // device-session cookie the pairing exchange returned installed instead
    // — same recipe as project-task-room-collaboration.spec.ts.
    const hostStorage = await page.context().storageState();
    const peerStorage = {
      ...hostStorage,
      cookies: hostStorage.cookies.filter(
        (cookie) =>
          cookie.name !== 'station-device' &&
          cookie.name !== '__Host-station-device',
      ),
      origins: hostStorage.origins.map((origin) => ({
        ...origin,
        localStorage: origin.localStorage
          .filter(
            (entry) => entry.name !== 'station-connect-connections-credentials',
          )
          .map((entry) =>
            entry.name === 'station-connect-connections'
              ? {
                  ...entry,
                  value: JSON.stringify(
                    (
                      JSON.parse(entry.value) as Array<Record<string, unknown>>
                    ).map((profile) => ({
                      ...profile,
                      credentialState: 'device-session',
                    })),
                  ),
                }
              : entry,
          ),
      })),
    };
    const peerContext = await browser.newContext({ storageState: peerStorage });
    await peerContext.addCookies([
      {
        name: 'station-device',
        value: paired.credential,
        url: baseURL,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    const peer = await peerContext.newPage();
    const browserHealth = await monitorBrowserHealth(peer);

    try {
      // 4. The paired device opens the app. A device with a real session
      // never sees the onboarding gate (paired-device-presentation.spec.ts's
      // premise); dismiss it defensively in case that ever changes so this
      // spec fails on the chat journey, not a stray launcher.
      await peer.goto(baseURL);
      await dismissSetupLauncher(peer).catch(() => undefined);
      await expect(peer.getByText(PRINCIPAL_UNRESOLVED_PATTERN)).toHaveCount(0);
      await expect(
        peer.getByText(PRINCIPAL_UNRESOLVED_CANNED_COPY_PATTERN),
      ).toHaveCount(0);

      // 5. Open the New Chat picker deterministically. The compact header
      // "New chat" icon only mounts inside a project/coding layout — a
      // paired device landing on Home sees the big "Start direct chat" card
      // instead, which is a one-click direct path to whatever agent Home
      // suggests, not necessarily the one this journey seeded. Dispatch the
      // same global event `ChatDock.tsx` listens for everywhere (same
      // reasoning as first-run-live.spec.ts) once the shell has mounted, and
      // select the seeded agent by its stable slug.
      await expect(
        peer.getByRole('button', { name: 'Station home' }),
      ).toBeVisible({ timeout: 20_000 });
      await peer.evaluate(() =>
        window.dispatchEvent(new Event('station:open-new-chat')),
      );
      const agentRow = peer.locator(
        `.new-chat-modal__agent[data-agent-slug="${agentSlug}"]`,
      );
      await expect(agentRow).toBeVisible({ timeout: 20_000 });
      await agentRow.click();

      await ensureChatDockOpen(peer);

      // 6. Send a real message through the real endpoint and observe the
      // real fixture's streamed reply.
      const composer = peer.getByPlaceholder('Type a message...');
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await composer.fill('Confirm the paired-device round trip.');
      await peer.getByRole('button', { name: 'Send' }).click();
      // A bare 60s poll on `chatRequests.length`
      // reads a reintroduced archive#4529/#4518 regression as a generic dispatch
      // timeout with no indication of why. Race the dispatch against the
      // principal-refusal copy actually appearing, so such a
      // regression fails fast with the named cause instead of a 60s
      // timeout.
      const principalRefused = peer
        .getByText(PRINCIPAL_UNRESOLVED_CANNED_COPY_PATTERN)
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => {
          throw new Error(
            `"${PRINCIPAL_UNRESOLVED_CANNED_COPY_PATTERN}" copy appeared instead of a dispatched chat request`,
          );
        });
      principalRefused.catch(() => undefined); // avoid an unhandled rejection if dispatch wins the race
      await Promise.race([
        expect
          .poll(() => chatRequests.length, { timeout: 60_000 })
          .toBeGreaterThan(0),
        principalRefused,
      ]);
      await expect(
        peer
          .locator('#chat-dock, #chat-workspace-pane')
          .getByText(FIXTURE_REPLY, { exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      // 7. The load-bearing negative: the principal resolved end to end, no
      // toast/copy anywhere named it unresolved.
      await expect(peer.getByText(PRINCIPAL_UNRESOLVED_PATTERN)).toHaveCount(0);
      await expect(
        peer.getByText(PRINCIPAL_UNRESOLVED_CANNED_COPY_PATTERN),
      ).toHaveCount(0);
      browserHealth.assertHealthy();
    } finally {
      await peerContext.close();
    }
  });
});
