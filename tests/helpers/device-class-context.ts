import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { requireE2EBrowserSessionCredential } from './e2e-operator-credential';

/**
 * The two device classes `devicePresentation` can report (archive#3843 §1),
 * as browser contexts, plus the premise assertion that makes each one a
 * FACT about the fixture rather than a hope.
 *
 * WHY THE TWO CONTEXTS DIFFER THE WAY THEY DO. `deviceClass` is derived from
 * ONE thing — the mint-time `locality: 'home-possession'` the auth boundary
 * binds for the request's principal — so a context's class is decided by
 * WHICH credential its page ends up presenting, and by nothing else:
 *
 *  - PAIRED is the suite's own default. `playwright.config.ts` seeds every
 *    context with the operator credential in Connect's credential vault
 *    (`credentialState: 'saved'`), so the SDK sends it as a bearer, and a
 *    bearer beats the cookie at the boundary. An operator credential is never
 *    home possession by design (`station environment access approve` issues
 *    it for a caller that proved nothing about where it is sitting), so the
 *    default context is a paired device. Measured, not assumed: the premise
 *    below fails the spec if that ever changes.
 *  - HOST presents the browser session cookie ALONE. Dropping the vault entry
 *    is what makes the cookie decide, and the runner's cookie is minted by
 *    exchanging the launcher capability over the UI PORT
 *    (`scripts/run-e2e-suite.mjs`) — byte for byte the URL `station start`
 *    prints for the operator. Since archive#3876 that is an exchange the
 *    server stamps `home-possession` on, because Station's own proxy attests
 *    that its client was on this machine; before it, only a direct-socket
 *    exchange no user performs was stamped. So the premise assertion below is
 *    also the regression test for that attestation.
 *
 * A spec CANNOT mint its own host credential. The launcher capability is
 * single-use and a second mint revokes the session every other spec is
 * running on. So the credential comes from the runner and the CHOICE of class
 * lives here, in the fixtures, where a reader can see it.
 */
export type DeviceClass = 'host' | 'paired';

/**
 * Connect's own profile, with NO stored credential — which is what makes the
 * page present the device-session cookie and nothing else. On a loopback URL
 * `deriveCredentialState` reads that as `not-required`, so no Authorization
 * header is ever attached, and the cookie is the principal.
 */
function hostStorageState(baseURL: string) {
  const origin = new URL(baseURL).origin;
  const connectionId = 'e2e-host-device';
  return {
    cookies: [
      {
        name:
          new URL(origin).protocol === 'https:'
            ? '__Host-station-device'
            : 'station-device',
        value: requireE2EBrowserSessionCredential(
          process.env.STATION_E2E_BROWSER_SESSION_CREDENTIAL,
        ),
        domain: new URL(origin).hostname,
        path: '/',
        expires: Math.floor(Date.now() / 1_000) + 3_600,
        httpOnly: true,
        secure: new URL(origin).protocol === 'https:',
        sameSite: 'Strict' as const,
      },
    ],
    origins: [
      {
        origin,
        localStorage: [
          {
            name: 'station-connect-connections',
            value: JSON.stringify([
              {
                profileVersion: 4,
                id: connectionId,
                name: 'Station E2E',
                url: origin,
                credentialState: 'device-session',
              },
            ]),
          },
          { name: 'station-connect-connections-active', value: connectionId },
          { name: 'station:onboarding-setup-dismissed', value: '1' },
        ],
      },
    ],
  };
}

export interface DeviceClassContext {
  context: BrowserContext;
  page: Page;
  /** The host machine's own name, as the SERVER reported it. */
  hostName: string;
}

/**
 * Opens a context of `deviceClass` and PROVES it is one before the caller
 * asserts anything about presentation. A spec whose fixture silently drifted
 * into the other class would otherwise assert the wrong surface and pass —
 * exactly the shape of archive#3753, one layer down.
 */
export async function openDeviceClassContext(
  browser: Browser,
  baseURL: string,
  deviceClass: DeviceClass,
  viewport: { width: number; height: number },
): Promise<DeviceClassContext> {
  const mobile = viewport.width < 500;
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    // Paired deliberately OMITS storageState so it inherits the suite-wide
    // default; host replaces it outright. An omitted option means "use the
    // configured default", which is precisely the difference being made here.
    ...(deviceClass === 'host'
      ? { storageState: hostStorageState(baseURL) }
      : {}),
  });
  const page = await context.newPage();
  // Read the answer the APP's own status query got, not one this fixture asked
  // for. A bare `fetch` from page script carries the cookie but NOT the bearer
  // Connect attaches from its vault, so it can report a different principal —
  // and therefore a different class — than every rendered surface is reading.
  // Measured: in the suite's default context the raw fetch says `host` (the
  // cookie) while every SDK query says `paired` (the operator bearer). The
  // premise has to be the class the page is actually rendering from.
  const statusResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/system/status') &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  await page.goto(baseURL);
  const presentation = (await (await statusResponse).json())
    .devicePresentation as { deviceClass?: string; hostName?: string } | null;
  expect(
    presentation,
    `the ${deviceClass} fixture must reach a server that serves devicePresentation`,
  ).toBeTruthy();
  expect(
    presentation?.deviceClass,
    `the ${deviceClass} fixture presented a credential the server reads as ${presentation?.deviceClass} — see the note in tests/helpers/device-class-context.ts`,
  ).toBe(deviceClass);
  expect(
    presentation?.hostName,
    'the projection must name the host machine in both classes',
  ).toBeTruthy();
  return { context, page, hostName: presentation?.hostName as string };
}
