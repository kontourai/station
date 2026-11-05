import { copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import type { ForegroundMessageInput } from '@kontourai/station-sdk/client';
import { expect, mergeTests, type Page, type TestInfo } from '@playwright/test';
import { pairBrowser } from '../live/helpers/station-instance.mjs';
import { ensureChatDockOpen } from './agents-journey';
import { test as authenticatedTest } from './authenticated-request';
import { readE2EOperatorCredential } from './e2e-operator-credential';
import { test as auditedTest } from './fixture-audit';
import {
  allocateLiveStation,
  type LiveStation,
  pairBrowserDevice,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from './live-station-task';
import {
  closeFixtureServer,
  type OllamaFixtureStream,
  startOllamaFixture,
} from './ollama-fixture';

const CONNECTION_AGENT = 'connection-qualification';
const RECEIVER_PROJECT = 'receiver-work';
const CONNECTION_MODEL = 'station-connection-qualification:latest';

declare global {
  interface Window {
    stationConnectionFaults: {
      loseNextSend(): void;
      disconnectEvents(disconnected: boolean): void;
    };
  }
}

/** Transport faults only: all dispatch, authentication and event bytes are real. */
async function installConnectionFaults(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let loseSend = false;
    let disconnected =
      sessionStorage.getItem('qualification-events-offline') === 'true';
    const eventControllers = new Set<AbortController>();
    window.stationConnectionFaults = {
      loseNextSend: () => {
        loseSend = true;
      },
      disconnectEvents: (value) => {
        disconnected = value;
        sessionStorage.setItem('qualification-events-offline', String(value));
        if (value)
          for (const controller of eventControllers) controller.abort();
      },
    };
    window.fetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.pathname.endsWith('/api/orchestration/events')) {
        if (disconnected)
          throw new TypeError('Qualification event connection is offline');
        const controller = new AbortController();
        eventControllers.add(controller);
        const signal = init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal;
        return original(input, { ...init, signal });
      }
      if (
        loseSend &&
        method === 'POST' &&
        url.pathname.endsWith('/api/orchestration/chat')
      ) {
        loseSend = false;
        const response = await original(input, init);
        if (!response.ok) return response;
        // Consume the actual acceptance before withholding it from the caller.
        await response.arrayBuffer();
        throw new TypeError(
          'Qualification response lost after receiver acceptance',
        );
      }
      return original(input, init);
    };
  });
}

/** Only disposable homes accept these credentials. Never include response bodies in receipts. */
export async function stationJson<T>(
  live: LiveStation,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${live.api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${readE2EOperatorCredential(live.home)}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.ok, `${method} ${path}: HTTP ${response.status}`).toBe(true);
  return (await response.json()) as T;
}

interface PeerChatStations {
  source: LiveStation;
  receiver: LiveStation;
  receiverId: string;
  delegationDeviceId: string;
  sourceDeviceId: string;
  streams: Array<{
    station: 'source' | 'receiver';
    stream: OllamaFixtureStream;
    offeredTools: string[];
  }>;
}

