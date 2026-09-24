import {
  DEVICE_AX_CLIENT_MAX_BYTES,
  DEVICE_AX_RESPONSE_MAX_BYTES,
  DEVICE_PUSH_PAYLOAD_MAX_BYTES,
} from '@kontourai/station-contracts/device-tools';
import { describe, expect, test, vi } from 'vitest';
import { DeviceToolError } from '../device-host-tools.js';
import type { DeviceHubEndpoint } from '../device-hub-endpoint.js';
import {
  capAccessibilityTreeBytes,
  DEVICE_TOOL_ARGV_SHAPES,
  type DeviceTool,
  type DeviceToolRunner,
  DeviceToolsError,
  DeviceToolsService,
  deviceControlConflict,
  deviceToolArgv,
  encodeDevicePushPayload,
  flattenAndroidAccessibility,
  flattenIosAccessibility,
  isAllowedDeviceToolArgv,
  parseAndroidForeground,
  parseAndroidLocation,
  parseAndroidPermissions,
} from '../device-tools.js';

/**
 * #1971 (D10): the Tools drawer's typed device actions. The guards under
 * test: every argument vector must match a fixed shape (nothing else runs,
 * whoever built it); every builder validates its inputs; a push payload is
 * bounded and shaped; values are READ BACK from the device, never echoed
 * from the request; and the lease half of authorization.
 */

const UDID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const SERIAL = 'emulator-5554';
const IOS = { hostId: 'local', platform: 'ios' as const, deviceId: UDID };
const ANDROID = {
  hostId: 'local',
  platform: 'android' as const,
  deviceId: SERIAL,
};

type Call = { tool: DeviceTool; args: string[]; stdin?: string };

/**
 * A fake host: answers each argv from `answers` (keyed by the joined argv),
 * records every call. Anything unanswered fails like a tool that exited 1.
 */
function fakeRunner(
  answers: Record<string, string | Error> = {},
): DeviceToolRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(tool, args, options) {
      calls.push({
        tool,
        args: [...args],
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      });
      const answer = answers[`${tool} ${args.join(' ')}`];
      if (answer instanceof Error) throw answer;
      if (answer === undefined)
        throw new DeviceToolError('tool-failed', 'no answer');
      return answer;
    },
  };
}

function hubAnswering(
  routes: Record<string, unknown> = {},
): Pick<DeviceHubEndpoint, 'connect'> & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    connect: async () => ({
      ok: true as const,
      connection: {
        baseUrl: 'http://127.0.0.1:1',
        request: async (_method, path) => {
          paths.push(path);
          if (!(path in routes)) return new Response('nope', { status: 404 });
          return new Response(JSON.stringify(routes[path]), { status: 200 });
        },
        openWebSocket: () => {
          throw new Error('no sockets here');
        },
      },
    }),
  };
}

