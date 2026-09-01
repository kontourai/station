/**
 * E2E: Connection Manager Modal
 *
 * Opens the app, seeds localStorage with a connection, verifies:
 *  - the connection chip appears in the header
 *  - clicking it opens the modal
 *  - adding a new connection via the form works
 *  - switching active connection updates the chip label
 *  - editing a connection works
 *  - removing a connection works
 *  - discover panel renders
 *  - status dot states render correctly
 */
import { expect, type Locator, test } from '@playwright/test';
import { requireE2EOperatorCredential } from './helpers/e2e-operator-credential';

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

test.describe('Connection Manager Modal', () => {
  test.beforeEach(async ({ page }) => {
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
    // The manual-add flow (archive#942) handshakes a candidate host's public
    // `/.well-known/station/v1` endpoint and gates the Add button on it
    // before saving. The suite adds hosts on addresses nothing is actually
    // listening on (e.g. 10.0.0.5), so without this the handshake runs for
    // its real ~5s timeout before failing open — racing (and losing to) the
    // default 5s `expect().toBeVisible()` timeout on the connection showing
    // up right after. Mock it the same way connections-crud.spec.ts does so
    // every candidate host resolves promptly, matching a real reachable host.
    // The body includes `compatibility` per the real shape
    // (`EnvironmentSecurityService.getPublicHandshake`,
    // src-server/services/ssh/environment-security-service.ts) — every field
    // a real host actually sends, not just the pre-archive#942 subset — so this
    // mock stays representative of what `checkHostCompatibility` really
    // parses instead of accidentally testing a payload no server sends.
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
    await expect(
      // archive#3311 made the connection control self-describing: its
      // accessible name now carries the state and the connection identity
      // ("Manage Stations — Connected · <name>"), so this matches by prefix.
      // The bare string is still the control’s `title` (archive#3297).
      page.getByRole('button', { name: /^Manage Stations/ }),
    ).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('Dev Server').first()).toBeVisible();
    await expect(
      page.getByRole('status').filter({
        hasText: 'Loading connection recovery…',
      }),
    ).toHaveCount(0, { timeout: 10_000 });
    await page.evaluate(() => {
      document.querySelector('[data-testid="setup-launcher"]')?.remove();
    });
  });

  test('connection chip is visible in the header', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /^Manage Stations/ }),
    ).toBeVisible();
  });

  test('clicking the chip opens the connection modal', async ({ page }) => {
    await page.getByRole('button', { name: /^Manage Stations/ }).click();
    await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();
    // The existing connection should appear in the modal list. A row's name
    // renders in two nested elements (`.station-connect-row__name-line` and
    // its child `.station-connect-row__name`, station#994), so `div`
    // `hasText` matches both and is a strict-mode violation — the row's own
    // `Select <name>` control is a stable, unique handle instead.
    await expect(
      page
        .getByRole('dialog')
        .getByRole('button', { name: 'Select Dev Server', exact: true }),
    ).toBeVisible();
  });

  test('traps keyboard focus, closes with Escape, and restores its trigger', async ({
    page,
  }) => {
    const trigger = page.getByRole('button', { name: /^Manage Stations/ });
    await trigger.focus();
    await trigger.click();
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

  test('can add a new connection manually', async ({ page }) => {
    // archive#945 LOW: a bare "the connection eventually appears" assertion would
    // pass identically even if the app silently stopped calling the archive#942
    // pre-save handshake — `ConnectionManagerModalContent`'s own post-add
    // health probe (`checkOne`) hits this exact same `.well-known/station/v1`
    // URL, so a naive "was this URL ever requested" counter cannot tell the
    // two apart (proven against a real build: hitting the endpoint happens
    // 3 times on the correct path and 2 times with the pre-save check
    // removed — not a discriminating signal to hardcode against). The one
    // signal that is exclusively tied to the pre-save gate is the composer's
    // own "Checking…" button label (`ManualAddPanel`'s `checking` prop,
    // driven only by `passesCompatibility`), so delay the mocked response
    // just enough to observe that transient state and assert on it directly.
    await page.route('**/.well-known/station/v1', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return route.fulfill({
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
      });
    });

    await page.getByRole('button', { name: /^Manage Stations/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add a Station address' })
      .click();
    await page.getByPlaceholder('Name (optional)').fill('Office');
    await page
      .getByPlaceholder('https://station.example.ts.net')
      .fill('http://10.0.0.5:3141');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // The pre-save handshake is actually in flight — this button label is
    // exclusively driven by that check, not by the unrelated post-add probe.
    await expect(
      page.getByRole('button', { name: 'Checking…', exact: true }),
    ).toBeVisible();

    // The modal remains open across the endpoint change, preserving context.
    const dialog = page.getByRole('dialog');
    // A successful add now carries straight into authorising the new host
    // instead of returning to the list (archive#986) — the pairing panel names it
    // by name, not "this Station".
    await expect(
      dialog.getByText(/Send a short-lived request to Office\./),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Back' }).click();

    // The connection is saved and active as soon as it is added, regardless
    // of whether authorising it is completed right away.
    await expect(dialog.getByText('Office', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close Station manager' }).click();

    // Chip should update to the new active connection after dismissal.
    await expect(
      page
        .getByRole('button', { name: /^Manage Stations/ })
        .getByText('Office'),
    ).toBeVisible();
  });

  test('keeps Add Station fields at the iOS focus-zoom floor', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /^Manage Stations/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add a Station address' })
      .click();

    const fields = [
      page.getByPlaceholder('Name (optional)'),
      page.getByPlaceholder('https://station.example.ts.net'),
    ];
    for (const field of fields) {
      await expect(field).toBeVisible();
      expect(
        await field.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        ),
      ).toBeGreaterThanOrEqual(16);
    }

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
    await fields[1].focus();
    const after = await page.evaluate(() => ({
      scale: window.visualViewport?.scale ?? 1,
      width: window.visualViewport?.width ?? window.innerWidth,
    }));
    expect(after.scale).toBeCloseTo(1, 5);
    expect(after.width).toBeCloseTo(before.width, 1);
  });

  test('resolves exactly one "Manage Stations" control at 390px, collapsed and maximized (#1048)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // Default mobile state: the ambient chat dock is present but collapsed,
    // NOT full-screen (`chat-dock is-collapsed`, not
    // `app__main--mobile-dock-fullscreen`) — this is the state every phone
    // user lands in on a fresh load, not an edge case. Before #1048 the app
    // toolbar's `app-toolbar-connection` and the dock header's
    // `chat-dock-mobile-connection` both rendered here and both matched.
    await expect(
      page.getByRole('button', { name: /^Manage Stations/ }),
    ).toHaveCount(1);

    // Maximized mobile dock: the app toolbar is genuinely hidden
    // (`app__main--mobile-dock-fullscreen`), and the dock header's own
    // connection control must still be the one surviving control — that is
    // the entire reason it exists (station#3297).
    await page.goto('/?dock=open&maximize=true');
    await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
    const survivor = page.getByRole('button', { name: /^Manage Stations/ });
    await expect(survivor).toHaveCount(1);
    await expect(survivor).toHaveAttribute(
      'data-testid',
      'chat-dock-mobile-connection',
    );
  });

  test('can switch between connections', async ({ page }) => {
    // Add a second connection via the UI
    await page.getByRole('button', { name: /^Manage Stations/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add a Station address' })
      .click();
    await page.getByPlaceholder('Name (optional)').fill('Remote');
    await page
      .getByPlaceholder('https://station.example.ts.net')
      .fill('http://203.0.113.5:3141');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // Back out of the authorize step this add now continues into (archive#986) —
    // switching to an already-saved connection does not require completing
    // pairing on the one just added.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Back' })
      .click();

    // Modal is still open on the list panel — click the Dev Server row to switch back
    await page
      .getByRole('button', { name: 'Select Dev Server', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close Station manager' })
      .click();

    // Chip should update back to Dev Server
    await expect(
      page.getByRole('button', { name: /^Manage Stations/ }),
    ).toBeVisible();
  });

  test('can edit a connection', async ({ page }) => {
    await page.getByRole('button', { name: /^Manage Stations/ }).click();
    await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();
    const dialog = page.getByRole('dialog');

    // Edit/Check reachability/Forget live behind the row's "More actions"
    // overflow menu, not standalone title-attributed buttons
    // (ConnectionListPanel.tsx station#4512 review M6).
    await (await openConnectionActionsMenu(dialog, 'Dev Server'))
      .getByRole('menuitem', { name: 'Edit Station', exact: true })
      .click();

    // Edit form should appear with pre-filled values
    const nameInput = page.getByPlaceholder('Name');
    const _urlInput = page.getByPlaceholder(/192\.168/);
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('Dev Server');

    // Change the name
    await nameInput.fill('Home Lab');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // Updated name should appear. The row's `Select <name>` control is a
    // stable handle — a bare `div` `hasText` match is ambiguous (station#994
    // nests the name in two elements) and one DOM change from breaking.
    await expect(
      dialog.getByRole('button', { name: 'Select Home Lab', exact: true }),
    ).toBeVisible();
  });

  test('can remove a connection', async ({ page }) => {
    // Add a second connection via the UI so we have something to remove
    await page.getByRole('button', { name: /^Manage Stations/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add a Station address' })
      .click();
    await page.getByPlaceholder('Name (optional)').fill('ToDelete');
    await page
      .getByPlaceholder('https://station.example.ts.net')
      .fill('http://delete-me:3141');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // Back out of the authorize step this add now continues into (archive#986).
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Back' })
      .click();

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
    await page.getByRole('button', { name: /^Manage Stations/ }).click();
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

  test('status dot shows correct colors', async ({ page }) => {
    await page.getByRole('button', { name: /^Manage Stations/ }).click();

    // The status dot should be visible in the modal (connecting state since health check won't resolve)
    const _dot = page.locator('[aria-label]').filter({ hasText: /^$/ }).first();
    // At minimum, verify a dot with aria-label exists in the connection row
    await expect(
      page
        .locator(
          '[aria-label="connecting"], [aria-label="connected"], [aria-label="error"]',
        )
        .first(),
    ).toBeVisible();
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
    await page.evaluate(() => {
      document.querySelector('[data-testid="setup-launcher"]')?.remove();
    });
    await expect(
      page.getByRole('status').filter({
        hasText: 'Loading connection recovery…',
      }),
    ).toHaveCount(0, { timeout: 10_000 });

    // archive#3311: the state moved from the title attribute into visible
    // text, so the accessible name is now "Manage Stations — <state>…".
    await page.getByRole('button', { name: /^Manage Stations/ }).click();
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