async function provisionModel(live: LiveStation, origin: string) {
  const connections = await stationJson<{
    data: Array<{ id: string; enabled?: boolean; capabilities?: string[] }>;
  }>(live, '/api/connections/models');
  for (const connection of connections.data) {
    if (
      connection.enabled !== false &&
      connection.capabilities?.includes('llm')
    )
      await stationJson(
        live,
        `/api/connections/${encodeURIComponent(connection.id)}`,
        'PUT',
        { ...connection, enabled: false },
      );
  }
  await stationJson(live, '/api/connections', 'POST', {
    id: 'connection-qualification-model',
    kind: 'model',
    type: 'ollama',
    name: 'Qualification model',
    enabled: true,
    capabilities: ['llm'],
    config: { baseUrl: origin, defaultModel: CONNECTION_MODEL },
    status: 'ready',
    prerequisites: [],
  });
  await stationJson(live, '/agents', 'POST', {
    slug: CONNECTION_AGENT,
    name: 'Connection qualification',
    prompt: 'Answer briefly.',
    tools: { mcpServers: ['station-docs'] },
  });
  await expect
    .poll(
      async () => {
        const catalog = await stationJson<{
          data: Array<{ slug: string; available?: boolean }>;
          catalogState?: string;
        }>(live, '/api/agents');
        return (
          catalog.catalogState !== 'reconciling' &&
          catalog.data.some(
            (agent) => agent.slug === CONNECTION_AGENT && agent.available,
          )
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

export const test = mergeTests(authenticatedTest, auditedTest).extend<{
  stations: PeerChatStations;
  hostModel: boolean;
}>({
  hostModel: [false, { option: true }],
  stations: async ({ page, hostModel }, use, testInfo) => {
    await installConnectionFaults(page);
    const source = await allocateLiveStation(
      'station-chat-source-',
      'chat-source',
    );
    const receiver = await allocateLiveStation(
      'station-chat-receiver-',
      'chat-receiver',
    );
    const listeners = [source, receiver].flatMap((live) => [
      ...Array.from({ length: 4 }, (_, offset) => live.serverPort + offset),
      live.uiPort,
    ]);
    expect(new Set(listeners).size, 'Station listeners must not overlap').toBe(
      10,
    );
    expect(listeners).not.toContain(3141);
    expect(listeners).not.toContain(3000);
    const streams: PeerChatStations['streams'] = [];
    const models = [];
    const started: Array<{
      live: LiveStation;
      environment: NodeJS.ProcessEnv;
    }> = [];
    const errors: unknown[] = [];
    // Do not inherit a user's provider keys, runtime home, feature flags or test controls.
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(STATION_|PW_|VITE_)|API_KEY|TOKEN|SECRET|CREDENTIAL/i.test(key),
      ),
    );
    try {
      for (const [station, live] of [
        ['source', source],
        ['receiver', receiver],
      ] as const) {
        const fixtureUserHome = join(
          stationRootForLiveHome(live.home),
          'fixture-user',
        );
        mkdirSync(fixtureUserHome, { recursive: true });
        const stationEnvironment: NodeJS.ProcessEnv = {
          ...environment,
          HOME: fixtureUserHome,
          USERPROFILE: fixtureUserHome,
          APPDATA: join(fixtureUserHome, 'appdata'),
          LOCALAPPDATA: join(fixtureUserHome, 'local-appdata'),
          XDG_CONFIG_HOME: join(fixtureUserHome, 'config'),
          XDG_DATA_HOME: join(fixtureUserHome, 'data'),
          XDG_CACHE_HOME: join(fixtureUserHome, 'cache'),
        };
        started.push({ live, environment: stationEnvironment }); // Partial boots also own cleanup.
        await startStation(live, true, {
          environment: stationEnvironment,
          logFile: testInfo.outputPath(`${station}.log`),
        });
        if (station === 'receiver' || hostModel) {
          const model = await startOllamaFixture(
            CONNECTION_MODEL,
            undefined,
            undefined,
            (stream, body) => {
              const request = body as {
                tools?: Array<{ function?: { name?: string } }>;
              };
              streams.push({
                station,
                stream,
                offeredTools:
                  request.tools?.flatMap((tool) =>
                    tool.function?.name ? [tool.function.name] : [],
                  ) ?? [],
              });
            },
          );
          models.push(model);
          await provisionModel(live, model.origin);
        }
      }
      const folder = join(receiver.home, 'qualification-project');
      mkdirSync(folder, { recursive: true });
      await stationJson(receiver, '/api/projects', 'POST', {
        name: 'Receiver work',
        slug: RECEIVER_PROJECT,
        workingDirectory: folder,
      });
      await stationJson(
        source,
        '/api/feature-previews/paired-station-chats',
        'PUT',
        { enabled: true },
      );
      const scope = pairingScopePresetString('delegation');
      const offer = await stationJson<{ offerId: string; challenge: string }>(
        receiver,
        '/api/pairing/offers',
        'POST',
        { endpoint: receiver.api, scope, kind: 'delegation' },
      );
      const request = await fetch(
        `${receiver.api}/.well-known/station/v1/pairing/request`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: receiver.ui },
          body: JSON.stringify({
            deviceName: 'Source Station',
            offerId: offer.offerId,
            proof: offer.challenge,
          }),
        },
      );
      expect(request.status).toBe(202);
      const { requestId } = (await request.json()) as { requestId: string };
      await stationJson(
        receiver,
        `/api/pairing/requests/${encodeURIComponent(requestId)}/confirm`,
        'POST',
      );
      const exchange = await fetch(
        `${receiver.api}/.well-known/station/v1/pairing/exchange`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: receiver.ui },
          body: JSON.stringify({
            offerId: offer.offerId,
            proof: offer.challenge,
            requestId,
          }),
        },
      );
      expect(exchange.ok).toBe(true);
      const delegation = (await exchange.json()) as {
        environmentId: string;
        credential: string;
        device: { id: string };
      };
      await stationJson(source, '/api/environments/peers', 'POST', {
        environmentId: delegation.environmentId,
        apiBase: receiver.api,
        credential: delegation.credential,
        scope,
        label: 'Receiver',
      });
      // Bootstrap sets up this browser's normal profile, then replace its cookie with a
      // separately approved standard owner Device. The chat never uses an operator bearer.
      await pairBrowser(page, {
        root: process.cwd(),
        instance: source.instance,
        serverPort: source.serverPort,
        uiOrigin: source.ui,
      });
      const paired = await pairBrowserDevice(
        source,
        readE2EOperatorCredential(source.home),
        'Owner browser',
      );
      await page.context().clearCookies();
      await page.context().addCookies([
        {
          name: 'station-device',
          value: paired.credential,
          url: source.ui,
          httpOnly: true,
          sameSite: 'Strict',
        },
      ]);
      await page.goto(source.ui);
      const authority = await page.request.get(
        `${source.ui}/api/auth/authority`,
      );
      expect(authority.ok()).toBe(true);
      expect(await authority.json()).toMatchObject({
        grant: { kind: 'device', deviceId: paired.device.id },
      });
      await use({
        source,
        receiver,
        receiverId: delegation.environmentId,
        delegationDeviceId: delegation.device.id,
        sourceDeviceId: paired.device.id,
        streams,
      });
    } catch (error) {
      errors.push(error);
    } finally {
      const cleanup = await Promise.allSettled([
        ...models.map((model) => closeFixtureServer(model.server)),
        ...started
          .reverse()
          .map(({ live, environment }) => stopStation(live, { environment })),
      ]);
      const failures = cleanup.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      errors.push(...failures.map((result) => result.reason));
    }
    if (errors.length)
      throw new AggregateError(errors, 'Station qualification failed');
  },
});

