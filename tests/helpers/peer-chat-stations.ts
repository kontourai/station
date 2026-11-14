import { copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  type DevicePairingOffer,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
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
import { closeRunSetup, runSetupControl } from './run-setup';

const CONNECTION_AGENT = 'connection-qualification';
const RECEIVER_PROJECT = 'receiver-work';
const CONNECTION_MODEL = 'station-connection-qualification:latest';

declare global {
  interface Window {
    stationConnectionFaults: {
      loseNextSend(): void;
      disconnectEvents(disconnected: boolean): void;
      disconnectObservation(disconnected: boolean): void;
      holdEventReconnects(): void;
      releaseEventReconnects(): void;
      holdDeliveryLookups(): void;
      releaseDeliveryLookups(): void;
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
    let snapshotsDisconnected =
      sessionStorage.getItem('qualification-windows-offline') === 'true';
    const eventControllers = new Set<AbortController>();
    const snapshotControllers = new Set<AbortController>();
    let eventReconnectsHeld = false;
    const eventWaiters = new Set<() => void>();
    let deliveryLookupsHeld = false;
    const deliveryWaiters = new Set<() => void>();
    window.stationConnectionFaults = {
      loseNextSend: () => {
        loseSend = true;
      },
      holdEventReconnects: () => {
        eventReconnectsHeld = true;
        for (const controller of eventControllers) controller.abort();
      },
      releaseEventReconnects: () => {
        eventReconnectsHeld = false;
        for (const resume of eventWaiters) resume();
        eventWaiters.clear();
      },
      holdDeliveryLookups: () => {
        deliveryLookupsHeld = true;
      },
      releaseDeliveryLookups: () => {
        deliveryLookupsHeld = false;
        for (const resume of deliveryWaiters) resume();
        deliveryWaiters.clear();
      },
      disconnectEvents: (value) => {
        disconnected = value;
        sessionStorage.setItem('qualification-events-offline', String(value));
        if (value)
          for (const controller of eventControllers) controller.abort();
      },
      disconnectObservation: (value) => {
        snapshotsDisconnected = value;
        sessionStorage.setItem('qualification-windows-offline', String(value));
        window.stationConnectionFaults.disconnectEvents(value);
        if (value)
          for (const controller of snapshotControllers) controller.abort();
      },
    };
    window.fetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (deliveryLookupsHeld && url.pathname.includes('/turn-deliveries/'))
        await new Promise<void>((resolve) => deliveryWaiters.add(resolve));
      const eventRequest = url.pathname.endsWith('/api/orchestration/events');
      const snapshotRequest = url.pathname.endsWith('/event-window');
      if (eventRequest && eventReconnectsHeld)
        await new Promise<void>((resolve) => eventWaiters.add(resolve));
      if (eventRequest || snapshotRequest) {
        if (
          (eventRequest && disconnected) ||
          (snapshotRequest && snapshotsDisconnected)
        )
          throw new TypeError(
            'Qualification observation connection is offline',
          );
        const controller = new AbortController();
        (eventRequest ? eventControllers : snapshotControllers).add(controller);
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
  await provisionAgent(live);
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
            (agent) =>
              agent.slug === CONNECTION_AGENT && agent.available !== false,
          )
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function provisionAgent(live: LiveStation) {
  await stationJson(live, '/agents', 'POST', {
    slug: CONNECTION_AGENT,
    name: 'Connection qualification',
    prompt: 'Answer briefly.',
    model: CONNECTION_MODEL,
    execution: {
      modelConnectionId: 'connection-qualification-model',
      modelId: CONNECTION_MODEL,
    },
    tools: { mcpServers: ['station-docs'] },
  });
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
          ALLOWED_ORIGINS: `${source.ui},${receiver.ui}`,
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
        } else {
          // Delegation verifies the same authored profile on both Stations.
          // S deliberately has no model; only R must be able to run it.
          await provisionAgent(live);
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
  const mobileHeader = page.getByTestId('chat-dock-mobile-header');
  const startOwner = (await mobileHeader.isVisible())
    ? mobileHeader
    : page.getByRole('complementary', { name: 'Inbox chats' });
  await startOwner
    .getByRole('button', { name: 'New chat', exact: true })
    .click();
  const form = page
    .getByRole('region', { name: 'New chat', exact: true })
    .getByRole('form', { name: 'Start work' });
  await expect(form).toBeVisible();
  await (
    await runSetupControl(form, (panel) =>
      panel.getByRole('button', { name: /^Agent:/ }),
    )
  ).click();
  await page.locator(`[data-agent-slug="${CONNECTION_AGENT}"]`).click();
  await closeRunSetup(page);
  if (route === 'relay') {
    await form.getByRole('button', { name: /Runs on .*Choose where/ }).click();
    await page
      .getByRole('dialog', { name: 'Where this work runs' })
      .getByRole('button', { name: /Receiver/ })
      .click();
    const modelPicker = page.getByRole('dialog', { name: 'Engine & model' });
    if (!(await modelPicker.isVisible()))
      await (
        await runSetupControl(form, (panel) =>
          panel.getByRole('button', { name: /^Model:/ }),
        )
      ).click();
    await modelPicker
      .getByRole('option', { name: new RegExp(CONNECTION_MODEL) })
      .click();
    await closeRunSetup(page);
    await form.getByRole('button', { name: /^Project:/ }).click();
    await page
      .getByRole('dialog', { name: 'Choose project', exact: true })
      .getByRole('button', { name: /^Receiver work/ })
      .click();
  }
  await closeRunSetup(page);
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

/** Pair an independent receiver Device through the invitation UI, keeping S selected. */
export async function addDirectReceiver(page: Page, receiver: LiveStation) {
  const sourceUrl = page.url();
  const offer = await stationJson<DevicePairingOffer>(
    receiver,
    '/api/pairing/offers',
    'POST',
    {
      endpoint: receiver.api,
      scope: pairingScopePresetString('standard'),
      approval: 'on-request',
    },
  );
  await page.getByTestId('app-toolbar-connection').click();
  await page
    .getByRole('menu', { name: 'Choose Station', exact: true })
    .getByRole('menuitem', { name: 'Manage Stations', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Connect a Station', exact: true })
    .click();
  const setup = page.getByRole('dialog', {
    name: 'Connect a Station',
    exact: true,
  });
  await setup
    .getByRole('button', { name: 'Pairing code', exact: true })
    .click();
  await setup.getByLabel('Station address for a short code').fill(receiver.api);
  await setup
    .getByRole('textbox', { name: 'Pairing code', exact: true })
    .fill(offer.manualCode);
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await setup
    .getByRole('button', { name: 'Request selected access', exact: true })
    .click();
  const requested = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url() ===
        `${receiver.api}/.well-known/station/v1/pairing/request`,
  );
  const exchanged = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.ok() &&
      response.url() ===
        `${receiver.api}/.well-known/station/v1/pairing/exchange`,
  );
  await setup
    .getByRole('button', { name: 'Request access', exact: true })
    .click();
  const request = await requested;
  expect(request.status()).toBe(202);
  const { requestId } = (await request.json()) as { requestId: string };
  await expect(
    setup.getByText('Device access requested. Track it in connection status.', {
      exact: true,
    }),
  ).toBeVisible();
  await setup.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByTestId('app-toolbar-connection').click();
  await page
    .getByRole('menu', { name: 'Choose Station', exact: true })
    .getByRole('menuitem', { name: /^Station details/ })
    .click();
  const details = page.getByRole('dialog', {
    name: 'Station details',
    exact: true,
  });
  await expect(details).toContainText(receiver.api);
  await expect(
    details.getByRole('button', { name: 'Cancel request', exact: true }),
  ).toBeVisible();
  await stationJson(
    receiver,
    `/api/pairing/requests/${encodeURIComponent(requestId)}/confirm`,
    'POST',
  );
  const paired = (await (await exchanged).json()) as {
    credential: string;
    device: { id: string };
  };
  expect(Boolean(paired.credential)).toBe(true);
  await expect(
    details.getByRole('button', { name: 'Cancel request', exact: true }),
  ).toHaveCount(0);
  await details
    .getByRole('button', { name: 'Close Station details', exact: true })
    .click();
  expect(page.url()).toBe(sourceUrl);
  await page.getByTestId('app-toolbar-connection').click();
  await page
    .getByRole('menu', { name: 'Choose Station', exact: true })
    .getByRole('menuitem', { name: 'Manage Stations', exact: true })
    .click();
  const manager = page.getByRole('dialog');
  await manager
    .getByRole('button', {
      name: `More actions for ${receiver.api}`,
      exact: true,
    })
    .click();
  await manager
    .getByRole('menu', { name: `Actions for ${receiver.api}`, exact: true })
    .getByRole('menuitem', { name: 'Edit Station', exact: true })
    .click();
  await manager
    .getByLabel('Station name', { exact: true })
    .fill('Direct Receiver');
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await manager
    .getByRole('button', { name: 'Close Station manager', exact: true })
    .click();
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
        await ensureConnectionInboxOpen(page);
      } else {
        await expect(
          page.getByRole('log', { name: 'Conversation transcript' }),
        ).toBeVisible();
        await expect(
          page.getByRole('status', {
            name: "Reading this chat's record",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(
          page.getByText("Could not read this Station's chat records", {
            exact: true,
          }),
        ).toHaveCount(0);
        const latest = page.getByRole('button', {
          name: 'Scroll to bottom',
          exact: true,
        });
        if (await latest.isVisible()) {
          await latest.click();
          await expect(latest).toHaveCount(0);
        }
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
      await testInfo.attach(`${name}.styles.json`, {
        body: JSON.stringify(
          await page.locator('.message.assistant p').evaluateAll((paragraphs) =>
            paragraphs.map((paragraph) => {
              const ancestors = [];
              for (
                let element: Element | null = paragraph;
                element;
                element = element.parentElement
              ) {
                const style = getComputedStyle(element);
                ancestors.push({
                  element: element.tagName,
                  className: element.className,
                  color: style.color,
                  textFillColor: style.webkitTextFillColor,
                  opacity: style.opacity,
                  filter: style.filter,
                  background: style.backgroundColor,
                });
              }
              return ancestors;
            }),
          ),
          null,
          2,
        ),
        contentType: 'application/json',
      });
      await testInfo.attach(name, {
        path: testInfo.outputPath(name),
        contentType: 'image/png',
      });
      // The product runner removes successful outputs after settlement.
      // Retain the original and Playwright's actual attachment before cleanup.
      const evidence = join(
        tmpdir(),
        'station-p17-evidence',
        basename(dirname(dirname(testInfo.outputDir))),
        basename(testInfo.outputDir),
      );
      mkdirSync(join(evidence, 'attachments'), { recursive: true });
      copyFileSync(testInfo.outputPath(name), join(evidence, name));
      const attachment = testInfo.attachments.find(
        (item) => item.name === name,
      );
      if (!attachment?.path)
        throw new Error(`Playwright did not retain the ${name} attachment`);
      copyFileSync(attachment.path, join(evidence, 'attachments', name));
      const kept = join(tmpdir(), 'station-p17-visual');
      mkdirSync(kept, { recursive: true });
      copyFileSync(testInfo.outputPath(name), join(kept, name));
    }
  if (original) await page.setViewportSize(original);
}

/** The mobile Inbox is a page in the dock, with its own named entry. */
export async function ensureConnectionInboxOpen(page: Page) {
  const mobileHeader = page.getByTestId('chat-dock-mobile-header');
  // Reload resolves before the responsive dock chrome has mounted.
  await expect(
    mobileHeader.or(page.getByRole('button', { name: /^(Show|Hide) inbox/ })),
  ).toBeVisible();
  if (await mobileHeader.isVisible()) {
    const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
    const entry = mobileHeader.getByRole('button', {
      name: 'Inbox',
      exact: true,
    });
    await expect(entry.or(inbox)).toBeVisible();
    if (await entry.isVisible()) await entry.click();
    await expect(inbox).toBeVisible();
    return inbox;
  }
  const entry = page.getByRole('button', { name: /^Show inbox/ });
  if (await entry.isVisible()) await entry.click();
  const inbox = page.getByRole('complementary', { name: 'Inbox chats' });
  await expect(inbox).toBeVisible();
  return inbox;
}
