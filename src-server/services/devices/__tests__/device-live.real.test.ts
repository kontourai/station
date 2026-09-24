import { execFile, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { LiveSurfaceStreamParams } from '@kontourai/station-contracts/live-surface';
import type { MobileDeviceSummary } from '@kontourai/station-contracts/mobile-device';
import { afterAll, describe, expect, test } from 'vitest';
import {
  dispatchHumanInput,
  LiveSurfaceRegistry,
} from '../../live-surface/registry.js';
import { LocalMobileDeviceHost } from '../../mobile-device/mobile-device-host.js';
import { jpegSize } from '../device-frame-codecs.js';
import {
  createDeviceHostActions,
  locateExecutable,
  standardFfmpegDirs,
} from '../device-host-tools.js';
import { explicitDeviceHubEndpoint } from '../device-hub-endpoint.js';
import { DeviceSessionService } from '../device-session-service.js';
import { createFfmpegDecoderProvider } from '../h264-jpeg-decoder.js';

/**
 * REAL device-surface evidence (#1970), against a real device hub and a real
 * simulator/emulator. Nothing here is mocked; every case SKIPS, naming why,
 * when what it needs is absent:
 *
 * - `STATION_REAL_DEVICE_HUB_URL`: an explicitly started expo-device-hub
 *   (see experiments/mobile-device/README.md), e.g. http://127.0.0.1:43891.
 * - iOS uses an already-booted simulator; with `STATION_REAL_DEVICE_BOOT=1`
 *   it boots one through the hub (Start) and powers it off afterwards.
 * - Android runs only with `STATION_REAL_DEVICE_ANDROID=1` (it boots the
 *   `station-test` AVD, which is heavy) and powers it off afterwards.
 * - The ffmpeg decode case needs an installed ffmpeg.
 *
 * Classified process-heavy in scripts/vitest-resource-manifest.mjs.
 */

const HUB = process.env.STATION_REAL_DEVICE_HUB_URL;
const BOOT = process.env.STATION_REAL_DEVICE_BOOT === '1';
const ANDROID = process.env.STATION_REAL_DEVICE_ANDROID === '1';
/** Optional file to append one JSON evidence line per observation to. */
const EVIDENCE = process.env.STATION_REAL_DEVICE_EVIDENCE;

function record(fact: Record<string, unknown>): void {
  if (EVIDENCE)
    appendFileSync(
      EVIDENCE,
      `${JSON.stringify({ at: new Date().toISOString(), ...fact })}\n`,
    );
}
const run = promisify(execFile);
const PARAMS: LiveSurfaceStreamParams = {
  maxFps: 10,
  quality: 60,
  maxWidth: 1280,
  maxHeight: 1280,
};
const HUMAN = {
  kind: 'human' as const,
  principal: 'operator',
  device: 'real-test',
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse())
    await cleanup().catch((error) =>
      record({ step: 'cleanup-failed', error: String(error) }),
    );
}, 120_000);

function harness() {
  const endpoint = explicitDeviceHubEndpoint(HUB);
  const host = new LocalMobileDeviceHost({ hub: endpoint, timeoutMs: 30_000 });
  const registry = new LiveSurfaceRegistry({ dispatchTimeoutMs: 15_000 });
  const errors: string[] = [];
  const sessions = new DeviceSessionService({
    host,
    endpoint,
    surfaces: registry,
    // The operator, for any request: this case proves streaming and input,
    // not authorization (the route suites cover D5/D12).
    access: {
      isOperator: async () => true,
      hasStanding: async () => true,
      mayAccessDevice: async () => true,
    },
    decoder: createFfmpegDecoderProvider(),
    actions: createDeviceHostActions(),
    onError: (message, error) => errors.push(`${message}: ${String(error)}`),
  });
  cleanups.push(async () => {
    await sessions.dispose();
    await registry.dispose();
  });
  return { endpoint, host, registry, sessions, errors };
}

