/**
 * Telemetry producer management through the PRODUCTION composition: the real
 * `configureRuntimeRoutes` mount, the real `EnvironmentSecurityService` and
 * device pairing, the real auth boundary and the real
 * `resolveOrchestrationRequestPrincipal`-backed `isOperator` predicate. The
 * route-level suite stubs that predicate; this one pins what it decides.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { K } from '../../../../src-shared/monitoring-keys.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import { getCachedUser } from '../../../routes/system/auth.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
} from '../../../utils/internal-api-token.js';
import { RuntimeEventLog } from '../../conversation/runtime-event-log.js';
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
    // Real monitoring storage, wired the way station-runtime.ts wires it.
    const eventLogPath = join(homeDir, 'monitoring');
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const eventLog = new RuntimeEventLog(eventLogPath, quiet);
    const monitoringEvents = new EventEmitter();
    const monitoringEmitter = new MonitoringEmitter(monitoringEvents, (event) =>
      eventLog.persist(event),
    );
    const context = deepStub({
      monitoringEmitter,
      monitoringEvents,
      eventLogPath,
      queryEventsFromDisk: (start: number, end: number, userId: string) =>
        eventLog.queryEvents(start, end, userId),
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
    const pairManageDevice = (scope = 'access:manage') => {
      const pairing = security.devicePairing;
      const offer = pairing.createOffer({
        endpoint: ORIGIN,
        scope,
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
    const ingest = (token: string, sessionId: string) =>
      app.request(
        `${ORIGIN}/v1/agent-events`,
        {
          method: 'POST',
          headers: {
            host: '127.0.0.1:4321',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            schema_version: '0.3.0',
            timestamp: `${Date.now()}`,
            session_id: sessionId,
            event_id: `event-${sessionId}`,
            event_type: 'tool.invoke',
            agent: { name: 'codex', runtime: 'codex', version: '1.0.0' },
            tool: { name: 'shell', input: { command: 'ls' } },
          }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
    const read = (path: string, credential: string) =>
      app.request(
        `${ORIGIN}${path}`,
        { headers: { Authorization: `Bearer ${credential}`, Origin: ORIGIN } },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
    return {
      operatorCredential,
      pairManageDevice,
      create,
      ingest,
      read,
      flush: () => monitoringEmitter.flush(),
      emitRaw: (event: Parameters<MonitoringEmitter['emitRaw']>[0]) =>
        monitoringEmitter.emitRaw(event),
    };
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

  test('rows a producer ingests are read by its owner and nobody else', async () => {
    const h = await setup();
    const created = await h.create(
      { Authorization: `Bearer ${h.operatorCredential}` },
      'e2e-codex',
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const { token } = ((await created.json()) as { data: { token: string } })
      .data;
    // An external Codex session id: no Station session has it.
    const ingested = await h.ingest(token, 'codex-session-123');
    expect(ingested.status, await ingested.clone().text()).toBe(200);
    // A non-producer row reporting the SAME session id. It is judged by the
    // Station session rule (no such session: unreadable), and must not
    // inherit the producer row's owner decision through a per-session memo.
    h.emitRaw({
      timestamp: new Date().toISOString(),
      [K.TIMESTAMP_MS]: Date.now(),
      [K.OP_NAME]: 'execute_tool',
      [K.SPAN_KIND]: 'start',
      [K.TOOL_NAME]: 'shell',
      [K.AT_SESSION_ID]: 'codex-session-123',
      [K.USER_ID]: getCachedUser().alias,
    });
    await h.flush();

    const events = async (credential: string) => {
      const response = await h.read('/monitoring/events?start=0', credential);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { data: Record<string, unknown>[] })
        .data;
    };
    const toolCalls = async (credential: string) => {
      const response = await h.read('/api/insights?days=1', credential);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      const data = (body.data ?? body) as { totalToolCalls?: number };
      return data.totalToolCalls;
    };

    const operatorRows = await events(h.operatorCredential);
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0]?.[K.TELEMETRY_PRODUCER]).toBe('e2e-codex');
    expect(await toolCalls(h.operatorCredential)).toBe(1);

    // Another paired person who may read monitoring, just not these rows.
    const other = h.pairManageDevice(
      'orchestration:read orchestration:operate',
    );
    expect(await events(other)).toEqual([]);
    expect(await toolCalls(other)).toBe(0);
  });
});
