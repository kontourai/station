/**
 * Telemetry producer management through the PRODUCTION composition: the real
 * `configureRuntimeRoutes` mount, the real `EnvironmentSecurityService` and
 * device pairing, the real auth boundary and the real
 * `resolveOrchestrationRequestPrincipal`-backed `isOperator` predicate. The
 * route-level suite stubs that predicate; this one pins what it decides.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
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

function deepCallable(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, property) =>
      property === 'then' ? undefined : deepCallable(),
    apply: () => deepCallable(),
  });
}

function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return deepCallable();
    },
  }) as T;
}

const ORIGIN = 'https://station.example.test';

describe('telemetry producer management over the production composition', () => {
  const makeTempDir = trackTempDirs();
  const ambient = {
    home: process.env.STATION_HOME,
    root: process.env.STATION_ROOT,
    origins: process.env.ALLOWED_ORIGINS,
  };
  let owned: string;
  beforeEach(() => {
    owned = makeTempDir('station-telemetry-producer-routes-');
    for (const name of ['home', 'root', 'data']) mkdirSync(join(owned, name));
    process.env.STATION_HOME = join(owned, 'home');
    process.env.STATION_ROOT = join(owned, 'root');
    process.env.ALLOWED_ORIGINS = ORIGIN;
  });
  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('STATION_HOME', ambient.home);
    restore('STATION_ROOT', ambient.root);
    restore('ALLOWED_ORIGINS', ambient.origins);
    vi.restoreAllMocks();
  });

  async function setup() {
    const homeDir = join(owned, 'data');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700, recursive: true });
    const security = new EnvironmentSecurityService({ homeDir });
    const { credential: operatorCredential } = await security.initialize();
    const app = new Hono();
    const context = deepStub({
      // Personal mode: no account authentication, native pilots or relay.
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      nativeDeviceProofPilot: undefined,
      nativeRelayEnrollment: undefined,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: async () => ({}),
        mutateAppConfig: async () => ({}),
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
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
        }),
      }),
      environmentSecurityService: security,
      eventBus: new EventBus(),
      taskGraphService: { listTasks: () => [] },
    });
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;

    /** A paired device holding `access:manage`, approved by the operator. */
    const pairManageDevice = () => {
      const pairing = security.devicePairing;
      const offer = pairing.createOffer({
        endpoint: ORIGIN,
        scope: 'access:manage',
      });
      const pending = pairing.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Admin laptop',
      });
      pairing.confirmRequest(pending.requestId, {
        kind: 'presented-credential',
      });
      return pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      }).credential;
    };

    const create = (headers: Record<string, string>, name: string) =>
      app.request(
        `${ORIGIN}/api/telemetry-producers`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            ...headers,
          },
          body: JSON.stringify({ name }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
    return { operatorCredential, pairManageDevice, create };
  }

  test('the operator credential may create a producer', async () => {
    const h = await setup();
    const response = await h.create(
      { Authorization: `Bearer ${h.operatorCredential}` },
      'flow-agents',
    );
    expect(response.status, await response.clone().text()).toBe(201);
    expect(
      ((await response.json()) as { data: { token: string } }).data.token,
    ).toMatch(/^sti_/);
  });

  test('a paired device with access:manage is refused as not the operator', async () => {
    const h = await setup();
    const device = h.pairManageDevice();
    const response = await h.create(
      { Authorization: `Bearer ${device}` },
      'device-made',
    );
    expect(response.status, await response.clone().text()).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      'operator_required',
    );
  });

  test('the same device reached through a Tailscale Serve identity is refused', async () => {
    const h = await setup();
    const device = h.pairManageDevice();
    const response = await h.create(
      {
        Authorization: `Bearer ${device}`,
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
          JSON.stringify({
            provider: 'tailscale-serve',
            login: 'casey@example.test',
            displayName: 'Casey',
          }),
        ).toString('base64url'),
      },
      'tailnet-made',
    );
    expect(response.status, await response.clone().text()).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      'operator_required',
    );
  });
});
