import type { HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { isRuntimeRequestPrincipalCurrent } from '../../security/runtime-request-security.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import { deviceAccessFromShares } from '../../services/devices/device-access.js';
import {
  DeviceHostBusyError,
  type DeviceShare,
} from '../../services/devices/device-shares.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { createMobileDeviceRoutes } from '../mobile-device.js';

const capturePath =
  '/api/mobile-devices/hosts/local/devices/ios/6E8C08FA-3A81-4347-90B9-AD41B7FAE876/capture';
const inventoryPath = '/api/mobile-devices/hosts/local/devices';
const SHARED_IOS = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const UNSHARED_IOS = 'D0EF88EE-6F52-4669-A407-936B76F63C90';
/** #1973: an SSH device host, and a simulator only it runs. */
const REMOTE = 'ssh-0123456789ab';
const REMOTE_IOS = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
function harness() {
  const credentials = new Map([
    ['operator', DEFAULT_GRANT_PAIRING_SCOPE],
    // A read-only device paired to the operator: operator standing, read scope.
    ['viewer', pairingScopePresetString('read-only')],
    ['admin-alpha', DEFAULT_GRANT_PAIRING_SCOPE],
    ['contributor-alpha', DEFAULT_GRANT_PAIRING_SCOPE],
  ]);
  const security = {
    verifyCredential: (value: string) => credentials.has(value),
    authorizeCredential: (value: string) => credentials.has(value),
    resolveGrantedScope: (value: string) => credentials.get(value),
    allowedOrigins: [],
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
    setLevel() {},
    getLevel() {
      return 'info' as const;
    },
  };
  const app = new Hono<{ Bindings: HttpBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: new EventBus(),
    security,
  } as Parameters<typeof configureRuntimeHttp>[0]);
  const host = {
    inventory: vi.fn(async () => ({
      hostId: 'local',
      state: 'ready' as const,
      observedAt: new Date().toISOString(),
      devices: [
        {
          hostId: 'local',
          platform: 'ios' as const,
          deviceId: SHARED_IOS,
          name: 'Shared iPhone',
          runtime: 'iOS 26.5',
          booted: true,
        },
        {
          hostId: 'local',
          platform: 'ios' as const,
          deviceId: UNSHARED_IOS,
          name: 'Operator iPhone',
          runtime: 'iOS 26.5',
          booted: true,
        },
        {
          hostId: 'local',
          platform: 'android' as const,
          deviceId: 'emulator-5554',
          name: 'Pixel',
          runtime: 'Android 16',
          booted: true,
        },
      ],
    })),
    capture: vi.fn(async () => ({
      captureId: 'capture',
      target: {
        hostId: 'local',
        platform: 'ios' as const,
        deviceId: 'selected',
      },
      capturedAt: new Date().toISOString(),
      width: 1,
      height: 1,
      mimeType: 'image/png' as const,
      pngBase64: 'private-frame',
    })),
  };
  const bearer = (request: Request) =>
    request.headers.get('authorization')?.replace(/^Bearer /, '');
  const shares: Record<string, DeviceShare[]> = {
    'p-alpha': [
      {
        hostId: 'local',
        platform: 'ios',
        deviceId: SHARED_IOS,
        label: 'Shared iPhone',
        addedBy: 'operator',
        addedAt: '2026-09-22T00:00:00.000Z',
      },
      {
        hostId: 'local',
        platform: 'android',
        deviceId: 'Pixel_A',
        label: 'Shared Pixel',
        addedBy: 'operator',
        addedAt: '2026-09-22T00:00:00.000Z',
      },
    ],
  };
  // Shared on the SSH host: only REMOTE_IOS. (SHARED_IOS is shared on
  // `local` only, and the SSH host happens to list the same UDID.)
  shares['p-alpha']!.push({
    hostId: REMOTE,
    platform: 'ios',
    deviceId: REMOTE_IOS,
    label: 'Remote iPhone',
    addedBy: 'operator',
    addedAt: '2026-09-22T00:00:00.000Z',
  });
  const remoteHost = {
    inventory: vi.fn(async () => ({
      hostId: REMOTE,
      state: 'ready' as const,
      observedAt: new Date().toISOString(),
      devices: [SHARED_IOS, REMOTE_IOS].map((deviceId) => ({
        hostId: REMOTE,
        platform: 'ios' as const,
        deviceId,
        name: deviceId === REMOTE_IOS ? 'Remote iPhone' : 'Same UDID',
        runtime: 'iOS 26.5',
        booted: true,
      })),
    })),
    capture: vi.fn(
      async (target: {
        hostId: string;
        platform: 'ios';
        deviceId: string;
      }) => ({
        captureId: 'remote-capture',
        target,
        capturedAt: new Date().toISOString(),
        width: 1,
        height: 1,
        mimeType: 'image/png' as const,
        pngBase64: 'remote-frame',
      }),
    ),
  };
  const avds: Record<string, string> = { 'emulator-5554': 'Pixel_A' };
  const authorizeProject: BrowserProjectAuthorizer = async (
    request,
    projectId,
  ) =>
    bearer(request) === 'admin-alpha' && projectId === 'p-alpha'
      ? { kind: 'project-admin', principalId: 'admin-alpha' }
      : undefined;
  app.route(
    '/api/mobile-devices',
    createMobileDeviceRoutes(host, {
      isRequestPrincipalCurrent: (request) =>
        isRuntimeRequestPrincipalCurrent(request, security),
      // The runtime's composition: lane E's share store behind the
      // `DeviceAccess` predicate the device routes ask.
      access: deviceAccessFromShares({
        authorizeOperator: async (request) =>
          ['operator', 'viewer'].includes(bearer(request) ?? ''),
        authorizeProject,
        resolveProject: (slug) =>
          ({ alpha: { id: 'p-alpha' }, beta: { id: 'p-beta' } })[slug],
        shares: { list: (projectId) => shares[projectId] ?? [] },
        resolveAndroidAvd: async (serial) => {
          // A host too busy to answer (#1973 D2).
          if (serial === 'emulator-5560') throw new DeviceHostBusyError();
          return avds[serial];
        },
      }),
      remoteHost: (hostId) =>
        hostId === REMOTE ? { host: remoteHost } : undefined,
      listRemoteHosts: () => [
        {
          hostId: REMOTE,
          label: 'Mac mini',
          kind: 'ssh' as const,
          hub: {
            state: 'running' as const,
            startedAt: '2026-09-22T00:00:00.000Z',
          },
        },
      ],
    }),
  );
  const request = (path: string, credential?: string, body?: string) =>
    app.request(
      path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
      },
      {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as HttpBindings,
    );
  return { credentials, host, remoteHost, request, avds };
}

