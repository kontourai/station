/**
 * E2E: the Device pane in a real browser (#1969).
 *
 * WHY THIS SPEC EXISTS. Five jsdom suites already pin this pane's behaviour,
 * and jsdom computes no layout — so the aspect-ratio assertions there read a
 * CSS custom property off the element's inline style and no fixture had ever
 * seen the pane RENDER. `docs/ui/responsive-action-surfaces.txt` recorded that
 * honestly, as `exception`. Everything measured here is measured from a laid
 * out box in Chromium: a frame's used width and height, a tap target's
 * `getBoundingClientRect`, a document that does or does not scroll sideways.
 *
 * WHAT IS OBSERVED VERSUS SUPPLIED. The setup state is observed against the
 * REAL route with no interception at all — the isolated suite instance runs
 * with `STATION_MOBILE_DEVICE_HUB_URL` unset, so `LocalMobileDeviceHost`
 * genuinely answers `not-configured` and the pane genuinely renders the
 * first-run card. Nothing in that test is supplied. The populated states
 * cannot be: they need a booted simulator and a booted emulator on the
 * runner, so their inventory and their frames are supplied through
 * `page.route` and only the RENDER is evidence. Every fixture is the exact
 * envelope the server emits (`mobile-device-host.ts`), and the PNGs are real
 * PNGs — built here, structurally valid, and accepted by both the SDK
 * client's base64 check and the host's own IHDR/IEND validation — rather than
 * a placeholder string that would prove the frame decodes when it does not.
 *
 * "Both native app targets" means one iOS simulator and one Android emulator,
 * each selected and each captured, in that order.
 *
 * WHAT THIS SPEC DOES NOT PROVE. It never reaches a device helper, so it says
 * nothing about `expo-device-hub`, about what a real simulator screen looks
 * like, or about the capture route's own authorization. The desktop-runtime
 * lane (`tests/tauri-shell/device-pane.e2e.ts`) is the one that drives the
 * real service against a real hub.
 */