describe('the argv whitelist', () => {
  test('every builder output is one of the fixed shapes', () => {
    const built: [DeviceTool, string[]][] = [
      ['xcrun', deviceToolArgv.iosAppearance(UDID)],
      ['xcrun', deviceToolArgv.iosAppearance(UDID, 'dark')],
      [
        'xcrun',
        deviceToolArgv.iosSetLocation(UDID, {
          latitude: -33.8688,
          longitude: 151.2093,
        }),
      ],
      ['xcrun', deviceToolArgv.iosClearLocation(UDID)],
      [
        'xcrun',
        deviceToolArgv.iosPrivacy(UDID, 'grant', 'photos', 'com.example.app'),
      ],
      ['xcrun', deviceToolArgv.iosPush(UDID, 'com.example.app')],
      ['adb', deviceToolArgv.androidNight(SERIAL)],
      ['adb', deviceToolArgv.androidNight(SERIAL, 'light')],
      [
        'adb',
        deviceToolArgv.androidSetLocation(SERIAL, {
          latitude: 37.7749,
          longitude: -122.4194,
        }),
      ],
      ['adb', deviceToolArgv.androidDumpsys(SERIAL, 'window')],
      ['adb', deviceToolArgv.androidDumpsys(SERIAL, 'location')],
      ['adb', deviceToolArgv.androidDumpsysPackage(SERIAL, 'com.example.app')],
      ...deviceToolArgv
        .androidPermissions(SERIAL, 'revoke', 'location', 'com.example.app')
        .map((args): [DeviceTool, string[]] => ['adb', args]),
    ];
    for (const [tool, args] of built)
      expect(isAllowedDeviceToolArgv(tool, args), args.join(' ')).toBe(true);
  });

  test.each([
    ['xcrun', ['simctl', 'spawn', UDID, 'launchctl', 'list']],
    ['xcrun', ['simctl', 'ui', UDID, 'appearance', 'dark', '--extra']],
    ['xcrun', ['simctl', 'ui', 'booted', 'appearance']],
    ['xcrun', ['simctl', 'privacy', UDID, 'grant', 'all', 'com.example.app']],
    ['xcrun', ['simctl', 'privacy', UDID, 'grant', 'photos', '-evil.app']],
    ['xcrun', ['simctl', 'push', UDID, 'com.example.app', '/etc/passwd']],
    ['xcrun', ['simctl', 'location', UDID, 'set', '1,2']],
    ['adb', ['-s', SERIAL, 'shell', 'rm', '-rf', '/sdcard']],
    [
      'adb',
      [
        '-s',
        SERIAL,
        'shell',
        'pm',
        'grant',
        'a.b;reboot',
        'android.permission.CAMERA',
      ],
    ],
    [
      'adb',
      [
        '-s',
        SERIAL,
        'shell',
        'pm',
        'grant',
        'com.example.app',
        'android.permission.INSTALL_PACKAGES',
      ],
    ],
    ['adb', ['-s', 'emulator-5554 ', 'shell', 'dumpsys', 'window']],
    ['adb', ['-s', '192.168.1.2:5555', 'shell', 'dumpsys', 'window']],
    [
      'adb',
      ['-s', SERIAL, 'shell', 'dumpsys', 'package', 'com.example.app', 'extra'],
    ],
    ['adb', ['-s', SERIAL, 'emu', 'kill']],
    ['sh', ['-c', 'echo']],
  ] as [DeviceTool, string[]][])('refuses %s %j', (tool, args) => {
    expect(isAllowedDeviceToolArgv(tool, args)).toBe(false);
  });

  test('exec refuses an off-list vector before the runner is ever called', async () => {
    const runner = fakeRunner();
    const service = new DeviceToolsService({ runner, hub: hubAnswering() });
    // A builder that let a bad app id through would produce this vector;
    // the shape check is the second line and must hold on its own.
    const exec = (
      service as unknown as {
        exec(tool: DeviceTool, args: string[]): Promise<string>;
      }
    ).exec.bind(service);
    await expect(
      exec('xcrun', ['simctl', 'spawn', UDID, 'launchctl', 'list']),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(runner.calls).toEqual([]);
  });

  test('builders refuse ids and app ids outside their patterns', () => {
    for (const appId of [
      '-rf',
      'noDot',
      'com.example.app;reboot',
      'com.example app',
      'com.example.$(id)',
      '../../x.y',
      `a.${'b'.repeat(300)}`,
    ])
      expect(() => deviceToolArgv.iosPush(UDID, appId), appId).toThrowError(
        DeviceToolsError,
      );
    expect(() =>
      deviceToolArgv.iosPrivacy(UDID, 'grant', 'camera', 'com.example.app'),
    ).toThrowError(expect.objectContaining({ code: 'unsupported' }));
    expect(() =>
      deviceToolArgv.androidPermissions(SERIAL, 'reset', 'camera', 'com.x.y'),
    ).toThrowError(expect.objectContaining({ code: 'unsupported' }));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 91, -90.0001])
      expect(() =>
        deviceToolArgv.iosSetLocation(UDID, { latitude: bad, longitude: 0 }),
      ).toThrowError(DeviceToolsError);
  });

  test('the shapes name only xcrun simctl and adb', () => {
    expect(Object.keys(DEVICE_TOOL_ARGV_SHAPES).sort()).toEqual([
      'adb',
      'xcrun',
    ]);
    for (const shape of DEVICE_TOOL_ARGV_SHAPES.xcrun)
      expect(shape[0]).toBe('simctl');
  });
});

