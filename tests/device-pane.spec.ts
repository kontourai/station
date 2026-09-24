/**
 * E2E: the Device pane in a real browser (#1969, #1970).
 *
 * jsdom computes no layout, so this is where the pane is seen to RENDER:
 * the picker's rows and buttons are measured from laid-out boxes, and a
 * phone-width document is checked for sideways scroll.
 *
 * WHAT IS OBSERVED VERSUS SUPPLIED. The setup state is observed against the
 * REAL route with no interception — the isolated suite instance runs with
 * `STATION_MOBILE_DEVICE_HUB_URL` unset, so the real host answers
 * `not-configured` and the pane renders the setup slot. The populated
 * picker needs booted devices no runner has, so the device list (and the
 * empty session list) are supplied through `page.route` in the exact
 * envelopes the server emits; only the RENDER is evidence.
 *
 * WHAT THIS SPEC DOES NOT PROVE. It opens no live session, so it says
 * nothing about the live stream or input; the real-hub evidence for those is
 * `src-server/services/devices/__tests__/device-live.real.test.ts`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  documentFitsViewportWidth,
  FIRST_RENDER_TIMEOUT_MS,
  surfaceDockShell,
} from './helpers/region-placement';

/**
 * The 44px floor, compared with a tolerance rather than as an integer.
 *
 * A pixel floor is a statement about a rendered box, and a rendered box is a
 * float: Chromium composites a `min-height: 44px` row and reports
 * 43.99999237060547 for it, which is the same measurement and a failing
 * `>= 44`. A sibling suite is red on exactly that today (#2086). Encoding the
 * floor as an exact integer comparison would therefore be encoding a property
 * of the compositor's rounding, not the property the CSS declares — so the
 * comparison carries one hundredth of a pixel of slack, which no real
 * violation fits inside (the shortest thing this pane could regress to is a
 * default-height control, tens of pixels under).
 */
const TOUCH_FLOOR_PX = 44;
const TOUCH_FLOOR_EPSILON_PX = 0.01;

const IOS_DEVICE_ID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const ANDROID_DEVICE_ID = 'emulator-5584';
const IOS_NAME = 'iPhone 17 Pro';
const ANDROID_NAME = 'Pixel 10 Pro XL';

/**
 * One booted simulator and one booted emulator: the pair the acceptance
 * criterion names.
 *
 * The Android id is an `emulator-<n>` serial because
 * `LocalMobileDeviceHost.parseDevices` refuses the whole inventory
 * `invalid-response` when a BOOTED Android row is spelled any other way — so
 * a fixture with a friendlier id would be one the server could never emit.
 * The iOS id is a UDID for the same reason, enforced unconditionally there.
 */
const READY_INVENTORY = {
  hostId: 'local',
  state: 'ready',
  observedAt: '2026-09-14T10:00:00.000Z',
  devices: [
    {
      hostId: 'local',
      platform: 'ios',
      deviceId: IOS_DEVICE_ID,
      name: IOS_NAME,
      runtime: 'iOS 26.5',
      booted: true,
    },
    {
      hostId: 'local',
      platform: 'android',
      deviceId: ANDROID_DEVICE_ID,
      name: ANDROID_NAME,
      runtime: 'Android 16',
      booted: true,
    },
  ],
} as const;

/**
 * Serves the mobile-device namespace and nothing else: the device list and
 * the (empty) session list. Anything else inside the namespace fails the
 * test by name through `rejectUnexpectedFixtureRequest`.
 */
/** The host picker's answer with no SSH device hosts (#1973). */
const LOCAL_ONLY_HOSTS = [
  { hostId: 'local', label: 'This Station', kind: 'local' },
];

async function seedDeviceRoutes(page: Page, inventory: unknown): Promise<void> {
  await page.route('**/api/mobile-devices/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // #1973: the host picker's list — this Station only (no SSH hosts).
    if (
      request.method() === 'GET' &&
      path.endsWith('/api/mobile-devices/hosts')
    )
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { hosts: LOCAL_ONLY_HOSTS },
        }),
      });
    if (
      request.method() === 'GET' &&
      path.endsWith('/api/mobile-devices/hosts/local/devices')
    )
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: inventory }),
      });
    if (
      request.method() === 'GET' &&
      path.endsWith('/api/mobile-devices/hosts/local/sessions')
    )
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { sessions: [] } }),
      });
    return rejectUnexpectedFixtureRequest(route);
  });
}