describe('mobile device routes: SSH device hosts (#1973)', () => {
  const remoteDevices = `/api/mobile-devices/hosts/${REMOTE}/devices`;

  test('a request names its host and reaches only that host', async () => {
    const h = harness();
    const response = await h.request(remoteDevices, 'operator');
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.data.hostId).toBe(REMOTE);
    expect(
      body.data.devices.map((d: { deviceId: string }) => d.deviceId),
    ).toEqual([SHARED_IOS, REMOTE_IOS]);
    expect(h.remoteHost.inventory).toHaveBeenCalledTimes(1);
    expect(h.host.inventory).not.toHaveBeenCalled();
    const capture = await h.request(
      `${remoteDevices}/ios/${REMOTE_IOS}/capture`,
      'operator',
      '{}',
    );
    expect(capture.status).toBe(200);
    expect(h.remoteHost.capture).toHaveBeenCalledWith({
      hostId: REMOTE,
      platform: 'ios',
      deviceId: REMOTE_IOS,
    });
    expect(h.host.capture).not.toHaveBeenCalled();
  });

  test('an unknown or malformed host is refused and touches nothing', async () => {
    const h = harness();
    for (const hostId of ['ssh-ffffffffffff', 'ssh-XYZ', 'LOCAL', '..'])
      expect(
        (
          await h.request(
            `/api/mobile-devices/hosts/${hostId}/devices`,
            'operator',
          )
        ).status,
      ).toBe(404);
    expect(
      (
        await h.request(
          `/api/mobile-devices/hosts/ssh-ffffffffffff/devices/ios/${REMOTE_IOS}/capture`,
          'operator',
          '{}',
        )
      ).status,
    ).toBe(400);
    expect(h.host.inventory).not.toHaveBeenCalled();
    expect(h.remoteHost.inventory).not.toHaveBeenCalled();
  });

  test('D12 by host: a local share does not admit the same UDID on the SSH host', async () => {
    const h = harness();
    const admin = `?projectSlug=alpha`;
    const listed = await readJson(
      await h.request(`${remoteDevices}${admin}`, 'admin-alpha'),
    );
    expect(
      listed.data.devices.map((d: { deviceId: string }) => d.deviceId),
    ).toEqual([REMOTE_IOS]);
    expect(
      (
        await h.request(
          `${remoteDevices}/ios/${SHARED_IOS}/capture${admin}`,
          'admin-alpha',
          '{}',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          `${remoteDevices}/ios/${REMOTE_IOS}/capture${admin}`,
          'admin-alpha',
          '{}',
        )
      ).status,
    ).toBe(200);
    // …and the remote share does not admit REMOTE_IOS on `local`.
    expect(
      (
        await h.request(
          `/api/mobile-devices/hosts/local/devices/ios/${REMOTE_IOS}/capture${admin}`,
          'admin-alpha',
          '{}',
        )
      ).status,
    ).toBe(403);
  });

  test('D2: a host too busy to name an emulator\u2019s AVD is a retryable 503, never a 403', async () => {
    const h = harness();
    const response = await h.request(
      '/api/mobile-devices/hosts/local/devices/android/emulator-5560/capture?projectSlug=alpha',
      'admin-alpha',
      '{}',
    );
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: 'device-host-busy',
    });
    expect(h.host.capture).not.toHaveBeenCalled();
  });

  test('the host picker: labels for anyone with standing, hub state for the operator only', async () => {
    const h = harness();
    const operator = await readJson(
      await h.request('/api/mobile-devices/hosts', 'operator'),
    );
    expect(operator.data.hosts).toEqual([
      { hostId: 'local', label: 'This Station', kind: 'local' },
      {
        hostId: REMOTE,
        label: 'Mac mini',
        kind: 'ssh',
        hub: { state: 'running', startedAt: '2026-09-22T00:00:00.000Z' },
      },
    ]);
    const admin = await readJson(
      await h.request(
        '/api/mobile-devices/hosts?projectSlug=alpha',
        'admin-alpha',
      ),
    );
    expect(admin.data.hosts).toEqual([
      { hostId: 'local', label: 'This Station', kind: 'local' },
      { hostId: REMOTE, label: 'Mac mini', kind: 'ssh' },
    ]);
    expect(
      (await h.request('/api/mobile-devices/hosts', 'contributor-alpha'))
        .status,
    ).toBe(403);
    // Never an ssh target.
    expect(JSON.stringify(operator)).not.toMatch(/@|sshTarget/);
  });
});

