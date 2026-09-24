import { EventEmitter } from 'node:events';
import type {
  MobileDeviceInventory,
  MobileDeviceSummary,
} from '@kontourai/station-contracts/mobile-device';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import type { DeviceAccess } from '../../services/devices/device-access.js';
import type { DeviceSocket } from '../../services/devices/device-live-surface-producer.js';
import { DeviceSessionService } from '../../services/devices/device-session-service.js';
import {
  type DeviceTool,
  DeviceToolsService,
  deviceControlConflict,
} from '../../services/devices/device-tools.js';
import {
  claimHumanControl,
  LiveSurfaceRegistry,
} from '../../services/live-surface/registry.js';
import {
  createDeviceToolsRoutes,
  DEVICE_TOOLS_ACTION_MAX_BODY_BYTES,
} from '../device-tools.js';

/**
 * #1971 (D10, D12): the Tools drawer routes. Reads need VIEW access to the
 * device, actions need DRIVE access; contributors/viewers get nothing; and
 * an action is refused while another controller holds the device's
 * live-surface lease (a real registry and a real device session here, not a
 * stubbed predicate).
 */

const IOS = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const OTHER_IOS = '11111111-2222-4333-8444-555555555555';

const DEVICES: MobileDeviceSummary[] = [
  {
    hostId: 'local',
    platform: 'ios',
    deviceId: IOS,
    name: 'iPhone 17 Pro',
    runtime: 'iOS 26.5',
    booted: true,
  },
];

class IdleSocket extends EventEmitter implements DeviceSocket {
  readyState = 0;
  send(_data: string | Uint8Array, callback: (error?: Error) => void) {
    callback(new Error('not open'));
  }
  close() {
    this.readyState = 3;
  }
}

/**
 * Who a request is, from test headers. `x-test-actor`: `operator`;
 * `shared:<id>` (an admin of a Project the device is shared with: view and
 * drive); `viewonly:<id>` (view, never drive); anything else (a Project
 * contributor or viewer) has no standing. `x-test-human`: the live-surface
 * human caller identity, `principal/device`.
 */
