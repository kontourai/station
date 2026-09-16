/**
 * Desktop runtime: the Device pane in the real Station shell (#1969).
 *
 * WHAT MAKES THIS DIFFERENT FROM `tests/device-pane.spec.ts`. That spec runs
 * in Chromium against the product's UI and serves the mobile-device namespace
 * through `page.route`, so the pane's RENDER is evidence and the service
 * behind it is not. This lane intercepts nothing. A real Tauri WebView loads
 * the real Station route, the real `LocalMobileDeviceHost` reads a real HTTP
 * endpoint, and the only thing standing in for production is the device
 * helper at the far end — a `node:http` server on loopback that answers the
 * two paths `expo-device-hub` answers. Everything between the WebView and
 * that socket is the shipping code path: the SDK client, the route's
 * principal recheck, the host's envelope parser, its PNG validator, and its
 * `emulator-<n>` rule.
 *
 * THE PROFILE MATTERS. `startTauriShellFixture` is asked NOT to seed the
 * plugin-host lane's mock remote profile, so the app injects its own bundled
 * local-owner profile (`setup_source: "local"`, no credential ref) pointing
 * at the sidecar it started. That is the one configuration in which the
 * WebView reaches a real Station route under real host authority; a seeded
 * `paired` profile would send the synthetic WebDriver bearer to a mock
 * server, and nothing about the real service would be exercised.
 *
 * THE PORT IS NOT INCIDENTAL. `parseMobileDeviceHubOrigin` accepts only
 * `http://127.0.0.1:<port>` where the port is four or five digits and is
 * neither 3000 nor 3141, and refuses anything at or below 1024. A
 * `listen(0)` could hand back a port outside that window, and the failure
 * would surface as `invalid-configuration` in the pane — a sentence that
 * reads like a product defect and is actually the fixture's. So the port is
 * allocated with the repository's own `findFreePortOutside` and then asserted
 * to PARSE before anything starts, which makes a bad allocation fail here,
 * loudly, by name.
 *
 * "Both native app targets" is the acceptance criterion, and it is driven
 * literally: select the iOS simulator, capture, screenshot; select the
 * Android emulator, capture, screenshot.
 *
 * WHAT IT STILL DOES NOT PROVE. The helper is a fixture, so this says nothing
 * about `expo-device-hub` itself, nor about what a real simulator screen
 * contains. It proves that Station, running as the desktop app, will read a
 * device helper over HTTP and put both platforms' frames on screen.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { findFreePortOutside } from '../../scripts/lib/free-ports.mjs';
import { parseMobileDeviceHubOrigin } from '../../src-server/services/mobile-device/mobile-device-host.js';
import {
  startTauriShellFixture,
  type TauriShellFixture,
} from './direct-webdriver.js';

const IOS_DEVICE_ID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const ANDROID_DEVICE_ID = 'emulator-5584';
const IOS_NAME = 'iPhone 17 Pro';
const ANDROID_NAME = 'Pixel 10 Pro XL';

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
 * A real PNG the HOST's own validator accepts.
 *
 * `LocalMobileDeviceHost.capture` re-reads these bytes: it checks the 8-byte
 * signature, that the first chunk is a 13-byte IHDR, that the file ends in
 * IEND, and it takes the frame's width and height from the IHDR rather than
 * from anything the helper says. A placeholder would be refused
 * `invalid-response`, so the fixture has to produce a genuine file — which
 * also means the dimensions asserted on screen came out of the PNG header,
 * not out of this test.
 */
function pngOfSize(
  width: number,
  height: number,
  bands: readonly (readonly [number, number, number])[],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
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
  ]);
}

const IOS_FRAME = pngOfSize(300, 650, [
  [220, 48, 48],
  [248, 248, 248],
  [32, 32, 32],
]);
const ANDROID_FRAME = pngOfSize(480, 640, [
  [40, 176, 96],
  [248, 248, 248],
  [32, 32, 32],
]);

