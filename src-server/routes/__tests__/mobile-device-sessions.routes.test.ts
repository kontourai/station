import { EventEmitter } from 'node:events';
import type {
  MobileDeviceInventory,
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import {
  type DeviceAccess,
  deviceAccessFromShares,
  failClosedDeviceAccess,
} from '../../services/devices/device-access.js';
import type { DeviceSocket } from '../../services/devices/device-live-surface-producer.js';
import { DeviceSessionService } from '../../services/devices/device-session-service.js';
import type { DeviceShare } from '../../services/devices/device-shares.js';
import { LiveSurfaceRegistry } from '../../services/live-surface/registry.js';
import { createMobileDeviceRoutes } from '../mobile-device.js';

/**
 * #1970 (D5 as amended by D12): device-session routes are authorized per
 * caller AND per DEVICE. Devices belong to the operator; a Project admin
 * reaches only a device the operator shared with their Project (a test
 * double of the share predicate here — the toolchain lane owns the real
 * store). Booting and powering off are the operator's alone. The surface
 * each session registers carries the same per-device rule into the
 * live-surface routes (view → view, input/control → drive).
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
  {
    hostId: 'local',
    platform: 'ios',
    deviceId: OTHER_IOS,
    name: 'iPhone Air',
    runtime: 'iOS 26.5',
    booted: true,
  },
  {
    hostId: 'local',
    platform: 'android',
    deviceId: 'station-test',
    name: 'station-test',
    runtime: 'Android 16',
    booted: false,
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
 * Who a request is, from a test header: `operator`; `shared:<deviceId>` (an
 * admin of a Project that device is shared with — view AND drive);
 * `viewonly:<deviceId>` (view but not drive, the future read-only role);
 * anything else has no standing.
 */
const fakeAccess: DeviceAccess = {
  isOperator: async (request) =>
    request.headers.get('x-test-actor') === 'operator',
  hasStanding: async (request) => {
    const actor = request.headers.get('x-test-actor') ?? '';
    return (
      actor === 'operator' ||
      actor.startsWith('shared:') ||
      actor.startsWith('viewonly:')
    );
  },
  mayAccessDevice: async (request, _platform, deviceId, purpose) => {
    const actor = request.headers.get('x-test-actor') ?? '';
    if (actor === 'operator') return true;
    if (actor === `shared:${deviceId}`) return true;
    return actor === `viewonly:${deviceId}` && purpose === 'view';
  },
};

let releaseBoot: () => void = () => {};
let bootGate: Promise<void> = Promise.resolve();

function setup() {
  bootGate = new Promise<void>((resolve) => {
    releaseBoot = resolve;
  });
  const shutdowns: MobileDeviceTarget[] = [];
  const boots: MobileDeviceTarget[] = [];
  // What the hub lists; a test rewrites it to walk a boot through.
  const listed: MobileDeviceSummary[] = DEVICES.map((device) => ({
    ...device,
  }));
  const inventory = vi.fn(
    async (): Promise<MobileDeviceInventory> => ({
      hostId: 'local',
      state: 'ready',
      observedAt: new Date().toISOString(),
      devices: listed.map((device) => ({ ...device })),
    }),
  );
  const host = {
    inventory,
    capture: vi.fn(async () => ({})),
    boot: vi.fn(async (target: MobileDeviceTarget) => {
      boots.push(target);
      await bootGate;
      return { deviceId: 'emulator-5554' };
    }),
    attachStream: vi.fn(async () => {}),
    shutdown: vi.fn(async (target: MobileDeviceTarget) => {
      shutdowns.push(target);
    }),
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
  const app = createMobileDeviceRoutes(host as never, {
    isRequestPrincipalCurrent: () => true,
    sessions,
    access: fakeAccess,
  });
  const call = (method: string, path: string, actor: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        'x-test-actor': actor,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  cleanups.push(async () => {
    await sessions.dispose();
    await registry.dispose();
  });
  return { app, call, host, sessions, registry, shutdowns, boots, listed };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const openPath = (platform: string, id: string) =>
  `/hosts/local/devices/${platform}/${id}/sessions`;

describe('opening a session (per device, D12)', () => {
  test('the operator opens any device, registering its surface', async () => {
    const { call, registry } = setup();
    const response = await call('POST', openPath('ios', IOS), 'operator', {});
    expect(response.status).toBe(200);
    const { data } = await readJson(response);
    expect(data).toMatchObject({
      hostId: 'local',
      platform: 'ios',
      deviceId: IOS,
      surfaceId: expect.stringMatching(/^device:ios:/),
    });
    expect(registry.get(data.surfaceId)).toBeDefined();
  });

  test('a Project admin opens only a device shared with them', async () => {
    const { call, registry } = setup();
    expect(
      (await call('POST', openPath('ios', IOS), `shared:${IOS}`, {})).status,
    ).toBe(200);
    const refused = await call(
      'POST',
      openPath('ios', OTHER_IOS),
      `shared:${IOS}`,
      {},
    );
    expect(refused.status).toBe(403);
    expect(registry.size).toBe(1);
  });

  test('without standing, opening is refused and nothing registers', async () => {
    const { call, registry } = setup();
    expect(
      (await call('POST', openPath('ios', IOS), 'viewer', {})).status,
    ).toBe(403);
    expect(registry.size).toBe(0);
  });

  test('a stopped device cannot be opened, only started', async () => {
    const { call } = setup();
    const response = await call(
      'POST',
      openPath('android', 'station-test'),
      'operator',
      {},
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).code).toBe('device-not-running');
  });

  test.each([
    ['POST', '/hosts/local/devices/windows/x/sessions', {}],
    ['POST', '/hosts/local/devices/ios/not-a-udid/sessions', {}],
    ['POST', openPath('ios', IOS), { projectId: 'p' }],
    ['POST', openPath('ios', IOS), { extra: 'x' }],
    ['POST', openPath('ios', IOS), []],
  ])('route-seam validation refuses %s %s %o', async (method, path, body) => {
    const { call } = setup();
    const response = await call(method, path, 'operator', body);
    expect(response.status).toBe(400);
  });
});

describe('starting drives the device; powering off is the operator’s alone', () => {
  test('start boots a device for the operator or an admin it is shared with, nobody else', async () => {
    const { call, boots, listed: hubRows, sessions } = setup();
    for (const actor of [`shared:${IOS}`, 'viewonly:station-test', 'viewer']) {
      const refused = await call(
        'POST',
        '/hosts/local/devices/android/station-test/start',
        actor,
        {},
      );
      expect(refused.status, actor).toBe(403);
    }
    expect(boots).toHaveLength(0);
    // D12: the hub's boot route is `drive`, so a shared admin may Start.
    const ok = await call(
      'POST',
      '/hosts/local/devices/android/station-test/start',
      'shared:station-test',
      {},
    );
    // A cold boot takes minutes: answered at once, booted in the background.
    expect(ok.status).toBe(202);
    expect((await readJson(ok)).data).toEqual({
      deviceId: 'station-test',
      state: 'starting',
    });
    expect(boots).toEqual([
      { hostId: 'local', platform: 'android', deviceId: 'station-test' },
    ]);
    // While it boots, the list says so, and a second Start does not boot again.
    const listed = await readJson(
      await call('GET', '/hosts/local/devices', 'operator'),
    );
    expect(
      listed.data.devices.find(
        (device: MobileDeviceSummary) => device.deviceId === 'station-test',
      ),
    ).toMatchObject({ starting: true });
    expect(listed.data.canManageDevices).toBe(true);
    await call(
      'POST',
      '/hosts/local/devices/android/station-test/start',
      'operator',
      {},
    );
    expect(boots).toHaveLength(1);
    releaseBoot();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const read = async () =>
      (
        await readJson(await call('GET', '/hosts/local/devices', 'operator'))
      ).data.devices.filter(
        (device: MobileDeviceSummary) => device.platform === 'android',
      );
    // The boot call returned but the hub still lists the stopped AVD: it is
    // still coming up, so it still says so.
    expect(await read()).toMatchObject([
      { deviceId: 'station-test', starting: true },
    ]);
    // The hub now lists neither name (the AVD row is gone, the serial not
    // yet there): the row the caller started is kept, not dropped.
    hubRows.splice(
      hubRows.findIndex((device) => device.deviceId === 'station-test'),
      1,
    );
    expect(await read()).toEqual([
      expect.objectContaining({
        deviceId: 'station-test',
        name: 'station-test',
        booted: false,
        starting: true,
      }),
    ]);
    // Once it is listed running under its serial, the starting row retires.
    hubRows.push({
      hostId: 'local',
      platform: 'android',
      deviceId: 'emulator-5554',
      name: 'station-test',
      runtime: 'Android 16',
      booted: true,
    });
    expect(await read()).toEqual([
      expect.objectContaining({ deviceId: 'emulator-5554', booted: true }),
    ]);
    expect(await read()).toHaveLength(1);
    expect(sessions.isStarting('android', 'station-test')).toBe(false);
  });

  test('a started emulator the hub never lists is dropped after the listing grace, not kept as a ghost', async () => {
    let clock = 1_000;
    const avd = DEVICES.find((device) => device.platform === 'android')!;
    const rows: MobileDeviceSummary[] = [{ ...avd }];
    const service = new DeviceSessionService({
      host: {
        inventory: async () => ({
          hostId: 'local',
          state: 'ready',
          observedAt: new Date(clock).toISOString(),
          devices: rows.map((row) => ({ ...row })),
        }),
        boot: async () => ({ deviceId: 'emulator-5554' }),
      } as never,
      endpoint: { onExit: () => () => {} },
      surfaces: new LiveSurfaceRegistry(),
      access: fakeAccess,
      now: () => clock,
    });
    cleanups.push(() => service.dispose());
    await service.start({
      hostId: 'local',
      platform: 'android',
      deviceId: avd.deviceId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    rows.length = 0;
    expect(service.withStartingRows([])).toMatchObject([
      { deviceId: avd.deviceId, starting: true },
    ]);
    clock += 3 * 60_000 + 1;
    expect(service.withStartingRows([])).toEqual([]);
    expect(service.isStarting('android', avd.deviceId)).toBe(false);
  });

  test('power off ends the session, then shuts the device down', async () => {
    const { call, shutdowns, sessions, registry } = setup();
    await call('POST', openPath('ios', IOS), `shared:${IOS}`, {});
    const refused = await call(
      'POST',
      `/hosts/local/devices/ios/${IOS}/power-off`,
      `shared:${IOS}`,
      {},
    );
    expect(refused.status).toBe(403);
    expect(shutdowns).toHaveLength(0);
    const ok = await call(
      'POST',
      `/hosts/local/devices/ios/${IOS}/power-off`,
      'operator',
      {},
    );
    expect(ok.status).toBe(200);
    expect(shutdowns).toHaveLength(1);
    expect(sessions.list()).toHaveLength(0);
    expect(registry.size).toBe(0);
  });
});

describe('listing, capture and closing', () => {
  test('the device list shows a non-operator only what is shared with them', async () => {
    const { call } = setup();
    const ids = async (actor: string) =>
      (
        await readJson(await call('GET', '/hosts/local/devices', actor))
      ).data.devices.map((device: MobileDeviceSummary) => device.deviceId);
    expect(await ids('operator')).toHaveLength(3);
    expect(await ids(`shared:${IOS}`)).toEqual([IOS]);
  });

  test('a caller with no device standing is refused before the host is touched', async () => {
    const { call, host } = setup();
    const response = await call('GET', '/hosts/local/devices', 'viewer');
    expect(response.status).toBe(403);
    // Reading the inventory may start the managed hub: a stranger must not.
    expect(host.inventory).not.toHaveBeenCalled();
    expect(
      (await call('GET', '/hosts/local/devices', `shared:${IOS}`)).status,
    ).toBe(200);
    expect(host.inventory).toHaveBeenCalledTimes(1);
  });

  test('the session list shows each caller only sessions on their devices', async () => {
    const { call } = setup();
    await call('POST', openPath('ios', IOS), 'operator', {});
    await call('POST', openPath('ios', OTHER_IOS), 'operator', {});
    const read = async (actor: string) =>
      (await readJson(await call('GET', '/hosts/local/sessions', actor))).data
        .sessions;
    expect(await read('operator')).toHaveLength(2);
    expect(await read(`shared:${IOS}`)).toMatchObject([{ deviceId: IOS }]);
    expect(await read('viewer')).toHaveLength(0);
  });

  test('a capture of an unshared device is refused', async () => {
    const { call, host } = setup();
    const response = await call(
      'POST',
      `/hosts/local/devices/ios/${OTHER_IOS}/capture`,
      `shared:${IOS}`,
      {},
    );
    expect(response.status).toBe(403);
    // A capture POSTs a hub screenshot (`drive`): view alone is not enough.
    const viewOnly = await call(
      'POST',
      `/hosts/local/devices/ios/${IOS}/capture`,
      `viewonly:${IOS}`,
      {},
    );
    expect(viewOnly.status).toBe(403);
    expect(host.capture).not.toHaveBeenCalled();
    const shared = await call(
      'POST',
      `/hosts/local/devices/ios/${IOS}/capture`,
      `shared:${IOS}`,
      {},
    );
    expect(shared.status).toBe(200);
    expect(host.capture).toHaveBeenCalledTimes(1);
  });

  test('ending a session for everyone is the operator’s; others learn nothing about which sessions exist', async () => {
    const { call, registry } = setup();
    const opened = (
      await readJson(await call('POST', openPath('ios', IOS), 'operator', {}))
    ).data;
    const path = `/hosts/local/sessions/${opened.sessionId}`;
    const unknown =
      '/hosts/local/sessions/00000000-0000-4000-8000-000000000000';
    // A shared admin: refused alike for a real and a made-up session id.
    for (const target of [path, unknown]) {
      const response = await call('DELETE', target, `shared:${IOS}`);
      expect(response.status).toBe(403);
      expect((await readJson(response)).code).toBe('access-denied');
    }
    expect(registry.get(opened.surfaceId)).toBeDefined();
    expect((await call('DELETE', path, 'operator')).status).toBe(200);
    expect(registry.get(opened.surfaceId)).toBeUndefined();
    expect((await call('DELETE', path, 'operator')).status).toBe(404);
  });

  test('a credential withdrawn during the access checks stops the side effect', async () => {
    const env = setup();
    let current = true;
    const app = createMobileDeviceRoutes(env.host as never, {
      isRequestPrincipalCurrent: () => current,
      sessions: env.sessions,
      access: {
        isOperator: async () => {
          current = false; // withdrawn while this awaited
          return true;
        },
        hasStanding: async () => {
          current = false;
          return true;
        },
        mayAccessDevice: async () => {
          current = false;
          return true;
        },
      },
    });
    const post = (path: string) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    for (const path of [
      '/hosts/local/devices/android/station-test/start',
      `/hosts/local/devices/ios/${IOS}/power-off`,
      openPath('ios', IOS),
    ]) {
      current = true;
      expect((await post(path)).status).toBe(403);
    }
    expect(env.boots).toHaveLength(0);
    expect(env.shutdowns).toHaveLength(0);
    expect(env.registry.size).toBe(0);
  });
});

describe('the surface authorizer (per device)', () => {
  async function opened() {
    const env = setup();
    const { data } = await readJson(
      await env.call('POST', openPath('ios', IOS), 'operator', {}),
    );
    return { ...env, entry: env.registry.get(data.surfaceId)!, data };
  }
  const request = (actor: string) =>
    new Request('http://station.test/', {
      headers: { 'x-test-actor': actor },
    });

  test('the operator and a shared admin may view, input and control', async () => {
    const { entry } = await opened();
    for (const action of ['view', 'input', 'control'] as const)
      for (const actor of ['operator', `shared:${IOS}`])
        expect(
          await entry.authorize('p', action, { request: request(actor) }),
        ).toBe(true);
  });

  test('view and drive are separate; others and a bare principal get nothing', async () => {
    const { entry } = await opened();
    const viewOnly = { request: request(`viewonly:${IOS}`) };
    expect(await entry.authorize('p', 'view', viewOnly)).toBe(true);
    expect(await entry.authorize('p', 'input', viewOnly)).toBe(false);
    expect(await entry.authorize('p', 'control', viewOnly)).toBe(false);
    expect(
      await entry.authorize('p', 'view', {
        request: request(`shared:${OTHER_IOS}`),
      }),
    ).toBe(false);
    expect(await entry.authorize('p', 'view')).toBe(false);
  });

  test('a closed session admits nobody', async () => {
    const { entry, call, data } = await opened();
    await call('DELETE', `/hosts/local/sessions/${data.sessionId}`, 'operator');
    expect(
      await entry.authorize('p', 'view', { request: request('operator') }),
    ).toBe(false);
  });
});

describe('the access predicates', () => {
  const req = new Request('http://station.test/');

  /**
   * The runtime's predicate over lane E's share store (D12): the operator
   * always; an admin of `?projectSlug=` only for a device shared with that
   * Project, an emulator serial resolved to its AVD; nobody else.
   */
  function sharesAccess(options: {
    operator?: boolean;
    admin?: boolean;
    shares?: Pick<DeviceShare, 'platform' | 'deviceId'>[];
    avd?: string;
  }) {
    const authorizeProject = vi.fn(async () =>
      options.admin
        ? { kind: 'project-admin' as const, principalId: 'u1' }
        : undefined,
    );
    const access = deviceAccessFromShares({
      authorizeOperator: async () => options.operator === true,
      authorizeProject,
      resolveProject: (slug) =>
        slug === 'demo' ? { id: 'proj-1' } : undefined,
      shares: {
        list: (projectId) =>
          projectId === 'proj-1'
            ? (options.shares ?? []).map((share) => ({
                hostId: 'local',
                ...share,
                label: share.deviceId,
                addedBy: 'operator',
                addedAt: '2026-09-01T00:00:00.000Z',
              }))
            : [],
      },
      resolveAndroidAvd: async () => options.avd,
    });
    return { access, authorizeProject };
  }
  const admin = new Request('http://station.test/?projectSlug=demo');

  test('shares: the operator reaches every device', async () => {
    const { access } = sharesAccess({ operator: true });
    expect(await access.isOperator(req)).toBe(true);
    expect(await access.hasStanding(req, 'view')).toBe(true);
    expect(
      await access.mayAccessDevice(req, 'ios', IOS, 'drive', 'local'),
    ).toBe(true);
  });

  test('shares: an admin reaches only a device shared with the named Project', async () => {
    const { access, authorizeProject } = sharesAccess({
      admin: true,
      shares: [
        { platform: 'ios', deviceId: IOS },
        { platform: 'android', deviceId: 'station-test' },
      ],
      avd: 'station-test',
    });
    expect(await access.isOperator(admin)).toBe(false);
    expect(await access.hasStanding(admin, 'view')).toBe(true);
    expect(
      await access.mayAccessDevice(admin, 'ios', IOS, 'drive', 'local'),
    ).toBe(true);
    expect(
      await access.mayAccessDevice(admin, 'ios', OTHER_IOS, 'view', 'local'),
    ).toBe(false);
    // An emulator serial is judged by the AVD running on it.
    expect(
      await access.mayAccessDevice(
        admin,
        'android',
        'emulator-5554',
        'drive',
        'local',
      ),
    ).toBe(true);
    // The Project authority is asked for the purpose the route needs.
    expect(authorizeProject).toHaveBeenCalledWith(admin, 'proj-1', 'drive');
    // Without `?projectSlug=` the same admin has no standing at all.
    expect(await access.hasStanding(req, 'view')).toBe(false);
    expect(await access.mayAccessDevice(req, 'ios', IOS, 'view', 'local')).toBe(
      false,
    );
  });

  test('shares: an admin of a Project with nothing shared, or an unresolvable serial, is refused', async () => {
    const none = sharesAccess({ admin: true }).access;
    expect(await none.hasStanding(admin, 'view')).toBe(false);
    expect(await none.mayAccessDevice(admin, 'ios', IOS, 'view', 'local')).toBe(
      false,
    );
    const unresolved = sharesAccess({
      admin: true,
      shares: [{ platform: 'android', deviceId: 'station-test' }],
    }).access;
    expect(
      await unresolved.mayAccessDevice(
        admin,
        'android',
        'emulator-5554',
        'view',
        'local',
      ),
    ).toBe(false);
    const stranger = sharesAccess({
      shares: [{ platform: 'ios', deviceId: IOS }],
    }).access;
    expect(await stranger.hasStanding(admin, 'view')).toBe(false);
  });

  test('fail-closed: a throwing check is a refusal', async () => {
    const access = failClosedDeviceAccess({
      isOperator: async () => {
        throw new Error('boom');
      },
      hasStanding: async () => {
        throw new Error('boom');
      },
      mayAccessDevice: async () => {
        throw new Error('boom');
      },
    });
    expect(await access.isOperator(req)).toBe(false);
    expect(await access.hasStanding(req, 'view')).toBe(false);
    expect(await access.mayAccessDevice(req, 'ios', IOS, 'view', 'local')).toBe(
      false,
    );
  });
});

describe('the live-surface routes carry the Project context to the device authorizer', () => {
  test('`?projectSlug=` reaches the REAL registered authorizer; other extra keys are still refused', async () => {
    const { createLiveSurfaceRoutes } = await import('../live-surface.js');
    const seen: string[] = [];
    // D12 double: an admin of `alpha`, which the operator shared the iOS
    // device with. It is the ONLY access the session service knows, so the
    // surface authorizer the service registers can only answer through it.
    const shares: DeviceAccess = {
      isOperator: async () => false,
      hasStanding: async () => true,
      mayAccessDevice: async (request, platform, deviceId) => {
        const slug = new URL(request.url).searchParams.get('projectSlug');
        seen.push(`${slug}:${platform}`);
        return slug === 'alpha' && platform === 'ios' && deviceId === IOS;
      },
    };
    const env = setup();
    const registry = new LiveSurfaceRegistry();
    const sessions = new DeviceSessionService({
      host: env.host as never,
      endpoint: { onExit: () => () => {} },
      surfaces: registry,
      access: shares,
    });
    cleanups.push(async () => {
      await sessions.dispose();
      await registry.dispose();
    });
    const session = await sessions.open({
      hostId: 'local',
      platform: 'ios',
      deviceId: IOS,
    });
    const routes = createLiveSurfaceRoutes(registry, {
      isRequestPrincipalCurrent: () => true,
      resolveHumanCaller: () => ({ principal: 'alice', device: 'd' }),
    });
    const frames = (query: string) =>
      routes.request(
        `/${encodeURIComponent(session.surfaceId)}/frames${query}`,
      );
    expect((await frames('?projectSlug=beta')).status).toBe(403);
    expect((await frames('')).status).toBe(403);
    const allowed = await frames('?projectSlug=alpha&maxFps=5');
    expect(allowed.status).toBe(200);
    await allowed.body?.cancel();
    expect((await frames('?projectSlug=alpha&extra=1')).status).toBe(400);
    expect(seen.slice(0, 3)).toEqual(['beta:ios', 'null:ios', 'alpha:ios']);
  });
});

describe('a session nobody watches ends by itself (Close only detaches)', () => {
  test('never watched, or watched and left: it ends after the idle grace; watching holds it', async () => {
    const env = setup();
    const registry = new LiveSurfaceRegistry();
    const sessions = new DeviceSessionService({
      host: env.host as never,
      endpoint: { onExit: () => () => {} },
      surfaces: registry,
      access: fakeAccess,
      idleEndMs: 30,
    });
    cleanups.push(async () => {
      await sessions.dispose();
      await registry.dispose();
    });
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const target = { hostId: 'local', platform: 'ios' as const, deviceId: IOS };

    // Opened, never watched: ends.
    const unwatched = await sessions.open(target);
    await wait(60);
    expect(sessions.get(unwatched.sessionId)).toBeUndefined();

    // Watched: held past the grace; the last viewer leaving ends it.
    const watched = await sessions.open(target);
    const viewer = registry.get(watched.surfaceId)!.hub.attach({
      maxFps: 5,
      quality: 50,
      maxWidth: 640,
      maxHeight: 640,
    });
    await registry.get(watched.surfaceId)!.hub.settled();
    await wait(60);
    expect(sessions.get(watched.sessionId)).toBeDefined();
    viewer.close();
    await registry.get(watched.surfaceId)?.hub.settled();
    await wait(60);
    expect(sessions.get(watched.sessionId)).toBeUndefined();
    expect(registry.get(watched.surfaceId)).toBeUndefined();
  });
});

describe('round 3', () => {
  test('a viewer that only suspends (tab hidden, pane collapsed) does not end the session within the default grace (D2)', async () => {
    const env = setup();
    const opened = (
      await readJson(
        await env.call('POST', openPath('ios', IOS), 'operator', {}),
      )
    ).data;
    const hub = env.registry.get(opened.surfaceId)!.hub;
    const params = { maxFps: 5, quality: 50, maxWidth: 640, maxHeight: 640 };
    // Watch, suspend, come back, suspend again: every suspension detaches
    // the viewer's stream, which is all the server can see.
    for (let i = 0; i < 2; i += 1) {
      const viewer = hub.attach(params);
      await hub.settled();
      viewer.close();
      await hub.settled();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(env.sessions.get(opened.sessionId)).toBeDefined();
  });

  test('a failed background Start is on the device row at once (D4)', async () => {
    const env = setup();
    env.host.boot.mockImplementationOnce(async () => {
      throw new Error('no space left on device');
    });
    const started = await env.call(
      'POST',
      '/hosts/local/devices/android/station-test/start',
      'operator',
      {},
    );
    expect(started.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const listed = await readJson(
      await env.call('GET', '/hosts/local/devices', 'operator'),
    );
    const row = listed.data.devices.find(
      (device: MobileDeviceSummary) => device.deviceId === 'station-test',
    );
    expect(row.starting).toBeUndefined();
    expect(row.startError).toBe('hub-unavailable');
  });

  test('a credential that lapses while the helper attaches registers no surface (Open re-check)', async () => {
    const env = setup();
    let current = true;
    env.host.attachStream.mockImplementationOnce(async () => {
      current = false;
    });
    const app = createMobileDeviceRoutes(env.host as never, {
      isRequestPrincipalCurrent: () => current,
      sessions: env.sessions,
      access: fakeAccess,
    });
    const response = await app.request(openPath('ios', IOS), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-actor': 'operator',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(env.registry.size).toBe(0);
    expect(env.sessions.list()).toHaveLength(0);
  });
});

describe('device sessions on an SSH device host (#1973)', () => {
  test('the session, its routes and its surface authorizer all carry the host', async () => {
    const REMOTE = 'ssh-0123456789ab';
    const env = setup();
    const asked: string[] = [];
    // Shared on the SSH host only: a check naming `local` is refused.
    const access: DeviceAccess = {
      isOperator: async (request) =>
        request.headers.get('x-test-actor') === 'operator',
      hasStanding: async () => true,
      mayAccessDevice: async (
        _request,
        platform,
        deviceId,
        purpose,
        hostId,
      ) => {
        asked.push(`${hostId}:${platform}:${deviceId}:${purpose}`);
        return hostId === REMOTE && deviceId === IOS;
      },
    };
    const remoteHost = {
      ...env.host,
      inventory: vi.fn(async () => ({
        hostId: REMOTE,
        state: 'ready' as const,
        observedAt: new Date().toISOString(),
        devices: DEVICES.map((device) => ({ ...device, hostId: REMOTE })),
      })),
    };
    const registry = new LiveSurfaceRegistry();
    const sessions = new DeviceSessionService({
      hostId: REMOTE,
      host: remoteHost as never,
      endpoint: { onExit: () => () => {} },
      surfaces: registry,
      access,
    });
    cleanups.push(async () => {
      await sessions.dispose();
      await registry.dispose();
    });
    const app = createMobileDeviceRoutes(env.host as never, {
      isRequestPrincipalCurrent: () => true,
      sessions: env.sessions,
      access,
      remoteHost: (hostId) =>
        hostId === REMOTE ? { host: remoteHost as never, sessions } : undefined,
    });
    const call = (method: string, path: string) =>
      app.request(path, {
        method,
        headers: {
          'x-test-actor': 'admin',
          'content-type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    // The same device on `local` is refused (not shared there)…
    expect(
      (await call('POST', `/hosts/local/devices/ios/${IOS}/sessions`)).status,
    ).toBe(403);
    // …and on the SSH host it opens, on that host.
    const opened = await call(
      'POST',
      `/hosts/${REMOTE}/devices/ios/${IOS}/sessions`,
    );
    expect(opened.status).toBe(200);
    const session = (await readJson(opened)).data;
    expect(session.hostId).toBe(REMOTE);
    expect(env.sessions.list()).toEqual([]);
    expect(
      (await readJson(await call('GET', `/hosts/${REMOTE}/sessions`))).data
        .sessions,
    ).toHaveLength(1);
    // The registered surface asks the device authorizer about THIS host.
    asked.length = 0;
    const { createLiveSurfaceRoutes } = await import('../live-surface.js');
    const routes = createLiveSurfaceRoutes(registry, {
      isRequestPrincipalCurrent: () => true,
      resolveHumanCaller: () => ({ principal: 'alice', device: 'd' }),
    });
    const frames = await routes.request(
      `/${encodeURIComponent(session.surfaceId)}/frames?maxFps=5`,
    );
    expect(frames.status).toBe(200);
    await frames.body?.cancel();
    expect(asked[0]).toBe(`${REMOTE}:ios:${IOS}:view`);
  });
});
