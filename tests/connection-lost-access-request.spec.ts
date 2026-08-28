import type { BrowserContext, Page } from '@playwright/test';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';

/**
 * The per-row `Request access to <name>` affordance, on the device it is FOR
 * (archive#3850).
 *
 * `device-pairing-mobile.spec.ts` covers the other scenario and says so in its
 * own docblock: an UNPAIRED device never reaches the shell, so its request,
 * its wait and the refusal all belong to the onboarding gate. This row is for
 * a device that IS paired, HAS the shell, and whose connection LOST access —
 * the owner revoked it from another machine, mid-session. Nothing covered it.
 *
 * THE PREMISE IS THE HARD PART, and it is asserted rather than trusted
 * (archive#3753's lesson, one scenario over). `connectionNeedsAccessRequest`
 * withholds this button for a connection whose credential still works, and
 * `recordAuthenticatedSuccess` clears `credentialState: 'required'` on the
 * very next accepted response — so a fixture that can authenticate by ANY
 * route makes the product correctly render nothing, and the spec waits forever
 * for a button that should not be there. Three premises are therefore measured
 * in order: this device reaches the shell WITH access (no affordance), the
 * revoke really lands (a 401 from a route that was 200 a moment ago), and only
 * then is the affordance a fact about lost access rather than about a device
 * that never had any.
 *
 * `storageState: { cookies: [], origins: [] }` is explicit, not omitted: an
 * omitted option inherits `playwright.config.ts`'s suite-wide state, whose
 * operator bearer would authenticate every request no matter what this test
 * revokes.
 */

const DEVICE_NAME = 'E2E Lost Access Device';
const CONNECTION_ID = 'e2e-lost-access';
const CONNECTION_LABEL = 'Revoked Station';
const REQUEST_ACCESS_ROW = `Request access to ${CONNECTION_LABEL}`;

/**
 * Pairs this browser context for real, over the public endpoints, so the
 * device session it ends up holding is one the SERVER issued rather than one
 * the fixture invented.
 *
 * `/pairing/exchange` returns the credential in its body — the browser-cookie
 * delivery belongs to the launcher's `/pairing/ui-bootstrap` route, not to
 * this one — so the cookie is installed here explicitly, the same way
 * `tests/project-task-room-collaboration.spec.ts` installs its peer's.
 */
