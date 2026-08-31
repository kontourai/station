import { createHmac } from 'node:crypto';
import { buildStationProofMessage } from '@kontourai/station-contracts';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

const ENVIRONMENT_ID = 'env-e2e-stable-301';
const CREDENTIAL = Buffer.alloc(32, 7).toString('base64url');
const FIRST_ENDPOINT = 'https://station-one.example.test';
const SECOND_ENDPOINT = 'https://station-two.example.test';

const STATUS_READY = {
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [],
    detected: { ollama: false, bedrock: false },
  },
};

async function removeSetupLauncher(page: Page) {
  await page.evaluate(() => {
    document.querySelector('[data-testid="setup-launcher"]')?.remove();
  });
}

/**
 * Per-connection actions (Edit/Check/Forget) live behind a "More actions"
 * overflow menu, not as standalone title-attributed buttons
 * (`ConnectionListPanel.tsx` station#4512 review M6). Open it and return the
 * menu scoped to this connection so its menuitems can be clicked.
 */
async function openConnectionActionsMenu(scope: Locator, name: string) {
  await scope
    .getByRole('button', { name: `More actions for ${name}`, exact: true })
    .click();
  return scope.getByRole('menu', { name: `Actions for ${name}` });
}

async function openConnections(page: Page, phone: boolean) {
  void phone;
  const dialog = page.getByRole('dialog');
  const accessRequired = page.getByRole('region', {
    name: 'Station access required',
  });
  const requestAccess = accessRequired.getByRole('button', {
    name: 'Enter a host address',
    exact: true,
  });
  const addressInput = dialog.getByPlaceholder(
    'https://station.example.ts.net',
  );
  const managerControl = dialog.getByRole('button', {
    name: /^(?:Request access|Add a Station address|Scan a QR code|Enter a pairing code|Paired devices)$/,
  });
  const addComputer = page.getByRole('button', {
    name: 'Add computer',
    exact: true,
  });
  const controlThisStation = page.getByRole('button', {
    name: /Control this Station from another device/,
  });
  // `/connections` is a resolver, not a page: it redirects to whichever
  // section needs attention, else Models (`views/ConnectionsHub.tsx:14-21`).
  // `Add computer` is the Computers section's own add action
  // (`views/connections-hub/connection-sections.ts:38-45`), so go there.
  await page.goto('/connections/computers');
  await expect
    .poll(
      async () =>
        (await managerControl.first().isVisible()) ||
        (await requestAccess.isVisible()) ||
        (await addComputer.isVisible()) ||
        (await controlThisStation.isVisible()),
      { timeout: 15_000 },
    )
    .toBe(true);
  if (!(await managerControl.first().isVisible())) {
    if (await requestAccess.isVisible()) {
      await requestAccess.click();
      return dialog;
    } else {
      if (!(await controlThisStation.isVisible())) await addComputer.click();
      await controlThisStation.click();
    }
  }
  if (await addressInput.isVisible()) return dialog;
  const backToConnections = dialog.getByRole('button', {
    name: 'Back',
    exact: true,
  });
  for (let depth = 0; depth < 2; depth += 1) {
    if (await managerControl.first().isVisible()) break;
    await expect(backToConnections).toBeVisible();
    await backToConnections.click();
  }
  await expect(managerControl.first()).toBeVisible({ timeout: 15_000 });
  return dialog;
}

async function openAddStationAddress(dialog: Locator) {
  const action = dialog.getByRole('button', {
    name: 'Add a Station address',
    exact: true,
  });
  if (await action.isVisible()) await action.click();
  await expect(
    dialog.getByPlaceholder('https://station.example.ts.net'),
  ).toBeVisible();
}

