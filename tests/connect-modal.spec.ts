/**
 * E2E: Connection Manager Modal
 *
 * Opens the app, seeds localStorage with a connection, verifies:
 *  - the connection chip appears in the header
 *  - its chooser opens the manager through Manage Stations
 *  - approving a Device grant saves its connection without switching
 *  - switching active connection updates the chip label
 *  - editing a connection works
 *  - removing a connection works
 *  - empty discovery remains unavailable
 *  - status dot states render correctly
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTHORITY_OBSERVATION_SCHEMA_VERSION,
  type AuthorityObservation,
} from '@kontourai/station-contracts/authority-observation';
import type { PublicStationHandshake } from '@kontourai/station-contracts/environment-security';
import { expect, type Locator, type Page } from '@playwright/test';
import { pairedDevicePrincipal } from '../src-server/runtime/bootstrap/orchestration-request-principal';
import {
  DevicePairingError,
  DevicePairingService,
} from '../src-server/services/ssh/device-pairing-service';
import { requireE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import { dismissSetupLauncher } from './helpers/orchestration';
import { fulfillStationShellRead } from './helpers/station-shell-fixtures';

/**
 * Per-connection actions (Edit/Check/Forget) live behind a "More actions"
 * overflow menu, not as standalone title-attributed buttons
 * (`ConnectionListPanel.tsx` station#4512 review M6). Open it and return the
 * menu scoped to this connection so its menuitems can be clicked.
 *
 * Lifted from `tests/connect-remote-auth-recovery.spec.ts` (station#1140,
 * not yet on `main` as of this fix) rather than reinvented — two independent
 * copies of the same navigation is how these drift apart. If that PR lands
 * first, prefer importing its helper instead of keeping this local copy.
 */
async function openConnectionActionsMenu(scope: Locator, name: string) {
  await scope
    .getByRole('button', { name: `More actions for ${name}`, exact: true })
    .click();
  return scope.getByRole('menu', { name: `Actions for ${name}` });
}

async function openStationManager(page: Page) {
  await page.getByTestId('app-toolbar-connection').click();
  const chooser = page.getByRole('menu', {
    name: 'Choose Station',
    exact: true,
  });
  await expect(chooser).toBeVisible();
  await chooser
    .getByRole('menuitem', { name: 'Manage Stations', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'Stations', exact: true }),
  ).toBeVisible();
}