async function pairContext(
  context: BrowserContext,
  baseURL: string,
  authenticatedRequest: AuthenticatedE2ERequest,
  deviceName: string,
): Promise<{ deviceId: string }> {
  const origin = new URL(baseURL).origin;
  const publicHeaders = {
    'Content-Type': 'application/json',
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
  };
  const requested = await context.request.post(
    '/.well-known/station/v1/pairing/access-request',
    { headers: publicHeaders, data: { deviceName } },
  );
  expect(
    requested.status(),
    'the public access-request endpoint must accept this device',
  ).toBe(202);
  const session = (await requested.json()) as {
    offerId: string;
    proof: string;
    requestId: string;
  };
  // Approved with the operator credential: since archive#1490 an approval
  // presenting nothing is refused when the request also arrived on the
  // loopback compatibility floor, which every context of a local E2E does.
  const confirmed = await authenticatedRequest.post(
    `/api/pairing/requests/${session.requestId}/confirm`,
  );
  expect(confirmed.status(), 'the operator must be able to approve').toBe(200);
  const exchanged = await context.request.post(
    '/.well-known/station/v1/pairing/exchange',
    {
      headers: publicHeaders,
      data: {
        offerId: session.offerId,
        proof: session.proof,
        requestId: session.requestId,
      },
    },
  );
  expect(exchanged.status(), 'the approved request must exchange').toBe(200);
  const issued = (await exchanged.json()) as {
    credential: string;
    device: { id: string };
  };
  await context.addCookies([
    {
      name: 'station-device',
      value: issued.credential,
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  return { deviceId: issued.device.id };
}

/** Connect's own profile for this Station, holding the session cookie alone. */
async function seedConnection(context: BrowserContext, baseURL: string) {
  await context.addInitScript(
    (profile) => {
      localStorage.setItem(
        'station-connect-connections',
        JSON.stringify([
          {
            profileVersion: 4,
            id: profile.id,
            name: profile.name,
            url: profile.url,
            credentialState: 'device-session',
          },
        ]),
      );
      localStorage.setItem('station-connect-connections-active', profile.id);
      // Past first run: the launcher is modal and its backdrop swallows clicks.
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
    },
    { id: CONNECTION_ID, name: CONNECTION_LABEL, url: new URL(baseURL).origin },
  );
}

/** A protected route's status, read with whatever credential the PAGE holds. */
function protectedRouteStatus(page: Page) {
  return page.evaluate(() =>
    fetch('/api/projects').then((response) => response.status),
  );
}

/**
 * Opens the connections dialog from the shell's own disclosure of lost access.
 *
 * The blocked banner's `Request access` action is the route a person takes,
 * and it is deliberately the one used here — reaching the row another way
 * would leave that action unproven. It keys on the ACTION and on the banner
 * naming the Station, not on one message: which sentence appears depends on
 * how the connection recorded the refusal (measured on a live revoke: "Revoked
 * Station answered, but not as a Station", not the plainer "Request access to
 * reconnect to …"), and this spec's subject is the row, not that wording.
 *
 * The window is deliberately long, and the wait is real rather than a sleep.
 * Nothing in this app refetches on window focus (`main.tsx` turns it off), so
 * the trigger is the shell's own polling query hitting a 401 — and
 * `RuntimeAuthFailureLimiter` counts refusals per PEER over a fixed 60s window
 * (10 failures), which every context of a local run shares. The second
 * viewport's revoke can therefore land while the first viewport's refusals
 * still hold the budget, and a 429 is not a 401 and never reaches
 * `reportUnauthorized`. Waiting out that window is what makes the second run
 * honest instead of flaky.
 */
async function openConnectionsFromLostAccessBanner(page: Page) {
  // The shell is STILL UP. This is the whole difference from the unpaired
  // scenario: a device with no working credential cannot rebuild the shell
  // from scratch, so a reload here would correctly land on the onboarding gate
  // and prove the opposite (measured).
  // `#station-main` is the shell's own route outlet (App.tsx, archive#3656). The
  // onboarding gate renders INSTEAD of its children, so this element exists in
  // exactly one of the two states and is the same marker at every viewport —
  // the sidebar's Home control is not (it is collapsed at 390).
  await expect(
    page.locator('main#station-main'),
    'the shell must survive losing access — this row belongs to a live session',
  ).toBeAttached({ timeout: 15_000 });
  const requestAccess = page.getByRole('button', {
    name: 'Request access',
    exact: true,
  });
  await expect
    .poll(() => requestAccess.count(), {
      timeout: 120_000,
      intervals: [2_000],
      message: 'losing access must be disclosed in the shell, not silently',
    })
    .toBeGreaterThan(0);
  // `visible=true`, not `.first()`: the label also appears in collapsed banner
  // detail and in the toolbar chip's truncated text, and the first match in DOM
  // order is not necessarily one a person can read (measured at 390).
  await expect
    .poll(
      () =>
        page
          .getByText(new RegExp(CONNECTION_LABEL))
          .locator('visible=true')
          .count(),
      {
        timeout: 15_000,
        message:
          'the disclosure must name the Station this device lost access to',
      },
    )
    .toBeGreaterThan(0);
  await requestAccess.first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  return dialog;
}

test.describe('a paired connection that lost access (station#3850)', () => {
  for (const [label, viewport, mobile] of [
    ['desktop', { width: 1280, height: 800 }, false],
    ['390', { width: 390, height: 844 }, true],
  ] as const) {
    const journey = !mobile;
    test(`offers the row's own request affordance at ${label}${journey ? ', and honours the deny and the approve' : ''}`, async ({
      browser,
      baseURL,
      authenticatedRequest,
    }, testInfo) => {
      // Pair, revoke, deny, request again, approve — one stateful scenario
      // against the shared instance, well past Playwright's unit-sized default.
      test.setTimeout(240_000);
      if (!baseURL) throw new Error('Playwright baseURL is required');
      const deviceName = `${DEVICE_NAME} ${label}`;
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
        // Explicit, not omitted — see the note at the top of this file.
        storageState: { cookies: [], origins: [] },
      });
      try {
        await seedConnection(context, baseURL);
        const { deviceId } = await pairContext(
          context,
          baseURL,
          authenticatedRequest,
          deviceName,
        );
        const page = await context.newPage();
        await page.goto(baseURL);

        // PREMISE 1 — this device has the shell AND access. The affordance
        // must be absent here, or its presence later proves nothing. Asserted
        // once before any poll, so a fixture that never paired reports THAT
        // rather than the auth limiter's 429 thirty seconds later.
        expect(
          await protectedRouteStatus(page),
          'the paired fixture must reach a protected route — this device holds a real issued session',
        ).toBe(200);
        await expect(
          page.getByRole('button', { name: REQUEST_ACCESS_ROW }),
          'a connection whose credential still works must not be offered a request',
        ).toHaveCount(0);

        // PREMISE 2 — the revoke lands, read from the SERVER's own record.
        // Deliberately not by polling a protected route until it 401s: the
        // auth-failure limiter answers 429 after a handful of refusals, and
        // the budget it spends is the same budget the APP needs to learn it
        // lost access (only a 401 reaches `reportUnauthorized`). Measured: a
        // 30s poll here turned every later refusal into 429 and the banner
        // never appeared.
        const revoked = await authenticatedRequest.delete(
          `/api/pairing/devices/${deviceId}`,
        );
        expect(revoked.status(), 'the owner must be able to revoke').toBe(200);
        const devices = await authenticatedRequest.get('/api/pairing/devices');
        expect(devices.status()).toBe(200);
        const listed = (
          (await devices.json()) as {
            devices?: Array<{ id: string; revokedAt?: number | null }>;
          }
        ).devices;
        expect(
          listed?.find((entry) => entry.id === deviceId)?.revokedAt,
          'the revoked device must be recorded as revoked, not merely forgotten',
        ).toEqual(expect.any(Number));

        // The shell stays up and says so.
        const dialog = await openConnectionsFromLostAccessBanner(page);
        const rowRequest = dialog.getByRole('button', {
          name: REQUEST_ACCESS_ROW,
        });
        await expect(
          rowRequest,
          'a paired connection that lost access must offer its own row a way back',
        ).toBeVisible({ timeout: 15_000 });
        if (mobile) {
          // The touch floor applies where there is touch. Measured on the same
          // control at 1280: 32px, which is a mouse target and correct there.
          const rowBox = await rowRequest.boundingBox();
          expect(
            rowBox?.height ?? 0,
            'the row affordance must clear the touch floor on a phone',
          ).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({
          path: testInfo.outputPath(`lost-access-row-${label}.png`),
        });

        if (!journey) {
          // The 390 variant proves the SURFACE, not the state machine again.
          // That is not timidity about mobile: the public access-request
          // endpoint admits 5 attempts per 60s PER PEER, and every context of a
          // local run is the same peer — running the full deny/retry/approve
          // journey twice spends 6 and the second viewport's retry is refused
          // with no request id (measured). The desktop variant below owns the
          // outcomes; this one owns that the row is there and tappable.
          return;
        }

        // DENY. The request is made FROM THE ROW, and the owner refuses it.
        // Submitting closes the dialog by design — the wait and its outcome
        // belong to the shell from here — so the refusal is read from the
        // shell's own banner, and it is the DEVICE-subject decline
        // (archive#3849's second named id), not the request-subject one the
        // dialog would have shown.
        await rowRequest.click();
        const denied = await requestAccessFromPanel(page, deviceName);
        const deniedResponse = await authenticatedRequest.delete(
          `/api/pairing/requests/${denied.requestId}`,
        );
        expect(deniedResponse.status(), 'the owner must be able to deny').toBe(
          200,
        );
        await expect(
          page.getByText(
            new RegExp(`${CONNECTION_LABEL} declined this device`),
          ),
          'a refusal must be reported to the device that asked, naming the Station that refused it',
        ).toBeVisible({ timeout: 45_000 });
        await page.screenshot({
          path: testInfo.outputPath(`lost-access-denied-${label}.png`),
        });

        // ASK AGAIN. The refusal's own action reopens the connection list, and
        // the row is offered a second time — the affordance has to survive its
        // own refusal, or a declined device has no way back at all.
        await page
          .getByRole('button', { name: 'Request access again' })
          .first()
          .click();
        await expect(
          rowRequest,
          'a declined connection must still be offered its row',
        ).toBeVisible({ timeout: 15_000 });
        await rowRequest.click();
        const retried = await requestAccessFromPanel(page, deviceName);

        // APPROVE. Access is back when the device holds a session again and
        // the shell stops saying it does not — asserted from the connection
        // record and the banner, never by re-probing a protected route, whose
        // refusals share a budget with the app's own.
        const confirmed = await authenticatedRequest.post(
          `/api/pairing/requests/${retried.requestId}/confirm`,
        );
        expect(confirmed.status(), 'the owner must be able to approve').toBe(
          200,
        );
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const profiles = JSON.parse(
                  localStorage.getItem('station-connect-connections') ?? '[]',
                ) as Array<{ credentialState?: string }>;
                return profiles[0]?.credentialState ?? 'absent';
              }),
            {
              timeout: 45_000,
              message:
                'an approved request must leave the connection holding a device session again',
            },
          )
          .toBe('device-session');
        await expect(
          page.getByText(
            new RegExp(`${CONNECTION_LABEL} declined this device`),
          ),
          'the refusal must stop being reported once it has been superseded',
        ).toHaveCount(0, { timeout: 30_000 });
        await page.screenshot({
          path: testInfo.outputPath(`lost-access-restored-${label}.png`),
        });
      } finally {
        await context.close();
      }
    });
  }
});

/**
 * Submits the request from the panel the row opened, and returns the id the
 * server assigned — read from the page's OWN response, so the outcome the
 * owner then decides is the one this device is waiting on.
 */
async function requestAccessFromPanel(
  page: Page,
  deviceName: string,
): Promise<{ requestId: string }> {
  const nameField = page.getByLabel('Device name');
  await expect(nameField).toBeVisible({ timeout: 15_000 });
  await nameField.fill(deviceName);
  const response = page.waitForResponse((candidate) =>
    new URL(candidate.url()).pathname.endsWith('/pairing/access-request'),
  );
  await page
    .getByRole('button', { name: 'Request access', exact: true })
    .last()
    .click();
  const body = (await (await response).json()) as { requestId: string };
  expect(body.requestId, 'the request must reach the server').toEqual(
    expect.any(String),
  );
  return body;
}