for (const fixture of [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
] as const) {
  test(`${fixture.name}: clean remote browser reaches pairing recovery before protected bootstrap`, async ({
    page,
  }) => {
    await page.setViewportSize(fixture.viewport);
    await page.addInitScript((endpoint) => {
      localStorage.clear();
      sessionStorage.clear();
      // Past first run: the launcher is modal and its backdrop swallows clicks.
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
      (window as Window & { __API_BASE__?: string }).__API_BASE__ = endpoint;
    }, FIRST_ENDPOINT);

    const consoleMessages: string[] = [];
    const statusAuthorizations: Array<string | null> = [];
    const pluginAuthorizations: Array<string | null> = [];
    const authAuthorizations: Array<string | null> = [];
    page.on('console', (message) => consoleMessages.push(message.text()));
    await page.route('https://station-*.example.test/**', (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const authorization = request.headers().authorization ?? null;
      const authorized = authorization === `Bearer ${CREDENTIAL}`;
      if (pathname === '/.well-known/station/v1') {
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            schemaVersion: 1,
            environmentId: ENVIRONMENT_ID,
            authentication: { scheme: 'bearer', protocolVersion: 1 },
            transports: { http: 1, sse: 1, websocket: 1 },
            compatibility: {
              serverVersion: '0.4.1',
              protocolVersion: 1,
              minClientProtocol: 1,
            },
          }),
        });
      }
      if (pathname === '/.well-known/station/v1/pairing/access-request') {
        expect(request.postData()).not.toContain(CREDENTIAL);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            requestId: 'request-clean-remote',
            offerId: 'offer-clean-remote',
            expiresAt: Date.now() + 60_000,
            environmentId: ENVIRONMENT_ID,
            proof: 'proof-clean-remote',
          }),
        });
      }
      if (pathname === '/.well-known/station/v1/pairing/exchange') {
        expect(request.postData()).not.toContain(CREDENTIAL);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {
            'set-cookie': `__Host-station-device=${CREDENTIAL}; Path=/; HttpOnly; Secure; SameSite=Strict`,
          },
          body: JSON.stringify({
            environmentId: ENVIRONMENT_ID,
            credential: CREDENTIAL,
            device: {
              id: 'device-clean-remote',
              name: 'This browser',
              scope: 'station:interactive',
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
              revokedAt: null,
            },
          }),
        });
      }
      if (pathname === '/api/system/status') {
        statusAuthorizations.push(authorization);
        return route.fulfill({
          status: authorized ? 200 : 401,
          contentType: 'application/json',
          body: JSON.stringify(
            authorized ? STATUS_READY : { error: 'authentication_required' },
          ),
        });
      }
      if (pathname === '/api/system/identity') {
        return route.fulfill({
          status: authorized ? 200 : 401,
          contentType: 'application/json',
          body: JSON.stringify(
            authorized
              ? {
                  environmentId: ENVIRONMENT_ID,
                  instanceId: 'remote-e2e-instance',
                  bootId: 'remote-e2e-boot',
                  sha: '1111111111111111111111111111111111111111',
                }
              : { error: 'authentication_required' },
          ),
        });
      }
      if (pathname === '/api/plugins') {
        pluginAuthorizations.push(authorization);
        return route.fulfill({
          status: authorized ? 200 : 401,
          contentType: 'application/json',
          body: JSON.stringify(
            authorized ? { plugins: [] } : { error: 'authentication_required' },
          ),
        });
      }
      if (pathname === '/api/auth/status') {
        authAuthorizations.push(authorization);
        return route.fulfill({
          status: authorized ? 200 : 401,
          contentType: 'application/json',
          body: JSON.stringify(
            authorized
              ? {
                  status: 'valid',
                  provider: 'fixture',
                  expiresAt: null,
                  user: null,
                }
              : { error: 'authentication_required' },
          ),
        });
      }
      return route.fulfill({
        status: authorized ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(
          authorized ? {} : { error: 'authentication_required' },
        ),
      });
    });
    await page.route('**/api/system/identity', (route) => {
      const request = route.request();
      const remote = new URL(request.url()).hostname.endsWith('.example.test');
      const authorized =
        request.headers().authorization === `Bearer ${CREDENTIAL}` ||
        request
          .headers()
          .cookie?.includes(`__Host-station-device=${CREDENTIAL}`) === true;
      return route.fulfill({
        status: !remote || authorized ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(
          !remote || authorized
            ? {
                environmentId: remote ? ENVIRONMENT_ID : 'env-local-ui',
                instanceId: remote
                  ? 'remote-e2e-instance'
                  : 'local-ui-instance',
                bootId: remote ? 'remote-e2e-boot' : 'local-ui-boot',
                sha: '1111111111111111111111111111111111111111',
              }
            : { error: 'authentication_required' },
        ),
      });
    });

    await page.goto('/');

    const pairingAction = page
      .getByRole('button', { name: 'Enter a host address' })
      .first();
    await expect(pairingAction).toBeVisible({ timeout: 15_000 });
    // The access gate must not probe protected routes before a credential is
    // established; pairing begins on the credential-free public surface.
    expect(statusAuthorizations).toEqual([]);
    expect(pluginAuthorizations).toEqual([]);
    const actionBox = await pairingAction.boundingBox();
    expect(actionBox?.x).toBeGreaterThanOrEqual(0);
    expect(actionBox && actionBox.x + actionBox.width).toBeLessThanOrEqual(
      fixture.viewport.width,
    );
    expect(actionBox && actionBox.y + actionBox.height).toBeLessThanOrEqual(
      fixture.viewport.height,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(fixture.viewport.width);
    await pairingAction.click();
    const connectionDialog = page.getByRole('dialog');
    await openAddStationAddress(connectionDialog);
    await connectionDialog
      .getByPlaceholder('Name (optional)')
      .fill('Clean remote');
    await connectionDialog
      .getByPlaceholder('https://station.example.ts.net')
      .fill(FIRST_ENDPOINT);
    await connectionDialog
      .getByRole('button', { name: 'Add', exact: true })
      .click();
    await connectionDialog
      .getByRole('button', { name: 'Request access', exact: true })
      .click();
    await expect(connectionDialog).toHaveCount(0);
    await expect
      .poll(() => statusAuthorizations.includes(`Bearer ${CREDENTIAL}`))
      .toBe(true);
    expect(
      authAuthorizations.every((value) => value === `Bearer ${CREDENTIAL}`),
    ).toBe(true);
    // Remote plugin bundles are intentionally not loaded into this host
    // webview: their code would execute beside native bridge credentials.
    // Authentication still applies to remote API calls such as status/auth.
    expect(pluginAuthorizations).toEqual([]);
    await expect(
      page.getByRole('button', { name: 'Request access to Clean remote' }),
    ).toHaveCount(0);
    expect(page.url()).not.toContain(CREDENTIAL);
    await expect(page.locator('body')).not.toContainText(CREDENTIAL);
    expect(consoleMessages.join('\n')).not.toContain(CREDENTIAL);
    const persistedProfiles = await page.evaluate(() =>
      localStorage.getItem('station-connect-connections'),
    );
    expect(persistedProfiles).not.toContain(CREDENTIAL);
  });

  test(`${fixture.name}: remote recovery remains authenticated and bound to stable identity`, async ({
    page,
  }) => {
    await page.setViewportSize(fixture.viewport);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('station-e2e-storage-initialized')) return;
      localStorage.clear();
      // Past first run: the launcher is modal and its backdrop swallows clicks.
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
      sessionStorage.setItem('station-e2e-storage-initialized', 'true');
    });

    const consoleMessages: string[] = [];
    const remoteStatusAuthorizations: Array<string | null> = [];
    const pluginAuthorizations: Array<string | null> = [];
    const remotePluginBundleRequests: string[] = [];
    const codingRepoAuthorizations: Array<string | null> = [];
    const unexpectedApi401s: string[] = [];
    let assertNoApi401 = false;
    page.on('console', (message) => consoleMessages.push(message.text()));
    page.on('response', (response) => {
      if (
        assertNoApi401 &&
        response.status() === 401 &&
        new URL(response.url()).pathname.startsWith('/api/')
      ) {
        unexpectedApi401s.push(response.url());
      }
    });

    await page.route('https://station-*.example.test/**', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fixture route not found' }),
      }),
    );
    await page.route('**/.well-known/station/v1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          environmentId: ENVIRONMENT_ID,
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: {
            serverVersion: '0.4.1',
            protocolVersion: 1,
            minClientProtocol: 1,
          },
        }),
      }),
    );
    await page.route('**/.well-known/station/v1/proof', (route) => {
      expect(route.request().headers().authorization).toBeUndefined();
      expect(route.request().url()).not.toContain(CREDENTIAL);
      expect(route.request().postData()).not.toContain(CREDENTIAL);
      const body = route.request().postDataJSON() as {
        nonce: string;
        protocolVersion: 1;
      };
      const signature = createHmac(
        'sha256',
        Buffer.from(CREDENTIAL, 'base64url'),
      )
        .update(buildStationProofMessage(ENVIRONMENT_ID, body.nonce))
        .digest('base64url');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          protocolVersion: 1,
          environmentId: ENVIRONMENT_ID,
          nonce: body.nonce,
          signature,
        }),
      });
    });
    await page.route('**/api/system/status', (route) => {
      const request = route.request();
      const isRemote = new URL(request.url()).hostname.endsWith(
        '.example.test',
      );
      if (isRemote) {
        const authorization = request.headers().authorization ?? null;
        remoteStatusAuthorizations.push(authorization);
        if (authorization !== `Bearer ${CREDENTIAL}`) {
          return route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'authentication_required' }),
          });
        }
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_READY),
      });
    });
    await page.route('**/api/system/identity', (route) => {
      const remote = new URL(route.request().url()).hostname.endsWith(
        '.example.test',
      );
      const authorization = route.request().headers().authorization ?? null;
      return route.fulfill({
        status: !remote || authorization === `Bearer ${CREDENTIAL}` ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(
          !remote || authorization === `Bearer ${CREDENTIAL}`
            ? {
                environmentId: remote ? ENVIRONMENT_ID : 'env-local-ui',
                instanceId: remote
                  ? 'remote-e2e-instance'
                  : 'local-ui-instance',
                bootId: remote ? 'remote-e2e-boot' : 'local-ui-boot',
                sha: '1111111111111111111111111111111111111111',
              }
            : { error: 'authentication_required' },
        ),
      });
    });
    await page.route('**/api/plugins', (route) => {
      const isRemote = new URL(route.request().url()).hostname.endsWith(
        '.example.test',
      );
      const authorization = route.request().headers().authorization ?? null;
      if (isRemote) pluginAuthorizations.push(authorization);
      const authorized = !isRemote || authorization === `Bearer ${CREDENTIAL}`;
      return route.fulfill({
        status: authorized ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(
          authorized ? { plugins: [] } : { error: 'authentication_required' },
        ),
      });
    });
    // A remote plugin's CODE is the thing that must never reach this webview.
    // Registered after the list route above, so it wins for bundle URLs only.
    await page.route('**/api/plugins/**', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname.endsWith('.example.test'))
        remotePluginBundleRequests.push(url.pathname);
      return route.fulfill({ status: 404, body: '' });
    });
    await page.route('**/api/coding/repos**', (route) => {
      const authorization = route.request().headers().authorization ?? null;
      codingRepoAuthorizations.push(authorization);
      return route.fulfill({
        status: authorization === `Bearer ${CREDENTIAL}` ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(
          authorization === `Bearer ${CREDENTIAL}`
            ? {
                success: true,
                data: {
                  workspace: '/fixture-workspace',
                  workspaceIsRepo: true,
                  repos: [],
                },
              }
            : { error: 'authentication_required' },
        ),
      });
    });

    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    await removeSetupLauncher(page);
    const connectionsCard = await openConnections(
      page,
      fixture.name === 'phone',
    );
    await openAddStationAddress(connectionsCard);
    // Scoped to the dialog, the way the sibling test above already does it.
    // "Add Station" is the MODAL's own `<h2>` title
    // (`ConnectionManagerModalContent.tsx:822-826`), so walking two parents up
    // from it lands on the modal header — which does not contain the form.
    await connectionsCard
      .getByPlaceholder('Name (optional)')
      .fill('Phone Station');
    await connectionsCard
      .getByPlaceholder('https://station.example.ts.net')
      .fill(FIRST_ENDPOINT);
    await connectionsCard
      .getByRole('button', { name: 'Add', exact: true })
      .click();

    // The add flow now continues straight into authorising the new host
    // (archive#986) instead of returning to the list. This test exercises the
    // manual credential-recovery path (via Edit), so back out of the
    // pairing panel first without completing the exchange.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Back' })
      .click();

    // archive#4512 (M4): the health probe against this freshly-added,
    // not-yet-credentialed connection gets a real 401
    // (`{error:'authentication_required'}` above), which
    // `classifyHttpFailureResponse` reads as `authentication-failed` —
    // the same reason a REJECTED credential produces. The Stations sheet
    // card now names that reason distinctly ("Credential required" was the
    // generic bucket for a connection that has never had a lastError at
    // all; this one has one), restoring the archive#3903 insight ("the address is
    // fine, this device isn't authorised there") the sheet used to carry
    // and this spec used to assert away.
    await expect(
      page.getByText("This device isn't authorised on this Station", {
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(() => remoteStatusAuthorizations.some((value) => value === null))
      .toBe(true);

    await (
      await openConnectionActionsMenu(connectionsCard, 'Phone Station')
    )
      .getByRole('menuitem', { name: 'Edit Station', exact: true })
      .click();
    const credentialInput = connectionsCard.getByLabel(
      'Station access credential',
    );
    await expect(credentialInput).toHaveAttribute('type', 'password');
    await credentialInput.fill(CREDENTIAL);
    const connectionSave = connectionsCard.getByRole('button', {
      name: 'Save',
      exact: true,
    });
    await expect(connectionSave).toBeEnabled();
    await connectionSave.click();
    await expect(
      page.getByText('Credential required', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("This device isn't authorised on this Station", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (credential) =>
            sessionStorage
              .getItem('station-connect-connections-credentials')
              ?.includes(credential) ?? false,
          CREDENTIAL,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            localStorage.getItem('station-connect-connections-credentials') ===
            null,
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => {
        await (
          await openConnectionActionsMenu(connectionsCard, 'Phone Station')
        )
          .getByRole('menuitem', { name: 'Check reachability', exact: true })
          .click();
        return remoteStatusAuthorizations.includes(`Bearer ${CREDENTIAL}`);
      })
      .toBe(true);
    assertNoApi401 = true;
    const codingReposStatus = await page.evaluate(async (endpoint) => {
      // The SDK barrel is published by the on-demand half of the shared-module
      // bridge (archive#883), and this Station has no plugins installed, so
      // nothing else would ever trigger that load. Awaiting the readiness
      // handle IS the contract for a page-level caller.
      await (window as any).__station_ai_shared_ready();
      const shared = (window as any).__station_ai_shared;
      const response = await shared[
        '@kontourai/station-sdk'
      ].authenticatedFetch(
        `${endpoint}/api/coding/repos?path=${encodeURIComponent('/fixture-workspace')}`,
      );
      return response.status;
    }, FIRST_ENDPOINT);
    expect(codingReposStatus).toBe(200);
    expect(codingRepoAuthorizations).toContain(`Bearer ${CREDENTIAL}`);
    // Once the remote Station is the active connection the registry DOES read
    // its plugin inventory — in isolated mode, which is the whole point:
    // `core/PluginRegistry.ts:179-197` takes the `remoteBrowserIsolation`
    // branch in a browser, skips the early return, and registers each plugin
    // through `registerIsolatedPlugin` instead of injecting its bundle. So the
    // claim this journey can make is not "no inventory read" (the two tests
    // above own that, for the pre-credential access gate) but the guarantee the
    // comment there actually names: no remote plugin CODE is fetched into this
    // webview, and no inventory read carries a credential other than this
    // host's own.
    expect(remotePluginBundleRequests).toEqual([]);
    expect(
      pluginAuthorizations.filter(
        (value) => value !== null && value !== `Bearer ${CREDENTIAL}`,
      ),
    ).toEqual([]);

    await (
      await openConnectionActionsMenu(connectionsCard, 'Phone Station')
    )
      .getByRole('menuitem', { name: 'Edit Station', exact: true })
      .click();
    await connectionsCard.getByPlaceholder(/192\.168/).fill(SECOND_ENDPOINT);
    await connectionsCard
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await (
      await openConnectionActionsMenu(connectionsCard, 'Phone Station')
    )
      .getByRole('menuitem', { name: 'Check reachability', exact: true })
      .click();
    await connectionsCard
      .getByRole('button', { name: 'Verify and use endpoint' })
      .click();

    await expect
      .poll(() =>
        page.evaluate(
          ({ environmentId, endpoint }) => {
            const profiles = JSON.parse(
              localStorage.getItem('station-connect-connections') ?? '[]',
            ) as Array<{
              environmentId?: string;
              url?: string;
            }>;
            return (
              profiles.filter(
                (profile) => profile.environmentId === environmentId,
              ).length === 1 &&
              profiles.some((profile) => profile.url === endpoint)
            );
          },
          { environmentId: ENVIRONMENT_ID, endpoint: SECOND_ENDPOINT },
        ),
      )
      .toBe(true);

    const activeBeforeReload = await page.evaluate(() => {
      const activeId = localStorage.getItem(
        'station-connect-connections-active',
      );
      const profiles = JSON.parse(
        localStorage.getItem('station-connect-connections') ?? '[]',
      ) as Array<{ id: string; name: string }>;
      return profiles.find((profile) => profile.id === activeId)?.name;
    });
    expect(activeBeforeReload).toBe('Phone Station');

    await page.reload();
    const activeAfterReload = await page.evaluate(() => {
      const activeId = localStorage.getItem(
        'station-connect-connections-active',
      );
      const profiles = JSON.parse(
        localStorage.getItem('station-connect-connections') ?? '[]',
      ) as Array<{ id: string; name: string }>;
      return {
        activeId,
        names: profiles.map((profile) => `${profile.id}:${profile.name}`),
        activeName: profiles.find((profile) => profile.id === activeId)?.name,
      };
    });
    expect(activeAfterReload.activeName).toBe('Phone Station');
    await removeSetupLauncher(page);
    await openConnections(page, fixture.name === 'phone');
    await expect(
      connectionsCard.getByText('Phone Station', { exact: true }),
    ).toBeVisible();
    expect(page.url()).not.toContain(CREDENTIAL);
    await expect(page.locator('body')).not.toContainText(CREDENTIAL);
    expect(consoleMessages.join('\n')).not.toContain(CREDENTIAL);
    expect(unexpectedApi401s).toEqual([]);

    const serializedProfiles = await page.evaluate(() =>
      localStorage.getItem('station-connect-connections'),
    );
    expect(serializedProfiles).not.toContain(CREDENTIAL);

    if (fixture.name === 'phone') {
      // The per-row "More actions" trigger is the direct tap target; Edit /
      // Check reachability / Forget now live as menuitems inside the menu it
      // opens (ConnectionListPanel.tsx station#4512 review M6), so both the
      // trigger and the opened menu's items must clear the minimum.
      const triggers = page.locator('[aria-label^="More actions for "]');
      for (let index = 0; index < (await triggers.count()); index += 1) {
        const box = await triggers.nth(index).boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(box?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }
      const actionsMenu = await openConnectionActionsMenu(
        connectionsCard,
        'Phone Station',
      );
      const menuItems = actionsMenu.getByRole('menuitem');
      for (let index = 0; index < (await menuItems.count()); index += 1) {
        const box = await menuItems.nth(index).boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(box?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }
      await page.keyboard.press('Escape');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });
}

test('local same-origin startup requires an explicit credential', async ({
  baseURL,
  browser,
}) => {
  if (!baseURL) throw new Error('Product suite requires a UI base URL');
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    await context.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
      // Past first run: the launcher is modal and its backdrop swallows clicks.
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
    });
    const page = await context.newPage();
    const protectedBootstrapRequests: string[] = [];
    const protectedBootstrapPaths = new Set([
      '/api/auth/status',
      '/api/plugins',
      '/api/system/status',
      '/config/app',
    ]);
    const identityRequests: Array<{
      authorization: string | null;
      cookie: string | null;
    }> = [];
    const identityStatuses: number[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (protectedBootstrapPaths.has(pathname)) {
        protectedBootstrapRequests.push(pathname);
      }
      if (pathname === '/api/system/identity') {
        identityRequests.push({
          authorization: request.headers().authorization ?? null,
          cookie: request.headers().cookie ?? null,
        });
      }
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/system/identity') {
        identityStatuses.push(response.status());
      }
    });

    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Connect to your Station host' }),
    ).toBeVisible();
    expect(await context.cookies()).toEqual([]);
    expect(identityRequests).toEqual([{ authorization: null, cookie: null }]);
    expect(identityStatuses).toEqual([401]);
    expect(protectedBootstrapRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