async function openConnectionEditor(dialog: Locator, name: string) {
  await dialog
    .getByRole('button', { name: `View details for ${name}`, exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Edit Station', exact: true })
    .click();
}

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

function seedConnection(
  id = 'conn-1',
  name = 'Dev Server',
  urlExpression = 'window.location.origin',
) {
  const credential = requireE2EOperatorCredential(
    process.env.STATION_E2E_HOST_CREDENTIAL ??
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  );
  return `
    window.localStorage.setItem('station-connect-connections', JSON.stringify([
      {
        profileVersion: 4,
        id: '${id}',
        name: '${name}',
        url: ${urlExpression},
        credentialRef: { credentialVersion: 1, kind: 'connection', id: '${id}' },
        credentialState: 'saved',
        lastConnected: ${Date.now()}
      }
    ]));
    window.localStorage.setItem('station-connect-connections-active', '${id}');
    window.localStorage.setItem('station-connect-connections-credentials', JSON.stringify({
      'connection:${id}': '${credential}'
    }));
  `;
}

const receiverHomes: string[] = [];

/** Approved receiver-domain fixture; browser Origin admission is covered separately. */
async function receiverFixture(
  page: Page,
  origin: string,
  holdDiscovery = false,
) {
  const home = mkdtempSync(join(tmpdir(), 'station-connect-modal-receiver-'));
  receiverHomes.push(home);
  mkdirSync(join(home, 'security'), { recursive: true });
  const environmentId = '11111111-1111-4111-8111-111111110259';
  const pairing = new DevicePairingService({ homeDir: home, environmentId });
  let releaseDiscovery = () => {};
  const discovery = holdDiscovery
    ? new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      })
    : Promise.resolve();
  const handshake: PublicStationHandshake = {
    schemaVersion: 1,
    environmentId,
    authentication: { scheme: 'bearer', protocolVersion: 1 },
    transports: { http: 1, sse: 1, websocket: 1 },
    compatibility: {
      serverVersion: '0.0.0-test',
      protocolVersion: 1,
      minClientProtocol: 1,
      capabilities: { remoteAuth: 1, devicePairing: 1, environmentProof: 1 },
    },
  };
  let exchangedDeviceId: string | undefined;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    if (request.method() === 'GET' && path === '/.well-known/station/v1') {
      await discovery;
      return route.fulfill({ json: handshake });
    }
    if (
      request.method() === 'POST' &&
      path === '/.well-known/station/v1/pairing/access-request'
    ) {
      const input = request.postDataJSON() as Pick<
        Parameters<DevicePairingService['requestAccess']>[0],
        'deviceName' | 'clientInstanceId' | 'kind'
      >;
      const pending = pairing.requestAccess({
        endpoint: origin,
        deviceName: input.deviceName,
        clientInstanceId: input.clientInstanceId,
        requesterPosition: 'off-box',
        kind: input.kind ?? 'device',
      });
      return route.fulfill({ status: 202, json: pending });
    }
    if (
      request.method() === 'POST' &&
      path === '/.well-known/station/v1/pairing/exchange'
    ) {
      try {
        const input = request.postDataJSON() as Parameters<
          DevicePairingService['exchange']
        >[0];
        const issued = pairing.exchange(input);
        exchangedDeviceId = issued.device.id;
        return route.fulfill({ json: issued });
      } catch (error) {
        if (error instanceof DevicePairingError)
          return route.fulfill({ status: 409, json: { error: error.code } });
        throw error;
      }
    }
    const authorization = request.headers().authorization;
    if (
      !authorization?.startsWith('Bearer ') ||
      !pairing.verifyCredential(authorization.slice(7))
    ) {
      return route.fulfill({
        status: 401,
        json: { error: 'authentication_required' },
      });
    }
    if (request.method() === 'GET' && path === '/api/auth/authority') {
      const device = pairing.identifyDevice(authorization.slice(7));
      if (!device)
        throw new Error('The verified receiver grant has no Device record');
      const principal = pairedDevicePrincipal(device);
      if (principal.kind !== 'human' && principal.kind !== 'tenant') {
        throw new Error(
          'The receiver Device resolved a principal kind unsupported by authority observations',
        );
      }
      const observation: AuthorityObservation = {
        schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
        environmentId,
        principal: { kind: principal.kind, id: principal.id },
        grant: {
          kind: 'device',
          deviceId: device.id,
          grantedScopes: device.scope.split(' '),
        },
      };
      return route.fulfill({ json: observation });
    }
    if (request.method() === 'GET' && path === '/api/system/status')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      });
    if (request.method() === 'GET' && path === '/api/system/identity')
      return route.fulfill({
        json: {
          environmentId,
          instanceId: 'connect-modal-receiver',
          bootId: 'receiver-boot',
          sha: '2222222222222222222222222222222222222222',
        },
      });
    if (
      request.method() === 'GET' &&
      (path === '/api/browser/projects/default/access' ||
        (path === '/api/browser/sessions' &&
          requestUrl.searchParams.get('projectSlug') === 'default'))
    )
      return rejectUnexpectedFixtureRequest(route);
    if (
      await fulfillStationShellRead(route, {
        environmentId,
        deviceId: exchangedDeviceId,
      })
    )
      return;
    return rejectUnexpectedFixtureRequest(route);
  });
  return { pairing, environmentId, releaseDiscovery };
}

async function identifyReceiver(page: Page, origin: string) {
  await openStationManager(page);
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: 'Connect a Station', exact: true })
    .click();
  await dialog
    .getByRole('textbox', { name: 'Station address', exact: true })
    .fill(origin);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  return dialog;
}

