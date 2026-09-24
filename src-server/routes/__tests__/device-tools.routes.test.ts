import { EventEmitter } from 'node:events';
import { DEVICE_AX_RESPONSE_MAX_BYTES } from '@kontourai/station-contracts/device-tools';
import type {
  MobileDeviceInventory,
  MobileDeviceSummary,
} from '@kontourai/station-contracts/mobile-device';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import type { DeviceAccess } from '../../services/devices/device-access.js';
import { DeviceToolError } from '../../services/devices/device-host-tools.js';
import type { DeviceSocket } from '../../services/devices/device-live-surface-producer.js';
import { DeviceSessionService } from '../../services/devices/device-session-service.js';
import { DeviceHostBusyError } from '../../services/devices/device-shares.js';
import {
  type DeviceTool,
  type DeviceToolRunner,
  DeviceToolsError,
  DeviceToolsService,
  deviceControlConflict,
} from '../../services/devices/device-tools.js';
import {
  createSshDeviceToolRunner,
  type SshDeviceToolHost,
  type SshToolRequest,
} from '../../services/devices/hosts/ssh-device-tools.js';
import {
  claimAgentControl,
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
 * #1973: device routes name their host. WITHOUT SSH device host services
 * wired (`toolsFor`), a device on an SSH device host is refused
 * `unsupported` — never run against a local device that happens to share
 * its UDID. With them wired, see #2442 below.
 */
describe('a device on an SSH device host, no SSH host services wired (#1973)', () => {
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

/**
 * #2442: with SSH device host services wired, the drawer runs on the
 * device's OWN host through that host's service, behind the SAME access
 * (D12, keyed by host, platform and device) and lease checks as `local`.
 */
describe('a device on an SSH device host, served by that host (#2442)', () => {
  const REMOTE = 'ssh-0123456789ab';
  const remotePath = (leaf = '', platform = 'ios', id = IOS) =>
    `/hosts/${REMOTE}/devices/${platform}/${id}/tools${leaf}`;
  const PROBE = new Request('http://station.test/', {
    headers: { 'x-test-actor': 'operator' },
  });

  function remoteSetup(
    options: {
      access?: DeviceAccess;
      run?: (
        tool: DeviceTool,
        args: readonly string[],
        options?: { beforeRun?: () => Promise<void> },
      ) => Promise<string>;
      hubTree?: unknown;
      /** Replaces the recording runner outright (e.g. the real SSH runner). */
      runner?: DeviceToolRunner;
    } = {},
  ) {
    const calls: { tool: DeviceTool; args: string[] }[] = [];
    const localCalls: string[][] = [];
    const run =
      options.run ??
      (async (_tool: DeviceTool, args: readonly string[]) =>
        args.join(' ') === `simctl ui ${IOS} appearance` ? 'dark\n' : '');
    const remoteTools = new DeviceToolsService({
      hostId: REMOTE,
      runner: options.runner ?? {
        run: async (tool, args, runOptions) => {
          calls.push({ tool, args: [...args] });
          return run(tool, args, runOptions);
        },
      },
      hub: {
        connect: async () =>
          options.hubTree === undefined
            ? { ok: false as const, failure: 'hub-unavailable' as const }
            : {
                ok: true as const,
                connection: {
                  request: async () =>
                    new Response(JSON.stringify(options.hubTree)),
                } as never,
              },
      },
    });
    const localTools = new DeviceToolsService({
      runner: {
        run: async (_tool, args) => {
          localCalls.push([...args]);
          return '';
        },
      },
      hub: {
        connect: async () => ({ ok: false, failure: 'hub-unavailable' }),
      },
    });
    const surfaces = new LiveSurfaceRegistry();
    const remoteHost = {
      inventory: vi.fn(
        async (): Promise<MobileDeviceInventory> => ({
          hostId: REMOTE,
          state: 'ready',
          observedAt: new Date().toISOString(),
          devices: DEVICES.map((device) => ({ ...device, hostId: REMOTE })),
        }),
      ),
      boot: vi.fn(),
      attachStream: vi.fn(async () => {}),
      shutdown: vi.fn(),
      screenshot: vi.fn(),
      connect: async () => ({
        ok: true as const,
        connection: {
          baseUrl: 'http://127.0.0.1:43872',
          request: async () => new Response(null, { status: 503 }),
          openWebSocket: () => new IdleSocket() as never,
        },
      }),
    };
    const access = options.access ?? fakeAccess;
    const remoteSessions = new DeviceSessionService({
      hostId: REMOTE,
      host: remoteHost as never,
      endpoint: { onExit: () => () => {} },
      surfaces,
      access,
    });
    const app = createDeviceToolsRoutes({
      isRequestPrincipalCurrent: () => true,
      access,
      tools: localTools,
      toolsFor: (hostId) => (hostId === REMOTE ? remoteTools : undefined),
      resolveHumanCaller: (c) => {
        const human = c.req.header('x-test-human');
        const [principal, device] = human ? human.split('/') : [];
        return principal && device ? { principal, device } : null;
      },
      // As the runtime wires it: the lease of the session ON ITS HOST.
      controlConflict: (caller, platform, deviceId, hostId) =>
        hostId === REMOTE
          ? deviceControlConflict(
              { sessions: remoteSessions, surfaces },
              platform,
              deviceId,
              caller,
            )
          : 'none',
    });
    const call = (
      method: string,
      path: string,
      actor: string,
      body?: unknown,
      human = 'user:ada/device:1',
    ) =>
      app.request(path, {
        method,
        headers: {
          'x-test-actor': actor,
          'x-test-human': human,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    cleanups.push(async () => {
      await remoteSessions.dispose();
      await surfaces.dispose();
    });
    return { call, calls, localCalls, remoteSessions, surfaces };
  }

  test('reads and acts ON that host, through its own service; nothing runs locally', async () => {
    const { call, calls, localCalls } = remoteSetup();
    const read = await call('GET', remotePath(), 'operator');
    expect(read.status).toBe(200);
    expect((await readJson(read)).data).toMatchObject({
      hostId: REMOTE,
      appearance: { state: 'read', value: 'dark' },
    });
    const acted = await call('POST', remotePath('/actions'), 'operator', DARK);
    expect(acted.status).toBe(200);
    expect(calls.map((entry) => entry.args.join(' '))).toContain(
      `simctl ui ${IOS} appearance dark`,
    );
    expect(localCalls).toEqual([]);
  });

  test('D12 is keyed by (host, platform, device): a share on the SSH host is not a share here, nor the reverse', async () => {
    const asked: string[] = [];
    const access: DeviceAccess = {
      ...fakeAccess,
      mayAccessDevice: async (request, platform, deviceId, purpose, hostId) => {
        asked.push(`${hostId}:${platform}:${deviceId}:${purpose}`);
        if (request.headers.get('x-test-actor') === 'operator') return true;
        return (
          request.headers.get('x-test-actor') === 'shared-remote' &&
          hostId === REMOTE &&
          platform === 'ios' &&
          deviceId === IOS
        );
      },
    };
    const { call, calls, localCalls } = remoteSetup({ access });
    expect(
      (await call('POST', remotePath('/actions'), 'shared-remote', DARK))
        .status,
    ).toBe(200);
    const beforeRefusals = calls.length;
    // The same UDID on THIS Station is not shared with them.
    expect(
      (
        await call(
          'POST',
          `/hosts/local/devices/ios/${IOS}/tools/actions`,
          'shared-remote',
          DARK,
        )
      ).status,
    ).toBe(403);
    // Nor is an Android emulator on that host they were not given.
    const refused = await call(
      'GET',
      remotePath('', 'android', 'emulator-5554'),
      'shared-remote',
    );
    expect(refused.status).toBe(403);
    expect(await readJson(refused)).toMatchObject({ code: 'access-denied' });
    expect(calls.length).toBe(beforeRefusals);
    expect(localCalls).toEqual([]);
    expect(asked).toEqual([
      `${REMOTE}:ios:${IOS}:drive`,
      `local:ios:${IOS}:drive`,
      `${REMOTE}:android:emulator-5554:view`,
    ]);
  });

  test('the lease on THAT host: another person or any agent driving refuses the action, and nothing runs', async () => {
    for (const holder of ['other-human', 'agent'] as const) {
      const env = remoteSetup();
      const session = await env.remoteSessions.open({
        hostId: REMOTE,
        platform: 'ios',
        deviceId: IOS,
      });
      const entry = env.surfaces.get(session.surfaceId)!;
      if (holder === 'other-human')
        claimHumanControl(entry, {
          kind: 'human',
          principal: 'user:bob',
          device: 'device:9',
        });
      else
        expect(
          (
            await claimAgentControl(
              entry,
              { kind: 'agent', principal: 'user:ada', sessionId: 'session-1' },
              'user:ada',
              { request: PROBE },
            )
          ).ok,
        ).toBe(true);
      const refused = await env.call(
        'POST',
        remotePath('/actions'),
        'operator',
        DARK,
      );
      expect(refused.status, holder).toBe(409);
      // An agent acting for this very person is still another controller.
      expect(await readJson(refused), holder).toEqual({
        success: false,
        code: 'device-controlled-by-other',
        heldBy: 'other',
      });
      expect(env.calls, holder).toEqual([]);
    }
  });

  test('the caller holding that host’s lease themselves may act', async () => {
    const env = remoteSetup();
    const session = await env.remoteSessions.open({
      hostId: REMOTE,
      platform: 'ios',
      deviceId: IOS,
    });
    claimHumanControl(env.surfaces.get(session.surfaceId)!, {
      kind: 'human',
      principal: 'user:ada',
      device: 'device:1',
    });
    expect(
      (await env.call('POST', remotePath('/actions'), 'operator', DARK)).status,
    ).toBe(200);
  });

  test('a busy host is 503 device-host-busy, never a refusal — at the access check and at the tool', async () => {
    const busyAccess = remoteSetup({
      access: {
        ...fakeAccess,
        mayAccessDevice: async () => {
          throw new DeviceHostBusyError();
        },
      },
    });
    for (const [method, path, body] of [
      ['GET', remotePath('', 'android', 'emulator-5554'), undefined],
      ['POST', remotePath('/actions', 'android', 'emulator-5554'), DARK],
    ] as const) {
      const response = await busyAccess.call(method, path, 'operator', body);
      expect(response.status, method).toBe(503);
      expect(await readJson(response)).toMatchObject({
        code: 'device-host-busy',
      });
    }
    expect(busyAccess.calls).toEqual([]);
    const busyTool = remoteSetup({
      run: async () => {
        throw new DeviceHostBusyError();
      },
    });
    const acted = await busyTool.call(
      'POST',
      remotePath('/actions'),
      'operator',
      DARK,
    );
    expect(acted.status).toBe(503);
    expect(await readJson(acted)).toMatchObject({ code: 'device-host-busy' });
    // A read degrades per value, like any tool failure, and says why.
    const read = await busyTool.call('GET', remotePath(), 'operator');
    expect(read.status).toBe(200);
    expect((await readJson(read)).data.appearance).toEqual({
      state: 'unreadable',
      reason: 'device-host-busy',
    });
  });

  test('the host’s own failures stay typed: not enabled 409, unreachable 503, deadline 504', async () => {
    for (const [error, status, code] of [
      [
        new DeviceToolsError('device-host-not-enabled'),
        409,
        'device-host-not-enabled',
      ],
      [
        new DeviceToolsError('device-host-unavailable'),
        503,
        'device-host-unavailable',
      ],
      [new DeviceToolError('tool-timeout', 'timed out'), 504, 'tool-timeout'],
    ] as const) {
      const env = remoteSetup({
        run: async () => {
          throw error;
        },
      });
      const response = await env.call(
        'POST',
        remotePath('/actions'),
        'operator',
        DARK,
      );
      expect(response.status, code).toBe(status);
      expect(await readJson(response)).toMatchObject({ code });
    }
  });

  /**
   * Review M2: an SSH host's runner may wait (its slot queue) between the
   * route's admission and the first command. The runner here waits the way
   * the registry does — the world changes during the wait — and then asks
   * `beforeRun` before running, as `DeviceHostRegistry.runTool` does once
   * the slot is granted.
   */
  function waitingRunner(duringWait: () => void | Promise<void>) {
    const ran: string[] = [];
    let waited = false;
    return {
      ran,
      run: async (
        _tool: DeviceTool,
        args: readonly string[],
        options?: { beforeRun?: () => Promise<void> },
      ) => {
        if (!waited) {
          waited = true;
          await duringWait();
        }
        await options?.beforeRun?.();
        ran.push(args.join(' '));
        return '';
      },
    };
  }

  test('a share revoked while the action waited for the host: 403, and nothing runs', async () => {
    let shared = true;
    const access: DeviceAccess = {
      ...fakeAccess,
      mayAccessDevice: async (request, _platform, deviceId) =>
        shared && request.headers.get('x-test-actor') === `shared:${deviceId}`,
    };
    const runner = waitingRunner(() => {
      shared = false;
    });
    const env = remoteSetup({ access, run: runner.run });
    const response = await env.call(
      'POST',
      remotePath('/actions'),
      `shared:${IOS}`,
      DARK,
    );
    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({ code: 'access-denied' });
    expect(runner.ran).toEqual([]);
  });

  test('someone taking control while the action waited: 409 with heldBy, and nothing runs', async () => {
    let entry: Parameters<typeof claimHumanControl>[0] | undefined;
    const runner = waitingRunner(() => {
      claimHumanControl(entry!, {
        kind: 'human',
        principal: 'user:bob',
        device: 'device:9',
      });
    });
    const env = remoteSetup({ run: runner.run });
    const session = await env.remoteSessions.open({
      hostId: REMOTE,
      platform: 'ios',
      deviceId: IOS,
    });
    entry = env.surfaces.get(session.surfaceId)!;
    const response = await env.call(
      'POST',
      remotePath('/actions'),
      'operator',
      DARK,
    );
    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      success: false,
      code: 'device-controlled-by-other',
      heldBy: 'other',
    });
    expect(runner.ran).toEqual([]);
  });

  test('a permission group is re-admitted ONCE, before its first command, and then runs whole', async () => {
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
    const runner = waitingRunner(() => {});
    const env = remoteSetup({ access, run: runner.run });
    const response = await env.call(
      'POST',
      remotePath('/actions', 'android', 'emulator-5554'),
      'operator',
      {
        type: 'set-permission',
        appId: 'com.example.app',
        permission: 'contacts',
        decision: 'grant',
      },
    );
    expect(response.status).toBe(200);
    // The admission, then the one re-admission — not one per command.
    expect(asked).toEqual([
      `${REMOTE}:android:drive`,
      `${REMOTE}:android:drive`,
    ]);
    expect(runner.ran.filter((args) => args.includes(' pm grant '))).toEqual([
      '-s emulator-5554 shell pm grant com.example.app android.permission.READ_CONTACTS',
      '-s emulator-5554 shell pm grant com.example.app android.permission.WRITE_CONTACTS',
    ]);
  });

  test('a host busy at the re-admission (its AVD lookup queued out) is 503, never a refusal', async () => {
    let busy = false;
    const access: DeviceAccess = {
      ...fakeAccess,
      mayAccessDevice: async () => {
        if (busy) throw new DeviceHostBusyError();
        return true;
      },
    };
    const runner = waitingRunner(() => {
      busy = true;
    });
    const env = remoteSetup({ access, run: runner.run });
    const response = await env.call(
      'POST',
      remotePath('/actions'),
      'operator',
      DARK,
    );
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: 'device-host-busy',
    });
    expect(runner.ran).toEqual([]);
  });

  test('a permission group whose re-admission finds the host busy: 503, and NO pm vector runs (round 3, D1)', async () => {
    let busy = false;
    let readmits = 0;
    const access: DeviceAccess = {
      ...fakeAccess,
      mayAccessDevice: async () => {
        if (!busy) return true;
        readmits += 1;
        throw new DeviceHostBusyError();
      },
    };
    const runner = waitingRunner(() => {
      busy = true;
    });
    const env = remoteSetup({ access, run: runner.run });
    for (const permission of ['contacts', 'photos']) {
      const response = await env.call(
        'POST',
        remotePath('/actions', 'android', 'emulator-5554'),
        'operator',
        {
          type: 'set-permission',
          appId: 'com.example.app',
          permission,
          decision: 'grant',
        },
      );
      expect(response.status, permission).toBe(503);
      expect(await readJson(response)).toMatchObject({
        code: 'device-host-busy',
      });
      // Asked once; the busy answer is what every later command got.
      expect(readmits, permission).toBe(1);
      readmits = 0;
    }
    expect(runner.ran.filter((args) => args.includes(' pm '))).toEqual([]);
  });

  test('the production path: a group through the real SSH runner whose re-admission finds the host busy answers 503, and no group run starts (final review R2)', async () => {
    let busy = false;
    const access: DeviceAccess = {
      ...fakeAccess,
      mayAccessDevice: async () => {
        if (busy) throw new DeviceHostBusyError();
        return true;
      },
    };
    // The registry's side of runTool: the slot is granted (the world
    // changed while waiting for it), then `beforeRun` decides before any
    // ssh — exactly what DeviceHostRegistry.runTool does.
    const groupRuns: SshToolRequest[] = [];
    const host: SshDeviceToolHost = {
      generation: () => 0,
      runTool: async (_hostId, request, control) => {
        busy = true;
        await control?.beforeRun?.();
        groupRuns.push(request);
        return { ok: true, stdout: '' };
      },
    };
    const env = remoteSetup({
      access,
      runner: createSshDeviceToolRunner(host, REMOTE),
    });
    const response = await env.call(
      'POST',
      remotePath('/actions', 'android', 'emulator-5554'),
      'operator',
      {
        type: 'set-permission',
        appId: 'com.example.app',
        permission: 'contacts',
        decision: 'grant',
      },
    );
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: 'device-host-busy',
    });
    expect(groupRuns).toEqual([]);
  });

  test('a host this Station does not have is unknown-host (404), after the access check; nothing runs', async () => {
    const { call, calls, localCalls } = remoteSetup();
    const response = await call(
      'GET',
      `/hosts/ssh-aaaaaaaaaaaa/devices/ios/${IOS}/tools`,
      'operator',
    );
    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ code: 'unknown-host' });
    expect(
      (
        await call(
          'GET',
          `/hosts/ssh-aaaaaaaaaaaa/devices/ios/${IOS}/tools`,
          'contributor',
        )
      ).status,
    ).toBe(403);
    expect(calls).toEqual([]);
    expect(localCalls).toEqual([]);
  });

  test('the accessibility tree from that host keeps the 256 KB response cap', async () => {
    const { call } = remoteSetup({
      hubTree: [
        {
          frame: { x: 0, y: 0, width: 400, height: 800 },
          children: Array.from({ length: 500 }, (_, index) => ({
            frame: { x: 10, y: index, width: 50, height: 20 },
            AXLabel: '\u0001'.repeat(200),
            type: 'Button',
          })),
        },
      ],
    });
    const response = await call(
      'GET',
      remotePath('/accessibility'),
      'operator',
    );
    expect(response.status).toBe(200);
    const tree = (await readJson(response)).data;
    expect(tree.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(tree), 'utf8')).toBeLessThanOrEqual(
      DEVICE_AX_RESPONSE_MAX_BYTES,
    );
  });
});