/**
 * The inventory shape `LocalMobileDeviceHost.parseDevices` reads — `simulators`
 * and `emulators` as separate arrays, each row carrying `physical`, which it
 * uses to drop a plugged-in phone before anything else.
 *
 * The Android row is `emulator-5584` because the host refuses the WHOLE
 * inventory `invalid-response` when a BOOTED Android row is spelled any other
 * way. Both rows are booted because `capture` re-reads the inventory and
 * refuses `device-unavailable` for a target that is not.
 */
const HUB_INVENTORY = {
  simulators: [
    {
      platform: 'ios',
      id: IOS_DEVICE_ID,
      name: IOS_NAME,
      version: 'iOS 26.5',
      booted: true,
      physical: false,
    },
  ],
  emulators: [
    {
      platform: 'android',
      id: ANDROID_DEVICE_ID,
      name: ANDROID_NAME,
      version: 'Android 16',
      booted: true,
      physical: false,
    },
  ],
};

interface HubLog {
  requests: string[];
}

/**
 * The device helper, as the host expects to find it.
 *
 * Content types are exact on purpose: the host compares the first
 * `content-type` segment against `application/json` for the inventory and
 * `image/png` for a capture, and treats a mismatch as `invalid-response`. It
 * also refuses a redirect outright, so this never sends one.
 */
async function startFakeHub(port: number, log: HubLog): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    log.requests.push(`${request.method} ${url.pathname}`);
    if (request.method === 'GET' && url.pathname === '/api/devices') {
      const body = Buffer.from(JSON.stringify(HUB_INVENTORY));
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(body.byteLength),
      });
      response.end(body);
      return;
    }
    if (request.method === 'POST') {
      const device = url.searchParams.get('device');
      const frame =
        url.pathname === '/vendor/serve-sim/api/screenshot' &&
        device === IOS_DEVICE_ID
          ? IOS_FRAME
          : url.pathname === '/vendor/serve-emu/api/screenshot' &&
              device === ANDROID_DEVICE_ID
            ? ANDROID_FRAME
            : undefined;
      if (frame) {
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': String(frame.byteLength),
        });
        response.end(frame);
        return;
      }
    }
    // An unmodeled read is a fixture defect, and must never look like an
    // empty success: 404 makes the host report `hub-unavailable`, which the
    // pane renders as a named failure rather than as "no devices".
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'unmodeled fixture request' }));
  });
  await new Promise<void>((settle, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => settle());
  });
  return server;
}

async function closeServer(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((settle, fail) => {
    server.close((error) => (error ? fail(error) : settle()));
  });
}

const sleep = (ms: number) =>
  new Promise<void>((settle) => setTimeout(settle, ms));

