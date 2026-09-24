/**
 * Device toolchain routes and the device hub proxy (#1970), behind the real
 * runtime authentication (pairing scopes) and a D5 authorizer stand-in.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import type { DeviceToolchainStatus } from '@kontourai/station-contracts/device-toolchain';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { requiredPairingScope } from '../../security/pairing-route-scopes.js';
import { isRuntimeRequestPrincipalCurrent } from '../../security/runtime-request-security.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import {
  DeviceHostBusyError,
  DeviceShareStore,
} from '../../services/devices/device-shares.js';
import { createDeviceHubConnection } from '../../services/devices/toolchain/device-hub-connection.js';
import { DeviceToolConsentRequiredError } from '../../services/devices/toolchain/device-toolchain.js';
import { createDeviceToolchainRoutes } from '../device-toolchain.js';

const SHARED = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const UNSHARED = 'D0EF88EE-6F52-4669-A407-936B76F63C90';
const REMOTE_HOST = 'ssh-0123456789ab';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const STATUS: DeviceToolchainStatus = {
  managedBy: 'station',
  canManage: true,
  hub: { tool: 'expo-device-hub', state: 'installed', version: '0.10.1' },
  agentDevice: {
    tool: 'agent-device',
    state: 'needs-consent',
    requiredVersion: '0.21.12',
  },
  hubProcess: {
    state: 'running',
    version: '0.10.1',
    startedAt: '2026-09-22T00:00:00.000Z',
  },
  hubSource: 'managed',
  hubEnabled: true,
  agentAccess: false,
  platforms: [],
};

function harness(
  options: {
    hubRunning?: boolean;
    status?: DeviceToolchainStatus;
    upstreamContentType?: string;
    streamLimits?: { perCaller: number; perProject: number };
    /** Which AVD each emulator serial is running now. */
    avds?: Record<string, string>;
    /** Delay every upstream answer (to open a race window). */
    upstreamDelayMs?: number;
    /** Make the first upstream request fail. */
    upstreamFailFirst?: boolean;
  } = {},
) {
  const credentials = new Map([
    ['operator', DEFAULT_GRANT_PAIRING_SCOPE],
    ['admin-beta', DEFAULT_GRANT_PAIRING_SCOPE],
    ['admin2-alpha', DEFAULT_GRANT_PAIRING_SCOPE],
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
    eventBus: { emit() {}, on() {}, off() {} },
    security,
  } as unknown as Parameters<typeof configureRuntimeHttp>[0]);
  let upstreamCalls = 0;
  const upstream = vi.fn(async (_url: string, _init?: RequestInit) => {
    upstreamCalls += 1;
    if (options.upstreamDelayMs)
      await new Promise((resolve) =>
        setTimeout(resolve, options.upstreamDelayMs),
      );
    if (options.upstreamFailFirst && upstreamCalls === 1)
      throw new Error('hub went away');
    return new Response('--frame\r\n', {
      status: 200,
      headers: {
        'content-type':
          options.upstreamContentType ??
          'multipart/x-mixed-replace; boundary=frame',
        'set-cookie': 'hub=1',
        'content-encoding': 'gzip',
      },
    });
  });
  const connection = createDeviceHubConnection({
    port: 50_123,
    version: '0.10.1',
    secret: 's'.repeat(64),
    fetch: upstream as unknown as typeof fetch,
  });
  // #1973: an SSH device host's forwarded hub, through its own connection.
  const remoteUpstream = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response('remote', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
  );
  const remoteConnection = createDeviceHubConnection({
    hostId: REMOTE_HOST,
    port: 41_000,
    version: '0.10.1',
    secret: 'r'.repeat(64),
    fetch: remoteUpstream as unknown as typeof fetch,
  });
  const remoteHubs = {
    has: (hostId: string) => hostId === REMOTE_HOST,
    ensureHub: vi.fn(async (hostId: string) =>
      hostId === REMOTE_HOST ? remoteConnection : undefined,
    ),
  };
  const service = {
    status: vi.fn(async () => options.status ?? STATUS),
    versions: vi.fn(() => ({
      checkedAt: '2026-09-22T00:00:00.000Z',
      tools: [],
    })),
    enableHub: vi.fn((request: { consent: true }) => {
      if (request?.consent !== true) throw new DeviceToolConsentRequiredError();
      return { completion: Promise.resolve() };
    }),
    disableHub: vi.fn(async () => {}),
    setAgentAccess: vi.fn(() => ({ completion: Promise.resolve() })),
    update: vi.fn(() => ({ completion: Promise.resolve() })),
    startHub: vi.fn(async () => connection),
    ensureHub: vi.fn(async () =>
      options.hubRunning === false ? undefined : connection,
    ),
  };
  const bearer = (request: Request) =>
    request.headers.get('authorization')?.replace(/^Bearer /, '');
  // Admins of both Projects; only alpha has a device shared with it (D12).
  const admins: Record<string, string[]> = {
    'p-alpha': ['admin-alpha', 'admin2-alpha'],
    'p-beta': ['admin-beta'],
  };
  const authorizeProject = vi.fn<BrowserProjectAuthorizer>(
    async (request, projectId) => {
      const credential = bearer(request);
      if (credential === 'operator') return { kind: 'operator' };
      if (credential && admins[projectId]?.includes(credential))
        return { kind: 'project-admin', principalId: credential };
      return undefined;
    },
  );
  const home = mkdtempSync(join(tmpdir(), 'station-device-routes-'));
  homes.push(home);
  const shares = new DeviceShareStore(home);
  shares.add(
    'p-alpha',
    {
      hostId: 'local',
      platform: 'ios',
      deviceId: SHARED,
      label: 'Shared iPhone',
    },
    'operator',
  );
  shares.add(
    'p-alpha',
    {
      hostId: 'local',
      platform: 'android',
      deviceId: 'Pixel_A',
      label: 'Shared Pixel',
    },
    'operator',
  );
  const projects = [
    { id: 'p-alpha', slug: 'alpha' },
    { id: 'p-beta', slug: 'beta' },
  ];
  app.route(
    '/api/mobile-devices',
    createDeviceToolchainRoutes({
      service,
      access: {
        authorizeOperator: async (request) => bearer(request) === 'operator',
        authorizeProject,
        resolveProject: (slug) =>
          projects.find((project) => project.slug === slug),
        shares,
        resolveAndroidAvd: async (serial) => {
          // A device host too busy to answer (#1973 D2).
          if (serial === 'emulator-5560') throw new DeviceHostBusyError();
          return (options.avds ?? { 'emulator-5554': 'Pixel_A' })[serial];
        },
      },
      shares,
      listProjects: () => projects,
      isRequestPrincipalCurrent: (request) =>
        isRuntimeRequestPrincipalCurrent(request, security),
      remoteHubs,
      ...(options.streamLimits ? { streamLimits: options.streamLimits } : {}),
    }),
  );
  const request = (
    method: string,
    path: string,
    credential?: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(
      `/api/mobile-devices${path}`,
      {
        method,
        headers: {
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      },
      {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as HttpBindings,
    );
  return { request, service, upstream, shares, remoteUpstream, remoteHubs };
}

const STREAM = `/hosts/local/hub/vendor/serve-sim/helper/${SHARED}/stream.mjpeg`;

describe('the hub proxy when a host is busy (#1973 D2)', () => {
  test('an admin\u2019s proxied request whose emulator cannot be named yet is a retryable 503, never a 403', async () => {
    const h = harness();
    const response = await h.request(
      'GET',
      '/hosts/local/hub/vendor/serve-emu/api/stream-settings?device=emulator-5560&projectSlug=alpha',
      'admin-alpha',
    );
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: 'device-host-busy',
    });
    expect(h.upstream).not.toHaveBeenCalled();
  });
});

describe('the hub proxy on an SSH device host (#1973)', () => {
  const remoteStream = (udid: string) =>
    `/hosts/${REMOTE_HOST}/hub/vendor/serve-sim/helper/${udid}/stream.mjpeg`;

  test('reaches THAT host’s connection, with its secret, never the local hub', async () => {
    const h = harness();
    const response = await h.request('GET', remoteStream(SHARED), 'operator');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('remote');
    expect(h.remoteHubs.ensureHub).toHaveBeenCalledWith(REMOTE_HOST);
    expect(h.service.ensureHub).not.toHaveBeenCalled();
    expect(h.upstream).not.toHaveBeenCalled();
    const [url, init] = h.remoteUpstream.mock.calls[0]!;
    expect(url).toBe(
      `http://127.0.0.1:41000/vendor/serve-sim/helper/${SHARED}/stream.mjpeg`,
    );
    expect(
      ((init?.headers ?? {}) as Record<string, string>)['x-station-hub-secret'],
    ).toBe('r'.repeat(64));
  });

  test('an unknown host is refused; an exec path is refused on every host', async () => {
    const h = harness();
    expect(
      (
        await h.request(
          'GET',
          `/hosts/ssh-ffffffffffff/hub/vendor/serve-sim/helper/${SHARED}/stream.mjpeg`,
          'operator',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request(
          'POST',
          `/hosts/${REMOTE_HOST}/hub/vendor/serve-sim/exec`,
          'operator',
          '{}',
        )
      ).status,
    ).toBe(404);
    expect(h.remoteUpstream).not.toHaveBeenCalled();
  });

  test('D12 by host: a device shared on `local` is not reachable on the SSH host', async () => {
    const h = harness();
    // SHARED is shared with alpha on `local` only.
    expect(
      (
        await h.request(
          'GET',
          `${remoteStream(SHARED)}?projectSlug=alpha`,
          'admin-alpha',
        )
      ).status,
    ).toBe(403);
    h.shares.add(
      'p-alpha',
      {
        hostId: REMOTE_HOST,
        platform: 'ios',
        deviceId: SHARED,
        label: 'Remote',
      },
      'operator',
    );
    const allowed = await h.request(
      'GET',
      `${remoteStream(SHARED)}?projectSlug=alpha`,
      'admin-alpha',
    );
    expect(allowed.status).toBe(200);
    await allowed.body?.cancel();
  });

  test('shares name their host; an unknown host is refused', async () => {
    const h = harness();
    const created = await h.request('POST', '/shares', 'operator', {
      projectSlug: 'alpha',
      hostId: REMOTE_HOST,
      platform: 'ios',
      deviceId: UNSHARED,
      label: 'Remote',
    });
    expect(created.status).toBe(201);
    expect((await readJson(created)).data.hostId).toBe(REMOTE_HOST);
    expect(
      (
        await h.request('POST', '/shares', 'operator', {
          projectSlug: 'alpha',
          hostId: 'ssh-ffffffffffff',
          platform: 'ios',
          deviceId: UNSHARED,
          label: 'Nowhere',
        })
      ).status,
    ).toBe(400);
    // Removing the local share of the same device leaves the remote one.
    expect(
      (
        await h.request(
          'DELETE',
          `/shares/alpha/ios/${UNSHARED}?hostId=${REMOTE_HOST}`,
          'operator',
        )
      ).status,
    ).toBe(200);
    expect(
      h.shares.list('p-alpha').some((share) => share.hostId === REMOTE_HOST),
    ).toBe(false);
  });
});
const UNSHARED_STREAM = `/hosts/local/hub/vendor/serve-sim/helper/${UNSHARED}/stream.mjpeg`;

describe('device toolchain routes: pairing scope classification', () => {
  test('status and versions are reads; mutations and the whole proxy need terminal:operate', () => {
    for (const path of [
      '/api/mobile-devices/toolchain',
      '/api/mobile-devices/toolchain/versions',
    ])
      expect(requiredPairingScope('GET', path)).toBe(
        PAIRING_SCOPE_ORCHESTRATION_READ,
      );
    for (const [method, path] of [
      ['POST', '/api/mobile-devices/toolchain/hub'],
      ['POST', '/api/mobile-devices/toolchain/agent-access'],
      ['POST', '/api/mobile-devices/toolchain/update'],
      ['POST', '/api/mobile-devices/toolchain/hub/start'],
      ['GET', `/api/mobile-devices${STREAM}`],
      [
        'POST',
        '/api/mobile-devices/hosts/local/hub/vendor/serve-sim/api/screenshot',
      ],
    ] as const)
      expect(requiredPairingScope(method, path), `${method} ${path}`).toBe(
        PAIRING_SCOPE_TERMINAL_OPERATE,
      );
  });

  test('a read-only paired device cannot reach the hub proxy', async () => {
    const h = harness();
    expect((await h.request('GET', STREAM, 'viewer')).status).toBe(403);
    expect(h.upstream).not.toHaveBeenCalled();
  });
});

describe('device toolchain routes: authorization (D5)', () => {
  test('mutations are operator-only; a Project admin and a contributor are refused', async () => {
    const h = harness();
    for (const credential of ['admin-alpha', 'contributor-alpha']) {
      for (const [path, body] of [
        ['/toolchain/hub?projectSlug=alpha', { enabled: true, consent: true }],
        [
          '/toolchain/agent-access?projectSlug=alpha',
          { enabled: true, consent: true },
        ],
        ['/toolchain/update?projectSlug=alpha', { tool: 'expo-device-hub' }],
        ['/toolchain/hub/start?projectSlug=alpha', {}],
      ] as const) {
        const response = await h.request('POST', path, credential, body);
        expect(response.status, `${credential} ${path}`).toBe(403);
      }
    }
    expect(h.service.enableHub).not.toHaveBeenCalled();
    expect(h.service.setAgentAccess).not.toHaveBeenCalled();
    expect(h.service.update).not.toHaveBeenCalled();
    expect(h.service.startHub).not.toHaveBeenCalled();
  });

  test('status: operator, or an admin of the named Project; never a contributor', async () => {
    const h = harness();
    expect((await h.request('GET', '/toolchain', 'operator')).status).toBe(200);
    expect(
      (await h.request('GET', '/toolchain?projectSlug=alpha', 'admin-alpha'))
        .status,
    ).toBe(200);
    expect((await h.request('GET', '/toolchain', 'admin-alpha')).status).toBe(
      403,
    );
    expect(
      (await h.request('GET', '/toolchain?projectSlug=beta', 'admin-alpha'))
        .status,
    ).toBe(403);
    expect(
      (
        await h.request(
          'GET',
          '/toolchain?projectSlug=alpha',
          'contributor-alpha',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          'GET',
          '/toolchain/versions?projectSlug=alpha',
          'contributor-alpha',
        )
      ).status,
    ).toBe(403);
  });

  test('the proxy: operator and Project admin stream; a contributor gets nothing', async () => {
    const h = harness();
    expect((await h.request('GET', STREAM, 'operator')).status).toBe(200);
    expect(
      (await h.request('GET', `${STREAM}?projectSlug=alpha`, 'admin-alpha'))
        .status,
    ).toBe(200);
    const refused = await h.request(
      'GET',
      `${STREAM}?projectSlug=alpha`,
      'contributor-alpha',
    );
    expect(refused.status).toBe(403);
    expect(h.upstream).toHaveBeenCalledTimes(2);
  });
});

describe('device toolchain routes: consent', () => {
  test('enabling the hub requires the literal consent', async () => {
    const h = harness();
    for (const body of [
      { enabled: true },
      { enabled: true, consent: 'true' },
      { enabled: true, consent: 1 },
    ]) {
      const response = await h.request(
        'POST',
        '/toolchain/hub',
        'operator',
        body,
      );
      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual({
        success: false,
        code: 'consent-required',
      });
    }
    expect(h.service.enableHub).not.toHaveBeenCalled();
    const accepted = await h.request('POST', '/toolchain/hub', 'operator', {
      enabled: true,
      consent: true,
    });
    expect(accepted.status).toBe(202);
    expect(h.service.enableHub).toHaveBeenCalledWith({ consent: true });
  });

  test('agent access needs consent to turn on, none to turn off', async () => {
    const h = harness();
    expect(
      (
        await h.request('POST', '/toolchain/agent-access', 'operator', {
          enabled: true,
        })
      ).status,
    ).toBe(400);
    expect(h.service.setAgentAccess).not.toHaveBeenCalled();
    expect(
      (
        await h.request('POST', '/toolchain/agent-access', 'operator', {
          enabled: false,
        })
      ).status,
    ).toBe(200);
    expect(h.service.setAgentAccess).toHaveBeenCalledWith(false, undefined);
  });

  test('route-seam validation refuses unknown fields and tools', async () => {
    const h = harness();
    expect(
      (
        await h.request('POST', '/toolchain/update', 'operator', {
          tool: 'npm',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request('POST', '/toolchain/hub', 'operator', {
          enabled: true,
          consent: true,
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(h.service.update).not.toHaveBeenCalled();
  });
});

describe('device hub proxy', () => {
  test('refuses every non-allowlisted and shell-exec path without reaching the hub', async () => {
    const h = harness();
    for (const [method, path] of [
      ['GET', '/hosts/local/hub/vendor/serve-sim/exec'],
      ['POST', '/hosts/local/hub/vendor/serve-sim/exec'],
      ['GET', '/hosts/local/hub/vendor/serve-sim/exec-ws'],
      ['GET', '/hosts/local/hub/vendor/serve-sim/api'],
      ['GET', '/hosts/local/hub/'],
      ['POST', '/hosts/local/hub/api/devices/create'],
      [
        'GET',
        '/hosts/local/hub/vendor/serve-sim/helper/a%2F..%2F..%2Fexec/config',
      ],
      ['POST', '/hosts/local/hub/api/devices'],
    ] as const) {
      const response = await h.request(
        method,
        path,
        'operator',
        method === 'POST' ? {} : undefined,
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(
      (await h.request('DELETE', '/hosts/local/hub/api/devices', 'operator'))
        .status,
    ).toBe(405);
    expect(
      (
        await h.request(
          'GET',
          '/hosts/local/hub/api/devices/ws',
          'operator',
          undefined,
          {
            Upgrade: 'websocket',
          },
        )
      ).status,
    ).toBe(405);
    expect(h.upstream).not.toHaveBeenCalled();
  });

  test('strips tickets and credentials, and answers no-store, no-transform', async () => {
    const h = harness();
    const response = await h.request(
      'GET',
      `${STREAM}?projectSlug=alpha&wsTicket=t1&ticket=t2&fps=5`,
      'admin-alpha',
      undefined,
      { Cookie: 'station_session=abc', Accept: 'multipart/x-mixed-replace' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'no-store, no-transform',
    );
    expect(response.headers.get('content-type')).toBe(
      'multipart/x-mixed-replace; boundary=frame',
    );
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
    const [url, init] = h.upstream.mock.calls[0] ?? [];
    expect(url).toBe(
      `http://127.0.0.1:50123/vendor/serve-sim/helper/${SHARED}/stream.mjpeg?fps=5`,
    );
    // Only the allowlisted request headers cross; the cookie and the bearer
    // credential that authenticated this request never reach the hub.
    expect(init?.headers).toEqual({
      accept: 'multipart/x-mixed-replace',
      'content-type': 'application/json',
      // The hub guard's per-launch secret, added by Station, never the client.
      'x-station-hub-secret': 's'.repeat(64),
    });
  });

  test('a credential in the query is refused at ingress, before the proxy', async () => {
    const h = harness();
    const response = await h.request('GET', `${STREAM}?token=t2`, 'operator');
    expect(response.status).toBe(401);
    expect(h.upstream).not.toHaveBeenCalled();
  });

  test('a hub that is not running is a typed 503', async () => {
    const h = harness({ hubRunning: false });
    const response = await h.request('GET', STREAM, 'operator');
    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({
      success: false,
      code: 'hub-unavailable',
    });
  });
});

describe('device access (D12)', () => {
  test('an admin streams only a device shared with their Project', async () => {
    const h = harness();
    expect(
      (await h.request('GET', `${STREAM}?projectSlug=alpha`, 'admin-alpha'))
        .status,
    ).toBe(200);
    for (const path of [
      `${UNSHARED_STREAM}?projectSlug=alpha`,
      // No single device named: the operator's alone.
      '/hosts/local/hub/api/devices?projectSlug=alpha',
      '/hosts/local/hub/vendor/serve-emu/health?projectSlug=alpha',
    ])
      expect((await h.request('GET', path, 'admin-alpha')).status, path).toBe(
        403,
      );
    expect(h.upstream).toHaveBeenCalledTimes(1);
  });

  test('an admin of a Project with nothing shared gets nothing', async () => {
    const h = harness();
    expect(
      (await h.request('GET', '/toolchain?projectSlug=beta', 'admin-beta'))
        .status,
    ).toBe(403);
    expect(
      (await h.request('GET', `${STREAM}?projectSlug=beta`, 'admin-beta'))
        .status,
    ).toBe(403);
    expect(h.service.ensureHub).not.toHaveBeenCalled();
  });

  test('an admin cannot enable or install, and sees status without detail', async () => {
    const h = harness({
      status: {
        ...STATUS,
        hub: {
          tool: 'expo-device-hub',
          state: 'failed',
          requiredVersion: '0.10.1',
          reason: 'install-failed',
          detail: 'npm ci exited 1 in /Users/brian/.station/devices',
          retryable: true,
        },
        platforms: [{ platform: 'ios', ready: true, reason: 'ready' }],
      },
    });
    expect(
      (
        await h.request(
          'POST',
          '/toolchain/hub?projectSlug=alpha',
          'admin-alpha',
          {
            enabled: true,
            consent: true,
          },
        )
      ).status,
    ).toBe(403);
    expect(h.service.enableHub).not.toHaveBeenCalled();
    const body = (await readJson(
      await h.request('GET', '/toolchain?projectSlug=alpha', 'admin-alpha'),
    )) as { data: DeviceToolchainStatus };
    expect(body.data.canManage).toBe(false);
    expect(body.data.hub).toMatchObject({ state: 'failed', detail: '' });
    expect(body.data.platforms).toEqual([]);
    const asOperator = (await readJson(
      await h.request('GET', '/toolchain', 'operator'),
    )) as { data: DeviceToolchainStatus };
    expect(asOperator.data.canManage).toBe(true);
    expect(asOperator.data.hub).toMatchObject({
      detail: 'npm ci exited 1 in /Users/brian/.station/devices',
    });
  });

  test('only the operator shares and unshares devices', async () => {
    const h = harness();
    const share = {
      projectSlug: 'beta',
      platform: 'ios',
      deviceId: UNSHARED,
      label: 'Operator iPhone',
    };
    expect(
      (
        await h.request(
          'POST',
          '/shares?projectSlug=alpha',
          'admin-alpha',
          share,
        )
      ).status,
    ).toBe(403);
    expect(h.shares.list('p-beta')).toEqual([]);
    expect((await h.request('POST', '/shares', 'operator', share)).status).toBe(
      201,
    );
    expect((await h.request('POST', '/shares', 'operator', share)).status).toBe(
      409,
    );
    expect(
      (
        await h.request('POST', '/shares', 'operator', {
          ...share,
          deviceId: 'not a udid',
        })
      ).status,
    ).toBe(400);
    const listed = (await readJson(
      await h.request('GET', '/shares', 'operator'),
    )) as {
      data: Array<{ projectSlug: string; shares: Array<{ deviceId: string }> }>;
    };
    expect(
      listed.data.map((entry) => [
        entry.projectSlug,
        entry.shares.map((s) => s.deviceId),
      ]),
    ).toEqual([
      ['alpha', [SHARED, 'Pixel_A']],
      ['beta', [UNSHARED]],
    ]);
    // An admin sees only their own Project's shares.
    const own = (await readJson(
      await h.request('GET', '/shares?projectSlug=alpha', 'admin-alpha'),
    )) as { data: Array<{ projectSlug: string }> };
    expect(own.data.map((entry) => entry.projectSlug)).toEqual(['alpha']);
    expect(
      (
        await h.request(
          'DELETE',
          `/shares/beta/ios/${UNSHARED}?projectSlug=alpha`,
          'admin-alpha',
        )
      ).status,
    ).toBe(403);
    expect(
      (await h.request('DELETE', `/shares/beta/ios/${UNSHARED}`, 'operator'))
        .status,
    ).toBe(200);
    expect(h.shares.list('p-beta')).toEqual([]);
  });
});

describe('device hub proxy: response hardening', () => {
  test('a sandboxing CSP on every proxied answer, and unknown types become opaque bytes', async () => {
    const h = harness({ upstreamContentType: 'text/html; charset=utf-8' });
    const response = await h.request('GET', STREAM, 'operator');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
  });

  test('admin streams are capped per caller and per Project; the operator never is', async () => {
    const h = harness({ streamLimits: { perCaller: 1, perProject: 1 } });
    const admin = `${STREAM}?projectSlug=alpha`;
    const first = await h.request('GET', admin, 'admin-alpha');
    expect(first.status).toBe(200);
    // Same caller again: per-caller cap.
    expect((await h.request('GET', admin, 'admin-alpha')).status).toBe(429);
    // Another admin of the same Project: per-Project cap.
    expect((await h.request('GET', admin, 'admin2-alpha')).status).toBe(429);
    // The operator is never locked out by admins' streams.
    expect((await h.request('GET', STREAM, 'operator')).status).toBe(200);
    expect((await h.request('GET', STREAM, 'operator')).status).toBe(200);
    // Finishing the admin's stream frees their slot.
    await first.text();
    expect((await h.request('GET', admin, 'admin-alpha')).status).toBe(200);
  });
});

describe('device-scoped routes (SF1, N1)', () => {
  test("serve-emu's fleet listing is operator-only, even with a shared device named", async () => {
    const h = harness();
    expect(
      (
        await h.request(
          'GET',
          '/hosts/local/hub/vendor/serve-emu/api/devices?device=emulator-5554&projectSlug=alpha',
          'admin-alpha',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          'GET',
          '/hosts/local/hub/vendor/serve-emu/api/devices',
          'operator',
        )
      ).status,
    ).toBe(200);
  });

  test('only the first, authorized device parameter is forwarded', async () => {
    const h = harness();
    const path =
      '/hosts/local/hub/vendor/serve-emu/api/stream-settings?device=emulator-5554&device=emulator-9999&projectSlug=alpha';
    expect((await h.request('GET', path, 'admin-alpha')).status).toBe(200);
    expect(h.upstream.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:50123/vendor/serve-emu/api/stream-settings?device=emulator-5554',
    );
    // An unshared device first is refused, whatever follows it.
    expect(
      (
        await h.request(
          'GET',
          '/hosts/local/hub/vendor/serve-emu/api/stream-settings?device=emulator-9999&device=emulator-5554&projectSlug=alpha',
          'admin-alpha',
        )
      ).status,
    ).toBe(403);
  });
});

describe('boot and power off (lane F)', () => {
  const BOOT = '/hosts/local/hub/api/devices/boot';
  const OFF = '/hosts/local/hub/api/devices/shutdown';

  test('an admin boots a shared device; only {platform, id} reaches the hub', async () => {
    const h = harness();
    const response = await h.request(
      'POST',
      `${BOOT}?projectSlug=alpha`,
      'admin-alpha',
      {
        platform: 'android',
        id: 'emulator-5554',
        name: 'Some_Other_AVD',
      },
    );
    expect(response.status).toBe(200);
    const [url, init] = h.upstream.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:50123/api/devices/boot');
    expect(init?.body).toBe('{"platform":"android","id":"emulator-5554"}');
  });

  test('an admin cannot boot an unshared device or power any device off', async () => {
    const h = harness();
    expect(
      (
        await h.request('POST', `${BOOT}?projectSlug=alpha`, 'admin-alpha', {
          platform: 'ios',
          id: UNSHARED,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request('POST', `${OFF}?projectSlug=alpha`, 'admin-alpha', {
          platform: 'ios',
          id: SHARED,
        })
      ).status,
    ).toBe(403);
    expect(h.upstream).not.toHaveBeenCalled();
  });

  test('the operator powers a device off; malformed bodies are refused', async () => {
    const h = harness();
    expect(
      (
        await h.request('POST', OFF, 'operator', {
          platform: 'ios',
          id: SHARED,
        })
      ).status,
    ).toBe(200);
    for (const body of [
      'x',
      { platform: 'tv', id: SHARED },
      { platform: 'ios', id: 'bad id' },
    ])
      expect((await h.request('POST', BOOT, 'operator', body)).status).toBe(
        400,
      );
    expect(h.upstream).toHaveBeenCalledTimes(1);
  });

  test('an admin boot does not start a hub the operator has not enabled', async () => {
    const h = harness({ hubRunning: false });
    expect(
      (
        await h.request('POST', `${BOOT}?projectSlug=alpha`, 'admin-alpha', {
          platform: 'ios',
          id: SHARED,
        })
      ).status,
    ).toBe(503);
  });
});

describe('Android shares are keyed by AVD name', () => {
  const SETTINGS =
    '/hosts/local/hub/vendor/serve-emu/api/stream-settings?projectSlug=alpha&device=emulator-5554';

  test('a shared AVD on emulator-5554 is reachable; another AVD booted on 5554 is not', async () => {
    expect(
      (await harness().request('GET', SETTINGS, 'admin-alpha')).status,
    ).toBe(200);
    const swapped = harness({ avds: { 'emulator-5554': 'Pixel_B' } });
    expect((await swapped.request('GET', SETTINGS, 'admin-alpha')).status).toBe(
      403,
    );
    // A serial nothing can resolve is refused too.
    const unknown = harness({ avds: {} });
    expect((await unknown.request('GET', SETTINGS, 'admin-alpha')).status).toBe(
      403,
    );
    expect(swapped.upstream).not.toHaveBeenCalled();
  });

  test('booting by serial follows the AVD running there', async () => {
    const swapped = harness({ avds: { 'emulator-5554': 'Pixel_B' } });
    expect(
      (
        await swapped.request(
          'POST',
          '/hosts/local/hub/api/devices/boot?projectSlug=alpha',
          'admin-alpha',
          { platform: 'android', id: 'emulator-5554' },
        )
      ).status,
    ).toBe(403);
    // By AVD name (how an unbooted emulator is listed), the share applies.
    const h = harness();
    expect(
      (
        await h.request(
          'POST',
          '/hosts/local/hub/api/devices/boot?projectSlug=alpha',
          'admin-alpha',
          { platform: 'android', id: 'Pixel_A' },
        )
      ).status,
    ).toBe(200);
  });

  test('sharing a running emulator by serial records the AVD running there', async () => {
    const h = harness();
    const response = await h.request('POST', '/shares', 'operator', {
      projectSlug: 'beta',
      platform: 'android',
      deviceId: 'emulator-5554',
      label: 'Pixel',
    });
    expect(response.status).toBe(201);
    expect(h.shares.list('p-beta').map((share) => share.deviceId)).toEqual([
      'Pixel_A',
    ]);
    // A serial nothing is running on cannot be shared.
    expect(
      (
        await h.request('POST', '/shares', 'operator', {
          projectSlug: 'beta',
          platform: 'android',
          deviceId: 'emulator-5556',
          label: 'Nothing',
        })
      ).status,
    ).toBe(409);
  });
});

describe('stream cap under concurrency', () => {
  test('a concurrent burst never exceeds the per-caller cap', async () => {
    const h = harness({
      streamLimits: { perCaller: 2, perProject: 10 },
      upstreamDelayMs: 30,
    });
    const statuses = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.request('GET', `${STREAM}?projectSlug=alpha`, 'admin-alpha'),
      ),
    ).then((responses) => responses.map((response) => response.status));
    expect(statuses.filter((status) => status === 200)).toHaveLength(2);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
  });

  test('a stream that fails before it starts gives its slot back', async () => {
    const h = harness({
      streamLimits: { perCaller: 1, perProject: 10 },
      upstreamFailFirst: true,
    });
    const admin = `${STREAM}?projectSlug=alpha`;
    expect((await h.request('GET', admin, 'admin-alpha')).status).toBe(502);
    expect((await h.request('GET', admin, 'admin-alpha')).status).toBe(200);
  });
});

describe('running emulator AVDs for the share list', () => {
  test('the operator maps serials to the AVD running there; admins are refused', async () => {
    const h = harness();
    const response = await h.request(
      'GET',
      '/shares/avds?serial=emulator-5554&serial=emulator-5556',
      'operator',
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: { 'emulator-5554': 'Pixel_A', 'emulator-5556': null },
    });
    expect(
      (
        await h.request(
          'GET',
          '/shares/avds?serial=emulator-5554&projectSlug=alpha',
          'admin-alpha',
        )
      ).status,
    ).toBe(403);
    expect(
      (await h.request('GET', '/shares/avds?serial=Pixel_A', 'operator'))
        .status,
    ).toBe(400);
  });
});