const fakeAccess: DeviceAccess = {
  isOperator: async (request) =>
    request.headers.get('x-test-actor') === 'operator',
  hasStanding: async () => true,
  mayAccessDevice: async (request, _platform, deviceId, purpose) => {
    const actor = request.headers.get('x-test-actor') ?? '';
    if (actor === 'operator') return true;
    if (actor === `shared:${deviceId}`) return true;
    return actor === `viewonly:${deviceId}` && purpose === 'view';
  },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup() {
  const calls: { tool: DeviceTool; args: string[] }[] = [];
  const runner = {
    async run(tool: DeviceTool, args: readonly string[]) {
      calls.push({ tool, args: [...args] });
      if (args.join(' ') === `simctl ui ${IOS} appearance`) return 'dark\n';
      return '';
    },
  };
  const hub = {
    connect: async () => ({
      ok: false as const,
      failure: 'hub-unavailable' as const,
    }),
  };
  const tools = new DeviceToolsService({ runner, hub });
  const host = {
    inventory: vi.fn(
      async (): Promise<MobileDeviceInventory> => ({
        hostId: 'local',
        state: 'ready',
        observedAt: new Date().toISOString(),
        devices: DEVICES.map((device) => ({ ...device })),
      }),
    ),
    boot: vi.fn(),
    attachStream: vi.fn(async () => {}),
    shutdown: vi.fn(),
    screenshot: vi.fn(),
    connect: async () => ({
      ok: true as const,
      connection: {
        baseUrl: 'http://127.0.0.1:43871',
        request: async () => new Response(null, { status: 503 }),
        openWebSocket: () => new IdleSocket() as never,
      },
    }),
  };
  const registry = new LiveSurfaceRegistry();
  const sessions = new DeviceSessionService({
    host: host as never,
    endpoint: { onExit: () => () => {} },
    surfaces: registry,
    access: fakeAccess,
  });
  const app = createDeviceToolsRoutes({
    isRequestPrincipalCurrent: () => true,
    access: fakeAccess,
    tools,
    // The resolved HUMAN caller, from a test header; no header (the
    // station-control token, a delegation device) resolves to null.
    resolveHumanCaller: (c) => {
      const human = c.req.header('x-test-human');
      const [principal, device] = human ? human.split('/') : [];
      return principal && device ? { principal, device } : null;
    },
    controlConflict: (caller, platform, deviceId) =>
      deviceControlConflict(
        { sessions, surfaces: registry },
        platform,
        deviceId,
        caller,
      ),
  });
  const call = (
    method: string,
    path: string,
    actor: string,
    body?: unknown,
    human: string | null = 'user:ada/device:1',
  ) =>
    app.request(path, {
      method,
      headers: {
        'x-test-actor': actor,
        ...(human ? { 'x-test-human': human } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  cleanups.push(async () => {
    await sessions.dispose();
    await registry.dispose();
  });
  return { call, calls, sessions, registry };
}

const toolsPath = (id = IOS) => `/hosts/local/devices/ios/${id}/tools`;
const actionPath = (id = IOS) => `${toolsPath(id)}/actions`;
const DARK = { type: 'set-appearance', appearance: 'dark' };

describe('who may read and act (D12: view vs drive)', () => {
  test('a contributor or viewer (no standing) is refused everything, and nothing runs', async () => {
    const { call, calls } = setup();
    for (const [method, path, body] of [
      ['GET', toolsPath(), undefined],
      ['GET', `${toolsPath()}/accessibility`, undefined],
      ['GET', `${toolsPath()}/permissions?appId=com.example.app`, undefined],
      ['POST', actionPath(), DARK],
    ] as const) {
      const response = await call(method, path, 'contributor', body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await readJson(response)).code).toBe('access-denied');
    }
    expect(calls).toEqual([]);
  });

  test('a shared admin reads and drives a device shared with them, and only that one', async () => {
    const { call, calls } = setup();
    const read = await call('GET', toolsPath(), `shared:${IOS}`);
    expect(read.status).toBe(200);
    expect((await readJson(read)).data.appearance).toEqual({
      state: 'read',
      value: 'dark',
    });
    const acted = await call('POST', actionPath(), `shared:${IOS}`, DARK);
    expect(acted.status).toBe(200);
    expect(calls.map((entry) => entry.args.join(' '))).toContain(
      `simctl ui ${IOS} appearance dark`,
    );
    const other = await call(
      'POST',
      actionPath(OTHER_IOS),
      `shared:${IOS}`,
      DARK,
    );
    expect(other.status).toBe(403);
  });

  test('a view-only caller reads but cannot change anything', async () => {
    const { call, calls } = setup();
    expect((await call('GET', toolsPath(), `viewonly:${IOS}`)).status).toBe(
      200,
    );
    const before = calls.length;
    const refused = await call('POST', actionPath(), `viewonly:${IOS}`, DARK);
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).code).toBe('access-denied');
    // No SET ran: only the reads from the GET above.
    expect(calls.slice(before)).toEqual([]);
    expect(
      calls.some((entry) => entry.args.join(' ').endsWith('appearance dark')),
    ).toBe(false);
  });
});

describe('another controller holding the lease', () => {
  async function openedWithHolder(holder: 'other-human' | 'me' | 'none') {
    const env = setup();
    const session = await env.sessions.open({
      hostId: 'local',
      platform: 'ios',
      deviceId: IOS,
    });
    const entry = env.registry.get(session.surfaceId)!;
    if (holder === 'other-human')
      claimHumanControl(entry, {
        kind: 'human',
        principal: 'user:bob',
        device: 'device:9',
      });
    if (holder === 'me')
      claimHumanControl(entry, {
        kind: 'human',
        principal: 'user:ada',
        device: 'device:1',
      });
    return env;
  }

  test('someone else driving refuses the action (device-controlled-by-other) and nothing runs', async () => {
    const { call, calls } = await openedWithHolder('other-human');
    const refused = await call('POST', actionPath(), 'operator', DARK);
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toEqual({
      success: false,
      code: 'device-controlled-by-other',
      heldBy: 'other',
    });
    expect(calls).toEqual([]);
    // Reads are not driving: still allowed.
    expect((await call('GET', toolsPath(), 'operator')).status).toBe(200);
  });

  test('the caller holding control themselves may act; nobody holding may too', async () => {
    for (const holder of ['me', 'none'] as const) {
      const { call } = await openedWithHolder(holder);
      const response = await call('POST', actionPath(), 'operator', DARK);
      expect(response.status, holder).toBe(200);
    }
  });

  test('the same person on a different client holding control is another controller', async () => {
    const { call } = await openedWithHolder('me');
    const refused = await call(
      'POST',
      actionPath(),
      'operator',
      DARK,
      'user:ada/device:2',
    );
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).heldBy).toBe('same-person-elsewhere');
  });

  test('a permission group is one decision: the lease is checked once, and a change of control mid-group does not stop it (D2)', async () => {
    const calls: string[][] = [];
    let checks = 0;
    const app = createDeviceToolsRoutes({
      isRequestPrincipalCurrent: () => true,
      access: fakeAccess,
      tools: new DeviceToolsService({
        runner: {
          run: async (_tool, args) => {
            calls.push([...args]);
            return '';
          },
        },
        hub: {
          connect: async () => ({ ok: false, failure: 'hub-unavailable' }),
        },
      }),
      resolveHumanCaller: () => ({ principal: 'user:ada', device: 'd' }),
      // Free when asked first; "someone took control" on any later ask.
      controlConflict: () => (checks++ === 0 ? 'none' : 'other'),
    });
    const response = await app.request(
      '/hosts/local/devices/android/emulator-5554/tools/actions',
      {
        method: 'POST',
        headers: {
          'x-test-actor': 'operator',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'set-permission',
          appId: 'com.example.app',
          permission: 'contacts',
          decision: 'grant',
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(checks).toBe(1);
    // Both commands of the group ran: never a half-granted app.
    expect(
      calls.filter((args) => args.includes('pm')).map((args) => args.at(-1)),
    ).toEqual([
      'android.permission.READ_CONTACTS',
      'android.permission.WRITE_CONTACTS',
    ]);
  });

  test('without a lease check wired, actions fail closed as unavailable', async () => {
    const tools = new DeviceToolsService({
      runner: { run: vi.fn(async () => '') },
      hub: { connect: async () => ({ ok: false, failure: 'hub-unavailable' }) },
    });
    const app = createDeviceToolsRoutes({
      isRequestPrincipalCurrent: () => true,
      access: fakeAccess,
      tools,
      resolveHumanCaller: () => ({ principal: 'user:ada', device: 'd' }),
    });
    const response = await app.request(actionPath(), {
      method: 'POST',
      headers: {
        'x-test-actor': 'operator',
        'content-type': 'application/json',
      },
      body: JSON.stringify(DARK),
    });
    expect(response.status).toBe(503);
  });
});

describe('an unresolved caller (S1: no bypass for agents)', () => {
  test('the station-control token / a delegation device (no human caller) is refused every route, with no lease holder, and nothing runs', async () => {
    const { call, calls, registry } = setup();
    // Nobody holds any lease: before the fix this was exactly the gap —
    // "no other controller", so an agent could set location or push.
    expect(registry.size).toBe(0);
    for (const [method, path, body] of [
      ['GET', toolsPath(), undefined],
      ['GET', `${toolsPath()}/accessibility`, undefined],
      ['GET', `${toolsPath()}/permissions?appId=com.example.app`, undefined],
      ['POST', actionPath(), DARK],
      [
        'POST',
        actionPath(),
        {
          type: 'send-push',
          appId: 'com.example.app',
          payload: { aps: { alert: 'x' } },
        },
      ],
      [
        'POST',
        actionPath(),
        { type: 'set-location', latitude: 1, longitude: 2 },
      ],
    ] as const) {
      const response = await call(method, path, 'operator', body, null);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await readJson(response), `${method} ${path}`).toEqual({
        success: false,
        code: 'principal-unresolved',
      });
    }
    expect(calls).toEqual([]);
  });

  test('without a caller resolver wired, every route fails closed as unavailable', async () => {
    const app = createDeviceToolsRoutes({
      isRequestPrincipalCurrent: () => true,
      access: fakeAccess,
      tools: new DeviceToolsService({
        runner: { run: vi.fn(async () => '') },
        hub: {
          connect: async () => ({ ok: false, failure: 'hub-unavailable' }),
        },
      }),
      controlConflict: () => 'none',
    });
    const response = await app.request(toolsPath(), {
      headers: { 'x-test-actor': 'operator' },
    });
    expect(response.status).toBe(503);
  });
});

describe('route-seam validation', () => {
  test.each([
    ['not json', '{'],
    ['array', []],
    ['unknown type', { type: 'shell', command: 'ls' }],
    ['extra key', { type: 'set-appearance', appearance: 'dark', x: 1 }],
    ['bad appearance', { type: 'set-appearance', appearance: 'blue' }],
    [
      'latitude out of range',
      { type: 'set-location', latitude: 91, longitude: 0 },
    ],
    [
      'string coordinates',
      { type: 'set-location', latitude: '1', longitude: 2 },
    ],
    [
      'permission outside the list',
      {
        type: 'set-permission',
        appId: 'com.x.y',
        permission: 'all',
        decision: 'grant',
      },
    ],
    [
      'app id with shell characters',
      {
        type: 'set-permission',
        appId: 'com.x;reboot',
        permission: 'camera',
        decision: 'grant',
      },
    ],
    [
      'push payload not an object',
      { type: 'send-push', appId: 'com.x.y', payload: 'hi' },
    ],
  ])('refuses %s', async (_label, body) => {
    const { call, calls } = setup();
    const response = await call('POST', actionPath(), 'operator', body);
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('an unknown target is invalid-target, before any access check or tool', async () => {
    const { call, calls } = setup();
    for (const path of [
      '/hosts/local/devices/ios/booted/tools',
      '/hosts/local/devices/android/Pixel_AVD/tools',
      '/hosts/local/devices/windows/x/tools',
    ]) {
      const response = await call('GET', path, 'operator');
      expect(response.status, path).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('an oversized push payload is 413; the whole body is bounded too', async () => {
    const { call, calls } = setup();
    const payload = { aps: { alert: 'x'.repeat(4200) } };
    const over = await call('POST', actionPath(), 'operator', {
      type: 'send-push',
      appId: 'com.example.app',
      payload,
    });
    expect(over.status).toBe(413);
    expect((await readJson(over)).code).toBe('payload-too-large');
    const huge = await call(
      'POST',
      actionPath(),
      'operator',
      JSON.stringify({
        type: 'send-push',
        appId: 'com.example.app',
        payload: {
          aps: { alert: 'y'.repeat(DEVICE_TOOLS_ACTION_MAX_BODY_BYTES) },
        },
      }),
    );
    expect(huge.status).toBe(413);
    expect(calls.some((entry) => entry.args.includes('push'))).toBe(false);
  });

  test('unexpected or repeated query keys are refused', async () => {
    const { call } = setup();
    expect(
      (
        await call(
          'GET',
          `${toolsPath()}?projectSlug=a&projectSlug=b`,
          'operator',
        )
      ).status,
    ).toBe(400);
    expect(
      (await call('GET', `${toolsPath()}/permissions?appId=bad`, 'operator'))
        .status,
    ).toBe(400);
  });
});

/**
 * #1973: device routes name their host. The drawer's tools run THIS
 * machine's xcrun/adb and read the local hub, so a device on an SSH device
 * host is refused `unsupported` — never run against a local device that
 * happens to share its UDID.
 */
describe('a device on an SSH device host (#1973)', () => {
  const REMOTE = 'ssh-0123456789ab';
  const remote = (leaf = '') =>
    `/hosts/${REMOTE}/devices/ios/${IOS}/tools${leaf}`;

  test('every tools route refuses it, typed, and no local tool runs', async () => {
    const { call, calls } = setup();
    for (const [method, path, body] of [
      ['GET', remote(), undefined],
      ['GET', remote('/accessibility'), undefined],
      [
        'GET',
        `/hosts/${REMOTE}/devices/android/emulator-5554/tools/permissions?appId=com.example.app`,
        undefined,
      ],
      ['POST', remote('/actions'), DARK],
    ] as const) {
      const response = await call(method, path, 'operator', body);
      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({ code: 'unsupported' });
    }
    expect(calls).toEqual([]);
    // The same device on THIS Station is still served.
    expect((await call('GET', toolsPath(), 'operator')).status).not.toBe(422);
  });

  test('the route refuses it BEFORE the access check (which could reach that host) and before the service', async () => {
    const asked: string[] = [];
    const served: string[] = [];
    const app = createDeviceToolsRoutes({
      isRequestPrincipalCurrent: () => true,
      access: {
        ...fakeAccess,
        mayAccessDevice: async (
          _request,
          _platform,
          _deviceId,
          _purpose,
          hostId,
        ) => {
          asked.push(hostId);
          return true;
        },
      },
      tools: {
        snapshot: async (target: { hostId: string }) => {
          served.push(target.hostId);
          return {};
        },
      } as never,
      resolveHumanCaller: () => ({ principal: 'user:ada', device: 'device:1' }),
      controlConflict: () => 'none',
    });
    const response = await app.request(remote(), {
      headers: { 'x-test-actor': 'operator' },
    });
    expect(response.status).toBe(422);
    expect(asked).toEqual([]);
    expect(served).toEqual([]);
  });

  test('a malformed host id is not a target', async () => {
    const { call, calls } = setup();
    for (const hostId of ['LOCAL', 'ssh-XYZ', 'ssh-'])
      expect(
        (
          await call(
            'GET',
            `/hosts/${hostId}/devices/ios/${IOS}/tools`,
            'operator',
          )
        ).status,
      ).toBe(400);
    expect(calls).toEqual([]);
  });

  test('D12 access is asked about the device on ITS host', async () => {
    const asked: string[] = [];
    const access: DeviceAccess = {
      ...fakeAccess,
      mayAccessDevice: async (request, platform, deviceId, purpose, hostId) => {
        asked.push(`${hostId}:${platform}:${purpose}`);
        return fakeAccess.mayAccessDevice(
          request,
          platform,
          deviceId,
          purpose,
          hostId,
        );
      },
    };
    const app = createDeviceToolsRoutes({
      isRequestPrincipalCurrent: () => true,
      access,
      tools: new DeviceToolsService({
        runner: { run: async () => 'light\n' },
        hub: {
          connect: async () => ({ ok: false, failure: 'hub-unavailable' }),
        },
      }),
      resolveHumanCaller: () => ({ principal: 'user:ada', device: 'device:1' }),
    });
    await app.request(toolsPath(), { headers: { 'x-test-actor': 'operator' } });
    expect(asked).toEqual(['local:ios:view']);
  });
});
