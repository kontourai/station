import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { E2E_STATION_COMPATIBILITY } from './helpers/current-station-contract';
import { e2eOperatorAuthorizationHeaders } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const RECOVERED_URL = 'https://recovered.example.test';

const STATUS_READY = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [],
    detected: { ollama: false, bedrock: false },
  },
});

async function seedConnection(page: Page, recovered: boolean | string = false) {
  const credential = process.env.STATION_E2E_HOST_CREDENTIAL;
  if (!credential) {
    throw new Error('Reconnect coverage requires the runner host credential');
  }
  await page.addInitScript(
    ({ hostCredential, recoveredUrl }) => {
      const now = Date.now();
      window.localStorage.setItem(
        'station-connect-connections',
        JSON.stringify([
          {
            profileVersion: 4,
            id: 'c1',
            name: 'Dev Server',
            url: window.location.origin,
            credentialRef: {
              credentialVersion: 1,
              kind: 'connection',
              id: 'c1',
            },
            credentialState: 'saved',
            lastConnected: now,
            lastSuccessAt: now,
          },
          ...(recoveredUrl
            ? [
                {
                  profileVersion: 4,
                  id: 'c2',
                  name: 'Recovered Station',
                  url: recoveredUrl,
                  credentialRef: {
                    credentialVersion: 1,
                    kind: 'connection',
                    id: 'c2',
                  },
                  credentialState: 'saved',
                  lastConnected: now,
                  lastSuccessAt: now,
                },
              ]
            : []),
        ]),
      );
      window.localStorage.setItem('station-connect-connections-active', 'c1');
      window.localStorage.setItem(
        'station-connect-connections-credentials',
        JSON.stringify({
          'connection:c1': hostCredential,
          ...(recoveredUrl ? { 'connection:c2': hostCredential } : {}),
        }),
      );
      window.localStorage.setItem('station:onboarding-setup-dismissed', '1');
    },
    {
      hostCredential: credential,
      recoveredUrl:
        typeof recovered === 'string'
          ? recovered
          : recovered
            ? RECOVERED_URL
            : undefined,
    },
  );
}

async function installTransport(
  page: Page,
  state: {
    healthy: boolean;
    bootId: string;
    inFlight: number;
    maxInFlight: number;
  },
) {
  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        environmentId: ENVIRONMENT_ID,
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: E2E_STATION_COMPATIBILITY,
      }),
    }),
  );
  // `OnboardingGate` gates first paint on its own `/api/system/status` query
  // (react-query, `retry: 2` with up to a ~2s+4s exponential backoff) —
  // separate from the compatibility-aware reachability probe this suite
  // drives through `/api/system/identity` below. Leaving it unmocked meant
  // this test depended on the REAL live Station instance answering
  // `/api/system/status` fast and without a transient failure. Isolated,
  // against an idle server, it always did; run in parallel with the rest of
  // the e2e suite hammering the same one live instance, an occasional slow
  // or dropped first response pushed the retry backoff past this test's
  // fixed assertion timeouts — the actual "passes isolated, fails in
  // parallel" cause (archive#985), not a leaked-state race. The status this gate
  // needs is always "ready" for every scenario this file drives (the
  // backend really is up throughout; only the compatibility probe below
  // simulates unreachability), so mock it the same way every other e2e spec
  // in this suite already does instead of depending on real server timing.
  await page.route('**/api/system/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: STATUS_READY,
    }),
  );
  await page.route('**/api/system/identity', async (route) => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 40));
    state.inFlight -= 1;
    if (!state.healthy) {
      await route.abort('connectionrefused');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ bootId: state.bootId }),
    });
  });
}

async function openStationDetails(page: Page) {
  await page.getByTestId('app-toolbar-connection').click();
  await page.getByRole('menuitem', { name: /^Station details/ }).click();
  const details = page.getByRole('dialog', {
    name: 'Station details',
    exact: true,
  });
  await expect(details).toBeVisible();
  return details;
}

