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

async function seedConnection(page: Page) {
  const credential = process.env.STATION_E2E_HOST_CREDENTIAL;
  if (!credential) {
    throw new Error('Reconnect coverage requires the runner host credential');
  }
  await page.addInitScript((hostCredential) => {
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
      ]),
    );
    window.localStorage.setItem('station-connect-connections-active', 'c1');
    window.localStorage.setItem(
      'station-connect-connections-credentials',
      JSON.stringify({ 'connection:c1': hostCredential }),
    );
    window.localStorage.setItem('station:onboarding-setup-dismissed', '1');
  }, credential);
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
  test.beforeEach(async ({ page }) => {
    await seedConnection(page);
  });

  test('deduplicates probes and recovers without reloading', async ({
    page,
  }) => {
    const state = {
      healthy: true,
      bootId: 'boot-1',
      inFlight: 0,
      maxInFlight: 0,
    };
    await installTransport(page, state);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: "What's next?" }),
    ).toBeVisible();

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
    await page.setViewportSize({ width: 390, height: 844 });
    const state = {
      healthy: true,
      bootId: 'boot-mobile',
      inFlight: 0,
      maxInFlight: 0,
    };
    await installTransport(page, state);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: "What's next?" }),
    ).toBeVisible();
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

  test('selects a new healthy Station after connection failure on mobile', async ({
    page,
    baseURL,
  }) => {
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
      if (requested.pathname === '/api/events') {
        await route.abort('connectionrefused');
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
    await expect(
      page.getByRole('heading', { name: "What's next?" }),
    ).toBeVisible();
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
      .getByRole('button', { name: 'Add a Station address' })
      .click();
    await page.getByPlaceholder('Name (optional)').fill('Recovered Station');
    await page
      .getByPlaceholder('https://station.example.ts.net')
      .fill(RECOVERED_URL);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
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
    expect(recoveredStatusRequests).toBeGreaterThanOrEqual(2);
  });
  test('identity repair in Station details opens the access-request flow', async ({
    page,
  }) => {
    const state = {
      healthy: true,
      bootId: 'repair-boot',
      inFlight: 0,
      maxInFlight: 0,
    };
    await installTransport(page, state);
    await page.route('**/.well-known/station/v1', (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: E2E_STATION_COMPATIBILITY,
          // Missing environment identity is the public probe's mismatch condition.
        },
      }),
    );
    await page.goto('/');
    await expect(page.getByTestId('app-toolbar-connection')).toHaveAttribute(
      'aria-label',
      /Needs re-pairing/,
    );
    const details = await openStationDetails(page);
    await expect(
      details.getByRole('button', { name: 'Remove connection' }),
    ).toBeVisible();
    await details.getByRole('button', { name: 'Pair again' }).click();
    await expect(details).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Close Station manager' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Request access', exact: true }),
    ).toBeVisible();
  });
});
