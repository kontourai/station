import { expect, test } from '@playwright/test';

/**
 * station#614 — Web Push subscribe/unsubscribe from the Notifications
 * settings section.
 *
 * Hermetic by design (CLAUDE.md testing conventions: route API calls via
 * `page.route` rather than depending on a real paired device or a live push
 * service): the browser's Notification/serviceWorker/PushManager surface is
 * mocked in-page (real headless Chromium push infrastructure needs a live
 * GCM/FCM sender and a user gesture policy this suite can't rely on), and
 * the server-side push-subscribe/push-unsubscribe endpoints are stubbed via
 * `page.route` with call counters — proving the *client* contract (the
 * subscribe request carries the caller's device credential; unsubscribing
 * stops any further subscribe attempt) without asserting on `web-push`'s
 * actual outbound network delivery, which is unit-tested server-side in
 * `src-server/services/notifications/__tests__/web-push-delivery.test.ts`.
 *
 * A device credential is simulated with a `station-device` session cookie
 * (the loopback delivery cookie name from `runtime-http.ts`, mirroring the
 * precedent in `device-pairing-mobile.spec.ts`) rather than running a full
 * pairing exchange, since this spec is about the push client, not pairing.
 */

const FAKE_DEVICE_CREDENTIAL = 'a'.repeat(43);
const FAKE_VAPID_PUBLIC_KEY = `${'B'.repeat(86)}A`;

async function goToNotificationsSettings(
  page: import('@playwright/test').Page,
) {
  await page.goto('/');
  await page.waitForSelector('button[aria-label="Open settings"]', {
    timeout: 10_000,
  });
  await page
    .locator('button[aria-label="Open settings"]')
    .first()
    .evaluate((el) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
  await page.waitForSelector('.settings__section-nav', { timeout: 10_000 });
  await page.getByRole('link', { name: 'Notifications', exact: true }).click();
}

test.describe('Web Push subscribe/unsubscribe', () => {
  test('subscribe reaches push-subscribe with the caller device credential; unsubscribe stops further subscribe attempts', async ({
    context,
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Playwright baseURL is required');
    const origin = new URL(baseURL).origin;

    await page.addInitScript(() => {
      localStorage.setItem(
        'station-feature-settings',
        JSON.stringify({ pushNotificationsEnabled: true }),
      );

      let currentSubscription: unknown = null;
      const fakeSubscription = {
        endpoint: 'https://push.example.test/fake-subscription-endpoint',
        toJSON: () => ({
          endpoint: 'https://push.example.test/fake-subscription-endpoint',
          keys: {
            p256dh: 'fake-p256dh-key-value',
            auth: 'fake-auth-key-value',
          },
        }),
        unsubscribe: async () => {
          currentSubscription = null;
          return true;
        },
      };
      const fakeRegistration = {
        pushManager: {
          getSubscription: async () => currentSubscription,
          subscribe: async () => {
            currentSubscription = fakeSubscription;
            return fakeSubscription;
          },
        },
      };

      Object.defineProperty(window, 'PushManager', {
        configurable: true,
        value: function PushManager() {},
      });
      const mockNotification = {
        permission: 'default',
        requestPermission: async () => {
          mockNotification.permission = 'granted';
          return 'granted';
        },
      };
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: mockNotification,
      });
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { register: async () => fakeRegistration },
      });
    });

    let subscribeCalls = 0;
    let subscribeRequestCookie: string | null = null;
    await page.route('**/api/system/vapid-public-key', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ publicKey: FAKE_VAPID_PUBLIC_KEY }),
      }),
    );
    await page.route('**/api/system/push-subscribe', (route) => {
      subscribeCalls += 1;
      subscribeRequestCookie = route.request().headers().cookie ?? null;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    let unsubscribeCalls = 0;
    await page.route('**/api/system/push-unsubscribe', (route) => {
      unsubscribeCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    // The production suite now starts without a configured provider. This
    // push-client test owns subscription behavior, so keep the independently
    // tested setup launcher out of the path and enter Settings as a ready
    // Station would.
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
            detected: {},
          },
          capabilities: { chat: { ready: true, source: 'push-test' } },
        }),
      }),
    );

    await goToNotificationsSettings(page);

    // Install the simulated credential only for the operation under test.
    // Sending an intentionally fake credential during app bootstrap correctly
    // trips server auth rate limiting and obscures the push-client contract.
    await context.addCookies([
      {
        name: 'station-device',
        value: FAKE_DEVICE_CREDENTIAL,
        url: origin,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);

    const enableButton = page.getByRole('button', {
      name: 'Enable push notifications',
    });
    await expect(enableButton).toBeVisible();
    await enableButton.click();

    await expect(
      page.getByText('Subscribed to push notifications'),
    ).toBeVisible();
    expect(subscribeCalls).toBe(1);
    // The device credential travels as the station-device session cookie —
    // this is what makes the endpoint's identifyDevice() resolution work.
    expect(subscribeRequestCookie).toContain(
      `station-device=${FAKE_DEVICE_CREDENTIAL}`,
    );

    await page.getByRole('button', { name: 'Unsubscribe' }).click();

    await expect(enableButton).toBeVisible();
    expect(unsubscribeCalls).toBe(1);
    // Revoking/unsubscribing must not trigger another subscribe attempt —
    // the counter proves no further send/subscribe call happens afterward.
    expect(subscribeCalls).toBe(1);
  });
});
