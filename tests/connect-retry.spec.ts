import { expect, type Page, test } from '@playwright/test';

async function seedUnreachable(page: Page) {
  let handshakeRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        {
          id: 'remote',
          name: 'Remote',
          url: 'https://station.example.ts.net',
          lastSuccessAt: Date.now() - 60_000,
          credentialState: 'not-required',
          environmentId: '11111111-1111-4111-8111-111111111111',
          selectedEndpointId: 'primary',
          endpoints: [
            {
              id: 'primary',
              kind: 'https',
              httpBaseUrl: 'https://station.example.ts.net',
            },
          ],
        },
      ]),
    );
    localStorage.setItem('station-connect-connections-active', 'remote');
  });
  // Readiness owns initial shell rendering; reachability has its own
  // compatibility probe below.
  await page.route('**/api/system/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: true,
        acp: { connected: false, connections: [] },
        clis: {},
        prerequisites: [],
        providers: {
          configuredChatReady: true,
          configured: [],
          detected: { ollama: false, bedrock: false },
        },
      }),
    }),
  );
  await page.route('**/.well-known/station/v1', async (route) => {
    handshakeRequests += 1;
    await route.abort('connectionrefused');
  });

  return {
    handshakeRequests: () => handshakeRequests,
  };
}

/**
 * A saved connection on a loopback address, from a browser that is not the
 * machine hosting it. Unreachable in a way no retry can fix, which is what
 * makes it a decision rather than a blip.
 */
async function seedUnreachableLoopback(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        {
          id: 'local',
          name: 'Local',
          url: 'http://localhost:59173',
          lastSuccessAt: Date.now() - 60_000,
          credentialState: 'not-required',
          environmentId: '22222222-2222-4222-8222-222222222222',
          selectedEndpointId: 'primary',
          endpoints: [
            {
              id: 'primary',
              kind: 'https',
              httpBaseUrl: 'http://localhost:59173',
            },
          ],
        },
      ]),
    );
    localStorage.setItem('station-connect-connections-active', 'local');
  });
  await page.route('**/api/system/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: true,
        acp: { connected: false, connections: [] },
        clis: {},
        prerequisites: [],
        providers: {
          configuredChatReady: true,
          configured: [],
          detected: { ollama: false, bedrock: false },
        },
      }),
    }),
  );
  await page.route('**/.well-known/station/v1', (route) =>
    route.abort('connectionrefused'),
  );
}

/**
 * archive#3297 — a remote host that is not answering is transient
 * reachability. It no longer earns a banner (the owner's "kinda getting tired
 * of the big banners for offline"); the connection indicator carries it, and
 * the indicator is where the real retry moved to.
 */
/**
 * archive#3311 made the connection control self-describing: its accessible
 * name now carries the state and the connection identity ("Manage Stations —
 * Connected · <name>"), so the locators below match by prefix. The bare
 * "Manage Stations" string is still the control's `title` (archive#3297).
 */
test('an unreachable connection is carried by the indicator, not a banner', async ({
  page,
}) => {
  await seedUnreachable(page);
  await page.goto('/');

  const indicator = page.getByRole('button', {
    name: /^Manage Stations/,
  });
  await expect(indicator.getByLabel('error')).toBeVisible();
  // The whole point of the change: no paragraph of prose with an address in it.
  await expect(
    page.locator('[data-banner-id="chrome:connection:offline"]'),
  ).toHaveCount(0);
});

test('the indicator still offers a real retry, not only navigation', async ({
  page,
}) => {
  // The banner's "Try now" went with the banner. Tapping a failing indicator
  // has to mean "check again now", or transient reachability would have no
  // user-driven retry at all between backoff intervals.
  const fixture = await seedUnreachable(page);
  await page.goto('/');

  const indicator = page.getByRole('button', { name: /^Manage Stations/ });
  await expect(indicator.getByLabel('error')).toBeVisible();

  const requestsBeforeRetry = fixture.handshakeRequests();
  const retryProbe = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/.well-known/station/v1' &&
      fixture.handshakeRequests() >= requestsBeforeRetry,
  );
  await indicator.click();
  await retryProbe;
  expect(fixture.handshakeRequests()).toBeGreaterThan(requestsBeforeRetry);
});

/**
 * The reachability copy itself is unchanged and still names both the saved
 * host and the address it tried — it just renders where a decision is
 * required rather than for every blip. A loopback address reached from a
 * browser that is not the host IS such a decision: no retry can resolve it.
 */
test('a decision-worthy reachability failure still names the host and address', async ({
  page,
}) => {
  await seedUnreachableLoopback(page);
  await page.goto('/');

  const banner = page.locator(
    '[role="alert"][data-banner-id="chrome:connection:offline"]',
  );
  await expect(banner).toContainText("Can't reach Local");
  await expect(banner).toContainText('http://localhost:59173');
  // One line: the cause and the advice are behind the disclosure.
  await expect(banner).not.toContainText('off, asleep');
  await banner.getByRole('button', { name: 'Details' }).click();
  await expect(banner).toContainText(
    'It may be off, asleep, or on another network.',
  );
  await expect(banner).toContainText(
    "Use the host's IP address instead of localhost",
  );
});