async function main() {
  const outputDir = resolve(
    import.meta.dirname,
    '../../.kontourai/device-pane-e2e',
  );
  mkdirSync(outputDir, { recursive: true });

  // The port window `parseMobileDeviceHubOrigin` admits, allocated rather
  // than hoped for, and then PROVEN to parse before the app is started.
  const hubPort = await findFreePortOutside(20_000, 8);
  const hubOrigin = `http://127.0.0.1:${hubPort}`;
  assert.equal(
    parseMobileDeviceHubOrigin(hubOrigin),
    hubOrigin,
    `The allocated hub port ${hubPort} is outside the window Station accepts ` +
      '(four or five digits, above 1024, and neither 3000 nor 3141). This is ' +
      'a fixture fault, not a product one — allocate again rather than ' +
      'reading the pane’s invalid-configuration card as a defect.',
  );

  const log: HubLog = { requests: [] };
  let hub: Server | undefined;
  let fixture: TauriShellFixture | undefined;
  try {
    hub = await startFakeHub(hubPort, log);
    fixture = await startTauriShellFixture({
      env: { STATION_MOBILE_DEVICE_HUB_URL: hubOrigin },
      // Reach the app's OWN sidecar under local host authority. See the
      // module docblock: a seeded remote profile would prove nothing here.
      seedRemoteProfile: false,
    });
    const driver = fixture.driver;

    await driver.navigate('tauri://localhost/?surface=device');
    await driver.waitUntil(
      async () =>
        Boolean(await driver.findElement('.chat-dock[aria-label="Device"]')),
      {
        timeout: 60_000,
        timeoutMsg: 'The Device pane never appeared in the shell.',
      },
    );

    // The inventory came from the real service reading the fixture helper.
    // Asserting the helper was actually ASKED separates "the pane rendered
    // two rows" from "the pane rendered two rows because Station read them".
    await driver.waitUntil(
      async () => log.requests.includes('GET /api/devices'),
      {
        timeout: 30_000,
        timeoutMsg: 'Station never read the device helper’s inventory.',
      },
    );

    for (const target of [
      {
        platform: 'ios' as const,
        name: IOS_NAME,
        deviceId: IOS_DEVICE_ID,
        vendor: 'serve-sim',
        shot: 'device-pane-desktop-ios.png',
      },
      {
        platform: 'android' as const,
        name: ANDROID_NAME,
        deviceId: ANDROID_DEVICE_ID,
        vendor: 'serve-emu',
        shot: 'device-pane-desktop-android.png',
      },
    ]) {
      // Wait for the ROW, not for the helper's request log. The hub records
      // the inventory read the moment it is asked, but the answer still has
      // to travel back through the route, the SDK client, the query cache and
      // a render before a row exists — so keying this wait on the request is
      // keying it on an event that is already true while the DOM is still
      // empty, which is how one run in two failed here with the pane visibly
      // fine. The request assertion above keeps its own meaning: it is what
      // separates "two rows rendered" from "two rows rendered because Station
      // read them".
      let radio: string | undefined;
      await driver.waitUntil(
        async () => {
          radio = await driver.findElement(
            `.device-pane__choice input[value="${target.platform}:${target.deviceId}"]`,
          );
          return Boolean(radio);
        },
        {
          timeout: 30_000,
          timeoutMsg: `The ${target.name} row was never offered for selection.`,
        },
      );
      assert.ok(radio, `The ${target.name} row resolved empty.`);
      await driver.clickElement(radio);

      let capture: string | undefined;
      await driver.waitUntil(
        async () => {
          capture = await driver.findElement(
            '.device-pane__actions button.button--primary:not([disabled])',
          );
          return Boolean(capture);
        },
        {
          timeout: 30_000,
          timeoutMsg: `Capture never became pressable for ${target.name}.`,
        },
      );
      assert.ok(capture, 'Capture was reported pressable but not resolvable.');
      await driver.clickElement(capture);

      await driver.waitUntil(
        async () =>
          log.requests.some((entry) =>
            entry.endsWith(`/vendor/${target.vendor}/api/screenshot`),
          ),
        {
          timeout: 30_000,
          timeoutMsg: `Station never asked the helper for ${target.name}’s screen.`,
        },
      );
      await driver.waitUntil(
        async () => Boolean(await driver.findElement('.device-pane__image')),
        {
          timeout: 30_000,
          timeoutMsg: `No frame reached the shell for ${target.name}.`,
        },
      );

      const caption = await driver.execute(
        () =>
          document.querySelector('.device-pane__caption')?.textContent ?? '',
      );
      assert.ok(
        caption.includes('Snapshot') && caption.includes(target.name),
        `The caption did not name a snapshot of ${target.name}: ${caption}`,
      );

      // Let the frame paint before the screenshot, so the artifact shows what
      // the assertions above already established rather than a blank box.
      await sleep(500);
      writeFileSync(join(outputDir, target.shot), await driver.screenshot());
    }

    console.log(
      `device-pane e2e: both native app targets captured. Helper saw ${log.requests.length} request(s): ${log.requests.join(', ')}`,
    );
  } finally {
    // Teardown reports itself and never REPLACES the journey's outcome. A
    // throw from `finally` discards the in-flight exception entirely, so a
    // cleanup race once surfaced as the only error this lane printed and the
    // real result — pass or fail — was unrecoverable from the log.
    for (const [what, close] of [
      ['the shell fixture', () => fixture?.stop()],
      ['the fixture device helper', () => closeServer(hub)],
    ] as const) {
      try {
        await close();
      } catch (error) {
        console.error(`device-pane e2e: could not shut down ${what}:`, error);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
