/**
 * #1971 review S3: the Tools drawer's lease rule through the REAL runtime
 * composition — `configureRuntimeRoutes` with the real credential pipeline,
 * the real `resolveLiveSurfaceHumanCaller`, the real live-surface registry,
 * a real device session (over a loopback fake of the device hub's HTTP
 * surface) and the real tools routes. Only the host tool runner is faked
 * (no `xcrun` on a Linux runner), so what is proved is the WIRING: the
 * credential that claimed the device's lease through `/api/live-surfaces`
 * may act through `/tools/actions`; a different credential of the SAME
 * operator (a paired local-grant device) is refused 409
 * `same-person-elsewhere`; agent-originated credentials (the station-control
 * token, a delegation device) are refused `principal-unresolved`; an
 * off-box paired device (not the operator, no share) is refused by D12; and
 * a read-only credential by the pairing scope.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

/** Every host tool invocation the tools service asked for. */
const toolCalls: { tool: string; args: string[] }[] = vi.hoisted(() => []);

vi.mock('../../../services/devices/device-tools.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../services/devices/device-tools.js')
    >();
  return {
    ...actual,
    // The one fake: the host runner (the argv shape check in the service
    // still runs before this is reached).
    createDeviceToolRunner: () => ({
      run: async (tool: string, args: readonly string[]) => {
        toolCalls.push({ tool, args: [...args] });
        return args.at(-1) === 'appearance' ? 'dark\n' : '';
      },
    }),
  };
});

vi.mock('../runtime-route-support.js', () => {
  const runtimeSupportStub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: runtimeSupportStub,
      notificationService: runtimeSupportStub,
      attentionProjection: runtimeSupportStub,
      webPushService: runtimeSupportStub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => runtimeSupportStub,
  };
});

/** Answers every unlisted member with an inert, non-thenable proxy. */
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

const OPERATOR_SECRET = 'operator-secret-device-tools-fixture';
const isOperatorSecret = (credential: string) => credential === OPERATOR_SECRET;
const UDID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const REMOTE = {
  incoming: { socket: { remoteAddress: '100.96.12.7' } },
} as never;
const LOOPBACK = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;
const HUB_ENV = 'STATION_MOBILE_DEVICE_HUB_URL';

/** The device hub's HTTP surface as Station reads it: one booted simulator. */
async function fakeHub(): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://hub').pathname;
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && path === '/api/devices')
      return json(200, {
        simulators: [
          {
            platform: 'ios',
            id: UDID,
            name: 'iPhone 17 Pro',
            version: '26.5',
            booted: true,
            physical: false,
          },
        ],
        emulators: [],
      });
    if (
      request.method === 'POST' &&
      path === '/vendor/serve-sim/grid/api/start'
    )
      return json(200, { ok: true });
    json(404, { ok: false });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

