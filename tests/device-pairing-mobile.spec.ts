import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

const CONNECTION_ENTRY_TIMEOUT_MS = 15_000;

async function openConnections(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog');
  const setupLauncher = page.getByTestId('setup-launcher');
  // By test id, not by name: ChatDockMobileConnection derives its accessible
  // name from the same connectionIndicatorLabel, so on a phone both it and the
  // toolbar chip start with "Manage Stations" (archive#3297 + archive#3311).
  const directConnections = page.getByTestId('app-toolbar-connection');
  const moreActions = page.getByRole('button', { name: 'More actions' });
  const addComputer = page.getByRole('button', {
    name: 'Add computer',
    exact: true,
  });
  const controlThisStation = page.getByRole('button', {
    name: /Control this Station from another device/,
  });
  const managerControl = dialog.getByRole('button', {
    name: /^(?:Request access|Add a Station address|Scan a QR code|Enter a pairing code|Paired devices)$/,
  });

  // A fresh container can have its HTTP endpoint ready before the lazy UI
  // shell has rendered its first actionable control. Wait for a concrete path
  // into Connections instead of choosing a fallback from an instantaneous
  // visibility snapshot, which otherwise leaves Playwright's broad action
  // timeout to hide the actual missing UI state.
  await expect
    .poll(
      async () =>
        (await dialog.isVisible()) ||
        (await setupLauncher.isVisible()) ||
        (await directConnections.isVisible()) ||
        (await moreActions.isVisible()),
      { timeout: CONNECTION_ENTRY_TIMEOUT_MS },
    )
    .toBe(true);

  if ((await dialog.isVisible()) && (await managerControl.first().isVisible()))
    return dialog;
  if (await setupLauncher.isVisible()) {
    await setupLauncher
      .getByRole('button', { name: 'View All Connections' })
      .click();
    await page.waitForURL(/\/connections(?:\?|$)/);
  } else if (await directConnections.isVisible()) {
    await directConnections.click();
  } else {
    await moreActions.click();
    const menu = page.locator('.app-toolbar__overflow-menu');
    await expect(menu).toBeVisible();
    await menu
      .getByRole('button', { name: 'Connections', exact: true })
      .click();
  }

  // Connection entry points can either open the legacy manager or navigate to
  // the Connections hub. The hub's "Open Connections" empty-state action is
  // intentionally not a manager trigger; pairing now begins at Add computer.
  // Do not admit that notice as readiness: it can appear behind a still-loading
  // manager and send this helper into the wrong Add computer branch.
  // Converge through the goal chooser and require a manager-specific control
  // so the chooser dialog cannot be mistaken for the destination.
  await expect
    .poll(
      async () =>
        (await managerControl.first().isVisible()) ||
        (await addComputer.isVisible()) ||
        (await controlThisStation.isVisible()),
      { timeout: CONNECTION_ENTRY_TIMEOUT_MS },
    )
    .toBe(true);
  if (!(await managerControl.first().isVisible())) {
    if (!(await controlThisStation.isVisible())) await addComputer.click();
    await controlThisStation.click();
  }
  await expect(managerControl.first()).toBeVisible({
    timeout: CONNECTION_ENTRY_TIMEOUT_MS,
  });
  return dialog;
}

async function pairedApiStatus(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    fetch('/api/projects').then((response) => response.status),
  );
}

/**
 * The host context speaks for the operator, and since archive#1490 that means
 * it presents the operator credential: approving a pairing request with no
 * credential at all is refused when the REQUEST also arrived on the loopback
 * compatibility floor, which both contexts of a two-browser E2E do. A real
 * phone on the LAN is still approved with nothing presented (pinned by
 * `src-server/runtime/__tests__/device-pairing-routes.test.ts`); a second
 * browser on the host itself is indistinguishable from the SSH-forward
 * adversary and now needs what `station environment access approve` presents.
 *
 * `STATION_E2E_HOST_CREDENTIAL` is published by `scripts/run-e2e-suite.mjs`
 * from the started instance's own security record;
 * `STATION_CONTAINER_HOST_CREDENTIAL` is the container suite's equivalent.
 */
function hostCredential() {
  return (
    process.env.STATION_E2E_HOST_CREDENTIAL ||
    process.env.STATION_CONTAINER_HOST_CREDENTIAL
  );
}

function hostCredentialHeaders() {
  const credential = hostCredential();
  return credential ? { Authorization: `Bearer ${credential}` } : undefined;
}