async function approveReceiverDevice(
  page: Page,
  origin: string,
  name: string,
  receiver: Awaited<ReturnType<typeof receiverFixture>>,
) {
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText(receiver.environmentId, { exact: true }),
  ).toBeVisible();
  expect(receiver.pairing.listDevices()).toHaveLength(0);
  await expect(
    dialog.getByRole('checkbox', {
      name: `Use ${origin} from this device`,
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', {
      name: `Let Dev Server send work to ${origin}`,
      exact: true,
    }),
  ).not.toBeChecked();
  await dialog
    .getByRole('button', { name: 'Request selected access', exact: true })
    .click();
  if (new URL(origin).protocol === 'http:') {
    const consent = dialog.getByRole('checkbox', {
      name: 'Allow an unencrypted connection',
    });
    await expect(consent).not.toBeChecked();
    await expect(
      dialog.getByRole('button', { name: 'Request access', exact: true }),
    ).toBeDisabled();
    await consent.check();
  }
  await dialog
    .getByRole('button', { name: 'Request access', exact: true })
    .click();
  await expect.poll(() => receiver.pairing.listRequests().length).toBe(1);
  expect(receiver.pairing.listDevices()).toHaveLength(0);
  const pending = receiver.pairing.listRequests()[0];
  receiver.pairing.confirmRequest(pending.requestId, {
    kind: 'presented-credential',
  });
  await expect
    .poll(async () =>
      page.evaluate((address) => {
        const saved = JSON.parse(
          localStorage.getItem('station-connect-connections') ?? '[]',
        ) as Array<{ url: string; credentialState: string }>;
        return saved.find((connection) => connection.url === address)
          ?.credentialState;
      }, origin),
    )
    .toBe('saved');
  expect(receiver.pairing.listDevices()).toHaveLength(1);
  await expect(page.getByTestId('app-toolbar-connection')).toHaveAccessibleName(
    /Dev Server/,
  );
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await openStationManager(page);
  const manager = page.getByRole('dialog');
  await openConnectionEditor(manager, origin);
  await manager
    .getByRole('textbox', { name: 'Station name', exact: true })
    .fill(name);
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    manager.getByRole('button', {
      name: `View details for ${name}`,
      exact: true,
    }),
  ).toBeVisible();
  return manager;
}