function devicePane(page: Page): Locator {
  return surfaceDockShell(page, 'Device');
}

test.describe('Device pane', () => {
  test('answers the real route: an unconfigured Station renders the setup card, not an empty list', async ({
    page,
  }) => {
    // NO interception anywhere in this test. The suite instance runs with
    // STATION_MOBILE_DEVICE_HUB_URL unset, so this is the real
    // LocalMobileDeviceHost reporting `not-configured` through the real route
    // and the real SDK client, and the card below is the pane's own reading
    // of it. It is the one assertion in this file that costs nothing to make
    // honest, and the one that would notice the route disappearing.
    await page.goto('/?surface=device');
    const pane = devicePane(page);
    await expect(pane).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

    await expect(
      pane.getByText('Set up device inspection', { exact: true }),
      'an unconfigured Station must say it is unconfigured',
    ).toBeVisible();
    await expect(
      pane.getByText(/This Station is not running a device hub yet/),
    ).toBeVisible();
    // The way out is the managed hub's setup wizard (#1970).
    await expect(
      pane.getByRole('button', { name: 'Set up devices' }),
    ).toBeVisible();
    // A setup state is not a failure, so it offers no retry: re-reading an
    // absent configuration answers the same thing every time.
    await expect(
      pane.getByRole('button', { name: /Refresh/ }),
      'the setup card must not offer a retry for a configuration that is absent',
    ).toHaveCount(0);
    // And it is not a device list: nothing here may read as "no devices".
    await expect(
      pane.getByRole('heading', { name: 'iOS Simulators' }),
    ).toHaveCount(0);
  });

  test('groups both native targets by platform, each offered for opening', async ({
    page,
  }) => {
    await seedDeviceRoutes(page, READY_INVENTORY);
    await page.goto('/?surface=device');
    const pane = devicePane(page);
    await expect(pane).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await expect(
      pane.getByRole('region', { name: 'iOS Simulators' }),
    ).toContainText(IOS_NAME);
    await expect(
      pane.getByRole('region', { name: 'Android Emulators' }),
    ).toContainText(ANDROID_NAME);
    for (const name of [IOS_NAME, ANDROID_NAME])
      await expect(
        pane.getByRole('button', { name: `Open ${name}` }),
      ).toBeEnabled();
  });
});

test.describe('Device pane at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('gives the picker rows and their Open controls a thumb-sized target on a phone', async ({
    page,
  }) => {
    await seedDeviceRoutes(page, READY_INVENTORY);
    await page.goto('/?surface=device');
    const pane = devicePane(page);
    await expect(pane).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

    expect(
      await documentFitsViewportWidth(page),
      'the Device pane must not push the phone document sideways',
    ).toBe(true);

    const rows = pane.locator('.device-pane__row');
    await expect(rows).toHaveCount(READY_INVENTORY.devices.length);
    const heights = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height),
    );
    for (const [index, height] of heights.entries())
      expect(
        height,
        `device picker row ${index} is under the phone tap floor at 390px`,
      ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - TOUCH_FLOOR_EPSILON_PX);

    for (const name of [IOS_NAME, ANDROID_NAME]) {
      const box = await pane
        .getByRole('button', { name: `Open ${name}` })
        .boundingBox();
      expect(
        box?.height,
        `Open ${name} must be a phone tap target`,
      ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - TOUCH_FLOOR_EPSILON_PX);
    }
  });
});

/**
 * #1971 (S4): the Tools drawer, laid out, on a phone. What is OBSERVED is the
 * rendered drawer's geometry; what is SUPPLIED (through `page.route`, in the
 * exact envelopes the server emits) is one open session and the device's
 * read-back values, because no runner has a booted simulator. The live
 * surface is not intercepted: the real server answers that it does not know
 * the fixture's surface, and the drawer does not depend on the stream.
 */
