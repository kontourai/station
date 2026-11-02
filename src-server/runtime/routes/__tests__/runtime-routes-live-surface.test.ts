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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { createLogger } from '../../../utils/logger.js';
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
    const pairing = await DevicePairingService.create({
      homeDir,
      environmentId: '33333333-3333-4333-8333-333333333333',
    });
    const currentPairing = { value: pairing };
    const device = pair(pairing, 'device');
    const delegation = pair(pairing, 'delegation');
    const readOnly = pair(
      pairing,
      'device',
      pairingScopePresetString('read-only'),
    );
    const app = new Hono();
    const errors = vi.fn();
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
      logger: { debug() {}, info() {}, warn() {}, error: errors },
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
      projectService: {
        listProjects: () => [{ id: 'alpha', slug: 'alpha' }],
        getProject: () => ({}),
      },
      featurePreviews: new FeaturePreviewRegistry(
        homeDir,
        createLogger({ name: 'browser-device-wiring-test', level: 'error' }),
      ),
      environmentSecurityService: deepStub({
        assessCredentialRoute: undefined,
        verifyCredential: (credential: string) =>
          credential === OPERATOR_SECRET ||
          currentPairing.value.verifyCredential(credential),
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_SECRET ||
          currentPairing.value.verifyCredential(credential),
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_SECRET,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_SECRET
            ? DEFAULT_GRANT_PAIRING_SCOPE
            : currentPairing.value.identifyDevice(credential)?.scope,
        identifyDevice: (credential: string) =>
          currentPairing.value.identifyDevice(credential),
        credentialLocality: (credential: string) =>
          currentPairing.value.credentialLocality(credential),
        credentialMintKind: (credential: string) =>
          currentPairing.value.credentialMintKind(credential),
        devicePairing: pairing,
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    return {
      app,
      result,
      device,
      delegation,
      readOnly,
      pairing,
      currentPairing,
      homeDir,
      featurePreviews: context.featurePreviews,
      errors,
    };
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

  test('only an operator-owned device can view Browser and cannot drive, including after rebinding during publication', async () => {
    const h = await setup();
    const sessionId = 'bs_00000000-0000-4000-8000-000000000001';
    const registry = h.result.browserService!.registry;
    const view = {
      browserSessionId: sessionId,
      projectId: 'alpha',
      principalKey: 'operator',
      state: 'live',
      generation: 1,
    };
    vi.spyOn(registry, 'getSession').mockReturnValue(view as never);
    await h.featurePreviews.setEnabled('browser-experience', true);
    h.result.liveSurfaceRegistry!.register(
      new SyntheticLiveSurfaceProducer(SURFACE),
      {
        authorize: (principal, _surface, action, context) =>
          authorizeBrowserSurfaceAction(
            h.result.browserProjectAuthorizer!,
            view,
            principal,
            action,
            context,
          ),
      },
    );
    const headers = (credential: string) => ({
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
    });
    const access = '/api/browser/projects/alpha/access';
    try {
      const ownResponse = await h.app.request(
        access,
        { headers: headers(h.device.credential) },
        REMOTE,
      );
      expect(ownResponse.status, JSON.stringify(h.errors.mock.calls)).toBe(200);
      expect(await ownResponse.json()).toMatchObject({
        data: { role: 'operator-device', canDrive: false },
      });
      expect(
        (
          await h.app.request(
            '/api/browser/projects/alpha/settings',
            { headers: headers(h.device.credential) },
            REMOTE,
          )
        ).status,
      ).toBe(200);
      const frames = await h.app.request(
        `/api/live-surfaces/${encodeURIComponent(SURFACE)}/frames`,
        { headers: headers(h.device.credential) },
        REMOTE,
      );
      expect(frames.status).toBe(200);
      expect((await firstRecord(frames)).kind).toBe('state');
      expect(
        (
          await h.app.request(
            access,
            { headers: headers(h.delegation.credential) },
            REMOTE,
          )
        ).status,
      ).toBe(403);
      for (const [path, body] of [
        [
          `/api/live-surfaces/${encodeURIComponent(SURFACE)}/input`,
          { epoch: 0, events: [{ kind: 'pointer', type: 'move', x: 1, y: 1 }] },
        ],
        [
          `/api/browser/sessions/${sessionId}/zoom`,
          { factor: 1.25, generation: 1 },
        ],
        [
          `/api/browser/sessions/${sessionId}/appearance`,
          { scheme: 'dark', generation: 1 },
        ],
      ] as const) {
        expect(
          (
            await h.app.request(
              path,
              {
                method: 'POST',
                headers: headers(h.device.credential),
                body: JSON.stringify(body),
              },
              REMOTE,
            )
          ).status,
        ).toBe(403);
      }
      const offer = h.pairing.createOffer({
        endpoint: 'https://station.example.test',
      });
      const request = h.pairing.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'bound',
        source: 'tailnet',
        requester: {
          provider: 'tailscale-serve',
          login: 'person@example.test',
        },
      });
      h.pairing.confirmRequest(
        request.requestId,
        { kind: 'presented-credential' },
        { kind: 'verified-ingress', principalId: 'human:deployment:person' },
      );
      const bound = h.pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      });
      expect(h.pairing.verifyCredential(bound.credential)).toBe(true);
      const boundResponse = await h.app.request(
        access,
        { headers: headers(bound.credential) },
        REMOTE,
      );
      expect(
        boundResponse.status,
        `${await boundResponse.text()} ${JSON.stringify(h.errors.mock.calls)}`,
      ).toBe(403);
      const revoked = pair(h.pairing, 'device');
      h.pairing.revokeDevice(revoked.device.id, 'operator-credential');
      expect(
        (
          await h.app.request(
            access,
            { headers: headers(revoked.credential) },
            REMOTE,
          )
        ).status,
      ).toBe(401);
      const reboundPairing = await DevicePairingService.create({
        homeDir: h.homeDir,
        environmentId: '33333333-3333-4333-8333-333333333333',
      });
      const status = h.result.browserService!.acquisition.status();
      vi.spyOn(
        h.result.browserService!.acquisition,
        'status',
      ).mockImplementation(() => {
        const file = join(h.homeDir, 'security', 'paired-devices.json');
        const data = JSON.parse(readFileSync(file, 'utf8'));
        const row = data.devices.find(
          (item: { id: string }) => item.id === h.device.device.id,
        );
        row.source = 'tailnet';
        row.requester = bound.device.requester;
        row.principalBinding = bound.device.principalBinding;
        writeFileSync(file, JSON.stringify(data));
        h.currentPairing.value = reboundPairing;
        return status;
      });
      const rebound = await h.app.request(
        access,
        { headers: headers(h.device.credential) },
        REMOTE,
      );
      expect(
        rebound.status,
        `${await rebound.text()} ${JSON.stringify(h.errors.mock.calls)}`,
      ).toBe(403);
    } finally {
      await h.result.liveSurfaceRegistry!.dispose();
      await h.result.browserService?.shutdown();
      await h.result.deviceHosts?.dispose();
      await h.result.deviceToolchainService?.shutdown();
    }
  });

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

  test("a keep-alive from the internal MCP token or a delegation device is refused, and the person's hold is untouched", async () => {
    const { app, result, delegation } = await setup();
    const registry = result.liveSurfaceRegistry!;
    registry.register(new SyntheticLiveSurfaceProducer(SURFACE), {
      authorize: () => true,
    });
    const lease = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/lease`;
    const claimed = await app.request(
      lease,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPERATOR_SECRET}`,
        },
        body: JSON.stringify({ action: 'claim' }),
      },
      REMOTE,
    );
    expect(claimed.status).toBe(200);
    const held = registry.get(SURFACE)!.lease.snapshot();
    const keepAlive = JSON.stringify({
      action: 'keep-alive',
      epoch: held.epoch,
    });

    const internal = await app.request(
      lease,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        },
        body: keepAlive,
      },
      LOOPBACK,
    );
    expect(internal.status).toBe(403);
    const delegated = await app.request(
      lease,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${delegation.credential}`,
        },
        body: keepAlive,
      },
      REMOTE,
    );
    expect(delegated.status).toBe(403);
    expect(await delegated.json()).toEqual({
      success: false,
      code: 'principal-unresolved',
    });
    // Neither moved the person's hold.
    expect(registry.get(SURFACE)!.lease.snapshot()).toMatchObject({
      holder: held.holder,
      expiresAt: held.expiresAt,
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
      const actor = await authorizeProject(args[0], args[1], args[2]);
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