async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function liveEvidence(
  env: ReturnType<typeof harness>,
  device: MobileDeviceSummary,
): Promise<{ frames: number; width: number; height: number; codec: string }> {
  const session = await env.sessions.open(
    { hostId: 'local', platform: device.platform, deviceId: device.deviceId },
    () => true,
  );
  const entry = env.registry.get(session.surfaceId);
  expect(entry).toBeDefined();
  const viewer = entry!.hub.attach(PARAMS);
  cleanups.push(async () => viewer.close());
  let frames = 0;
  let first: { width: number; height: number; codec: string } | undefined;
  // A cold emulator can take minutes before its first frame.
  const deadline = Date.now() + 180_000;
  while (frames < 3 && Date.now() < deadline) {
    const record = await viewer.next();
    if (record?.kind !== 'frame') continue;
    frames += 1;
    first ??= {
      width: record.header.width,
      height: record.header.height,
      codec: record.header.codec,
    };
  }
  record({
    step: 'frames',
    platform: device.platform,
    frames,
    first,
    state: entry!.hub.state(),
    errors: [...env.errors],
  });
  expect(frames).toBeGreaterThanOrEqual(1);
  await until(
    () => (entry!.hub.state().inputChannel === 'connected' ? true : undefined),
    'input channel',
    30_000,
  );
  const foreground = async () => {
    if (device.platform !== 'ios') return null;
    const connection = await env.endpoint.connect();
    if (!connection.ok) return null;
    const response = await connection.connection.request(
      'GET',
      `/vendor/serve-sim/helper/${device.deviceId}/foreground`,
    );
    return `${response.status} ${(await response.text()).slice(0, 300)}`;
  };
  // A just-booted simulator ignores HID until SpringBoard is up: wait for
  // the boot to finish (test setup, not product code).
  if (device.platform === 'ios')
    await run('xcrun', ['simctl', 'bootstatus', device.deviceId], {
      windowsHide: true,
      timeout: 120_000,
    }).catch((error) =>
      record({ step: 'bootstatus-failed', error: String(error) }),
    );
  if (device.platform === 'android')
    await until(
      async () =>
        (
          await run(
            'adb',
            ['-s', device.deviceId, 'shell', 'getprop', 'sys.boot_completed'],
            { windowsHide: true },
          ).catch(() => ({ stdout: '' }))
        ).stdout.trim() === '1'
          ? true
          : undefined,
      'Android boot to complete',
      180_000,
    );
  if (device.platform === 'ios')
    await run(
      'xcrun',
      ['simctl', 'launch', device.deviceId, 'com.apple.Preferences'],
      {
        windowsHide: true,
      },
    ).catch((error) =>
      record({ step: 'launch-settings-failed', error: String(error) }),
    );
  else
    await run(
      'adb',
      [
        '-s',
        device.deviceId,
        'shell',
        'am',
        'start',
        '-a',
        'android.settings.SETTINGS',
      ],
      { windowsHide: true },
    ).catch((error) =>
      record({ step: 'launch-settings-failed', error: String(error) }),
    );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const before = await foreground();
  const androidTop = async () =>
    device.platform === 'android'
      ? ((
          await run(
            'adb',
            [
              '-s',
              device.deviceId,
              'shell',
              'dumpsys',
              'activity',
              'activities',
            ],
            { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
          )
        ).stdout
          .split('\n')
          .find((line) => /topResumedActivity|mResumedActivity/.test(line))
          ?.trim() ?? null)
      : null;
  const androidBefore = await androidTop();
  const result = await dispatchHumanInput(
    entry!,
    HUMAN,
    entry!.lease.snapshot().epoch,
    [{ kind: 'device-button', button: 'home' }],
  );
  expect(result).toMatchObject({ ok: true, accepted: 1 });
  // The press must MOVE the foreground away from Settings (to SpringBoard).
  const after = await until(
    async () => {
      const now = await foreground();
      return now === null || !now.includes('com.apple.Preferences')
        ? now
        : undefined;
    },
    'Home to leave Settings',
    15_000,
  ).catch(() => foreground());
  if (device.platform === 'ios')
    expect(after).toContain('com.apple.springboard');
  const androidAfter =
    device.platform === 'android'
      ? await until(
          async () => {
            const top = await androidTop();
            return top && !top.includes('com.android.settings')
              ? top
              : undefined;
          },
          'Home to leave Settings',
          15_000,
        ).catch(() => androidTop())
      : null;
  if (device.platform === 'android')
    expect(androidAfter).not.toContain('com.android.settings');
  record({
    step: 'home',
    platform: device.platform,
    device: device.name,
    result,
    foregroundBefore: before ?? androidBefore,
    foregroundAfter: after ?? androidAfter,
    state: entry!.hub.state(),
    errors: env.errors,
  });
  viewer.close();
  await env.sessions.close(session.sessionId);
  return { frames, ...first! };
}

const DECODE_FRAMES = 30;

describe('real ffmpeg decode (Android pipeline, no device)', () => {
  // yuv420p LIMITED range is what emulators and screen encoders emit; the
  // mjpeg encoder refuses it unless the filter chain converts to full range
  // (a yuv444p fixture passed while the real format produced zero images).
  // `minLive` is how many frames must come out while input is still OPEN:
  // a live screen never sends EOF. B-frames cost a little reorder delay.
  const LIMITED = [
    '-x264-params',
    'fullrange=off:colorprim=bt709:transfer=bt709:colormatrix=bt709',
  ];
  // `test.for`, not `test.each`: only `for` hands the test its context, so
  // only `for` can SKIP. Under `each` the second argument is undefined and a
  // host without ffmpeg (a Linux CI runner) FAILED on `context.skip`.
  test.for([
    {
      // The ORIGINAL defect's trigger: yuv420p with an UNKNOWN colour range
      // (no VUI range at all), which with `-fflags nobuffer` produced
      // nothing.
      name: 'unknown range (no range signalled)',
      encode: ['-tune', 'zerolatency', '-bf', '0'],
      minLive: DECODE_FRAMES - 2,
    },
    {
      name: 'baseline, limited range signalled (screen encoder, no B-frames)',
      encode: [...LIMITED, '-tune', 'zerolatency', '-bf', '0'],
      minLive: DECODE_FRAMES - 2,
    },
    {
      name: 'limited range signalled, with B-frames',
      encode: [...LIMITED, '-bf', '2'],
      minLive: DECODE_FRAMES - 3,
    },
  ])(
    'yuv420p H.264 Annex-B in, JPEG frames out: $name',
    async ({ encode, minLive }, context) => {
      const ffmpeg = await locateExecutable('ffmpeg', standardFfmpegDirs());
      if (!ffmpeg) {
        context.skip('ffmpeg is not installed on this host');
        return;
      }
      // The FIXTURE needs libx264 and the lavfi test source; a minimal
      // ffmpeg build (some Linux images) can decode H.264 but not make it.
      // That is a missing prerequisite of this test, not a decoder defect.
      const { stdout: encoders } = await run(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-encoders'],
        { encoding: 'utf8', windowsHide: true },
      );
      const { stdout: formats } = await run(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-formats'],
        { encoding: 'utf8', windowsHide: true },
      );
      if (!/\blibx264\b/.test(encoders) || !/\blavfi\b/.test(formats)) {
        context.skip(
          'this ffmpeg cannot make the fixture (no libx264 encoder or lavfi input)',
        );
        return;
      }
      const { stdout } = await run(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=320x640:rate=10',
          '-frames:v',
          String(DECODE_FRAMES),
          '-pix_fmt',
          'yuv420p',
          '-c:v',
          'libx264',
          ...encode,
          '-g',
          '10',
          '-bsf:v',
          'h264_mp4toannexb',
          '-f',
          'h264',
          'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      const provider = createFfmpegDecoderProvider({
        locate: async () => ffmpeg,
        // Not the owned-process registry: this test's child is its own.
        spawn: (command, args) => {
          const proc = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
          return { proc, release: () => {} };
        },
      });
      const availability = await provider.availability();
      expect(availability.available).toBe(true);
      const images: Uint8Array[] = [];
      let exited: string | null = null;
      const decoder = provider.create(ffmpeg, PARAMS, {
        onImage: (jpeg) => images.push(jpeg),
        onExit: (reason) => {
          exited = reason;
        },
      });
      decoder.write(new Uint8Array(stdout));
      await until(
        () =>
          images.length >= minLive
            ? true
            : exited
              ? (() => {
                  throw new Error(`decoder exited: ${exited}`);
                })()
              : undefined,
        `${minLive} decoded frames before end of input`,
        20_000,
      );
      record({ step: 'ffmpeg-decode', live: images.length, of: DECODE_FRAMES });
      await decoder.close();
      expect(images.length).toBeGreaterThanOrEqual(minLive);
      expect(jpegSize(images[0]!)).toEqual({ width: 320, height: 640 });
    },
  );
});