export async function startConnectionChat(
  page: Page,
  route: 'host' | 'relay',
  text: string,
) {
  await ensureChatDockOpen(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const form = page.getByRole('form', { name: 'Start work' });
  await expect(form).toBeVisible();
  if (route === 'host') {
    await form.getByRole('button', { name: /^Agent:/ }).click();
    await page.locator(`[data-agent-slug="${CONNECTION_AGENT}"]`).click();
  }
  if (route === 'relay') {
    await form.getByRole('button', { name: /Runs on .*Choose where/ }).click();
    await page
      .getByRole('dialog', { name: 'Where this work runs' })
      .getByRole('button', { name: /Receiver/ })
      .click();
    const modelPicker = page.getByRole('dialog', { name: 'Engine & model' });
    if (!(await modelPicker.isVisible()))
      await form.getByRole('button', { name: /^Model:/ }).click();
    await modelPicker
      .getByRole('option', { name: new RegExp(CONNECTION_MODEL) })
      .click();
    await form.getByRole('button', { name: /^Project:/ }).click();
    await page.getByRole('button', { name: /Receiver work/ }).click();
  }
  await form
    .getByRole('textbox', { name: 'What would you like done?' })
    .fill(text);
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/api/orchestration/chat'),
  );
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  const response = await sent;
  expect(response.ok()).toBe(true);
  if (route === 'relay') {
    const dispatched = response
      .request()
      .postDataJSON() as ForegroundMessageInput;
    expect(dispatched.target).toMatchObject({
      environment: { kind: 'current' },
      workspace: { kind: 'project', projectSlug: RECEIVER_PROJECT },
    });
  }
  const body = (await response.json()) as {
    data: { conversationId: string; sessionId: string };
  };
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText(text);
  return body.data;
}

/** Independently pair R, then save its Device credential through the normal editor. */
export async function addDirectReceiver(page: Page, receiver: LiveStation) {
  const paired = await pairBrowserDevice(
    receiver,
    readE2EOperatorCredential(receiver.home),
    'Direct owner browser',
  );
  await page.getByTestId('app-toolbar-connection').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add a Station address' }).click();
  await dialog.getByLabel('Name (optional)').fill('Direct Receiver');
  await dialog.getByLabel('Station address').fill(receiver.api);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Request Access', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'More actions for Direct Receiver' })
    .click();
  await dialog
    .getByRole('menu', { name: 'Actions for Direct Receiver' })
    .getByRole('menuitem', { name: 'Edit Station' })
    .click();
  await dialog.getByLabel('Station access credential').fill(paired.credential);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close Station manager' }).click();
  return paired;
}

export async function captureConnectionState(
  page: Page,
  testInfo: TestInfo,
  state: string,
  surface: 'conversation' | 'history' | 'inbox' = 'conversation',
) {
  const original = page.viewportSize();
  for (const width of [390, 1440])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        document.documentElement.classList.toggle('dark', value === 'dark');
      }, theme);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      if (state === 'relay-preview-off') {
        await expect(
          page.getByRole('button', {
            name: 'Open Feature previews',
            exact: true,
          }),
        ).toBeVisible();
      } else if (surface === 'history') {
        await expect(
          page.getByRole('list', {
            name: /^(Task room history|Shared history records)$/,
          }),
        ).toBeVisible();
      } else if (surface === 'inbox') {
        await expect(
          page.locator(
            '[aria-label="Inbox chats"]:visible, [role="region"][aria-label="Inbox"]:visible',
          ),
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole('log', { name: 'Conversation transcript' }),
        ).toBeVisible();
      }
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      const name = `${state}-${width}-${theme}.png`;
      await page.screenshot({
        path: testInfo.outputPath(name),
        animations: 'disabled',
      });
      await testInfo.attach(name, {
        path: testInfo.outputPath(name),
        contentType: 'image/png',
      });
      const kept = join(tmpdir(), 'station-p17-visual');
      mkdirSync(kept, { recursive: true });
      copyFileSync(testInfo.outputPath(name), join(kept, name));
    }
  if (original) await page.setViewportSize(original);
}
