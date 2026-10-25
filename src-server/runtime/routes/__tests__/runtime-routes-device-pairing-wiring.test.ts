/**
 * Device pairing's security wiring, through the REAL composition.
 *
 * `device-pairing-routes.test.ts` configures the pairing routes itself, so it
 * proves what the handlers do with an audit sink or an ingress resolver, not
 * that production supplies them. Only `configureRuntimeRoutes` does that, and
 * dropping one of those options leaves every handler test green. This drives
 * the real `configureRuntimeRoutes` over a real `DevicePairingService` and
 * reads the outcome where production writes it: the runtime logger for both
 * audit sinks, and the endpoint the pairing service records for the resolver.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  runAsStationServer,
  stationServerScopeHeaders,
} from '../../../security/station-server-scope.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token.js';
import { StationRuntime } from '../../bootstrap/station-runtime.js';
import { createConsentApp } from '../../consent/consent-listener.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const ingress = vi.hoisted(() => ({
  ports: [] as number[],
  origins: undefined as readonly string[] | undefined,
}));

vi.mock(
  '../../../services/tailscale/public-ingress-origin.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../services/tailscale/public-ingress-origin.js')
      >();
    return {
      ...actual,
      // Only the daemon lookup is replaced: a test cannot ask a real
      // Tailscale daemon which origin serves this Station.
      publicIngressOriginResolver: (port: number) => {
        ingress.ports.push(port);
        return { resolve: async () => ingress.origins };
      },
    };
  },
);

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

const ORIGIN = 'https://station.example.test';
const PORT = 4321;
// TEST-NET-2 (RFC 5737): no machine can hold it, so it is never "local".
const DEVICE_PEER = '198.51.100.42';

describe('runtime routes: device pairing security wiring', () => {
  const makeTempDir = trackTempDirs();
  const ambientOrigins = process.env.ALLOWED_ORIGINS;
  afterEach(() => {
    if (ambientOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = ambientOrigins;
    vi.unstubAllEnvs();
    ingress.ports = [];
    ingress.origins = undefined;
  });

  async function compose(operatorMode?: 'personal' | 'hosted') {
    process.env.ALLOWED_ORIGINS = ORIGIN;
    const homeDir = makeTempDir('station-pairing-wiring-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: 'env-pairing-wiring',
    });
    const security = new EnvironmentSecurityService({ homeDir });
    const operator = await security.initialize();
    if (operatorMode === 'hosted') {
      const file = join(homeDir, 'hosted.json');
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
        }),
      );
      vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', file);
    } else vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
    const channel = new ConsentChannelService({
      trustedOrigin: 'https://station.example.test:8443',
    });
    channel.markListening(4324);
    const warn = vi.fn();
    const app = new Hono();
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      relayEnrollment: undefined,
      app,
      host: '127.0.0.1',
      port: PORT,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn, error() {} },
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
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      environmentSecurityService: operatorMode
        ? security
        : deepStub({
            devicePairing: pairing,
            pseudonymizePairingAuditSource: (source: string) =>
              `pseudonym-of-${source.length}`,
          }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    let runtime: StationRuntime | undefined;
    let result: ReturnType<typeof configureRuntimeRoutes>;
    if (operatorMode) {
      const target = Object.assign(
        Object.create(StationRuntime.prototype),
        context,
        {
          consentChannel: channel,
          operatorPasskeyRegistry: undefined,
          operatorPasskeys: undefined,
          operatorSessions: undefined,
          runtimeSearch: deepStub({}),
          nativeDeviceProofPilot: undefined,
        },
      );
      runtime = new Proxy(target, {
        get: (object, key) =>
          Reflect.has(object, key)
            ? Reflect.get(object, key)
            : Reflect.get(context, key),
      });
      Reflect.get(runtime!, 'configureRoutes').call(runtime, app);
      result = target;
    } else {
      result = configureRuntimeRoutes(
        context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
      );
    }
    await result.kitLifecycleReady;
    const request = (url: string, init: RequestInit, peer: string) =>
      app.request(url, init, { incoming: { socket: { remoteAddress: peer } } });
    const dispose = async () => {
      await result.browserService?.shutdown();
      await result.deviceHosts?.dispose();
      await result.deviceToolchainService?.shutdown();
      if (runtime) Reflect.get(runtime, 'operatorPasskeyRegistry')?.close();
    };
    return {
      pairing: operatorMode ? security.devicePairing : pairing,
      warn,
      request,
      dispose,
      runtime,
      security,
      operator,
      homeDir,
      channel,
    };
  }

  test.each(['personal', 'hosted'] as const)(
    'operator sign-in availability uses real StationRuntime and HTTP credential wiring in %s mode',
    async (mode) => {
      const h = await compose(mode);
      try {
        const consent = createConsentApp({
          channel: h.channel,
          credentials: h.security,
          passkeys: Reflect.get(h.runtime!, 'getOperatorPasskeys').call(
            h.runtime,
          ),
          sessions: Reflect.get(h.runtime!, 'getOperatorSessions').call(
            h.runtime,
          ),
        });
        const response = await h.request(
          mode === 'hosted'
            ? 'https://alpha.example.test/api/operator/passkeys'
            : '/api/operator/passkeys',
          {
            headers: {
              authorization: `Bearer ${h.operator.credential}`,
              ...(mode === 'hosted'
                ? {
                    host: 'alpha.example.test',
                    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
                    [INTERNAL_TENANT_HEADER]: 'alpha',
                  }
                : {}),
            },
          },
          mode === 'hosted' ? '127.0.0.1' : DEVICE_PEER,
        );
        expect(response.status).toBe(mode === 'hosted' ? 503 : 200);
        expect(await response.json()).toMatchObject(
          mode === 'hosted'
            ? { error: { code: 'sign_in_unavailable' } }
            : { passkeys: [] },
        );
        const signIn = await consent.request('/operator/sign-in', {
          headers: {
            host: 'station.example.test:8443',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
            'sec-fetch-site': 'none',
          },
        });
        expect(signIn.status).toBe(mode === 'hosted' ? 404 : 401);
        expect(
          existsSync(
            join(h.homeDir, 'authentication/operator-passkeys.sqlite'),
          ),
        ).toBe(false);
      } finally {
        await h.dispose();
      }
    },
  );

  test('D10 refuses an IP-only consent origin before StationRuntime can offer sign-in', () => {
    vi.stubEnv('STATION_TRUSTED_CONSENT_ORIGIN', 'https://192.0.2.10:8443');
    const homeDir = makeTempDir('station-ip-consent-');
    expect(() => new StationRuntime({ projectHomeDir: homeDir })).toThrow(
      'an IP address is not allowed',
    );
    expect(
      existsSync(join(homeDir, 'authentication/operator-passkeys.sqlite')),
    ).toBe(false);
  });

  test('a rejected pairing authentication reaches the runtime audit log, pseudonymized', async () => {
    const { warn, request, dispose } = await compose();
    try {
      const response = await request(
        '/.well-known/station/v1/pairing/request',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceName: 'Phone' }),
        },
        DEVICE_PEER,
      );
      expect(response.status).toBe(400);
      const audited = warn.mock.calls.filter(
        ([message]) => message === 'Pairing authentication attempt rejected',
      );
      expect(audited).toHaveLength(1);
      expect(audited[0]?.[1]).toMatchObject({
        event: 'station.pairing.authentication_failed',
        surface: 'pairing-request',
        reason: 'invalid_request',
        sourceCorrelation: expect.stringMatching(/^pseudonym-of-/),
      });
      expect(JSON.stringify(audited)).not.toContain(DEVICE_PEER);
    } finally {
      await dispose();
    }
  });

  test('an approval attempt by a caller that presented no credential reaches the runtime audit log', async () => {
    const { pairing, warn, request, dispose } = await compose();
    try {
      const offer = pairing.createOffer({ endpoint: ORIGIN });
      const pending = pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Phone',
        source: 'same-origin',
        requesterPosition: 'unproven',
      });
      // Station's own server code presents no credential. Since #2377 slice A
      // the station-control guard refuses a bare internal token here, so the
      // server-self attestation (attached inside `runAsStationServer`) is the
      // one remaining caller in this approval class. An unproven requester
      // position needs an operator, so the approval is refused, and the host
      // route writes that refusal to the audit log.
      const confirm = await request(
        `/api/pairing/requests/${pending.requestId}/confirm`,
        {
          method: 'POST',
          headers: {
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_PROXY_CALLER_HEADER]: 'local',
            ...runAsStationServer(stationServerScopeHeaders),
          },
        },
        '127.0.0.1',
      );
      expect(confirm.status).toBe(403);
      const audited = warn.mock.calls.filter(
        ([message]) => message === 'Device pairing approval refused',
      );
      expect(audited).toHaveLength(1);
      expect(audited[0]?.[1]).toMatchObject({
        event: 'station.pairing.refused',
        approver: 'unauthenticated',
        source: 'same-origin',
      });
    } finally {
      await dispose();
    }
  });

  test('a tailnet access request is recorded at the daemon-published origin for this port', async () => {
    const { pairing, request, dispose } = await compose();
    try {
      ingress.origins = ['https://station-node.example.ts.net'];
      const recorded = vi.spyOn(pairing, 'requestAccess');
      const response = await request(
        'http://station-node.example.ts.net/.well-known/station/v1/pairing/access-request',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({ deviceName: 'Phone' }),
        },
        DEVICE_PEER,
      );
      expect(response.status).toBe(202);
      expect(ingress.ports).toEqual([PORT, PORT]);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(recorded.mock.calls[0]?.[0]).toMatchObject({
        endpoint: 'https://station-node.example.ts.net',
      });
    } finally {
      await dispose();
    }
  });
});