describe('real device surfaces', () => {
  test('iOS simulator: open a session, receive frames, press Home', async (context) => {
    if (!HUB) {
      context.skip(
        'no device hub: set STATION_REAL_DEVICE_HUB_URL to an explicitly started expo-device-hub',
      );
      return;
    }
    const env = harness();
    const inventory = await env.host.inventory();
    if (inventory.state === 'unavailable') {
      context.skip(`device hub unreachable: ${inventory.failure}`);
      return;
    }
    const ios = inventory.devices.filter((device) => device.platform === 'ios');
    let device = ios.find((candidate) => candidate.booted);
    if (!device) {
      if (!BOOT || ios.length === 0) {
        context.skip(
          ios.length === 0
            ? 'no iOS simulator is available'
            : 'no simulator is booted (set STATION_REAL_DEVICE_BOOT=1 to boot one)',
        );
        return;
      }
      const pick =
        ios.find((candidate) => candidate.name === 'iPhone 17 Pro') ?? ios[0]!;
      const target = {
        hostId: 'local',
        platform: 'ios' as const,
        deviceId: pick.deviceId,
      };
      await env.sessions.start(target);
      device = await until(
        async () =>
          (await env.host.inventory()).devices.find(
            (row) =>
              row.platform === 'ios' &&
              row.deviceId === pick.deviceId &&
              row.booted,
          ),
        'the simulator to be listed as running',
        240_000,
      );
      record({ step: 'booted', platform: 'ios', device: pick.name });
      try {
        const evidence = await liveEvidence(env, device);
        expect(evidence.codec).toBe('jpeg');
      } finally {
        // Shut down only what this test booted, and say whether it worked.
        await env.sessions
          .powerOff(target)
          .then(() => record({ step: 'powered-off', platform: 'ios' }))
          .catch((error) =>
            record({ step: 'power-off-failed', error: String(error) }),
          );
      }
      return;
    }
    const evidence = await liveEvidence(env, device);
    expect(evidence.codec).toBe('jpeg');
  }, 240_000);

  test('Android emulator (station-test): open, receive frames, press Home', async (context) => {
    if (!HUB || !ANDROID) {
      context.skip(
        !HUB
          ? 'no device hub: set STATION_REAL_DEVICE_HUB_URL'
          : 'Android is opt-in (set STATION_REAL_DEVICE_ANDROID=1; it boots an emulator)',
      );
      return;
    }
    const env = harness();
    const inventory = await env.host.inventory();
    const avd = inventory.devices.find(
      (device) =>
        device.platform === 'android' &&
        (device.deviceId === 'station-test' || device.name === 'station-test'),
    );
    if (!avd) {
      context.skip('the station-test AVD is not listed by the hub');
      return;
    }
    let device = avd;
    if (!avd.booted) {
      // Start answers at once (`starting`); the emulator comes back under
      // its serial, so wait for it by name, as the pane does.
      const started = await env.sessions.start({
        hostId: 'local',
        platform: 'android',
        deviceId: avd.deviceId,
      });
      record({ step: 'start', platform: 'android', started });
      device = await until(
        async () =>
          (await env.host.inventory()).devices.find(
            (row) =>
              row.platform === 'android' && row.name === avd.name && row.booted,
          ),
        'the emulator to be listed as running',
        240_000,
      );
      const target = {
        hostId: 'local',
        platform: 'android' as const,
        deviceId: device.deviceId,
      };
      record({
        step: 'booted',
        platform: 'android',
        deviceId: device.deviceId,
      });
      cleanups.push(async () => {
        await env.sessions
          .powerOff(target)
          .then(() => record({ step: 'powered-off', platform: 'android' }))
          .catch((error) =>
            record({ step: 'power-off-failed', error: String(error) }),
          );
      });
    }
    const evidence = await liveEvidence(env, device);
    expect(['jpeg', 'png']).toContain(evidence.codec);
  }, 480_000);
});