import { deflateSync } from 'node:zlib';
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let remainder = 0xffffffff;
  for (const byte of bytes)
    remainder = (CRC_TABLE[(remainder ^ byte) & 0xff] ?? 0) ^ (remainder >>> 8);
  return (remainder ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

/**
 * A real PNG of exactly these dimensions, in three horizontal bands.
 *
 * Real bytes rather than a reused 1x1 placeholder for two reasons. The bitmap
 * has to DECODE for the frame to show anything, and a screenshot of this test
 * is only readable as evidence if the bands are visible — a 1x1 stretched by
 * `object-fit: contain` is a flat rectangle that proves nothing about whether
 * the image element received a frame at all. It is also structurally valid to
 * the server's own reader (8-byte signature, a 13-byte IHDR, a terminating
 * IEND), so the identical helper serves the desktop lane's fake hub.
 */
function pngOfSize(
  width: number,
  height: number,
  bands: readonly (readonly [number, number, number])[],
): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // no per-row filter
    const band = bands[Math.floor((y * bands.length) / height) % bands.length];
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = band?.[0] ?? 0;
      raw[pixel + 1] = band?.[1] ?? 0;
      raw[pixel + 2] = band?.[2] ?? 0;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

interface CaptureFixture {
  width: number;
  height: number;
  bands: readonly (readonly [number, number, number])[];
}

/** Portrait, landscape (the same device rotated), and a differently shaped emulator. */
const IOS_PORTRAIT: CaptureFixture = {
  width: 300,
  height: 650,
  bands: [
    [220, 48, 48],
    [248, 248, 248],
    [32, 32, 32],
  ],
};
const IOS_LANDSCAPE: CaptureFixture = {
  width: 650,
  height: 300,
  bands: [
    [32, 96, 220],
    [248, 248, 248],
    [32, 32, 32],
  ],
};
const ANDROID_PORTRAIT: CaptureFixture = {
  width: 480,
  height: 640,
  bands: [
    [40, 176, 96],
    [248, 248, 248],
    [32, 32, 32],
  ],
};

/**
 * The capture envelope, with `capturedAt` a fixed distance in the PAST.
 *
 * Ten seconds rather than "now": it is comfortably inside the 30-second
 * staleness threshold, so this is a CURRENT frame, but its seconds field
 * differs from the wall clock at render — which is what makes the caption
 * assertion able to tell a time derived from `capture.capturedAt` apart from
 * one derived from `Date.now()`. A capture stamped at the moment of render
 * would satisfy both readings and prove neither.
 */
function captureEnvelope(
  platform: 'ios' | 'android',
  deviceId: string,
  fixture: CaptureFixture,
  capturedAt: string,
) {
  return {
    captureId: `capture-${platform}-${fixture.width}x${fixture.height}`,
    target: { hostId: 'local', platform, deviceId },
    capturedAt,
    mimeType: 'image/png',
    width: fixture.width,
    height: fixture.height,
    pngBase64: pngOfSize(fixture.width, fixture.height, fixture.bands),
  };
}

function tenSecondsAgo(): string {
  return new Date(Date.now() - 10_000).toISOString();
}

type CaptureAnswer =
  | { fixture: CaptureFixture; capturedAt: string }
  | { status: number };

/**
 * Serves the mobile-device namespace and nothing else.
 *
 * Only `/api/mobile-devices/**` is intercepted, so every other read this page
 * makes — the shell, the config, the projects — still reaches the real
 * Station. Anything inside the namespace that is not modeled here falls to
 * `rejectUnexpectedFixtureRequest`, which fails the test by name rather than
 * answering an unmodeled read with an empty success.
 */
async function seedDeviceRoutes(
  page: Page,
  answers: {
    inventory?: unknown;
    captures?: Partial<Record<'ios' | 'android', CaptureAnswer[]>>;
  },
): Promise<void> {
  const queues = {
    ios: [...(answers.captures?.ios ?? [])],
    android: [...(answers.captures?.android ?? [])],
  };
  await page.route('**/api/mobile-devices/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      request.method() === 'GET' &&
      path.endsWith('/api/mobile-devices/hosts/local/devices') &&
      answers.inventory
    )
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: answers.inventory }),
      });
    const capture = /\/devices\/(ios|android)\/([^/]+)\/capture$/.exec(path);
    if (request.method() === 'POST' && capture) {
      const platform = capture[1] as 'ios' | 'android';
      const deviceId = decodeURIComponent(capture[2] ?? '');
      const next = queues[platform].shift();
      if (!next) return rejectUnexpectedFixtureRequest(route);
      if ('status' in next)
        return route.fulfill({
          status: next.status,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, code: 'access-denied' }),
        });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: captureEnvelope(
            platform,
            deviceId,
            next.fixture,
            next.capturedAt,
          ),
        }),
      });
    }
    return rejectUnexpectedFixtureRequest(route);
  });
}

function devicePane(page: Page): Locator {
  return surfaceDockShell(page, 'Device');
}

function deviceRadio(page: Page, name: string): Locator {
  return devicePane(page).getByRole('radio', { name: new RegExp(name) });
}

function captureControl(page: Page): Locator {
  return devicePane(page).getByRole('button', { name: 'Capture', exact: true });
}

/**
 * The frame's USED aspect ratio, from its laid out box.
 *
 * `getBoundingClientRect` rather than `getComputedStyle(el).aspectRatio`: the
 * computed property is the declaration echoed back — it reads
 * `--device-frame-ratio` and says what the stylesheet asked for whether or not
 * anything laid out that way. The rect is what the compositor produced, which
 * is the only reading that can fail when the frame does not honour the ratio.
 */
async function frameRatio(page: Page): Promise<number> {
  return page.locator('.device-pane__frame').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.height === 0 ? Number.NaN : box.width / box.height;
  });
}