describe('mobile device routes through runtime authentication', () => {
  test('unauthenticated inventory is rejected before the helper is called', async () => {
    const h = harness();
    expect((await h.request(inventoryPath)).status).toBe(401);
    expect(h.host.inventory).not.toHaveBeenCalled();
  });
  test('read-only credentials can list metadata but cannot capture screens', async () => {
    const h = harness();
    expect((await h.request(inventoryPath, 'viewer')).status).toBe(200);
    expect((await h.request(capturePath, 'viewer', '{}')).status).toBe(403);
    expect(h.host.capture).not.toHaveBeenCalled();
  });
  test('authorized capture is not cached and has no raw proxy route', async () => {
    const h = harness();
    const response = await h.request(capturePath, 'operator', '{}');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.host.capture).toHaveBeenCalledWith({
      hostId: 'local',
      platform: 'ios',
      deviceId: '6E8C08FA-3A81-4347-90B9-AD41B7FAE876',
    });
    expect(
      (await h.request('/api/mobile-devices/exec', 'operator', '{}')).status,
    ).toBe(404);
  });
  test('scope revocation during capture suppresses the private frame', async () => {
    const h = harness();
    const original = h.host.capture.getMockImplementation()!;
    h.host.capture.mockImplementation(async () => {
      const result = await original();
      h.credentials.set('operator', pairingScopePresetString('read-only'));
      return result;
    });
    const response = await h.request(capturePath, 'operator', '{}');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('private-frame');
  });
  test('removing a credential during inventory suppresses its result', async () => {
    const h = harness();
    const original = h.host.inventory.getMockImplementation()!;
    h.host.inventory.mockImplementation(async () => {
      const result = await original();
      h.credentials.delete('viewer');
      return result;
    });
    expect((await h.request(inventoryPath, 'viewer')).status).toBe(403);
  });
  test.each(['{"url":"http://other-host"}', '[]', 'null', 'x'.repeat(1025)])(
    'rejects capture body instead of forwarding it',
    async (body) => {
      const h = harness();
      expect((await h.request(capturePath, 'operator', body)).status).toBe(400);
      expect(h.host.capture).not.toHaveBeenCalled();
    },
  );
});

