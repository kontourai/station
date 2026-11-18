import { expect, type Page } from '@playwright/test';
import { E2E_STATION_COMPATIBILITY } from './helpers/current-station-contract';
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

async function seedConnection(page: Page, withRecovered = false) {
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
      recoveredUrl: withRecovered ? RECOVERED_URL : undefined,
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
      test(`Connections navigation, setup and Station controls work ${identityMismatch ? 'with' : 'without'} a Station notice`, async ({
        page,
      }) => {
        await seedConnection(page);
        await installTransport(page, {
          healthy: true,
          bootId: 'connections-mobile-boot',
          inFlight: 0,
          maxInFlight: 0,
        });
        if (identityMismatch) {
          await page.route('**/.well-known/station/v1', (route) =>
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

        await page.goto('/connections/computers');
        const toolbar = page.getByTestId('app-toolbar-connection');
        await expect(toolbar).toHaveAttribute(
          'aria-label',
          identityMismatch ? /Needs re-pairing/ : /Choose Station — Connected/,
        );
        await toolbar.tap();
        await page.getByRole('menuitem', { name: /^Station details/ }).tap();
        const details = page.getByRole('dialog', { name: 'Station details' });
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
              .getByRole('tab', { name: new RegExp(`^${section.title}\\b`) })
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
            setup.getByRole('textbox', { name: 'Pairing code', exact: true }),
          ).toBeVisible();
          await setup
            .getByRole('button', { name: 'Scan QR', exact: true })
            .tap();
          await setup
            .getByRole('button', { name: 'Cancel', exact: true })
            .tap();
          await expect(
            setup.getByRole('textbox', {
              name: 'Station address',
              exact: true,
            }),
          ).toBeVisible();
          await setup
            .getByRole('button', { name: 'Station address', exact: true })
            .tap();
          await expect(
            setup.getByRole('button', { name: 'Station address', exact: true }),
          ).toHaveAttribute('aria-pressed', 'true');
          await setup.getByRole('button', { name: 'Done', exact: true }).tap();
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
          await chooser
            .getByRole('button', {
              name: /^Control this Station from another device/,
            })
            .tap();
          await expect(
            page.getByRole('heading', { name: 'Pair a Device', exact: true }),
          ).toBeVisible();
          await page
            .getByRole('button', { name: 'Close Station manager' })
            .tap();
          await expect(chooser).toBeHidden();
        });

        await expect(toolbar).toHaveAttribute(
          'aria-label',
          identityMismatch ? /Needs re-pairing/ : /Choose Station — Connected/,
        );
        await toolbar.tap();
        await page.getByRole('menuitem', { name: /^Station details/ }).tap();
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
            page.getByRole('button', { name: 'Request access', exact: true }),
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
          await access.getByRole('button', { name: 'Back', exact: true }).tap();
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
          await expect(rowActions).toHaveAttribute('aria-expanded', 'false');

          await rowActions.tap();
          await stations.getByRole('menuitem', { name: 'Copy address' }).tap();
          await expect(
            stations.getByText(
              'Could not copy. The full address is shown above.',
              { exact: true },
            ),
          ).toBeVisible();

          await rowActions.tap();
          await stations.getByRole('menuitem', { name: 'Edit Station' }).tap();
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

        await test.step('Station manager pairing entry points', async () => {
          await stations
            .getByRole('button', { name: 'Enter a pairing code', exact: true })
            .tap();
          const enter = page.getByRole('dialog', {
            name: 'Enter a pairing code',
          });
          await expect(
            enter.getByRole('button', { name: 'Enter manually' }),
          ).toHaveAttribute('aria-pressed', 'true');
          await enter.getByRole('button', { name: 'Back', exact: true }).tap();

          await stations
            .getByRole('button', { name: 'Scan a QR code', exact: true })
            .tap();
          const scan = page.getByRole('dialog', {
            name: 'Scan a pairing code',
          });
          await expect(
            scan.getByRole('button', { name: 'Scan code', exact: true }),
          ).toHaveAttribute('aria-pressed', 'true');
          await scan
            .getByRole('button', { name: 'Enter manually', exact: true })
            .tap();
          await scan.getByRole('button', { name: 'Back', exact: true }).tap();

          await stations
            .getByRole('button', { name: 'Paired devices', exact: true })
            .tap();
          const devices = page.getByRole('dialog', { name: 'Paired Devices' });
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
          const invite = page.getByRole('dialog', { name: 'Pair a Device' });
          await expect(invite).toBeVisible();
          await invite.getByRole('button', { name: 'Back', exact: true }).tap();

          await stations
            .getByRole('button', { name: 'Connect a Station', exact: true })
            .tap();
          const setup = page.getByRole('dialog', {
            name: 'Connect a Station',
            exact: true,
          });
          await expect(setup).toBeVisible();
          await setup
            .getByRole('button', { name: 'Close Station setup', exact: true })
            .tap();
          await expect(setup).toBeHidden();
          await expect(managerClose).toBeHidden();
        });
      });
    }
  });
});