/** The browser's own rendering of an instant, which is what the caption prints. */
async function localeTime(page: Page, iso: string): Promise<string> {
  return page.evaluate((value) => new Date(value).toLocaleTimeString(), iso);
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
      pane.getByText(
        /Point STATION_MOBILE_DEVICE_HUB_URL at a local device helper/,
      ),
    ).toBeVisible();
    // A setup state is not a failure, so it offers no retry: re-reading an
    // absent configuration answers the same thing every time.
    await expect(
      pane.getByRole('button', { name: 'Refresh', exact: true }),
      'the setup card must not offer a retry for a configuration that is absent',
    ).toHaveCount(0);
    // And it is not a device list: nothing here may read as "no devices".
    await expect(pane.getByRole('radio')).toHaveCount(0);
  });

  test('renders both native app targets, and the frame takes its shape from each capture', async ({
    page,
  }) => {
    const iosFirst = tenSecondsAgo();
    const iosRotated = tenSecondsAgo();
    const androidAt = tenSecondsAgo();
    await seedDeviceRoutes(page, {
      inventory: READY_INVENTORY,
      captures: {
        ios: [
          { fixture: IOS_PORTRAIT, capturedAt: iosFirst },
          { fixture: IOS_LANDSCAPE, capturedAt: iosRotated },
        ],
        android: [{ fixture: ANDROID_PORTRAIT, capturedAt: androidAt }],
      },
    });
    await page.goto('/?surface=device');
    const pane = devicePane(page);
    await expect(pane).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

    // BOTH PLATFORMS SELECTABLE. Each booted row is an enabled radio; a row
    // the client could not address would be disabled and carry its reason,
    // so "enabled" is the observable that separates them.
    const ios = deviceRadio(page, IOS_NAME);
    const android = deviceRadio(page, ANDROID_NAME);
    await expect(ios).toBeEnabled();
    await expect(android).toBeEnabled();
    await expect(
      captureControl(page),
      'Capture must not be offered before a device is chosen',
    ).toBeDisabled();

    // The view-only line is a property of the build, so it is present before
    // any frame exists as well as beside one.
    const viewOnly = pane.getByText(
      'View only — taps and typing are not sent to this device.',
      { exact: true },
    );
    await expect(viewOnly).toBeVisible();

    // --- iOS simulator, portrait ---
    await ios.check();
    await expect(captureControl(page)).toBeEnabled();
    await captureControl(page).click();

    const iosTime = await localeTime(page, iosFirst);
    const portraitImage = pane.getByRole('img', {
      name: new RegExp(
        `^Snapshot of ${IOS_NAME}, captured ${escapeRegExp(iosTime)}`,
      ),
    });
    await expect(portraitImage).toBeVisible();
    // The alt text carries the word and the time, which is what a reader who
    // reaches the image rather than the caption is told.
    await expect(
      pane.locator('.device-pane__caption'),
      'the caption names the snapshot, the platform and the time it was taken',
    ).toHaveText(
      new RegExp(
        `^Snapshot of ${IOS_NAME} · iOS · captured ${escapeRegExp(iosTime)}`,
      ),
    );

    // OBSERVED PIXELS. The frame's laid out box, not its declared ratio.
    await expect
      .poll(() => frameRatio(page), {
        message: 'the frame must lay out at the portrait capture’s own ratio',
      })
      .toBeCloseTo(IOS_PORTRAIT.width / IOS_PORTRAIT.height, 2);
    const portraitBox = await page.locator('.device-pane__frame').boundingBox();
    expect(
      portraitBox && portraitBox.height > portraitBox.width,
      'a 300x650 capture must produce a box taller than it is wide',
    ).toBe(true);

    // --- the same device, rotated ---
    await captureControl(page).click();
    const rotatedTime = await localeTime(page, iosRotated);
    await expect(
      pane.getByRole('img', {
        name: new RegExp(
          `^Snapshot of ${IOS_NAME}, captured ${escapeRegExp(rotatedTime)}`,
        ),
      }),
    ).toBeVisible();
    await expect
      .poll(() => frameRatio(page), {
        message:
          'a rotated capture reports the other way round, so the frame must relayout',
      })
      .toBeCloseTo(IOS_LANDSCAPE.width / IOS_LANDSCAPE.height, 2);
    const landscapeBox = await page
      .locator('.device-pane__frame')
      .boundingBox();
    expect(
      landscapeBox && landscapeBox.width > landscapeBox.height,
      'a 650x300 capture must produce a box wider than it is tall',
    ).toBe(true);

    // --- Android emulator ---
    await android.check();
    // Switching devices drops the previous frame rather than hiding it, so
    // there is no window in which one device's picture wears another's name.
    await expect(page.locator('.device-pane__frame')).toHaveCount(0);
    await captureControl(page).click();

    const androidTime = await localeTime(page, androidAt);
    await expect(
      pane.getByRole('img', {
        name: new RegExp(
          `^Snapshot of ${ANDROID_NAME}, captured ${escapeRegExp(androidTime)}`,
        ),
      }),
    ).toBeVisible();
    await expect(pane.locator('.device-pane__caption')).toHaveText(
      new RegExp(
        `^Snapshot of ${ANDROID_NAME} · Android · captured ${escapeRegExp(androidTime)}`,
      ),
    );
    await expect
      .poll(() => frameRatio(page), {
        message:
          'the emulator frame must lay out at the emulator capture’s ratio',
      })
      .toBeCloseTo(ANDROID_PORTRAIT.width / ANDROID_PORTRAIT.height, 2);

    await expect(
      viewOnly,
      'the view-only line stays beside a frame',
    ).toBeVisible();
  });

  test('keeps Capture offered when the Station refuses the capture', async ({
    page,
  }) => {
    await seedDeviceRoutes(page, {
      inventory: READY_INVENTORY,
      captures: { ios: [{ status: 403 }] },
    });
    await page.goto('/?surface=device');
    const pane = devicePane(page);
    await expect(pane).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

    await deviceRadio(page, IOS_NAME).check();
    await captureControl(page).click();

    await expect(
      pane.getByText('This Station refused the screen capture', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      pane.getByText(
        /A read-only credential can list devices but not capture their screens/,
      ),
    ).toBeVisible();

    // The amended decision on #1969: a refusal withholds a SECOND button that
    // would duplicate Capture, not Capture itself. One of the two causes the
    // copy names — a sign-in that changed since the pane opened — is
    // repairable in place, and the very next Capture is the retry. Removing
    // or disabling the control would strand that reader at a dead end.
    await expect(
      captureControl(page),
      'an access-denied refusal must leave Capture pressable, because it IS the retry',
    ).toBeEnabled();
    await expect(
      pane.getByRole('button', { name: 'Try again', exact: true }),
      'access-denied offers no remedy of its own, so it adds no second button',
    ).toHaveCount(0);
  });
});

test.describe('Device pane at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('gives the picker rows and Capture a thumb-sized target on a phone', async ({
    page,
  }) => {
    await seedDeviceRoutes(page, { inventory: READY_INVENTORY });
    await page.goto('/?surface=device');
    const pane = devicePane(page);
    await expect(pane).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

    expect(
      await documentFitsViewportWidth(page),
      'the Device pane must not push the phone document sideways',
    ).toBe(true);

    // Measured from the laid out rows, which is the whole point: the
    // `min-height: 44px` in DeviceWorkspacePane.css is a declaration, and
    // until now nothing had watched it produce a box.
    const rows = pane.locator('.device-pane__choice');
    await expect(rows).toHaveCount(READY_INVENTORY.devices.length);
    const heights = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height),
    );
    for (const [index, height] of heights.entries())
      expect(
        height,
        `device picker row ${index} is under the phone tap floor at 390px`,
      ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - TOUCH_FLOOR_EPSILON_PX);

    const captureBox = await captureControl(page).boundingBox();
    expect(
      captureBox?.height,
      'Capture is the pane’s primary action and must be a phone tap target',
    ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - TOUCH_FLOOR_EPSILON_PX);
  });
});

/** Device names and locale times go into `RegExp`; neither may act as syntax. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