test.describe('Connection Manager Modal', () => {
  test.afterEach(() => {
    for (const home of receiverHomes.splice(0))
      rmSync(home, { recursive: true, force: true });
  });
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', async (route) => {
      if (
        await fulfillStationShellRead(route, {
          environmentId: 'env-connect-modal-suite',
        })
      )
        return;
      await route.fallback();
    });
    await page.addInitScript(seedConnection());
    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    );
    await page.route('**/api/system/identity', (route) =>
      route.fulfill({
        json: {
          environmentId: 'env-connect-modal-suite',
          instanceId: 'connect-modal-fixture',
          bootId: 'connect-modal-fixture-boot',
          sha: '1111111111111111111111111111111111111111',
        },
      }),
    );
    // The controlling Station is already paired. Receiver fixtures below
    // override only their own origin and issue grants through the pairing owner.
    await page.route('**/.well-known/station/v1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          environmentId: 'env-connect-modal-suite',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: {
            serverVersion: '0.0.0-test',
            protocolVersion: 1,
            minClientProtocol: 1,
            capabilities: {
              remoteAuth: 1,
              devicePairing: 1,
              environmentProof: 1,
            },
          },
        }),
      }),
    );
    await page.goto('/');
    // Wait for the connection chip to appear in the header
    await expect(page.getByTestId('app-toolbar-connection')).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByTestId('app-toolbar-connection'),
    ).toHaveAccessibleName(/Dev Server/);
    await expect(
      page.getByRole('status').filter({
        hasText: 'Loading connection recovery…',
      }),
    ).toHaveCount(0, { timeout: 10_000 });
    await dismissSetupLauncher(page);
  });

  test('the chip chooser opens the connection manager', async ({ page }) => {
    await openStationManager(page);
    await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();
    // The existing connection should appear in the modal list. A row's name
    // renders in two nested elements (`.station-connect-row__name-line` and
    // its child `.station-connect-row__name`, station#994), so `div`
    // `hasText` matches both and is a strict-mode violation — the row's own
    // details control is a stable, unique handle instead.
    await expect(
      page.getByRole('dialog').getByRole('button', {
        name: 'View details for Dev Server',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('traps keyboard focus, closes with Escape, and restores its trigger', async ({
    page,
  }) => {
    const trigger = page.getByTestId('app-toolbar-connection');
    await trigger.focus();
    await openStationManager(page);
    const dialog = page.getByRole('dialog');
    const close = dialog.getByRole('button', { name: 'Close Station manager' });
    await expect(close).toBeFocused();
    expect(
      await page
        .locator('.app')
        .evaluate((root) => (root as HTMLElement).inert),
    ).toBe(true);

    await page.keyboard.press('Shift+Tab');
    await expect(
      dialog.getByRole('button', {
        name: 'Paired devices',
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(
      await page
        .locator('.app')
        .evaluate((root) => (root as HTMLElement).inert),
    ).toBe(false);
  });

  test('can approve a new Device connection and select it explicitly', async ({
    page,
  }) => {
    const origin = 'http://10.0.0.5:3141';
    const receiver = await receiverFixture(page, origin, true);
    const dialog = await identifyReceiver(page, origin);
    await expect(
      dialog.getByRole('button', { name: 'Checking Station…', exact: true }),
    ).toBeVisible();
    expect(receiver.pairing.listRequests()).toHaveLength(0);
    receiver.releaseDiscovery();
    const manager = await approveReceiverDevice(
      page,
      origin,
      'Office',
      receiver,
    );
    await manager
      .getByRole('button', { name: 'View details for Office', exact: true })
      .click();
    await manager
      .getByRole('button', { name: 'Switch to Office', exact: true })
      .click();
    await expect(
      manager.locator('.station-connect-row').filter({ hasText: 'Office' }),
    ).toContainText('Current ·');
    await manager
      .getByRole('button', { name: 'Close Station manager', exact: true })
      .click();
    await expect(
      page.getByTestId('app-toolbar-connection'),
    ).toHaveAccessibleName(/Office/);
  });

  test('keeps Connect Station fields at the iOS focus-zoom floor', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openStationManager(page);
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('button', { name: 'Connect a Station', exact: true })
      .click();
    const address = dialog.getByRole('textbox', {
      name: 'Station address',
      exact: true,
    });
    await expect(address).toBeVisible();
    expect(
      await address.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveAttribute('content', /initial-scale=1/);
    await expect(viewport).not.toHaveAttribute(
      'content',
      /(?:user-scalable=no|maximum-scale=1)/,
    );
    const before = await page.evaluate(() => ({
      scale: window.visualViewport?.scale ?? 1,
      width: window.visualViewport?.width ?? window.innerWidth,
    }));
    await address.focus();
    await dialog
      .getByRole('button', { name: 'Pairing code', exact: true })
      .click();
    for (const field of [
      dialog.getByRole('textbox', {
        name: 'Station address for a short code',
        exact: true,
      }),
      dialog.getByRole('textbox', { name: 'Pairing code', exact: true }),
    ]) {
      await expect(field).toBeVisible();
      expect(
        await field.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        ),
      ).toBeGreaterThanOrEqual(16);
      await field.focus();
    }
    const after = await page.evaluate(() => ({
      scale: window.visualViewport?.scale ?? 1,
      width: window.visualViewport?.width ?? window.innerWidth,
    }));
    expect(after.scale).toBeCloseTo(1, 5);
    expect(after.width).toBeCloseTo(before.width, 1);
  });

  test('keeps one Station chooser on the page and one manager action in fullscreen chat at 390px (#1048)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // Default mobile state: the ambient chat dock is present but collapsed,
    // NOT full-screen (`chat-dock is-collapsed`, not
    // `app__main--mobile-dock-fullscreen`) — this is the state every phone
    // user lands in on a fresh load, not an edge case. Before #1048 the app
    // toolbar's `app-toolbar-connection` and the dock header's
    // `chat-dock-mobile-connection` both rendered here and both matched.
    await expect(page.getByTestId('app-toolbar-connection')).toHaveCount(1);

    // Fullscreen keeps message context primary. Station management moves into
    // the mobile chat actions sheet, where exactly one control remains reachable.
    await page.goto('/?dock=open&maximize=true');
    await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
    await page
      .getByTestId('chat-dock-mobile-header')
      .getByRole('button', { name: 'Chat actions', exact: true })
      .click();
    const survivor = page.getByRole('button', { name: /^Manage Stations/ });
    await expect(survivor).toHaveCount(1);
    await expect(survivor).toHaveAttribute(
      'data-testid',
      'chat-dock-mobile-connection',
    );
  });

  test('can switch between approved Device connections', async ({ page }) => {
    const origin = 'http://10.0.0.6:3141';
    const receiver = await receiverFixture(page, origin);
    await identifyReceiver(page, origin);
    const dialog = await approveReceiverDevice(
      page,
      origin,
      'Remote',
      receiver,
    );
    await dialog
      .getByRole('button', { name: 'View details for Remote', exact: true })
      .click();
    await dialog
      .getByRole('button', { name: 'Switch to Remote', exact: true })
      .click();
    await expect(
      dialog.locator('.station-connect-row').filter({ hasText: 'Remote' }),
    ).toContainText('Current ·');
    await dialog
      .getByRole('button', { name: 'Close Station manager', exact: true })
      .click();
    await expect(
      page.getByTestId('app-toolbar-connection'),
    ).toHaveAccessibleName(/Remote/);
    await openStationManager(page);
    const manager = page.getByRole('dialog');
    await manager
      .getByRole('button', { name: 'View details for Dev Server', exact: true })
      .click();
    await manager
      .getByRole('button', { name: 'Switch to Dev Server', exact: true })
      .click();
    await manager
      .getByRole('button', { name: 'Close Station manager', exact: true })
      .click();
    await expect(
      page.getByTestId('app-toolbar-connection'),
    ).toHaveAccessibleName(/Dev Server/);
  });

  test('can edit a connection', async ({ page }) => {
    await openStationManager(page);
    await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();
    const dialog = page.getByRole('dialog');

    // Inspecting the saved row exposes its explicit Edit action.
    await openConnectionEditor(dialog, 'Dev Server');

    // Edit form should appear with pre-filled values
    const nameInput = dialog.getByRole('textbox', {
      name: 'Station name',
      exact: true,
    });
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('Dev Server');

    // Change the name
    await nameInput.fill('Home Lab');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // Updated name should appear. The row's details control is a
    // stable handle — a bare `div` `hasText` match is ambiguous (station#994
    // nests the name in two elements) and one DOM change from breaking.
    await expect(
      dialog.getByRole('button', {
        name: 'View details for Home Lab',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('mobile saved addresses wrap, copy in full, and remain editable', async ({
    page,
  }, testInfo) => {
    const address =
      'https://desktop-win.with-a-long-personal-tailnet-name.example.test:8444';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            document.documentElement.dataset.copiedAddress = value;
          },
        },
      });
    });
    const receiver = await receiverFixture(page, address);
    await identifyReceiver(page, address);
    const dialog = await approveReceiverDevice(
      page,
      address,
      'Desktop proof',
      receiver,
    );
    const url = dialog.getByText(address, { exact: true });
    await expect(url).toBeVisible();
    expect(
      await url.evaluate((element) => ({
        fits: element.scrollWidth <= element.clientWidth + 1,
        whiteSpace: getComputedStyle(element).whiteSpace,
      })),
    ).toEqual({ fits: true, whiteSpace: 'normal' });
    await (await openConnectionActionsMenu(dialog, 'Desktop proof'))
      .getByRole('menuitem', { name: 'Copy address', exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-copied-address',
      address,
    );
    await openConnectionEditor(dialog, 'Desktop proof');
    await expect(
      dialog.getByRole('textbox', { name: 'Station address', exact: true }),
    ).toHaveValue(address);
    await dialog
      .getByRole('textbox', { name: 'Station name', exact: true })
      .fill('Renamed desktop');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      dialog.getByRole('button', {
        name: 'View details for Renamed desktop',
        exact: true,
      }),
    ).toBeVisible();
    await expect(url).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('full-station-address.png'),
    });
  });

  test('can remove a connection', async ({ page }) => {
    const origin = 'https://delete-me.example.test';
    const receiver = await receiverFixture(page, origin);
    await identifyReceiver(page, origin);
    await approveReceiverDevice(page, origin, 'ToDelete', receiver);

    // Modal is still open. Forget lives behind the row's "More actions"
    // overflow menu (ConnectionListPanel.tsx station#4512 review M6), and
    // forgetting is destructive so it arms a second, explicit Confirm step
    // rather than removing on the first click.
    const dialog = page.getByRole('dialog');
    await (await openConnectionActionsMenu(dialog, 'ToDelete'))
      .getByRole('menuitem', { name: 'Forget Station', exact: true })
      .click();
    await dialog
      .getByRole('button', { name: 'Confirm forgetting ToDelete', exact: true })
      .click();

    await expect(page.getByText('ToDelete')).not.toBeVisible();
  });

  test('modal closes when clicking the backdrop', async ({ page }) => {
    await openStationManager(page);
    await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();

    // Click the dark overlay (outside the modal card)
    await page.mouse.click(10, 10);
    await expect(
      page.getByRole('heading', { name: 'Stations' }),
    ).not.toBeVisible();
  });

  test('does not expose empty discovery when no candidate provider is registered', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 520 });
    await page.getByRole('button', { name: 'More actions' }).click();
    await page
      .getByRole('button', { name: 'Connections', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();

    await expect(
      page.getByRole('button', { name: 'Enter a pairing code' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Other Stations' }),
    ).toHaveCount(0);
  });

  /**
   * The device list is mostly a phone surface, so it is exercised at a phone
   * viewport with a device name long enough to crowd the row.
   *
   * The assertions are behavioural, not geometric. Bounding-box checks were
   * tried first and dropped: the panel stayed inside the viewport under every
   * injected layout fault (no wrap, no flex shrink, a 32px control), so those
   * assertions passed unconditionally and would have been decoration rather
   * than evidence.
   */
  test('paired devices panel opens and revokes from a phone viewport', async ({
    page,
  }) => {
    await page.route('**/api/pairing/devices', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          devices: [
            {
              id: 'device-phone',
              // Long enough to crowd the row and force the wrap this asserts.
              name: 'Pixel 9 Pro XL · Chrome Canary',
              scope: 'station:interactive',
              createdAt: Date.now() - 86_400_000,
              lastUsedAt: Date.now() - 30_000,
              revokedAt: null,
            },
          ],
        }),
      }),
    );
    await page.setViewportSize({ width: 390, height: 640 });
    await page.getByRole('button', { name: 'More actions' }).click();
    await page
      .getByRole('button', { name: 'Connections', exact: true })
      .click();
    await page.getByRole('button', { name: 'Paired devices' }).click();

    await expect(
      page.getByRole('heading', { name: 'Paired Devices' }),
    ).toBeVisible();
    await expect(
      page.getByText('Pixel 9 Pro XL · Chrome Canary'),
    ).toBeVisible();
    await expect(page.getByText('Active recently')).toBeVisible();

    // Revoking is destructive, so it takes a deliberate second step.
    const revoke = page.getByRole('button', { name: /^Revoke / });
    await revoke.click();
    await expect(
      page.getByRole('button', { name: 'Confirm', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(revoke).toBeVisible();
  });

  test('the manager reflects current healthy status and offers a reachability check', async ({
    page,
  }) => {
    await openStationManager(page);
    // Current status comes from the host; the explicit check remains usable.
    await (
      await openConnectionActionsMenu(page.getByRole('dialog'), 'Dev Server')
    )
      .getByRole('menuitem', { name: 'Check reachability', exact: true })
      .click();

    const dot = page
      .locator('.station-connect-row')
      .filter({ hasText: 'Dev Server' })
      .getByRole('img', { name: 'connected', exact: true });
    await expect(dot).toBeVisible();
    await expect(dot).toHaveCSS('background-color', 'rgb(34, 197, 94)');
  });

  test('cleared connection storage falls back to the current app connection', async ({
    page,
  }) => {
    // Clear all connections
    await page.evaluate(() => {
      localStorage.removeItem('station-connect-connections');
      localStorage.removeItem('station-connect-connections-active');
    });
    await page.addInitScript(() => {
      localStorage.removeItem('station-connect-connections');
      localStorage.removeItem('station-connect-connections-active');
    });
    await page.reload();
    await expect(page.locator('body')).toBeVisible({ timeout: 15_000 });
    await dismissSetupLauncher(page);
    await expect(
      page.getByRole('status').filter({
        hasText: 'Loading connection recovery…',
      }),
    ).toHaveCount(0, { timeout: 10_000 });

    await openStationManager(page);
    await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();
    // archive#198: the correct same-origin default is the page's OWN origin (the UI
    // port Playwright actually navigated to via baseURL/PW_BASE_URL), not
    // the server port — the old assertion here
    // (`http://localhost:${STATION_PORT}`) pinned the pre-archive#198 bug where the
    // UI server unconditionally injected the server's own localhost URL
    // regardless of the page's real origin.
    const pageOrigin = new URL(page.url()).origin;
    await expect(page.getByText(pageOrigin)).toBeVisible();
  });
});