describe('the push payload bound', () => {
  test('a JSON object with an aps object, at most 4 KB, is encoded exactly', () => {
    const payload = { aps: { alert: 'Hi' }, extra: 1 };
    expect(encodeDevicePushPayload(payload)).toBe(JSON.stringify(payload));
  });

  test('exactly the limit passes; one byte over is refused as payload-too-large', () => {
    const base = JSON.stringify({ aps: { alert: '' } });
    const atLimit = {
      aps: { alert: 'x'.repeat(DEVICE_PUSH_PAYLOAD_MAX_BYTES - base.length) },
    };
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(
      DEVICE_PUSH_PAYLOAD_MAX_BYTES,
    );
    expect(() => encodeDevicePushPayload(atLimit)).not.toThrow();
    const over = { aps: { alert: `${atLimit.aps.alert}x` } };
    expect(() => encodeDevicePushPayload(over)).toThrowError(
      expect.objectContaining({ code: 'payload-too-large' }),
    );
    // Multi-byte characters count as bytes, not characters.
    const wide = { aps: { alert: 'é'.repeat(2100) } };
    expect(() => encodeDevicePushPayload(wide)).toThrowError(
      expect.objectContaining({ code: 'payload-too-large' }),
    );
  });

  test.each([
    null,
    'text',
    [],
    { alert: 'no aps' },
    { aps: 'not-an-object' },
    { aps: [] },
  ])('refuses a payload shaped %j', (payload) => {
    expect(() => encodeDevicePushPayload(payload)).toThrowError(
      expect.objectContaining({ code: 'invalid-request' }),
    );
  });

  test('the payload travels on stdin, never argv', async () => {
    const runner = fakeRunner({
      [`xcrun simctl push ${UDID} com.example.app -`]: '',
      [`xcrun simctl ui ${UDID} appearance`]: 'light\n',
    });
    const service = new DeviceToolsService({ runner, hub: hubAnswering() });
    const result = await service.act(IOS, {
      type: 'send-push',
      appId: 'com.example.app',
      payload: { aps: { alert: 'secret-ish' } },
    });
    expect(result.push).toBe('sent');
    const push = runner.calls.find((call) => call.args[1] === 'push')!;
    expect(push.stdin).toBe('{"aps":{"alert":"secret-ish"}}');
    expect(push.args.join(' ')).not.toContain('secret-ish');
  });

  test('Android has no push: unsupported, and nothing runs', async () => {
    const runner = fakeRunner();
    const service = new DeviceToolsService({ runner, hub: hubAnswering() });
    await expect(
      service.act(ANDROID, {
        type: 'send-push',
        appId: 'com.example.app',
        payload: { aps: {} },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(runner.calls).toEqual([]);
  });
});

describe('read-back', () => {
  test('appearance is what the device reports AFTER the change, not what was asked', async () => {
    // The device refuses to change (e.g. an old runtime): the read-back
    // says light, and so does the result.
    const runner = fakeRunner({
      [`xcrun simctl ui ${UDID} appearance dark`]: '',
      [`xcrun simctl ui ${UDID} appearance`]: 'light\n',
    });
    const service = new DeviceToolsService({
      runner,
      hub: hubAnswering({
        [`/vendor/serve-sim/helper/${UDID}/foreground`]: {
          bundleId: 'com.apple.Preferences',
        },
      }),
    });
    const result = await service.act(IOS, {
      type: 'set-appearance',
      appearance: 'dark',
    });
    expect(result.snapshot.appearance).toEqual({
      state: 'read',
      value: 'light',
    });
    expect(result.snapshot.foregroundApp).toEqual({
      state: 'read',
      value: { appId: 'com.apple.Preferences' },
    });
  });

  test('an unreadable value says why instead of guessing', async () => {
    const runner = fakeRunner({
      [`xcrun simctl ui ${UDID} appearance`]: new DeviceToolError(
        'tool-unavailable',
        'no xcrun',
      ),
    });
    const service = new DeviceToolsService({
      runner,
      hub: { connect: async () => ({ ok: false, failure: 'hub-unavailable' }) },
    });
    const snapshot = await service.snapshot(IOS);
    expect(snapshot.appearance).toEqual({
      state: 'unreadable',
      reason: 'tool-unavailable',
    });
    expect(snapshot.foregroundApp).toEqual({
      state: 'unreadable',
      reason: 'hub-unavailable',
    });
    // iOS never reports location, and nothing was set: unreadable.
    expect(snapshot.location).toEqual({
      state: 'unreadable',
      reason: 'unsupported',
    });
  });

  test('iOS location after a set is labelled last-set by Station, never a device reading', async () => {
    const runner = fakeRunner({
      [`xcrun simctl location ${UDID} set 37.774900,-122.419400`]: '',
      [`xcrun simctl location ${UDID} clear`]: '',
      [`xcrun simctl ui ${UDID} appearance`]: 'dark',
    });
    const service = new DeviceToolsService({
      runner,
      hub: hubAnswering(),
      now: () => Date.parse('2026-09-23T10:00:00Z'),
    });
    const set = await service.act(IOS, {
      type: 'set-location',
      latitude: 37.7749,
      longitude: -122.4194,
    });
    expect(set.snapshot.location).toEqual({
      state: 'last-set',
      value: { latitude: 37.7749, longitude: -122.4194 },
      setAt: '2026-09-23T10:00:00.000Z',
    });
    const cleared = await service.act(IOS, { type: 'clear-location' });
    expect(cleared.snapshot.location).toMatchObject({
      state: 'last-set',
      value: null,
    });
  });

  test('Android location is read from dumpsys, not from what was sent', async () => {
    const runner = fakeRunner({
      [`adb -s ${SERIAL} emu geo fix -122.419400 37.774900`]: 'OK',
      [`adb -s ${SERIAL} shell dumpsys location`]:
        '  last location=Location[gps 37.774800,-122.419300 hAcc=5 et=+1s]',
      [`adb -s ${SERIAL} shell cmd uimode night`]: 'Night mode: no',
      [`adb -s ${SERIAL} shell dumpsys window`]:
        '  mCurrentFocus=Window{abc u0 com.android.settings/com.android.settings.Settings}',
    });
    const service = new DeviceToolsService({ runner, hub: hubAnswering() });
    const result = await service.act(ANDROID, {
      type: 'set-location',
      latitude: 37.7749,
      longitude: -122.4194,
    });
    expect(result.snapshot.location).toEqual({
      state: 'read',
      value: { latitude: 37.7748, longitude: -122.4193 },
    });
    expect(result.snapshot.appearance).toEqual({
      state: 'read',
      value: 'light',
    });
    expect(result.snapshot.foregroundApp).toEqual({
      state: 'read',
      value: { appId: 'com.android.settings' },
    });
  });

  test('Android permissions are read back from dumpsys package after the change', async () => {
    const runner = fakeRunner({
      [`adb -s ${SERIAL} shell pm grant com.example.app android.permission.ACCESS_FINE_LOCATION`]:
        '',
      // The app does not declare coarse location: pm refuses that one.
      [`adb -s ${SERIAL} shell pm grant com.example.app android.permission.ACCESS_COARSE_LOCATION`]:
        new DeviceToolError('tool-failed', 'not declared'),
      [`adb -s ${SERIAL} shell dumpsys package com.example.app`]: [
        'Packages:',
        '  Package [com.example.app] (abc):',
        '    runtime permissions:',
        '      android.permission.ACCESS_FINE_LOCATION: granted=true, flags=[ USER_SET ]',
        '      android.permission.CAMERA: granted=false, flags=[ USER_SET ]',
      ].join('\n'),
      [`adb -s ${SERIAL} shell cmd uimode night`]: 'Night mode: yes',
    });
    const service = new DeviceToolsService({ runner, hub: hubAnswering() });
    const result = await service.act(ANDROID, {
      type: 'set-permission',
      appId: 'com.example.app',
      permission: 'location',
      decision: 'grant',
    });
    expect(result.permissions).toEqual({
      appId: 'com.example.app',
      permissions: {
        state: 'read',
        value: expect.objectContaining({
          location: 'granted',
          camera: 'denied',
          microphone: 'not-requested',
        }),
      },
    });
  });

  test('a permission change where every command failed is an error, not a success', async () => {
    const runner = fakeRunner();
    const service = new DeviceToolsService({ runner, hub: hubAnswering() });
    await expect(
      service.act(ANDROID, {
        type: 'set-permission',
        appId: 'com.example.app',
        permission: 'camera',
        decision: 'grant',
      }),
    ).rejects.toMatchObject({ code: 'tool-failed' });
  });

  test('iOS permissions: the change runs, and the read-back honestly says unsupported', async () => {
    const runner = fakeRunner({
      [`xcrun simctl privacy ${UDID} revoke photos com.example.app`]: '',
      [`xcrun simctl ui ${UDID} appearance`]: 'light',
    });
    const service = new DeviceToolsService({ runner, hub: hubAnswering() });
    const result = await service.act(IOS, {
      type: 'set-permission',
      appId: 'com.example.app',
      permission: 'photos',
      decision: 'revoke',
    });
    expect(result.permissions?.permissions).toEqual({
      state: 'unreadable',
      reason: 'unsupported',
    });
  });

  test('parsers', () => {
    expect(parseAndroidForeground('mCurrentFocus=null')).toBeNull();
    expect(parseAndroidForeground('nothing')).toBeUndefined();
    expect(parseAndroidLocation('no fix here')).toBeNull();
    expect(
      parseAndroidPermissions('Package [other.app] (x):', 'com.example.app'),
    ).toBeUndefined();
  });
});

describe('the accessibility tree', () => {
  test('iOS: flattened, screen-sized nodes dropped, normalised to the root frame', async () => {
    const tree = [
      {
        frame: { x: 0, y: 0, width: 400, height: 800 },
        type: 'Application',
        children: [
          {
            frame: { x: 40, y: 80, width: 200, height: 40 },
            AXLabel: 'Settings',
            AXUniqueId: 'settings',
            type: 'Button',
          },
        ],
      },
    ];
    const service = new DeviceToolsService({
      runner: fakeRunner(),
      hub: hubAnswering({ [`/vendor/serve-sim/helper/${UDID}/ax`]: tree }),
    });
    const result = await service.accessibility(IOS);
    expect(result.space).toEqual({ width: 400, height: 800 });
    expect(result.elements).toEqual([
      {
        id: 'settings',
        label: 'Settings',
        role: 'Button',
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.05,
      },
    ]);
  });

  test('Android: the device is named in the query, and window-sized containers are dropped', async () => {
    const hub = hubAnswering({
      [`/vendor/serve-emu/api/accessibility?device=${SERIAL}`]: {
        nodes: [
          { bounds: { left: 0, top: 0, right: 1000, bottom: 2000 } },
          {
            bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
            className: 'android.widget.FrameLayout',
          },
          {
            bounds: { left: 100, top: 200, right: 600, bottom: 300 },
            text: 'OK',
            className: 'android.widget.Button',
            id: 7,
          },
        ],
      },
    });
    const service = new DeviceToolsService({ runner: fakeRunner(), hub });
    const result = await service.accessibility(ANDROID);
    expect(hub.paths).toEqual([
      `/vendor/serve-emu/api/accessibility?device=${SERIAL}`,
    ]);
    expect(result.elements).toEqual([
      {
        id: '7',
        label: 'OK',
        role: 'Button',
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.05,
      },
    ]);
  });

  test('the element count is capped and says so', () => {
    const children = Array.from({ length: 600 }, (_, index) => ({
      frame: { x: 0, y: index, width: 10, height: 1 },
      AXLabel: `row ${index}`,
    }));
    const flat = flattenIosAccessibility([
      { frame: { x: 0, y: 0, width: 100, height: 1000 }, children },
    ])!;
    expect(flat.elements).toHaveLength(500);
    expect(flat.truncated).toBe(true);
    expect(flattenAndroidAccessibility({ nodes: 'x' })).toBeUndefined();
  });

  test.for([
    // JSON escapes a C0 control character as \\u00XX: 6 bytes per character.
    { name: 'escaped control characters', ch: '\u0001' },
    // CJK is 3 UTF-8 bytes per character.
    { name: 'CJK', ch: '界' },
  ])(
    'a worst-case tree ($name) is cut to the serialized byte cap, and says so',
    async ({ ch }) => {
      const long = ch.repeat(400);
      const children = Array.from({ length: 600 }, (_, index) => ({
        frame: { x: 0, y: index, width: 10, height: 1 },
        AXLabel: long,
        type: long,
        AXUniqueId: `${index}-${ch.repeat(200)}`,
      }));
      const service = new DeviceToolsService({
        runner: fakeRunner(),
        hub: hubAnswering({
          [`/vendor/serve-sim/helper/${UDID}/ax`]: [
            { frame: { x: 0, y: 0, width: 100, height: 1000 }, children },
          ],
        }),
      });
      const tree = await service.accessibility(IOS);
      const bytes = Buffer.byteLength(JSON.stringify(tree), 'utf8');
      // Without the cap this tree serializes to ~0.8-1.6 MB.
      expect(bytes).toBeLessThanOrEqual(DEVICE_AX_RESPONSE_MAX_BYTES);
      expect(tree.truncated).toBe(true);
      expect(tree.elements.length).toBeGreaterThan(0);
      // Even inside the route envelope it stays under the client's ceiling.
      expect(
        Buffer.byteLength(JSON.stringify({ success: true, data: tree })),
      ).toBeLessThan(DEVICE_AX_CLIENT_MAX_BYTES);
    },
  );

  test('a tree already within the cap is returned untouched', () => {
    const tree = {
      space: { width: 1, height: 1 },
      elements: [
        {
          id: 'a',
          label: 'A',
          role: 'Button',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
      truncated: false,
      readAt: '2026-09-23T00:00:00.000Z',
    };
    expect(capAccessibilityTreeBytes(tree)).toBe(tree);
  });

  test('a hub that does not answer is hub-unavailable, not an empty tree', async () => {
    const service = new DeviceToolsService({
      runner: fakeRunner(),
      hub: { connect: async () => ({ ok: false, failure: 'hub-unavailable' }) },
    });
    await expect(service.accessibility(IOS)).rejects.toMatchObject({
      code: 'hub-unavailable',
    });
  });

  test('a target that is not a UDID or emulator serial is refused before the hub', async () => {
    const hub = hubAnswering();
    const service = new DeviceToolsService({ runner: fakeRunner(), hub });
    await expect(
      service.accessibility({
        hostId: 'local',
        platform: 'android',
        deviceId: 'Pixel_AVD',
      }),
    ).rejects.toMatchObject({ code: 'invalid-target' });
    expect(hub.paths).toEqual([]);
  });
});

describe('another controller (the live-surface lease)', () => {
  const me = { principal: 'user:ada', device: 'device:1' };
  const deps = (holder: unknown, session = true) => ({
    sessions: {
      forDevice: vi.fn(() =>
        session ? { surfaceId: 'device:ios:s' } : undefined,
      ),
    },
    surfaces: {
      get: vi.fn(() => ({
        lease: { snapshot: () => ({ holder: holder as never }) },
      })),
    },
  });

  test('nobody holding, or no session at all, is no conflict', () => {
    expect(deviceControlConflict(deps(null), 'ios', UDID, me)).toBe('none');
    expect(
      deviceControlConflict(
        deps({ kind: 'human', principal: 'user:bob', device: 'x' }, false),
        'ios',
        UDID,
        me,
      ),
    ).toBe('none');
  });

  test('the caller itself (this principal, this client) holding is no conflict', () => {
    expect(
      deviceControlConflict(deps({ kind: 'human', ...me }), 'ios', UDID, me),
    ).toBe('none');
  });

  test('the same person on another client is told apart from someone else', () => {
    expect(
      deviceControlConflict(
        deps({ kind: 'human', principal: 'user:ada', device: 'device:2' }),
        'ios',
        UDID,
        me,
      ),
    ).toBe('same-person-elsewhere');
    for (const holder of [
      { kind: 'human', principal: 'user:bob', device: 'device:1' },
      // An agent is always another controller, whoever it acts for.
      { kind: 'agent', principal: 'user:ada', sessionId: 's1' },
    ])
      expect(
        deviceControlConflict(deps(holder), 'ios', UDID, me),
        JSON.stringify(holder),
      ).toBe('other');
  });
});

/**
 * #1973: this service runs THIS machine's xcrun/adb and reads the local
 * hub. A device on an SSH device host — even one whose UDID or serial a
 * local device shares — is refused before anything runs.
 */
describe('a device on another host (#1973)', () => {
  const REMOTE = 'ssh-0123456789ab';

  test('every read and action is refused `unsupported`; no local tool runs and no hub is read', async () => {
    // A runner and hub that WOULD answer for the same ids locally.
    const runner = fakeRunner({
      [`xcrun ${deviceToolArgv.iosAppearance(UDID).join(' ')}`]: 'light\n',
    });
    const hub = hubAnswering({
      [`/vendor/serve-sim/helper/${UDID}/foreground`]: { bundleId: 'x' },
      [`/vendor/serve-sim/helper/${UDID}/ax`]: { elements: [] },
    });
    const service = new DeviceToolsService({ runner, hub });
    const remoteIos = { ...IOS, hostId: REMOTE };
    const remoteAndroid = { ...ANDROID, hostId: REMOTE };
    for (const attempt of [
      () => service.snapshot(remoteIos),
      () => service.accessibility(remoteIos),
      () => service.permissions(remoteAndroid, 'com.example.app'),
      () =>
        service.act(remoteIos, { type: 'set-appearance', appearance: 'dark' }),
      () => service.act(remoteAndroid, { type: 'clear-location' }),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: 'unsupported' });
    expect(runner.calls).toEqual([]);
    expect(hub.paths).toEqual([]);
  });

  test('a service built for a host serves only that host', async () => {
    const runner = fakeRunner();
    const service = new DeviceToolsService({
      hostId: REMOTE,
      runner,
      hub: hubAnswering(),
    });
    await expect(
      service.act(IOS, { type: 'clear-location' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(runner.calls).toEqual([]);
  });
});