async function seedBrowserConnection(
  context: BrowserContext,
  input: {
    id: string;
    url: string;
    credentialState: 'required' | 'saved';
    credential?: string;
  },
) {
  await context.addInitScript((profile) => {
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        {
          id: profile.id,
          name: 'Default',
          url: profile.url,
          credentialState: profile.credentialState,
        },
      ]),
    );
    localStorage.setItem('station-connect-connections-active', profile.id);
    if (profile.credential) {
      sessionStorage.setItem(
        'station-connect-connections-credentials',
        JSON.stringify({ [`connection:${profile.id}`]: profile.credential }),
      );
    }
  }, input);
}

test('keeps direct pairing methods usable at 390px without an advanced detour', async ({
  browser,
  baseURL,
}) => {
  // The container smoke runs against a freshly started image on shared-host
  // storage. Keep its scenario bounded, but allow the same startup budget as
  // the longer pairing scenario below instead of the unit-sized default.
  test.setTimeout(60_000);
  // This test's premise is an ESTABLISHED browser: `LocalUiSessionGate`
  // keeps the whole shell unmounted for an anonymous one, which renders
  // GuidedConnect — a surface with none of the affordances `openConnections`
  // polls. The e2e runner supplies that premise through the suite storage
  // state (`STATION_E2E_RUNNER`); the container harness cannot (the browser
  // bootstrap mint is e2e-runner-only), so present the operator bearer and
  // seed the saved connection — the exact recipe the pairing scenario's host
  // context below already proves green in the container (#917).
  const operatorCredential = hostCredential();
  if (!operatorCredential) {
    throw new Error(
      'STATION_E2E_HOST_CREDENTIAL or STATION_CONTAINER_HOST_CREDENTIAL is required',
    );
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    extraHTTPHeaders: hostCredentialHeaders(),
  });
  if (!baseURL) throw new Error('Playwright baseURL is required');
  await seedBrowserConnection(context, {
    id: 'e2e-mobile-established',
    url: baseURL,
    credentialState: 'saved',
    credential: operatorCredential,
  });
  const page = await context.newPage();

  await page.goto(baseURL);
  const connections = await openConnections(page);
  await expect(
    connections.getByRole('button', {
      name: 'Advanced connection options',
      exact: true,
    }),
  ).toHaveCount(0);
  for (const name of [
    'Request access',
    'Add a Station address',
    'Scan a QR code',
    'Enter a pairing code',
  ]) {
    const method = connections.getByRole('button', { name, exact: true });
    await expect(method).toBeVisible();
    const box = await method.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await connections
    .getByRole('button', { name: 'Enter a pairing code', exact: true })
    .click();

  const deviceName = page.getByLabel('Device name');
  await expect(deviceName).toHaveValue(/^[^·]+ · (?:HeadlessChrome|Chrome)$/);
  await expect(page.getByRole('button', { name: 'Scan code' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(
    page.getByRole('button', { name: 'Enter manually' }),
  ).toHaveAttribute('aria-pressed', 'true');

  await deviceName.fill('Laptop browser');
  await page.setViewportSize({ width: 390, height: 520 });
  await expect(
    page.getByRole('button', { name: 'Enter manually' }),
  ).toBeVisible();
  const cancel = page.getByRole('button', { name: 'Back' });
  await cancel.scrollIntoViewIfNeeded();
  const cancelBox = await cancel.boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(520);
  await cancel.click();
  await expect(
    connections.getByRole('button', {
      name: 'Enter a pairing code',
      exact: true,
    }),
  ).toBeFocused();
  await context.close();
});

/**
 * The surfaces an UNPAIRED device actually has, and only those.
 *
 * A device with a saved Station and no access never reaches the shell: it
 * lands on the onboarding gate ("Connect to your Station host"), and its
 * request, its wait and the host's refusal are all reported by the request
 * panel that gate opens. The shell's own connection manager offers the same
 * journey per-row as "Request access to <name>"
 * (`connectionNeedsAccessRequest`) — but that row is for a device that HAS a
 * shell and lost access, which is a different scenario, so this one does not
 * pretend it might be there. That confusion is what archive#3753 was: the
 * phone context silently inherited the suite-wide device session, so it was
 * never unpaired, the shell rendered, and the leg waited for a per-row button
 * the product had no reason to offer.
 *
 * The shell's own wording for these same two states lives in
 * `src-ui/src/components/OnboardingGate.tsx` and
 * `src-ui/src/components/PendingPairingReconciler.tsx`; the panel's is in
 * `packages/connect/src/react/DevicePairingPanel.tsx`. Two components own one
 * fact — noted here so the next reader does not read this file's single
 * spelling as the only one.
 */
async function openPhoneAccessRequest(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Request access', exact: true })
    .click({ timeout: CONNECTION_ENTRY_TIMEOUT_MS });
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function expectPhoneAwaitingApproval(page: Page): Promise<void> {
  await expect(
    page.getByRole('dialog').getByText(/Waiting for approval on Default/),
  ).toBeVisible({ timeout: 10_000 });
}

async function expectPhoneDeclined(page: Page): Promise<void> {
  // The device polls with backoff (to 5s, 10s when rate limited), so this is
  // bounded well above one cycle rather than at the action default.
  await expect(
    page.getByRole('dialog').getByText(/declined this access request/),
  ).toBeVisible({ timeout: 20_000 });
}

/**
 * Asks again after a refusal. The panel keeps the device name and its own
 * "Request access", so the retry is the same submit — asserted present rather
 * than assumed, because a refusal that leaves no way to ask again is the
 * failure worth catching here.
 */
async function expectPhoneCanRequestAgain(page: Page): Promise<void> {
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Request access' }),
  ).toBeVisible();
}

test('pairs once, survives a phone browser restart, and revokes independently', async ({
  browser,
  baseURL,
}) => {
  // The phone must start with NO access, and that is not automatic here:
  // `playwright.config.ts` sets a suite-wide `use.storageState` carrying a
  // REAL issued Station device-session cookie, and Playwright applies context
  // options to `browser.newContext()` too. Inheriting it made this context a
  // device that was already paired before the scenario began — its first
  // accepted response re-derived `credentialState` away from `required`, so
  // `connectionNeedsAccessRequest` correctly withheld the per-row
  // "Request access to <name>" affordance and the leg waited forever for a
  // button the product had no reason to render (archive#3753). The premise is
  // asserted below rather than trusted, so a future change to that shared
  // fixture fails here, naming itself, instead of surfacing as a missing
  // button.
  // This intentionally performs deny, approve, replay rejection, browser
  // restart, and revoke in one stateful scenario. The container fleet needs
  // more than Playwright's 30s unit-sized default without any single wait
  // becoming less strict.
  test.setTimeout(90_000);
  if (!baseURL) throw new Error('Playwright baseURL is required');
  const operatorCredential = hostCredential();
  if (!operatorCredential) {
    throw new Error('The E2E host credential is required for device pairing');
  }
  const hostContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: hostCredentialHeaders(),
  });
  let phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // Explicitly empty, not omitted: an omitted `storageState` means "use the
    // configured default", which is the shared device session this scenario
    // exists to not have.
    storageState: { cookies: [], origins: [] },
  });
  await seedBrowserConnection(hostContext, {
    id: 'e2e-host-default',
    url: baseURL,
    credentialState: 'saved',
    credential: operatorCredential,
  });
  await seedBrowserConnection(phoneContext, {
    id: 'e2e-phone-default',
    url: baseURL,
    credentialState: 'required',
  });
  const host = await hostContext.newPage();
  let phone = await phoneContext.newPage();

  await host.goto(baseURL);
  const hostConnections = await openConnections(host);
  // Reviewing paired devices is the front door; approving a new one is the
  // step inside it that opens the request inbox this test drives.
  const createPairingCode = hostConnections.getByRole('button', {
    name: 'Create pairing code',
  });
  if (await createPairingCode.isVisible()) {
    await hostConnections.getByRole('button', { name: 'Back' }).click();
  } else {
    await hostConnections
      .getByRole('button', { name: 'Paired devices' })
      .click();
  }
  await hostConnections
    .getByRole('button', { name: 'Approve another device' })
    .click();

  await phone.goto(baseURL);
  const phoneSessionCookiesBeforeRequest = (
    await phoneContext.storageState()
  ).cookies.filter((cookie) =>
    ['__Host-station-device', 'station-device'].includes(cookie.name),
  );
  expect(
    phoneSessionCookiesBeforeRequest,
    'the phone must reach this Station with no device session at all — see the note at the top of this test',
  ).toEqual([]);
  await openPhoneAccessRequest(phone);
  await phone.getByLabel('Device name').fill('Phone E2E');
  const deniedPairingRequestResponse = phone.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/pairing/access-request'),
  );
  await phone.getByRole('button', { name: 'Request access' }).click();
  await deniedPairingRequestResponse;
  await expectPhoneAwaitingApproval(phone);

  const phoneRequestCard = host
    .getByRole('region', { name: 'Device access requests' })
    .locator(':scope > div')
    .filter({ hasText: 'Phone E2E' });
  const denyButton = phoneRequestCard.getByRole('button', { name: 'Deny' });
  await expect(denyButton).toBeVisible();
  await denyButton.click();
  await expectPhoneDeclined(phone);
  expect(
    (await phoneContext.storageState()).cookies.filter((cookie) =>
      ['__Host-station-device', 'station-device'].includes(cookie.name),
    ),
  ).toEqual(phoneSessionCookiesBeforeRequest);

  await expectPhoneCanRequestAgain(phone);
  await phone.getByLabel('Device name').fill('Phone E2E');
  const pairingRequestResponse = phone.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/pairing/access-request'),
  );
  await phone.getByRole('button', { name: 'Request access' }).click();
  const pairingRequest = (await (await pairingRequestResponse).json()) as {
    offerId: string;
    proof: string;
    requestId: string;
  };
  await expectPhoneAwaitingApproval(phone);

  const confirmButton = phoneRequestCard.getByRole('button', {
    name: 'Approve',
  });
  await expect(confirmButton).toBeVisible();
  await confirmButton.click();
  await expect(
    host
      .getByRole('region', { name: 'Paired devices' })
      .getByText('Phone E2E')
      .last(),
  ).toBeVisible();
  await expect(
    phone.getByRole('button', {
      name: 'Request access to Default',
    }),
  ).toHaveCount(0);
  await expect.poll(() => pairedApiStatus(phone)).toBe(200);
  await expect
    .poll(() =>
      phone.evaluate(() => {
        const profiles = JSON.parse(
          localStorage.getItem('station-connect-connections') ?? '[]',
        ) as Array<{ credentialState?: string }>;
        const credentialVault = JSON.parse(
          sessionStorage.getItem('station-connect-connections-credentials') ??
            '{}',
        ) as Record<string, unknown>;
        return {
          hasPhoneStoredCredential:
            typeof credentialVault['connection:e2e-phone-default'] === 'string',
          hasDeviceSession: profiles.some(
            (profile) => profile.credentialState === 'device-session',
          ),
        };
      }),
    )
    .toEqual({ hasPhoneStoredCredential: false, hasDeviceSession: true });
  const persisted = await phoneContext.storageState();
  const deviceCookie = persisted.cookies.find((cookie) =>
    ['__Host-station-device', 'station-device'].includes(cookie.name),
  );
  expect(deviceCookie).toMatchObject({
    httpOnly: true,
    sameSite: 'Strict',
  });
  expect(deviceCookie!.expires).toBeGreaterThan(Date.now() / 1_000);
  const replayStatus = await phone.evaluate(
    async ({ offerId, requestId, proof }) =>
      fetch('/.well-known/station/v1/pairing/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offerId, requestId, proof }),
      }).then((response) => response.status),
    {
      offerId: pairingRequest.offerId,
      requestId: pairingRequest.requestId,
      proof: pairingRequest.proof,
    },
  );
  expect(replayStatus).toBe(409);

  await phoneContext.close();
  phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    storageState: persisted,
  });
  phone = await phoneContext.newPage();
  await phone.goto(baseURL);
  await expect.poll(() => pairedApiStatus(phone)).toBe(200);

  await expect(
    host
      .getByRole('region', { name: 'Paired devices' })
      .getByText('Phone E2E')
      .last(),
  ).toBeVisible();
  // Revoking takes a deliberate confirmation, and the device then moves out of
  // the with-access group rather than staying in it with a suffix.
  await host
    .getByRole('region', { name: 'Devices with access' })
    .getByRole('button', { name: 'Revoke Phone E2E' })
    .last()
    .click();
  await host.getByRole('button', { name: 'Confirm' }).last().click();
  await expect(
    host
      .getByRole('region', { name: 'Revoked devices' })
      .getByText('Phone E2E')
      .last(),
  ).toBeVisible();
  await expect(
    host
      .getByRole('region', { name: 'Devices with access' })
      .getByText('Phone E2E'),
  ).toHaveCount(0);
  await hostContext.close();
  await phoneContext.close();
});