const TOOLS_SNAPSHOT = {
  hostId: 'local',
  platform: 'ios',
  deviceId: IOS_DEVICE_ID,
  readAt: '2026-09-23T10:00:00.000Z',
  foregroundApp: { state: 'read', value: { appId: 'com.apple.Preferences' } },
  appearance: { state: 'read', value: 'dark' },
  location: { state: 'unreadable', reason: 'unsupported' },
  capabilities: {
    appearance: true,
    location: true,
    clearLocation: true,
    push: true,
    permissions: [
      'calendar',
      'contacts',
      'location',
      'media-library',
      'microphone',
      'motion',
      'photos',
      'reminders',
    ],
    permissionDecisions: ['grant', 'revoke', 'reset'],
    accessibility: true,
  },
} as const;

const OPEN_SESSION = {
  sessionId: '0000beef-aaaa-4bbb-8ccc-dddddddddddd',
  surfaceId: 'device:ios:0000beef-aaaa-4bbb-8ccc-dddddddddddd',
  hostId: 'local',
  platform: 'ios',
  deviceId: IOS_DEVICE_ID,
  name: IOS_NAME,
  runtime: 'iOS 26.5',
  openedAt: '2026-09-23T10:00:00.000Z',
} as const;

async function seedDrawerRoutes(page: Page): Promise<void> {
  const sessions: unknown[] = [];
  await page.route('**/api/mobile-devices/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const ok = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    if (
      request.method() === 'GET' &&
      path.endsWith('/api/mobile-devices/hosts')
    )
      return ok({ hosts: LOCAL_ONLY_HOSTS });
    if (request.method() === 'GET' && path.endsWith('/hosts/local/devices'))
      return ok(READY_INVENTORY);
    if (request.method() === 'GET' && path.endsWith('/hosts/local/sessions'))
      return ok({ sessions });
    if (
      request.method() === 'POST' &&
      path.endsWith(`/devices/ios/${IOS_DEVICE_ID}/sessions`)
    ) {
      sessions.push(OPEN_SESSION);
      return ok(OPEN_SESSION);
    }
    if (
      request.method() === 'GET' &&
      path.endsWith(`/devices/ios/${IOS_DEVICE_ID}/tools`)
    )
      return ok(TOOLS_SNAPSHOT);
    return rejectUnexpectedFixtureRequest(route);
  });
}

test.describe('Device Tools drawer at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('overlays the stage, fits the phone, and gives every control a thumb-sized target', async ({
    page,
  }) => {
    await seedDrawerRoutes(page);
    await page.goto('/?surface=device');
    const pane = devicePane(page);
    await expect(pane).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await pane.getByRole('button', { name: `Open ${IOS_NAME}` }).click();
    await pane.getByRole('button', { name: 'Tools', exact: true }).click();
    const drawer = pane.getByRole('complementary', { name: 'Tools' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('com.apple.Preferences')).toBeVisible();

    // Below 560px of pane width the drawer OVERLAYS the stage.
    await expect(drawer).toHaveAttribute('data-layout', 'overlay');
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox, 'the drawer must be laid out').not.toBeNull();
    expect(drawerBox!.x).toBeGreaterThanOrEqual(-TOUCH_FLOOR_EPSILON_PX);
    expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(
      390 + TOUCH_FLOOR_EPSILON_PX,
    );
    expect(drawerBox!.width).toBeLessThanOrEqual(288 + TOUCH_FLOOR_EPSILON_PX);
    expect(
      await documentFitsViewportWidth(page),
      'the open drawer must not push the phone document sideways',
    ).toBe(true);

    const controls = await drawer
      .locator('button, input, select, textarea')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return {
            name:
              element.getAttribute('aria-label') ||
              (element as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
              element.textContent?.trim() ||
              element.tagName,
            height: box.height,
            right: box.right,
          };
        }),
      );
    // Refresh, Close, Light/Dark, frames toggle, push fields + Send, the
    // three presets, both coordinates, Set + Clear, the permission fields,
    // three decisions and Read: the whole drawer, not a sample.
    expect(controls.length).toBeGreaterThanOrEqual(20);
    for (const control of controls) {
      expect(
        control.height,
        `${control.name} is under the phone tap floor at 390px`,
      ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - TOUCH_FLOOR_EPSILON_PX);
      expect(
        control.right,
        `${control.name} overflows the drawer sideways`,
      ).toBeLessThanOrEqual(
        drawerBox!.x + drawerBox!.width + TOUCH_FLOOR_EPSILON_PX,
      );
    }
  });
});