test.describe('compatibility-aware reconnect', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('deduplicates probes and recovers without reloading', async ({
    page,
  }) => {
    await seedConnection(page);
    const state = {
      healthy: true,
      bootId: 'boot-1',
      inFlight: 0,
      maxInFlight: 0,
    };
    await installTransport(page, state);
    await page.goto('/');
    await expect(page.getByRole('form', { name: 'Start work' })).toBeVisible();

    await page.evaluate(() => {
      (
        window as typeof window & { __reconnectSentinel?: true }
      ).__reconnectSentinel = true;
    });

    state.healthy = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const connection = page.getByTestId('app-toolbar-connection');
    await expect(connection).toHaveAttribute('aria-label', /Can't connect/);
    expect(state.maxInFlight).toBe(1);

    state.healthy = true;
    state.bootId = 'boot-2';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect(
      page.getByRole('button', { name: /^Choose Station — Connected/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const profiles = JSON.parse(
            localStorage.getItem('station-connect-connections') ?? '[]',
          ) as Array<{ lastBootId?: string }>;
          return profiles[0]?.lastBootId;
        }),
      )
      .toBe('boot-2');
    // Recovered in place: the same document, not a reload.
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __reconnectSentinel?: true })
            .__reconnectSentinel,
      ),
    ).toBe(true);
  });

  test('keeps toolbar recheck and Station details reachable on a phone viewport', async ({
    page,
  }) => {
    await seedConnection(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const state = {
      healthy: true,
      bootId: 'boot-mobile',
      inFlight: 0,
      maxInFlight: 0,
    };
    await installTransport(page, state);
    await page.goto('/');
    await expect(page.getByRole('form', { name: 'Start work' })).toBeVisible();
    state.healthy = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const connection = page.getByTestId('app-toolbar-connection');
    await expect(connection).toHaveAttribute('aria-label', /Can't connect/);
    const actionBox = await connection.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.x).toBeGreaterThanOrEqual(0);
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(390);
    expect(actionBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(844);
    const details = await openStationDetails(page);
    await expect(details).toContainText('No additional Station notices.');
    await details
      .getByRole('button', { name: 'Close Station details' })
      .click();
    state.healthy = true;
    await connection.click();
    await expect(connection).toHaveAttribute(
      'aria-label',
      /Choose Station — Connected/,
    );
  });

  test('selects another saved healthy Station after connection failure on mobile', async ({
    page,
    baseURL,
  }) => {
    await seedConnection(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    let recoveredStatusRequests = 0;
    let primaryHealthy = true;

    if (!baseURL || !process.env.STATION_E2E_HOST_CREDENTIAL) {
      throw new Error(
        'Station switching requires the runner backend and credential',
      );
    }
    const backend = baseURL;
    const credential = process.env.STATION_E2E_HOST_CREDENTIAL;
    // The recovered address aliases the real runner backend. Only the health
    // probes below are modeled; inventory reads retain their real contracts.
    await page.route(`${RECOVERED_URL}/**`, async (route) => {
      const requested = new URL(route.request().url());
      if (route.request().headers().accept?.includes('text/event-stream')) {
        await route.abort('connectionrefused');
        return;
      }
      // Provider catalogs and release discovery can wait on external hosts;
      // this connection-selection fixture explicitly leaves them unavailable.
      if (
        [
          '/api/models',
          '/api/agents',
          '/api/models/capabilities',
          '/api/system/core-update',
        ].includes(requested.pathname)
      ) {
        await route.fulfill({
          status: 503,
          json: {
            success: false,
            error: 'Catalog and release discovery unavailable in this fixture',
          },
        });
        return;
      }
      const response = await route.fetch({
        url: new URL(requested.pathname + requested.search, backend).href,
        headers: {
          ...route.request().headers(),
          authorization: `Bearer ${credential}`,
        },
      });
      await route.fulfill({ response });
    });
    await page.route('**/.well-known/station/v1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          environmentId: ENVIRONMENT_ID,
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: E2E_STATION_COMPATIBILITY,
        }),
      }),
    );
    await page.route('**/api/system/status', async (route) => {
      if (new URL(route.request().url()).origin === RECOVERED_URL) {
        recoveredStatusRequests += 1;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      });
    });
    // Readiness keeps the shell usable; compatibility identity is the
    // connection-health probe that owns the toolbar indicator.
    await page.route('**/api/system/identity', async (route) => {
      if (
        new URL(route.request().url()).origin !== RECOVERED_URL &&
        !primaryHealthy
      ) {
        await route.abort('connectionrefused');
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ bootId: 'recovered-boot' }),
      });
    });

    await page.goto('/');
    await expect(page.getByRole('form', { name: 'Start work' })).toBeVisible();
    primaryHealthy = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByTestId('app-toolbar-connection')).toHaveAttribute(
      'aria-label',
      /Can't connect/,
    );
    const details = await openStationDetails(page);
    await details
      .getByRole('button', { name: 'Manage Stations', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'View details for Recovered Station' })
      .click();
    await page
      .getByRole('button', { name: 'Switch to Recovered Station', exact: true })
      .click();
    await expect.poll(() => recoveredStatusRequests).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Close Station manager' }).click();

    await expect(page.getByRole('button', { name: 'Toggle menu' })).toBeVisible(
      {
        timeout: 10_000,
      },
    );
    await expect(page.getByTestId('app-toolbar-connection')).toContainText(
      'Recovered Station',
    );
    await expect(page.getByTestId('app-toolbar-connection')).toHaveAttribute(
      'aria-label',
      /Choose Station — Connected/,
    );
    await expect(page.getByRole('form', { name: 'Start work' })).toBeVisible();
    expect(recoveredStatusRequests).toBeGreaterThanOrEqual(2);
  });
  test.describe('390px Connections', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });

    for (const identityMismatch of [false, true]) {
      test.describe(
        identityMismatch ? 'with a Station notice' : 'without a Station notice',
        () => {
          test.beforeEach(async ({ page, baseURL }) => {
            if (!baseURL)
              throw new Error(
                'The Connections matrix requires an isolated Station URL',
              );
            const secondStation = new URL(baseURL);
            secondStation.hostname =
              secondStation.hostname === 'localhost'
                ? '127.0.0.1'
                : 'localhost';
            await seedConnection(page, secondStation.origin);
            await installTransport(page, {
              healthy: true,
              bootId: 'connections-mobile-boot',
              inFlight: 0,
              maxInFlight: 0,
            });
            await page.route(
              new URL('/.well-known/station/v1', secondStation).href,
              (route) =>
                route.fulfill({
                  json: {
                    schemaVersion: 1,
                    environmentId: '22222222-2222-4222-8222-222222222222',
                    authentication: { scheme: 'bearer', protocolVersion: 1 },
                    transports: { http: 1, sse: 1, websocket: 1 },
                    compatibility: E2E_STATION_COMPATIBILITY,
                  },
                }),
            );
            if (identityMismatch) {
              await page.route(`${baseURL}/.well-known/station/v1`, (route) =>
                route.fulfill({
                  json: {
                    schemaVersion: 1,
                    authentication: { scheme: 'bearer', protocolVersion: 1 },
                    transports: { http: 1, sse: 1, websocket: 1 },
                    compatibility: E2E_STATION_COMPATIBILITY,
                  },
                }),
              );
            }
          });

          test('Connections navigation, setup and writable details', async ({
            page,
            baseURL,
          }) => {
            if (!baseURL)
              throw new Error(
                'The Connections matrix requires the isolated Station URL',
              );
            const headers = e2eOperatorAuthorizationHeaders(
              process.env.STATION_E2E_HOST_CREDENTIAL,
            );
            const suffix = identityMismatch ? 'notice' : 'healthy';
            const toolId = `phone-tool-${suffix}`;
            await page.goto('/connections/computers');
            const toolbar = page.getByTestId('app-toolbar-connection');
            await expect(toolbar).toHaveAttribute(
              'aria-label',
              identityMismatch
                ? /Needs re-pairing/
                : /Choose Station — Connected/,
            );
            await toolbar.tap();
            await page
              .getByRole('menuitem', { name: /^Station details/ })
              .tap();
            const details = page.getByRole('dialog', {
              name: 'Station details',
            });
            if (identityMismatch) {
              await expect(
                details.getByText(/isn't the one this device paired with/),
              ).toBeVisible();
            } else {
              await expect(
                details.getByText('No additional Station notices.'),
              ).toBeVisible();
            }
            await details
              .getByRole('button', { name: 'Close Station details' })
              .tap();
            await expect(details).toBeHidden();

            const sections = [
              {
                title: 'Models',
                path: '/connections/models',
                add: 'Add model connection',
                target: '/connections/models/new',
              },
              {
                title: 'Engines',
                path: '/connections/engines',
                add: 'Add engine',
                target: '/connections/engines/new',
              },
              {
                title: 'Tools',
                path: '/connections/tools',
                add: 'Add tool server',
                target: '/connections/tools/new',
              },
              {
                title: 'Knowledge',
                path: '/connections/knowledge',
                add: 'Add knowledge source',
                target: '/settings?view=knowledge',
              },
              {
                title: 'Computers',
                path: '/connections/computers',
                add: 'Add computer',
              },
            ];
            for (const section of sections) {
              await test.step(section.title, async () => {
                const tabs = page.getByRole('tablist', {
                  name: 'Connection sections',
                });
                await tabs
                  .getByRole('tab', {
                    name: new RegExp(`^${section.title}\\b`),
                  })
                  .tap();
                await expect(page).toHaveURL(
                  (url) => url.pathname === section.path,
                );
                await expect(
                  page.getByRole('heading', {
                    name: section.title,
                    level: 1,
                    exact: true,
                  }),
                ).toBeVisible();
                if (identityMismatch) {
                  await expect(
                    toolbar.getByRole('img', { name: /Station notices/ }),
                  ).toBeVisible();
                }
                await page
                  .getByRole('button', { name: section.add, exact: true })
                  .tap();
                if (section.target) {
                  await expect(page).toHaveURL(
                    (url) => url.pathname + url.search === section.target,
                  );
                  await page.goBack();
                  await expect(page).toHaveURL(
                    (url) => url.pathname === section.path,
                  );
                } else {
                  const chooser = page.getByRole('dialog', {
                    name: 'What do you want to do?',
                  });
                  await expect(chooser).toBeVisible();
                  await chooser
                    .getByRole('button', { name: 'Close add a computer' })
                    .tap();
                  await expect(chooser).toBeHidden();
                }
              });
            }

            await test.step('Saved model and tool details', async () => {
              const tabs = page.getByRole('tablist', {
                name: 'Connection sections',
              });
              await tabs.getByRole('tab', { name: /^Models/ }).tap();
              await page
                .getByRole('button', {
                  name: 'Add model connection',
                  exact: true,
                })
                .tap();
              await page
                .getByRole('button', { name: /^OpenAI-Compatible/ })
                .tap();
              await page
                .getByRole('textbox', { name: 'Name', exact: true })
                .fill(`Phone model ${suffix}`);
              await page
                .getByRole('textbox', { name: 'Server URL', exact: true })
                .fill(new URL(`/__e2e_phone/model-${suffix}/v1`, baseURL).href);
              await page
                .getByRole('textbox', { name: 'Default model', exact: true })
                .fill('fixture-model');
              const createModel = page.waitForResponse(
                (response) =>
                  response.request().method() === 'POST' &&
                  new URL(response.url()).pathname === '/api/connections',
              );
              await page
                .getByRole('button', { name: 'Create', exact: true })
                .tap();
              const created = await createModel;
              expect(created.ok()).toBe(true);
              const {
                data: { id: modelId },
              } = (await created.json()) as { data: { id: string } };
              await expect(page).toHaveURL(
                (url) => url.pathname === `/connections/models/${modelId}`,
              );

              await page.route(
                `**/api/connections/${modelId}/test`,
                async (route) => {
                  expect(route.request().method()).toBe('POST');
                  await route.fulfill({
                    json: {
                      success: true,
                      data: {
                        healthy: false,
                        reason: 'The fixture provider rejected the API key.',
                      },
                    },
                  });
                },
              );
              await expect(
                page.getByRole('button', { name: 'Load models', exact: true }),
              ).toHaveCount(0);
              const hideAll = page.getByRole('button', {
                name: 'Hide all (1)',
                exact: true,
              });
              const showAll = page.getByRole('button', {
                name: 'Show all (1)',
                exact: true,
              });
              await expect(showAll).toBeDisabled();
              await expect(
                page.getByRole('button', {
                  name: 'Move fixture-model up',
                  exact: true,
                }),
              ).toBeDisabled();
              await expect(
                page.getByRole('button', {
                  name: 'Move fixture-model down',
                  exact: true,
                }),
              ).toBeDisabled();
              await hideAll.tap();
              await expect(
                page.getByText('0 of 1 visible', { exact: true }),
              ).toBeVisible();
              await expect(hideAll).toBeDisabled();
              await showAll.tap();
              await expect(
                page.getByText('1 of 1 visible', { exact: true }),
              ).toBeVisible();
              await page
                .getByRole('button', {
                  name: 'Add fixture-model to favorites',
                  exact: true,
                })
                .tap();
              await page
                .getByRole('button', {
                  name: 'Remove fixture-model from favorites',
                  exact: true,
                })
                .tap();
              await page
                .getByRole('button', {
                  name: 'Hide fixture-model',
                  exact: true,
                })
                .tap();
              await expect(
                page.getByText('0 of 1 visible', { exact: true }),
              ).toBeVisible();
              await page
                .getByRole('button', {
                  name: 'Show fixture-model',
                  exact: true,
                })
                .tap();
              await expect(
                page.getByText('1 of 1 visible', { exact: true }),
              ).toBeVisible();
              const defaultModel = page.getByRole('combobox', {
                name: 'Default model',
                exact: true,
              });
              await defaultModel.selectOption('');
              await expect(defaultModel).toHaveValue('');
              await defaultModel.selectOption('fixture-model');
              const enabled = page.getByRole('checkbox', {
                name: 'Enabled',
                exact: true,
              });
              await enabled.uncheck();
              await expect(enabled).not.toBeChecked();
              await enabled.check();
              const modelAdvanced = page.getByText('Advanced', { exact: true });
              await modelAdvanced.tap();
              await expect(
                page.getByRole('combobox', {
                  name: 'Connection type',
                  exact: true,
                }),
              ).toBeVisible();
              await modelAdvanced.tap();
              const modelPath = `/api/connections/${modelId}`;
              const updatedModel = page.getByRole('button', {
                name: new RegExp(`^Renamed model ${suffix}`),
              });
              await page
                .getByRole('button', { name: 'Test connection', exact: true })
                .tap();
              await expect(
                page.getByText('The fixture provider rejected the API key.'),
              ).toBeVisible();
              await page
                .getByRole('button', { name: 'Delete', exact: true })
                .tap();
              const deleteModel = page.getByRole('alertdialog');
              await expect(deleteModel).toContainText(`Phone model ${suffix}`);
              await deleteModel.getByRole('button', { name: 'Cancel' }).tap();
              await page
                .getByRole('textbox', { name: 'Name', exact: true })
                .fill(`Renamed model ${suffix}`);
              const modelSaved = page.waitForResponse(
                (response) =>
                  response.request().method() === 'PUT' &&
                  new URL(response.url()).pathname === modelPath,
              );
              await page
                .getByRole('button', { name: 'Save', exact: true })
                .tap();
              expect((await modelSaved).ok()).toBe(true);
              const savedModel = await page.request.get(modelPath, { headers });
              expect(await savedModel.json()).toMatchObject({
                data: { name: `Renamed model ${suffix}` },
              });
              await page.getByRole('button', { name: '← Back to list' }).tap();
              const modelSearch = page.getByPlaceholder(
                'Search model connections…',
              );
              await modelSearch.fill('nothing-matches-this-model');
              await expect(updatedModel).toHaveCount(0);
              await modelSearch.clear();
              await updatedModel.tap();
              await page
                .getByRole('button', { name: 'Delete', exact: true })
                .tap();
              const modelDeleted = page.waitForResponse(
                (response) =>
                  response.request().method() === 'DELETE' &&
                  new URL(response.url()).pathname === modelPath,
              );
              await deleteModel
                .getByRole('button', { name: 'Delete', exact: true })
                .tap();
              expect((await modelDeleted).ok()).toBe(true);
              expect(
                (await page.request.get(modelPath, { headers })).status(),
              ).toBe(404);
              await expect(page).toHaveURL(/\/connections\/models$/);
              await expect(updatedModel).toHaveCount(0);

              await tabs.getByRole('tab', { name: /^Tools/ }).tap();
              await expect(
                page.getByRole('button', { name: /^Station Docs\b/ }),
              ).toBeVisible();
              const bindings = page.getByRole('region', {
                name: 'Advanced: Secret bindings',
              });
              const bindingsDisclosure = bindings.getByText(
                'Advanced: Secret bindings',
                { exact: true },
              );
              await bindingsDisclosure.tap();
              await expect(
                bindings.getByRole('textbox', {
                  name: 'Reference',
                  exact: true,
                }),
              ).toBeVisible();
              await expect(
                bindings.getByRole('button', {
                  name: 'Create binding',
                  exact: true,
                }),
              ).toBeDisabled();
              await bindingsDisclosure.tap();
              await expect(
                bindings.getByRole('textbox', {
                  name: 'Reference',
                  exact: true,
                }),
              ).toBeHidden();
              await page
                .getByRole('button', { name: 'Add tool server', exact: true })
                .tap();
              await page
                .getByRole('textbox', { name: 'ID', exact: true })
                .fill(toolId);
              await page
                .getByRole('textbox', { name: 'Display Name', exact: true })
                .fill(`Phone tool server ${suffix}`);
              await page
                .getByRole('combobox', { name: 'Connection type', exact: true })
                .selectOption('streamable-http');
              await page
                .getByRole('textbox', { name: 'Endpoint URL', exact: true })
                .fill(new URL(`/__e2e_phone/${toolId}/mcp`, baseURL).href);
              const createTool = page.waitForResponse(
                (response) =>
                  response.request().method() === 'POST' &&
                  new URL(response.url()).pathname === '/integrations',
              );
              await page
                .getByRole('button', { name: 'Create', exact: true })
                .tap();
              expect((await createTool).ok()).toBe(true);
              const toolPath = `/integrations/${toolId}`;
              const updatedTool = page.getByRole('button', {
                name: new RegExp(`^Renamed tool server ${suffix}`),
              });
              await expect(page).toHaveURL(
                (url) => url.pathname === `/connections/tools/${toolId}`,
              );
              await page
                .getByRole('button', { name: 'Delete', exact: true })
                .tap();
              const deleteTool = page.getByRole('alertdialog', {
                name: 'Delete tool server',
              });
              await deleteTool.getByRole('button', { name: 'Cancel' }).tap();
              await page
                .getByRole('textbox', { name: 'Display Name', exact: true })
                .fill(`Renamed tool server ${suffix}`);
              const toolSaved = page.waitForResponse(
                (response) =>
                  response.request().method() === 'PUT' &&
                  new URL(response.url()).pathname === toolPath,
              );
              await page
                .getByRole('button', { name: 'Save', exact: true })
                .tap();
              expect((await toolSaved).ok()).toBe(true);
              const savedTool = await page.request.get(toolPath, { headers });
              expect(await savedTool.json()).toMatchObject({
                data: { displayName: `Renamed tool server ${suffix}` },
              });
              await page.getByRole('button', { name: '← Back to list' }).tap();
              const toolSearch = page.getByPlaceholder('Search tool servers…');
              await toolSearch.fill('nothing-matches-this-tool');
              await expect(updatedTool).toHaveCount(0);
              await toolSearch.clear();
              await updatedTool.tap();
              for (const enabled of [true, false]) {
                const lifecycle = page.waitForResponse(
                  (response) =>
                    response.request().method() === 'POST' &&
                    new URL(response.url()).pathname === `${toolPath}/enabled`,
                );
                await page
                  .getByRole('button', {
                    name: enabled ? 'Enable' : 'Disable',
                    exact: true,
                  })
                  .tap();
                expect((await lifecycle).ok()).toBe(true);
                const state = await page.request.get(toolPath, { headers });
                expect(await state.json()).toMatchObject({ data: { enabled } });
                await expect(
                  page.getByRole('button', {
                    name: enabled ? 'Disable' : 'Enable',
                    exact: true,
                  }),
                ).toBeVisible();
              }

              const account = page.getByRole('region', {
                name: 'Your connected account',
              });
              const authorize = page.waitForResponse(
                (response) =>
                  response.request().method() === 'POST' &&
                  new URL(response.url()).pathname ===
                    `${toolPath}/oauth/authorize`,
              );
              await account
                .getByRole('button', {
                  name: /^(Sign in|Connect your account)$/,
                })
                .tap();
              expect((await authorize).status()).toBe(400);
              await expect(
                account.getByText('Account action failed', { exact: true }),
              ).toBeVisible();
              await expect(
                account.getByRole('button', {
                  name: 'Open sign-in page',
                  exact: true,
                }),
              ).toHaveCount(0);
              const toolChecked = page.waitForResponse(
                (response) =>
                  response.request().method() === 'POST' &&
                  new URL(response.url()).pathname === `${toolPath}/reconnect`,
              );
              await page
                .getByRole('button', { name: 'Reconnect', exact: true })
                .tap();
              expect((await toolChecked).ok()).toBe(true);
              await expect(
                page.getByText('Connection check completed.', { exact: true }),
              ).toBeVisible();
              await page
                .getByRole('button', { name: 'Raw JSON', exact: true })
                .tap();
              await expect(
                page.getByRole('heading', {
                  name: 'Raw configuration',
                  exact: true,
                }),
              ).toBeVisible();
              await page
                .getByRole('button', { name: 'Form', exact: true })
                .tap();
              await expect(
                page.getByRole('textbox', {
                  name: 'Display Name',
                  exact: true,
                }),
              ).toHaveValue(`Renamed tool server ${suffix}`);
              await page
                .getByRole('button', { name: 'Delete', exact: true })
                .tap();
              const toolDeleted = page.waitForResponse(
                (response) =>
                  response.request().method() === 'DELETE' &&
                  new URL(response.url()).pathname === toolPath,
              );
              await deleteTool
                .getByRole('button', { name: 'Delete', exact: true })
                .tap();
              expect((await toolDeleted).ok()).toBe(true);
              expect(
                (await page.request.get(toolPath, { headers })).status(),
              ).toBe(404);
              await expect(page).toHaveURL(/\/connections\/tools$/);
              await expect(updatedTool).toHaveCount(0);
              await tabs.getByRole('tab', { name: /^Computers/ }).tap();
            });

            await test.step('Engine setup and Knowledge navigation', async () => {
              const tabs = page.getByRole('tablist', {
                name: 'Connection sections',
              });
              await tabs.getByRole('tab', { name: /^Engines/ }).tap();
              await page
                .getByRole('button', { name: 'Add engine', exact: true })
                .tap();
              const custom = page.getByRole('button', {
                name: 'Set up custom engine',
              });
              await custom.tap();
              const engineSetup = page.getByRole('region', {
                name: 'Engine setup',
              });
              await expect(
                engineSetup.getByRole('heading', { name: 'Custom engine' }),
              ).toBeVisible();
              await expect(
                engineSetup.getByRole('button', { name: 'Check engine' }),
              ).toBeDisabled();
              await engineSetup
                .getByRole('button', { name: 'Back', exact: true })
                .tap();
              await expect(custom).toBeVisible();
              await page.route('**/acp/connections', (route) =>
                route.request().method() === 'POST'
                  ? route.fulfill({
                      json: {
                        success: false,
                        error: 'The fixture engine command is unavailable.',
                      },
                    })
                  : route.fallback(),
              );
              await custom.tap();
              await engineSetup
                .getByLabel('Name', { exact: true })
                .fill('Phone fixture engine');
              await engineSetup
                .getByRole('textbox', { name: 'Command', exact: true })
                .fill('station-e2e-unavailable');
              await engineSetup
                .getByRole('button', { name: 'Check engine', exact: true })
                .tap();
              await expect(engineSetup.getByRole('alert')).toContainText(
                'Unavailable',
              );
              const retry = page.waitForRequest(
                (request) =>
                  request.method() === 'POST' &&
                  new URL(request.url()).pathname === '/acp/connections',
              );
              await engineSetup
                .getByRole('button', { name: 'Retry', exact: true })
                .tap();
              await retry;
              await expect(engineSetup.getByRole('alert')).toContainText(
                'Unavailable',
              );
              await engineSetup
                .getByRole('button', { name: 'Edit setup', exact: true })
                .tap();
              await expect(
                engineSetup.getByRole('textbox', {
                  name: 'Command',
                  exact: true,
                }),
              ).toHaveValue('station-e2e-unavailable');
              await engineSetup
                .getByRole('button', { name: 'Back', exact: true })
                .tap();
              await expect(custom).toBeVisible();

              await page.goBack();
              await expect(page).toHaveURL(/\/connections\/engines$/);

              await tabs.getByRole('tab', { name: /^Knowledge/ }).tap();
              const sections = page.getByRole('navigation', {
                name: 'Knowledge sections',
              });
              for (const [label, section] of [
                ['Embedding model', 'embedding-model'],
                ['Vector database', 'vector-database'],
                ['Usage', 'usage'],
              ]) {
                await sections.getByRole('link', { name: label }).tap();
                await expect(page).toHaveURL(
                  (url) => url.searchParams.get('section') === section,
                );
                await expect(
                  page.getByRole('heading', { name: label, exact: true }),
                ).toBeVisible();
              }

              await page
                .getByRole('button', {
                  name: 'Open Settings → My knowledge store',
                })
                .tap();
              await expect(page).toHaveURL(
                (url) =>
                  url.pathname === '/settings' &&
                  url.searchParams.get('view') === 'knowledge',
              );
              await page.goBack();
              await expect(page).toHaveURL(
                (url) => url.pathname === '/connections/knowledge',
              );
              await tabs.getByRole('tab', { name: /^Computers/ }).tap();
            });

            await test.step('Computer chooser branches', async () => {
              const add = page.getByRole('button', {
                name: 'Add computer',
                exact: true,
              });
              const chooser = page.getByRole('dialog', {
                name: 'What do you want to do?',
              });
              await add.tap();
              await chooser
                .getByRole('button', { name: /^Connect a Station/ })
                .tap();
              const setup = page.getByRole('dialog', {
                name: 'Connect a Station',
                exact: true,
              });
              await expect(chooser).toBeHidden();
              await expect(
                setup.getByRole('button', { name: 'Continue' }),
              ).toBeDisabled();
              await setup
                .getByRole('button', { name: 'Pairing code', exact: true })
                .tap();
              await expect(
                setup.getByRole('textbox', {
                  name: 'Pairing code',
                  exact: true,
                }),
              ).toBeVisible();
              await setup
                .getByRole('button', { name: 'Scan QR', exact: true })
                .tap();
              // Headless Chromium has no camera, so the scan falls back to
              // code entry and withdraws Scan QR instead of a camera error.
              await expect(
                setup.getByRole('button', { name: 'Scan QR', exact: true }),
              ).toHaveCount(0);
              await expect(
                setup.getByRole('button', {
                  name: 'Pairing code',
                  exact: true,
                }),
              ).toHaveAttribute('aria-pressed', 'true');
              await expect(setup.getByText(/Camera error/)).toHaveCount(0);
              await setup
                .getByRole('button', { name: 'Station address', exact: true })
                .tap();
              await expect(
                setup.getByRole('textbox', {
                  name: 'Station address',
                  exact: true,
                }),
              ).toBeVisible();
              await expect(
                setup.getByRole('button', {
                  name: 'Station address',
                  exact: true,
                }),
              ).toHaveAttribute('aria-pressed', 'true');
              await setup
                .getByRole('button', { name: 'Done', exact: true })
                .tap();
              await expect(setup).toBeHidden();

              await add.tap();
              await chooser
                .getByRole('button', {
                  name: /^Run work on another computer over SSH/,
                })
                .tap();
              const ssh = page.getByRole('dialog', {
                name: 'Run work on another computer over SSH',
              });
              await expect(
                ssh.getByRole('button', { name: 'Save computer' }),
              ).toBeDisabled();
              await expect(
                ssh.getByRole('button', { name: 'Test connection' }),
              ).toBeDisabled();
              await ssh
                .getByRole('button', { name: 'Close SSH computer setup' })
                .tap();
              await expect(ssh).toBeHidden();

              await add.tap();
              const guide = chooser.getByRole('link', {
                name: 'How device pairing and remote computers differ',
              });
              await expect(guide).toHaveAttribute(
                'href',
                /machine-relationships\.md$/,
              );
              const guideURL =
                'https://github.com/kontourai/station/blob/main/docs/guides/machine-relationships.md';
              await page
                .context()
                .route(guideURL, (route) =>
                  route.fulfill({ body: 'Machine relationships' }),
                );
              const guideTab = page.waitForEvent('popup');
              await guide.tap();
              const openedGuide = await guideTab;
              await expect(openedGuide).toHaveURL(guideURL);
              await openedGuide.close();

              await chooser
                .getByRole('button', {
                  name: /^Control this Station from another device/,
                })
                .tap();
              await expect(
                page.getByRole('heading', {
                  name: 'Pair a Device',
                  exact: true,
                }),
              ).toBeVisible();
              await page
                .getByRole('button', { name: 'Close Station manager' })
                .tap();
              await expect(chooser).toBeHidden();
            });
          });

          test('saves and restores the isolated Knowledge data directory', async ({
            page,
          }) => {
            const home = process.env.STATION_E2E_HOME;
            if (!home)
              throw new Error(
                'Knowledge writes require the runner-owned Station home',
              );
            const headers = e2eOperatorAuthorizationHeaders(
              process.env.STATION_E2E_HOST_CREDENTIAL,
            );
            const recordPath = '/api/connections/lancedb-builtin';
            const readDataDirectory = async () => {
              const response = await page.request.get(recordPath, { headers });
              expect(response.ok()).toBe(true);
              const record = (await response.json()) as {
                data: { config: { dataDir?: string } };
              };
              return record.data.config.dataDir ?? '';
            };
            const originalDirectory = await readDataDirectory();
            await page.goto('/connections/knowledge');
            const toolbar = page.getByTestId('app-toolbar-connection');
            await expect(toolbar).toHaveAttribute(
              'aria-label',
              identityMismatch
                ? /Needs re-pairing/
                : /Choose Station — Connected/,
            );
            const db = page.locator('#section-vector-database');
            const directory = db.getByRole('textbox', {
              name: 'Data Directory',
            });
            const save = db.getByRole('button', { name: 'Save', exact: true });
            await expect(directory).toHaveValue(originalDirectory);
            await expect(save).toBeDisabled();
            const newDirectory = join(
              home,
              identityMismatch
                ? 'phone-notice-knowledge'
                : 'phone-healthy-knowledge',
            );
            for (const nextDirectory of [newDirectory, originalDirectory]) {
              await directory.fill(nextDirectory);
              const saved = page.waitForResponse(
                (response) =>
                  response.request().method() === 'PUT' &&
                  new URL(response.url()).pathname === recordPath,
              );
              await save.tap();
              expect((await saved).ok()).toBe(true);
              expect(await readDataDirectory()).toBe(nextDirectory);
              await page.reload();
              await expect(directory).toHaveValue(nextDirectory);
              await expect(save).toBeDisabled();
            }
            const tested = page.waitForResponse(
              (response) =>
                response.request().method() === 'POST' &&
                new URL(response.url()).pathname ===
                  '/api/providers/lancedb-builtin/test-vectordb',
            );
            await db
              .getByRole('button', { name: 'Test connection', exact: true })
              .tap();
            expect((await tested).ok()).toBe(true);
            await expect(
              db.getByText('Healthy', { exact: true }),
            ).toBeVisible();
          });

          test('saves and resets the selected engine setup', async ({
            page,
          }) => {
            const initialName = 'Phone fixture engine';
            const updatedName = 'Renamed phone fixture engine';
            const engineFixture = {
              id: 'codex',
              kind: 'agent',
              type: 'codex',
              name: initialName,
              enabled: true,
              capabilities: ['agent-runtime'],
              config: {
                executionClass: 'connected',
                defaultModel: 'codex-mini',
              },
              status: 'ready',
              prerequisites: [],
              setup: { state: 'ready', detected: true, configured: true },
            };
            const failedCheck = {
              evidenceVersion: 1,
              level: 'configured',
              observedAt: '2026-11-18T14:00:00.000Z',
              freshness: 'fresh',
              summary: 'The fixture engine did not authorize this check.',
              smoke: {
                status: 'failed',
                testedAt: '2026-11-18T14:00:00.000Z',
                provider: 'codex',
                reason: 'The fixture engine did not authorize this check.',
                freshness: 'fresh',
                turnLimit: 1,
              },
            };
            let engine:
              | (typeof engineFixture & {
                  readinessEvidence?: typeof failedCheck;
                })
              | null = engineFixture;
            await page.route('**/api/connections/agents', (route) =>
              route.fulfill({
                json: { success: true, data: engine ? [engine] : [] },
              }),
            );
            await page.route('**/api/connections/codex', async (route) => {
              const method = route.request().method();
              if (method === 'PUT') {
                const request = route.request().postDataJSON() as {
                  name: string;
                };
                if (!engine)
                  throw new Error(
                    'The fixture engine cannot be updated after reset',
                  );
                engine = { ...engine, name: request.name };
                await route.fulfill({ json: { success: true, data: engine } });
              } else if (method === 'DELETE') {
                engine = null;
                await route.fulfill({ json: { success: true } });
              } else if (method === 'GET') {
                if (engine)
                  await route.fulfill({
                    json: { success: true, data: engine },
                  });
                else
                  await route.fulfill({
                    status: 404,
                    json: { success: false, error: 'Engine not found' },
                  });
              } else {
                await route.fallback();
              }
            });
            await page.route(
              '**/api/connections/codex/smoke',
              async (route) => {
                if (!engine)
                  throw new Error(
                    'The fixture engine cannot be checked after reset',
                  );
                engine = { ...engine, readinessEvidence: failedCheck };
                await route.fulfill({
                  json: { success: true, data: failedCheck },
                });
              },
            );
            await page.route('**/api/connections/codex/test', (route) =>
              route.fulfill({
                status: 503,
                json: {
                  success: false,
                  error: 'The fixture catalog is temporarily unavailable.',
                },
              }),
            );
            await page.goto('/connections/engines');
            await expect(
              page.getByTestId('app-toolbar-connection'),
            ).toHaveAttribute(
              'aria-label',
              identityMismatch
                ? /Needs re-pairing/
                : /Choose Station — Connected/,
            );
            const engineSearch = page.getByPlaceholder('Search engines…');
            const initialRow = page.getByRole('button', {
              name: new RegExp(`^${initialName}`),
            });
            await expect(initialRow).toBeVisible();
            await engineSearch.fill('nothing-matches-this-engine');
            await expect(initialRow).toHaveCount(0);
            await engineSearch.clear();
            await page
              .getByRole('button', { name: new RegExp(`^${initialName}`) })
              .tap();
            const account = page.getByRole('region', {
              name: 'Codex account and usage',
            });
            await expect(
              account.getByText('Signed out', { exact: true }),
            ).toBeVisible();
            await expect(
              account.getByText('Add an account to sign in here.', {
                exact: true,
              }),
            ).toBeVisible();
            await account
              .getByRole('button', { name: 'Add account', exact: true })
              .tap();
            await expect(
              account.getByRole('textbox', { name: 'Account name' }),
            ).toBeVisible();
            await account
              .getByRole('button', { name: 'Cancel', exact: true })
              .tap();
            await expect(
              account.getByRole('textbox', { name: 'Account name' }),
            ).toHaveCount(0);
            const accountsRead = page.waitForResponse(
              (response) =>
                response.request().method() === 'GET' &&
                new URL(response.url()).pathname ===
                  '/api/connections/agent/codex/accounts',
            );
            await account
              .getByRole('button', { name: 'Refresh', exact: true })
              .tap();
            expect((await accountsRead).ok()).toBe(true);
            const month = account.getByRole('button', {
              name: '30 days',
              exact: true,
            });
            await month.tap();
            await expect(month).toHaveAttribute('aria-pressed', 'true');
            const week = account.getByRole('button', {
              name: '7 days',
              exact: true,
            });
            await week.tap();
            await expect(week).toHaveAttribute('aria-pressed', 'true');
            const activity = account.getByRole('combobox', {
              name: 'Activity for',
              exact: true,
            });
            await activity.selectOption('account');
            await expect(
              account.getByText(
                'This Station · selected account · attributed runs',
              ),
            ).toBeVisible();
            await activity.selectOption('engine');
            await expect(
              account.getByText('This Station · this engine · all accounts'),
            ).toBeVisible();
            await page
              .getByRole('button', {
                name: 'Manage proxies in Models',
                exact: true,
              })
              .tap();
            await expect(page).toHaveURL(/\/connections\/models$/);
            await page.goBack();
            await expect(page).toHaveURL(/\/connections\/engines\/codex$/);
            const refreshed = page.waitForResponse(
              (response) =>
                response.request().method() === 'POST' &&
                new URL(response.url()).pathname ===
                  '/api/connections/codex/test',
            );
            await page
              .getByRole('button', { name: 'Refresh models', exact: true })
              .tap();
            expect((await refreshed).status()).toBe(503);
            await expect(
              page.getByText('Couldn’t refresh models.', { exact: false }),
            ).toBeVisible();
            await page.getByText('Advanced', { exact: true }).tap();
            const name = page.getByRole('textbox', {
              name: 'Name',
              exact: true,
            });
            await name.fill(updatedName);
            const saved = page.waitForResponse(
              (response) =>
                response.request().method() === 'PUT' &&
                new URL(response.url()).pathname === '/api/connections/codex',
            );
            await page.getByRole('button', { name: 'Save', exact: true }).tap();
            expect((await saved).ok()).toBe(true);
            expect(engine?.name).toBe(updatedName);
            await page.getByRole('button', { name: '← Back to list' }).tap();
            const updated = page.getByRole('button', {
              name: new RegExp(`^${updatedName}`),
            });
            await updated.tap();
            const check = page.waitForRequest(
              (request) =>
                request.method() === 'POST' &&
                new URL(request.url()).pathname ===
                  '/api/connections/codex/smoke',
            );
            await page
              .getByRole('button', { name: 'Check connection', exact: true })
              .tap();
            expect((await check).postDataJSON()).toEqual({ confirmed: true });
            await expect(
              page.getByText(
                'Couldn’t connect. Check the connection settings, then try again.',
              ),
            ).toBeVisible();

            await page.getByText('Advanced', { exact: true }).tap();
            const reset = page.getByRole('button', {
              name: 'Reset to defaults',
              exact: true,
            });
            await reset.tap();
            const confirmation = page.getByRole('dialog', {
              name: 'Reset this engine',
            });
            await confirmation
              .getByRole('button', { name: 'Cancel', exact: true })
              .tap();
            expect(engine?.name).toBe(updatedName);
            await reset.tap();
            const deleted = page.waitForResponse(
              (response) =>
                response.request().method() === 'DELETE' &&
                new URL(response.url()).pathname === '/api/connections/codex',
            );
            await confirmation
              .getByRole('button', { name: 'Reset', exact: true })
              .tap();
            expect((await deleted).ok()).toBe(true);
            expect(engine).toBeNull();
            await expect(confirmation).toBeHidden();
            await page.getByRole('button', { name: '← Back to list' }).tap();
            await expect(page).toHaveURL(/\/connections\/engines$/);
            await expect(updated).toHaveCount(0);
          });

          test('saves a probed SSH computer and confirms removal', async ({
            page,
          }) => {
            const id = 'phone-ssh-computer';
            const hostAlias = 'phone-fixture-ssh';
            const name = 'Phone fixture computer';
            let stored: {
              profile: Record<string, unknown>;
              state: { phase: string } & Record<string, unknown>;
            } | null = null;
            let probePassed = false;
            await page.route('**/api/environments/ssh/probe', async (route) => {
              expect(route.request().method()).toBe('POST');
              expect(route.request().postDataJSON()).toMatchObject({
                hostAlias,
              });
              probePassed = true;
              await route.fulfill({
                json: {
                  success: true,
                  data: {
                    evidenceVersion: 1,
                    level: 'discovered',
                    freshness: 'fresh',
                    observedAt: '2026-11-18T14:00:00.000Z',
                    reachable: true,
                    summary: 'The fixture verified the SSH destination.',
                    resolved: {
                      hostname: '127.0.0.1',
                      user: 'fixture',
                      port: 2222,
                      identityAgent: 'default',
                    },
                  },
                },
              });
            });
            await page.route('**/api/environments/ssh', async (route) => {
              switch (route.request().method()) {
                case 'GET':
                  await route.fulfill({
                    json: { success: true, data: stored ? [stored] : [] },
                  });
                  return;
                case 'POST': {
                  expect(probePassed).toBe(true);
                  const input = route.request().postDataJSON() as {
                    name: string;
                    hostAlias: string;
                    remoteProjectPath: string;
                    remotePort: number;
                  };
                  expect(input).toMatchObject({ name, hostAlias });
                  const timestamp = '2026-11-18T14:00:00.000Z';
                  stored = {
                    profile: {
                      schemaVersion: 1,
                      ...input,
                      id,
                      environmentId: null,
                      hostIdentity: null,
                      verifiedProjectPath: null,
                      workerProtocolVersion: null,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                      lastConnectedAt: null,
                    },
                    state: { phase: 'idle' },
                  };
                  await route.fulfill({
                    status: 201,
                    json: { success: true, data: stored },
                  });
                  return;
                }
                default:
                  await route.fallback();
              }
            });
            await page.route(`**/api/environments/ssh/${id}`, async (route) => {
              expect(route.request().method()).toBe('DELETE');
              stored = null;
              await route.fulfill({ json: { success: true } });
            });

            await page.route(
              new RegExp(`/api/environments/ssh/${id}/(connect|disconnect)$`),
              async (route) => {
                expect(route.request().method()).toBe('POST');
                if (!stored)
                  throw new Error(
                    'The fixture SSH computer must be saved before connecting',
                  );
                const connect = new URL(
                  route.request().url(),
                ).pathname.endsWith('/connect');
                if (connect)
                  stored.profile.lastConnectedAt = '2026-11-18T14:00:05.000Z';
                stored.state = connect
                  ? {
                      phase: 'connected',
                      localUrl: page.url(),
                      instanceId: 'phone-ssh-fixture',
                      sha: '1234567',
                      bootId: 'phone-ssh-boot',
                      connectedAt: '2026-11-18T14:00:05.000Z',
                    }
                  : { phase: 'disconnected', reason: 'stopped' };
                await route.fulfill({ json: { success: true, data: stored } });
              },
            );

            await page.goto('/connections/computers');
            await expect(
              page.getByTestId('app-toolbar-connection'),
            ).toHaveAttribute(
              'aria-label',
              identityMismatch
                ? /Needs re-pairing/
                : /Choose Station — Connected/,
            );
            const delegation = page.getByText(
              'Advanced: delegate to another Station',
              { exact: true },
            );
            await delegation.tap();
            const copy = page.getByRole('button', {
              name: 'Copy command',
              exact: true,
            });
            await copy.tap();
            await expect(
              page.getByRole('button', { name: "Can't copy", exact: true }),
            ).toBeVisible();
            await delegation.tap();
            await expect(copy).toBeHidden();
            await page
              .getByRole('button', { name: 'Add computer', exact: true })
              .tap();
            await page
              .getByRole('button', {
                name: /^Run work on another computer over SSH/,
              })
              .tap();
            const ssh = page.getByRole('dialog', {
              name: 'Run work on another computer over SSH',
            });
            const save = ssh.getByRole('button', { name: 'Save computer' });
            await expect(save).toBeDisabled();
            await ssh
              .getByPlaceholder('box-b, or 192.168.1.20')
              .fill(hostAlias);
            await ssh.getByPlaceholder('Build box').fill(name);
            await ssh
              .getByRole('button', { name: 'Test connection', exact: true })
              .tap();
            await expect(
              ssh.getByText('The fixture verified the SSH destination.'),
            ).toBeVisible();
            await expect(save).toBeEnabled();
            await save.tap();
            await expect(ssh).toBeHidden();
            expect(stored).toMatchObject({ profile: { id, name, hostAlias } });

            const row = page
              .locator('.connections-computers__row')
              .filter({ hasText: name });
            await expect(row).toContainText('Not connected');
            await row
              .getByRole('button', { name: 'Connect', exact: true })
              .tap();
            await row.getByRole('button', { name: 'Stop', exact: true }).tap();
            await row
              .getByRole('button', { name: 'Resume', exact: true })
              .tap();
            await row.getByRole('button', { name: 'Stop', exact: true }).tap();
            await expect(
              row.getByRole('button', { name: 'Resume', exact: true }),
            ).toBeVisible();
            await row
              .getByRole('button', { name: 'Remove this computer' })
              .tap();
            const confirmation = page.getByRole('alertdialog', {
              name: 'Remove computer?',
            });
            await confirmation
              .getByRole('button', { name: 'Cancel', exact: true })
              .tap();
            await expect(row).toBeVisible();
            await row
              .getByRole('button', { name: 'Remove this computer' })
              .tap();
            await confirmation
              .getByRole('button', { name: 'Remove', exact: true })
              .tap();
            await expect(row).toHaveCount(0);
            expect(stored).toBeNull();
          });

          test('Station manager actions and writable profiles', async ({
            page,
          }) => {
            await page.goto('/connections/computers');
            const toolbar = page.getByTestId('app-toolbar-connection');
            const details = page.getByRole('dialog', {
              name: 'Station details',
            });
            await expect(toolbar).toHaveAttribute(
              'aria-label',
              identityMismatch
                ? /Needs re-pairing/
                : /Choose Station — Connected/,
            );
            await toolbar.tap();
            await page
              .getByRole('menuitem', { name: /^Station details/ })
              .tap();
            if (identityMismatch) {
              const remove = details.getByRole('button', {
                name: 'Remove connection',
                exact: true,
              });
              await remove.tap();
              await expect(
                details.getByRole('button', {
                  name: 'Confirm removing this connection',
                }),
              ).toBeVisible();
              await details
                .getByRole('button', { name: 'Cancel', exact: true })
                .tap();
              await expect(remove).toBeVisible();
            }
            await details
              .getByRole('button', {
                name: identityMismatch ? 'Pair again' : 'Manage Stations',
              })
              .tap();
            await expect(details).toBeHidden();
            const managerClose = page.getByRole('button', {
              name: 'Close Station manager',
            });
            await expect(managerClose).toBeVisible();
            if (identityMismatch) {
              await expect(
                page.getByRole('button', {
                  name: 'Request access',
                  exact: true,
                }),
              ).toBeVisible();
              const access = page.getByRole('dialog', {
                name: 'Request Access',
                exact: true,
              });
              await page.route(
                '**/.well-known/station/v1/pairing/access-request',
                (route) => route.abort('connectionrefused'),
              );
              const request = page.waitForRequest(
                (request) =>
                  request.method() === 'POST' &&
                  new URL(request.url()).pathname.endsWith(
                    '/pairing/access-request',
                  ),
              );
              await access
                .getByRole('button', { name: 'Request access', exact: true })
                .tap();
              await request;
              await expect(
                access.getByText(
                  'Could not reach the Station at that address. Check that it is running and that this device can reach it.',
                ),
              ).toBeVisible();
              const retry = page.waitForRequest(
                (request) =>
                  request.method() === 'POST' &&
                  new URL(request.url()).pathname.endsWith(
                    '/pairing/access-request',
                  ),
              );
              await access
                .getByRole('button', { name: 'Retry', exact: true })
                .tap();
              await retry;
              await expect(access.getByRole('alert')).toContainText(
                'Connection request failed',
              );
              await access
                .getByRole('button', { name: 'Back', exact: true })
                .tap();
            }
            const stations = page.getByRole('dialog', {
              name: 'Stations',
              exact: true,
            });
            await expect(stations).toBeVisible();

            await test.step('Saved Station controls', async () => {
              const disclosure = stations.getByRole('button', {
                name: 'View details for Dev Server',
              });
              await disclosure.tap();
              await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
              await expect(
                stations.getByRole('button', { name: 'Switch to Dev Server' }),
              ).toBeDisabled();
              const rowActions = stations.getByRole('button', {
                name: 'More actions for Dev Server',
              });
              await rowActions.tap();
              const reachability = page.waitForRequest(
                (request) =>
                  new URL(request.url()).pathname === '/.well-known/station/v1',
              );
              await stations
                .getByRole('menuitem', { name: 'Check reachability' })
                .tap();
              await reachability;
              await expect(rowActions).toHaveAttribute(
                'aria-expanded',
                'false',
              );

              await rowActions.tap();
              await stations
                .getByRole('menuitem', { name: 'Copy address' })
                .tap();
              await expect(
                stations.getByText(
                  'Could not copy. The full address is shown above.',
                  { exact: true },
                ),
              ).toBeVisible();

              await rowActions.tap();
              await stations
                .getByRole('menuitem', { name: 'Edit Station' })
                .tap();
              const name = stations.getByRole('textbox', {
                name: 'Station name',
                exact: true,
              });
              await expect(name).toHaveValue('Dev Server');
              await name.fill('Mobile Station');
              await stations
                .getByRole('button', { name: 'Cancel', exact: true })
                .tap();
              await expect(
                stations.getByRole('button', {
                  name: 'View details for Dev Server',
                }),
              ).toBeVisible();

              await rowActions.tap();
              await stations
                .getByRole('menuitem', { name: 'Forget Station' })
                .tap();
              await expect(
                stations.getByRole('button', {
                  name: 'Confirm forgetting Dev Server',
                }),
              ).toBeVisible();
              await stations
                .getByRole('button', { name: 'Cancel', exact: true })
                .tap();
              await expect(rowActions).toBeVisible();

              await rowActions.tap();
              await stations
                .getByRole('menuitem', { name: 'Reconnect', exact: true })
                .tap();
              const reconnect = page.getByRole('dialog', {
                name: 'Request Access',
              });
              await expect(reconnect).toBeVisible();
              await reconnect
                .getByRole('button', { name: 'Back', exact: true })
                .tap();
              await expect(stations).toBeVisible();
            });

            await test.step('Renaming and forgetting the other saved Station', async () => {
              const label = 'Recovered Station';
              const renamed = 'Renamed recovery Station';
              const row = stations.getByRole('button', {
                name: `View details for ${label}`,
              });
              await row.tap();
              const activeId = () =>
                page.evaluate(() =>
                  localStorage.getItem('station-connect-connections-active'),
                );
              await stations
                .getByRole('button', {
                  name: `Switch to ${label}`,
                  exact: true,
                })
                .tap();
              await expect.poll(activeId).toBe('c2');
              await stations
                .getByRole('button', {
                  name: 'View details for Dev Server',
                  exact: true,
                })
                .tap();
              await stations
                .getByRole('button', {
                  name: 'Switch to Dev Server',
                  exact: true,
                })
                .tap();
              await expect.poll(activeId).toBe('c1');
              await expect(row).toHaveAttribute('aria-expanded', 'true');
              await row.tap({ position: { x: 20, y: 14 } });
              await expect(row).toHaveAttribute('aria-expanded', 'false');
              await row.tap();
              const rowDetails = stations
                .locator('.station-connect-row')
                .filter({
                  has: page.getByRole('button', {
                    name: `View details for ${label}`,
                  }),
                });
              await rowDetails
                .getByRole('button', { name: 'Edit Station', exact: true })
                .tap();
              await stations
                .getByRole('textbox', { name: 'Station name', exact: true })
                .fill(renamed);
              await stations
                .getByRole('button', { name: 'Save', exact: true })
                .tap();
              const updated = stations.getByRole('button', {
                name: `View details for ${renamed}`,
              });
              await expect(updated).toBeVisible();

              const persisted = () =>
                page.evaluate(() => {
                  const records = JSON.parse(
                    localStorage.getItem('station-connect-connections') ?? '[]',
                  ) as { id: string; name: string }[];
                  return (
                    records.find((record) => record.id === 'c2')?.name ?? null
                  );
                });
              await expect.poll(persisted).toBe(renamed);
              await stations
                .getByRole('button', { name: `More actions for ${renamed}` })
                .tap();
              await stations
                .getByRole('menuitem', { name: 'Forget Station' })
                .tap();
              await stations
                .getByRole('button', { name: `Confirm forgetting ${renamed}` })
                .tap();
              await expect(updated).toHaveCount(0);
              await expect.poll(persisted).toBeNull();
            });

            await test.step('Station manager pairing entry points', async () => {
              await stations
                .getByRole('button', {
                  name: 'Enter a pairing code',
                  exact: true,
                })
                .tap();
              const enter = page.getByRole('dialog', {
                name: 'Enter a pairing code',
              });
              await expect(
                enter.getByRole('button', { name: 'Enter manually' }),
              ).toHaveAttribute('aria-pressed', 'true');
              await expect(
                enter.getByRole('button', { name: 'Connect', exact: true }),
              ).toBeDisabled();
              await page.evaluate(() => {
                Object.defineProperty(navigator.clipboard, 'readText', {
                  configurable: true,
                  value: () =>
                    Promise.reject(
                      new DOMException(
                        'Clipboard not allowed',
                        'NotAllowedError',
                      ),
                    ),
                });
              });
              await enter
                .getByRole('button', {
                  name: 'Paste pairing code',
                  exact: true,
                })
                .tap();
              await expect(enter.getByRole('alert')).toContainText(
                'Clipboard paste is unavailable.',
              );
              await enter
                .getByRole('button', { name: 'Back', exact: true })
                .tap();

              await stations
                .getByRole('button', { name: 'Scan a QR code', exact: true })
                .tap();
              const scan = page.getByRole('dialog', {
                name: 'Scan a pairing code',
              });
              // Headless Chromium has no camera, so the scanner gives way to
              // code entry instead of a camera error.
              await expect(scan.getByLabel('Pairing code')).toBeVisible();
              await expect(
                scan.getByRole('button', { name: 'Scan code', exact: true }),
              ).toHaveCount(0);
              await expect(scan.getByText(/Camera error/)).toHaveCount(0);
              await scan
                .getByRole('button', { name: 'Back', exact: true })
                .tap();

              await stations
                .getByRole('button', { name: 'Paired devices', exact: true })
                .tap();
              const devices = page.getByRole('dialog', {
                name: 'Paired Devices',
              });
              await expect(devices).toBeVisible();
              await devices
                .getByRole('button', { name: 'Back', exact: true })
                .tap();

              await stations
                .getByRole('button', {
                  name: 'Connect another device',
                  exact: true,
                })
                .tap();
              const invite = page.getByRole('dialog', {
                name: 'Pair a Device',
              });
              await expect(invite).toBeVisible();
              await invite
                .getByRole('textbox', { name: 'Pairing endpoint', exact: true })
                .fill(new URL(page.url()).origin);
              await invite
                .getByRole('button', {
                  name: 'Create pairing code',
                  exact: true,
                })
                .tap();
              await expect(
                invite.getByText(/This address only works on this computer/),
              ).toBeVisible();

              await invite
                .getByRole('button', { name: 'Back', exact: true })
                .tap();

              await stations
                .getByRole('button', { name: 'Connect a Station', exact: true })
                .tap();
              const setup = page.getByRole('dialog', {
                name: 'Connect a Station',
                exact: true,
              });
              await expect(setup).toBeVisible();
              await setup
                .getByRole('button', {
                  name: 'Close Station setup',
                  exact: true,
                })
                .tap();
              await expect(setup).toBeHidden();
              await expect(managerClose).toBeHidden();
            });

            if (identityMismatch) {
              await toolbar.tap();
              await page
                .getByRole('menuitem', { name: /^Station details/ })
                .tap();
              await page.clock.install();
              await details
                .getByRole('button', { name: 'Remove connection', exact: true })
                .tap();
              await page.clock.runFor(350);
              await details
                .getByRole('button', {
                  name: 'Confirm removing this connection',
                })
                .tap();
              await expect
                .poll(() =>
                  page.evaluate(() => {
                    const records = JSON.parse(
                      localStorage.getItem('station-connect-connections') ??
                        '[]',
                    ) as { id: string }[];
                    return records.some((record) => record.id === 'c1');
                  }),
                )
                .toBe(false);
            }
          });
        },
      );
    }
  });
});