describe('device tools lease rule in the runtime composition (S3)', () => {
  const directories: string[] = [];
  const servers: Server[] = [];
  const originalHub = process.env[HUB_ENV];
  afterEach(async () => {
    vi.restoreAllMocks();
    toolCalls.splice(0);
    if (originalHub === undefined) delete process.env[HUB_ENV];
    else process.env[HUB_ENV] = originalHub;
    for (const server of servers.splice(0))
      await new Promise((resolve) => server.close(resolve));
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function pair(
    pairing: DevicePairingService,
    kind: 'device' | 'delegation',
    scope = DEFAULT_GRANT_PAIRING_SCOPE,
    /**
     * The mint-time stamp only the local-grant route writes (the desktop
     * app's own credential on this machine): home possession makes the
     * credential the operator's, as `projectMembershipAuthority.operator`
     * decides.
     */
    localGrant = false,
  ) {
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope,
      kind,
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: `${kind} fixture`,
    });
    pairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
      ...(localGrant
        ? {
            locality: 'home-possession' as const,
            mintKind: 'local-grant' as const,
          }
        : {}),
    });
  }

  async function setup() {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-device-tools-'));
    directories.push(homeDir);
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '33333333-3333-4333-8333-333333333333',
    });
    const device = pair(pairing, 'device');
    const localDevice = pair(
      pairing,
      'device',
      DEFAULT_GRANT_PAIRING_SCOPE,
      true,
    );
    const delegation = pair(pairing, 'delegation');
    const readOnly = pair(
      pairing,
      'device',
      pairingScopePresetString('read-only'),
    );
    const app = new Hono();
    const context = deepStub({
      // Explicitly absent (a deep stub would otherwise answer these with a
      // callable proxy and the auth pipeline would treat them as installed).
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port: 4321,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: { listAgents: () => [] },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      // Route composition starts the boot-only dispatch repair; model the
      // empty authority explicitly (same shape as the hosted composition test).
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
        }),
      }),
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) =>
          isOperatorSecret(credential) || pairing.verifyCredential(credential),
        authorizeCredential: (credential: string) =>
          isOperatorSecret(credential) || pairing.verifyCredential(credential),
        verifyOperatorCredential: (credential: string) =>
          isOperatorSecret(credential),
        resolveGrantedScope: (credential: string) =>
          isOperatorSecret(credential)
            ? DEFAULT_GRANT_PAIRING_SCOPE
            : pairing.identifyDevice(credential)?.scope,
        identifyDevice: (credential: string) =>
          pairing.identifyDevice(credential),
        credentialLocality: (credential: string) =>
          pairing.credentialLocality(credential),
        credentialMintKind: (credential: string) =>
          pairing.credentialMintKind(credential),
        devicePairing: pairing,
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    return { app, result, device, localDevice, delegation, readOnly };
  }

  test('the credential holding the lease acts (200); the same operator on another paired device is 409; agents, off-box and read-only credentials are refused', async () => {
    const hub = await fakeHub();
    servers.push(hub.server);
    process.env[HUB_ENV] = hub.url;
    const { app, result, device, localDevice, delegation, readOnly } =
      await setup();
    const operator = { Authorization: `Bearer ${OPERATOR_SECRET}` };
    const json = { 'Content-Type': 'application/json' };

    const opened = await app.request(
      `/api/mobile-devices/hosts/local/devices/ios/${UDID}/sessions`,
      { method: 'POST', headers: { ...operator, ...json }, body: '{}' },
      REMOTE,
    );
    expect(opened.status).toBe(200);
    const { surfaceId } = (await readJson(opened)).data as {
      surfaceId: string;
    };

    const claimed = await app.request(
      `/api/live-surfaces/${encodeURIComponent(surfaceId)}/lease`,
      {
        method: 'POST',
        headers: { ...operator, ...json },
        body: JSON.stringify({ action: 'claim' }),
      },
      REMOTE,
    );
    expect(claimed.status).toBe(200);
    const holder = result
      .liveSurfaceRegistry!.get(surfaceId)!
      .lease.snapshot().holder;
    expect(holder).toMatchObject({ kind: 'human' });

    const actions = `/api/mobile-devices/hosts/local/devices/ios/${UDID}/tools/actions`;
    const dark = JSON.stringify({ type: 'set-appearance', appearance: 'dark' });

    const same = await app.request(
      actions,
      { method: 'POST', headers: { ...operator, ...json }, body: dark },
      REMOTE,
    );
    expect(same.status).toBe(200);
    expect(toolCalls.map((call) => call.args.join(' '))).toContain(
      `simctl ui ${UDID} appearance dark`,
    );

    toolCalls.splice(0);
    const other = await app.request(
      actions,
      {
        method: 'POST',
        // A paired device credential of the SAME operator (the desktop
        // app's local grant): the same principal, a different client
        // identity (`device:<id>`), so a different live-surface controller.
        headers: { Authorization: `Bearer ${localDevice.credential}`, ...json },
        body: dark,
      },
      REMOTE,
    );
    expect(other.status).toBe(409);
    expect(await readJson(other)).toEqual({
      success: false,
      code: 'device-controlled-by-other',
      heldBy: 'same-person-elsewhere',
    });

    const internal = await app.request(
      actions,
      {
        method: 'POST',
        headers: {
          ...json,
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        },
        body: dark,
      },
      LOOPBACK,
    );
    const delegated = await app.request(
      actions,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${delegation.credential}`, ...json },
        body: dark,
      },
      REMOTE,
    );
    // Agent-originated: the station-control token and a delegation device.
    for (const [label, response] of [
      ['internal token', internal],
      ['delegation device', delegated],
    ] as const) {
      expect(response.status, label).toBe(403);
      expect(await readJson(response), label).toEqual({
        success: false,
        code: 'principal-unresolved',
      });
    }

    // An off-box paired device is a person but not the operator, and this
    // device is shared with no Project: D12 refuses it before the lease.
    const offBox = await app.request(
      actions,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${device.credential}`, ...json },
        body: dark,
      },
      REMOTE,
    );
    expect(offBox.status).toBe(403);
    expect((await readJson(offBox)).code).toBe('access-denied');

    // A read-only paired credential is stopped by the pairing scope: the
    // tools leaves sit on the terminal authority.
    const readOnlyResponse = await app.request(
      actions,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${readOnly.credential}`, ...json },
        body: dark,
      },
      REMOTE,
    );
    expect(readOnlyResponse.status).toBe(403);

    // No refusal reached the host.
    expect(toolCalls).toEqual([]);
    await result.deviceSessions?.dispose();
    await result.liveSurfaceRegistry!.dispose();
  });
});
