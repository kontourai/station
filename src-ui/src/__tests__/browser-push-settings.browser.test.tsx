import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const fixture = `
import { createRoot } from 'react-dom/client';
import { PushNotificationsProvider } from './src-ui/src/contexts/PushNotificationsContext';
import { usePushNotifications } from './src-ui/src/hooks/usePushNotifications';
import { BrowserPushStatus } from './src-ui/src/views/settings/BrowserPushStatus';
function Settings() {
  const push = usePushNotifications({ enabled: true, apiBase: window.location.origin });
  return <PushNotificationsProvider value={push}>
    <main className="settings"><h1>Notifications</h1><BrowserPushStatus /></main>
  </PushNotificationsProvider>;
}
createRoot(document.getElementById('root')).render(<Settings />);
`;

test('Web Push Settings distinguishes authentication, access and unsupported responses', async () => {
  let status = 401;
  const { browser, page, errors } = await scrollBrowserFixture(
    fixture,
    [],
    {},
    async (page) => {
      await page.addInitScript(() => {
        const subscription = {
          endpoint: 'https://push.example.test/current',
          options: { applicationServerKey: Uint8Array.from([1, 0, 1]).buffer },
          toJSON: () => ({
            endpoint: 'https://push.example.test/current',
            keys: { p256dh: 'p', auth: 'a' },
          }),
        };
        const worker = {
          pushManager: { getSubscription: async () => subscription },
        };
        Object.defineProperty(navigator, 'serviceWorker', {
          value: {
            getRegistration: async () => worker,
            register: async () => worker,
          },
        });
        Object.defineProperty(window, 'PushManager', {
          value: class PushManager {},
        });
        Object.defineProperty(window, 'Notification', {
          value: { permission: 'granted' },
        });
      });
      await page.route(
        'http://station.test/api/system/vapid-public-key',
        (route) =>
          route.fulfill({ status, json: { error: 'fixture_refusal' } }),
      );
    },
  );
  try {
    for (const path of ['../index.css', '../views/SettingsView.css']) {
      await page.addStyleTag({
        content: resolveCssImports(resolve(import.meta.dirname, path)),
      });
    }
    const feedback = page.locator('.settings__notif-error');
    await feedback.waitFor({ timeout: 5000 });
    const capture = process.env.STATION_WEB_PUSH_CAPTURE_DIR;
    if (capture) {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(
            (value) =>
              document.documentElement.setAttribute('data-theme', value),
            theme,
          );
          await page.screenshot({
            animations: 'disabled',
            path: resolve(capture, `push-${width}-${theme}.png`),
          });
        }
      }
    }
    expect(await feedback.textContent()).toContain('Sign in to this Station');
    for (const [code, expected] of [
      [403, 'refused Web Push access'],
      [404, 'unavailable on this Station'],
    ] as const) {
      status = code;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect.poll(() => feedback.textContent()).toContain(expected);
    }
    expect(
      await page.getByText('Subscribed to push notifications').count(),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
