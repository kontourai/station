/**
 * #90 (lane B review, S1/M2): who may drive a live surface, decided by the
 * REAL composition — `configureRuntimeRoutes` with the real
 * `configureRuntimeHttp` credential pipeline (bearer parsing, a real
 * `DevicePairingService`, the real principal resolver). No hand-set
 * authenticated principal: the fixture pairs real devices and presents
 * their credentials, exactly as the pairing tests do.
 *
 * In personal mode every credential resolves to a HUMAN principal —
 * including the per-boot internal token the station-control MCP child
 * presents — so "the principal is human" refuses nothing. The composition
 * must refuse agent-originated credentials itself.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import {
  type LiveSurfaceRecord,
  LiveSurfaceRecordDecoder,
} from '@kontourai/station-contracts/live-surface';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SyntheticLiveSurfaceProducer } from '../../../__test-utils__/synthetic-live-surface-producer.js';
import { authorizeBrowserSurfaceAction } from '../../../services/browser/browser-live-surfaces.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

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

const OPERATOR_SECRET = 'operator-secret-live-surface-fixture';
const SURFACE = 'browser:composition';
const REMOTE = {
  incoming: { socket: { remoteAddress: '100.96.12.7' } },
} as never;
const LOOPBACK = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;
const REGISTRY_ENV = 'STATION_HOSTED_TENANT_REGISTRY_FILE';

describe('live surface routes in the runtime composition', () => {
  const directories: string[] = [];
  const originalRegistry = process.env[REGISTRY_ENV];
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalRegistry === undefined) delete process.env[REGISTRY_ENV];
    else process.env[REGISTRY_ENV] = originalRegistry;
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function pair(
    pairing: DevicePairingService,
    kind: 'device' | 'delegation',
    scope = DEFAULT_GRANT_PAIRING_SCOPE,
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
    });
  }

  async function setup(options: { projectMembership?: object } = {}) {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-live-surface-'));
    directories.push(homeDir);
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '33333333-3333-4333-8333-333333333333',
    });
    const device = pair(pairing, 'device');
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
      projectMembership: options.projectMembership,
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
          credential === OPERATOR_SECRET ||
          pairing.verifyCredential(credential),
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_SECRET ||
          pairing.verifyCredential(credential),
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_SECRET,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_SECRET
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
    return { app, result, device, delegation, readOnly };
  }

  async function firstRecord(response: Response): Promise<LiveSurfaceRecord> {
    const reader = response.body!.getReader();
    const decoder = new LiveSurfaceRecordDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('stream ended');
        const [record] = decoder.push(chunk.value);
        if (record) return record;
      }
    } finally {
      // Not awaited: the stream's pull is parked until its next record, and
      // disposing the registry at the end of the test closes it.
      void reader.cancel().catch(() => {});
    }
  }

  test('a human operator and a paired device are admitted; each is told who it is', async () => {
    const { app, result, device } = await setup();
    const registry = result.liveSurfaceRegistry!;
    expect(registry).toBeDefined();
    registry.register(new SyntheticLiveSurfaceProducer(SURFACE), {
      authorize: () => true,
    });
    const frames = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/frames`;

    const operator = await app.request(
      frames,
      { headers: { Authorization: `Bearer ${OPERATOR_SECRET}` } },
      REMOTE,
    );
    expect(operator.status).toBe(200);
    const operatorState = await firstRecord(operator);
    expect(operatorState).toMatchObject({
      kind: 'state',
      state: { viewer: { principal: 'human:local:operator' } },
    });

    // N-b: a non-device credential's id is a per-boot HMAC, stable within
    // this boot, and not a plain digest of the credential anyone could
    // check a guessed secret against.
    const operatorDevice =
      operatorState.kind === 'state' ? operatorState.state.viewer?.device : '';
    expect(operatorDevice).toMatch(/^credential:[A-Za-z0-9_-]{22}$/);
    const digest = createHash('sha256')
      .update(OPERATOR_SECRET)
      .digest('base64url');
    expect(operatorDevice).not.toContain(digest.slice(0, 16));
    const again = await firstRecord(
      await app.request(
        frames,
        { headers: { Authorization: `Bearer ${OPERATOR_SECRET}` } },
        REMOTE,
      ),
    );
    expect(again.kind === 'state' && again.state.viewer?.device).toBe(
      operatorDevice,
    );

    const phone = await app.request(
      frames,
      { headers: { Authorization: `Bearer ${device.credential}` } },
      REMOTE,
    );
    expect(phone.status).toBe(200);
    const phoneState = await firstRecord(phone);
    expect(phoneState).toMatchObject({
      kind: 'state',
      state: { viewer: { device: `device:${device.device.id}` } },
    });
    // Two clients are two devices, so "you" is decided per client.
    expect(
      phoneState.kind === 'state' &&
        operatorState.kind === 'state' &&
        phoneState.state.viewer?.device !== operatorState.state.viewer?.device,
    ).toBe(true);
    await registry.dispose();
  });

  test('the internal MCP token and a delegation-kind device are refused (S1)', async () => {
    const { app, result, delegation } = await setup();
    const registry = result.liveSurfaceRegistry!;
    const producer = new SyntheticLiveSurfaceProducer(SURFACE);
    registry.register(producer, { authorize: () => true });
    const base = `/api/live-surfaces/${encodeURIComponent(SURFACE)}`;
    const input = JSON.stringify({
      epoch: 0,
      events: [{ kind: 'pointer', type: 'move', x: 1, y: 1 }],
    });

    const internal = await app.request(
      `${base}/input`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        },
        body: input,
      },
      LOOPBACK,
    );
    // #2377 slice A: no station-control tool reaches this route, so the
    // station-control authority guard refuses the internal token before the
    // route's own `principal-unresolved` refusal can run.
    expect(internal.status).toBe(403);
    expect(await internal.json()).toMatchObject({
      success: false,
      code: 'station_control_route_unmapped',
    });

    const delegated = await app.request(
      `${base}/input`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${delegation.credential}`,
        },
        body: input,
      },
      REMOTE,
    );
    expect(delegated.status).toBe(403);
    expect(await delegated.json()).toEqual({
      success: false,
      code: 'principal-unresolved',
    });
    expect(producer.dispatched).toEqual([]);
    expect(registry.get(SURFACE)!.lease.snapshot()).toMatchObject({
      holder: null,
    });
    await registry.dispose();
  });

  test('a browser surface judges the REQUEST: operator by credential, a paired admin by membership through the captured principal (#90)', async () => {
    // Membership that, like the real service, first resolves the caller from
    // the request (`authority.current()`), which reads the request principal
    // the /api/live-surfaces middleware captured. Whoever it resolves is an
    // admin of `alpha` here; what is under test is whether it CAN resolve.
    const resolved: string[] = [];
    const projectMembership = deepStub({
      readableProjectAdmissions: async (authority: {
        current(): Promise<{ principal: { id: string } }>;
      }) => {
        const actor = await authority.current();
        resolved.push(actor.principal.id);
        return [
          {
            scope: { localProjectId: 'alpha' },
            member: {
              status: 'active',
              role: 'admin',
              principal: { id: actor.principal.id },
            },
          },
        ];
      },
    });
    const { app, result, device } = await setup({ projectMembership });
    const authorizeProject = result.browserProjectAuthorizer!;
    expect(authorizeProject).toBeDefined();
    const actors: Array<{ kind: string } | undefined> = [];
    const recordingAuthorizer: typeof authorizeProject = async (...args) => {
      const actor = await authorizeProject(...args);
      actors.push(actor);
      return actor;
    };
    result.liveSurfaceRegistry!.register(
      new SyntheticLiveSurfaceProducer(SURFACE),
      {
        // The browser binder's REAL decision over the composition's REAL
        // Project authorizer. The session is in the caller's own profile
        // (keyed by the live-surface principal), so what decides is whether
        // the caller has Project standing at all.
        authorize: (principal, _surface, action, context) =>
          authorizeBrowserSurfaceAction(
            recordingAuthorizer,
            { projectId: 'alpha', principalKey: `principal:${principal}` },
            principal,
            action,
            context,
          ),
      },
    );
    const lease = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/lease`;
    const operator = await app.request(
      lease,
      { headers: { Authorization: `Bearer ${OPERATOR_SECRET}` } },
      REMOTE,
    );
    expect(operator.status).toBe(200);
    expect(actors.at(-1)).toEqual({ kind: 'operator' });
    // A paired device is NOT the operator (no operator credential, not home
    // possession), but resolves through membership — which needs the
    // principal the middleware captured for this request.
    const phone = await app.request(
      lease,
      { headers: { Authorization: `Bearer ${device.credential}` } },
      REMOTE,
    );
    expect(phone.status).toBe(200);
    expect(actors.at(-1)).toMatchObject({ kind: 'project-admin' });
    expect(resolved).toHaveLength(1);
    await result.liveSurfaceRegistry!.dispose();
    await result.browserService?.shutdown();
  });

  test('a read-only paired credential is refused by the pairing scope', async () => {
    const { app, result, readOnly } = await setup();
    result.liveSurfaceRegistry!.register(
      new SyntheticLiveSurfaceProducer(SURFACE),
      { authorize: () => true },
    );
    // Sanity: the family requires more than the read-only preset grants.
    expect(pairingScopePresetString('read-only')).not.toContain(
      'terminal:operate',
    );
    const response = await app.request(
      `/api/live-surfaces/${encodeURIComponent(SURFACE)}/lease`,
      { headers: { Authorization: `Bearer ${readOnly.credential}` } },
      REMOTE,
    );
    expect(response.status).toBe(403);
  });

  test('on a hosted tenant runtime the routes are not mounted at all', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-live-surface-hosted-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
      }),
    );
    process.env[REGISTRY_ENV] = registryPath;
    const { app, result } = await setup();
    expect(result.liveSurfaceRegistry).toBeUndefined();
    expect(
      app.routes.filter((route) => route.path.startsWith('/api/live-surfaces')),
    ).toEqual([]);
  });
});