describe('mobile device routes: device access (D12)', () => {
  const unsharedCapture = capturePath.replace(SHARED_IOS, UNSHARED_IOS);

  test('a contributor is refused and the host is never touched', async () => {
    const h = harness();
    expect(
      (
        await h.request(
          `${inventoryPath}?projectSlug=alpha`,
          'contributor-alpha',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          `${capturePath}?projectSlug=alpha`,
          'contributor-alpha',
          '{}',
        )
      ).status,
    ).toBe(403);
    expect(h.host.inventory).not.toHaveBeenCalled();
    expect(h.host.capture).not.toHaveBeenCalled();
  });

  test('a Project admin sees only the devices shared with that Project', async () => {
    const h = harness();
    const response = await h.request(
      `${inventoryPath}?projectSlug=alpha`,
      'admin-alpha',
    );
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      data: { devices: Array<{ deviceId: string }> };
    };
    expect(body.data.devices.map((device) => device.deviceId)).toEqual([
      SHARED_IOS,
      'emulator-5554',
    ]);
    // Without a Project, or for a Project with nothing shared: nothing.
    expect((await h.request(inventoryPath, 'admin-alpha')).status).toBe(403);
    expect(
      (await h.request(`${inventoryPath}?projectSlug=beta`, 'admin-alpha'))
        .status,
    ).toBe(403);
  });

  test('a Project admin captures a shared device but not an unshared one', async () => {
    const h = harness();
    expect(
      (await h.request(`${capturePath}?projectSlug=alpha`, 'admin-alpha', '{}'))
        .status,
    ).toBe(200);
    expect(
      (
        await h.request(
          `${unsharedCapture}?projectSlug=alpha`,
          'admin-alpha',
          '{}',
        )
      ).status,
    ).toBe(403);
    expect(h.host.capture).toHaveBeenCalledTimes(1);
  });

  test('the operator sees every device', async () => {
    const h = harness();
    const body = (await readJson(
      await h.request(inventoryPath, 'operator'),
    )) as { data: { devices: unknown[] } };
    expect(body.data.devices).toHaveLength(3);
  });
});

describe('mobile device routes: Android by AVD name (D12)', () => {
  test('a different AVD booted on the shared serial disappears from the list and cannot be captured', async () => {
    const h = harness();
    h.avds['emulator-5554'] = 'Pixel_B';
    const body = (await readJson(
      await h.request(`${inventoryPath}?projectSlug=alpha`, 'admin-alpha'),
    )) as { data: { devices: Array<{ deviceId: string }> } };
    expect(body.data.devices.map((device) => device.deviceId)).toEqual([
      SHARED_IOS,
    ]);
    const androidCapture =
      '/api/mobile-devices/hosts/local/devices/android/emulator-5554/capture';
    expect(
      (
        await h.request(
          `${androidCapture}?projectSlug=alpha`,
          'admin-alpha',
          '{}',
        )
      ).status,
    ).toBe(403);
    h.avds['emulator-5554'] = 'Pixel_A';
    expect(
      (
        await h.request(
          `${androidCapture}?projectSlug=alpha`,
          'admin-alpha',
          '{}',
        )
      ).status,
    ).toBe(200);
  });
});
