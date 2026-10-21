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
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
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
const STATION_SESSION = 'station-session-1';

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
      // One real Station session everyone here may read.
      orchestrationService: deepStub({
        canUserReadSession: (sessionId: string) =>
          sessionId === STATION_SESSION,
      }),
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
    const ingest = (
      token: string,
      sessionId: string,
      overrides: Record<string, unknown> = {},
    ) =>
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
            // Last: the claims under test must win over the defaults above.
            ...overrides,
          }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
    const ingestSpan = (
      token: string,
      conversationId: string,
      extraAttributes: { key: string; value: { stringValue: string } }[] = [],
      end = false,
    ) =>
      app.request(
        `${ORIGIN}/v1/traces`,
        {
          method: 'POST',
          headers: {
            host: '127.0.0.1:4321',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            resourceSpans: [
              {
                scopeSpans: [
                  {
                    spans: [
                      {
                        traceId: conversationId,
                        spanId: 's1',
                        name: 'tool',
                        kind: 1,
                        startTimeUnixNano: '1',
                        ...(end ? { endTimeUnixNano: '2' } : {}),
                        attributes: [
                          // First: the receiver reads the first match, so the
                          // claims under test win over the defaults below.
                          ...extraAttributes,
                          {
                            key: K.CONVERSATION_ID,
                            value: { stringValue: conversationId },
                          },
                          {
                            key: K.OP_NAME,
                            value: { stringValue: 'execute_tool' },
                          },
                          {
                            key: K.TOOL_NAME,
                            value: { stringValue: 'injected' },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
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
      ingestSpan,
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
    // A producer row stored before identities were namespaced: it shares the
    // raw session id with the row above. Insights must decide it by owner,
    // not reuse the Station row's per-session decision.
    h.emitRaw({
      timestamp: new Date().toISOString(),
      [K.TIMESTAMP_MS]: Date.now(),
      [K.OP_NAME]: 'execute_tool',
      [K.SPAN_KIND]: 'start',
      [K.TOOL_NAME]: 'shell',
      [K.AT_SESSION_ID]: 'codex-session-123',
      [K.USER_ID]: getCachedUser().alias,
      [K.TELEMETRY_PRODUCER]: 'e2e-codex',
      [K.TELEMETRY_PRODUCER_OWNER]: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
    await h.flush();

    const events = async (credential: string) => {
      const response = await h.read('/monitoring/events?start=0', credential);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { data: Record<string, unknown>[] })
        .data;
    };
    // Producer activity is reported apart from Station's figures, under the
    // producer, and only to the producer's owner.
    const toolCalls = async (credential: string) => {
      const response = await h.read(
        '/api/insights?days=1&producer=e2e-codex',
        credential,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      const data = (body.data ?? body) as { totalToolCalls?: number };
      return data.totalToolCalls;
    };

    const operatorRows = await events(h.operatorCredential);
    expect(operatorRows).toHaveLength(2);
    expect(operatorRows.map((row) => row[K.TELEMETRY_PRODUCER])).toEqual([
      'e2e-codex',
      'e2e-codex',
    ]);
    expect(await toolCalls(h.operatorCredential)).toBe(2);

    // Another paired person who may read monitoring, just not these rows.
    const other = h.pairManageDevice(
      'orchestration:read orchestration:operate',
    );
    expect(await events(other)).toEqual([]);
    expect(await toolCalls(other)).toBe(0);
  });

  test('a producer reporting a real Station session id does not join that session', async () => {
    const h = await setup();
    const created = await h.create(
      { Authorization: `Bearer ${h.operatorCredential}` },
      'spoofer',
    );
    const { token } = ((await created.json()) as { data: { token: string } })
      .data;
    // The genuine Station row for that session.
    h.emitRaw({
      timestamp: new Date().toISOString(),
      [K.TIMESTAMP_MS]: Date.now(),
      [K.OP_NAME]: 'execute_tool',
      [K.SPAN_KIND]: 'start',
      [K.TOOL_NAME]: 'real',
      [K.CONVERSATION_ID]: STATION_SESSION,
      [K.USER_ID]: getCachedUser().alias,
    });
    expect((await h.ingestSpan(token, STATION_SESSION)).status).toBe(200);
    expect((await h.ingest(token, STATION_SESSION)).status).toBe(200);
    await h.flush();

    const rows = async (query: string) => {
      const response = await h.read(
        `/monitoring/events?start=0${query}`,
        h.operatorCredential,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { data: Record<string, unknown>[] })
        .data;
    };
    // Under the Station conversation: only Station's own row.
    const underSession = await rows(`&conversation=${STATION_SESSION}`);
    expect(underSession.map((row) => row[K.TOOL_NAME])).toEqual(['real']);
    // The producer's rows exist, in the producer's own namespace.
    const all = await rows('');
    const producerRows = all.filter((row) => K.TELEMETRY_PRODUCER in row);
    expect(producerRows).toHaveLength(2);
    for (const row of producerRows) {
      for (const key of [K.TRACE_ID, K.CONVERSATION_ID, K.AT_SESSION_ID]) {
        if (row[key] !== undefined)
          expect(row[key]).toBe(`producer:spoofer:${STATION_SESSION}`);
      }
    }
  });

  test('a producer claiming a Station agent and engine counts toward neither', async () => {
    const h = await setup();
    const created = await h.create(
      { Authorization: `Bearer ${h.operatorCredential}` },
      'claimer',
    );
    const { token } = ((await created.json()) as { data: { token: string } })
      .data;
    // Station's own chat for agent `default`, on engine `station`.
    for (const kind of ['start', 'end'] as const)
      h.emitRaw({
        timestamp: new Date().toISOString(),
        [K.TIMESTAMP_MS]: Date.now(),
        [K.OP_NAME]: 'invoke_agent',
        [K.SPAN_KIND]: kind,
        [K.TRACE_ID]: 'station-trace',
        [K.AGENT_SLUG]: 'default',
        [K.PROVIDER]: 'station',
        [K.USER_ID]: getCachedUser().alias,
      });
    await h.flush();
    const insights = async () => {
      const response = await h.read(
        '/api/insights?days=1',
        h.operatorCredential,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: {
          agentUsage: Record<string, { chats: number }>;
          producerActivity?: Record<string, { chats: number }>;
        };
      };
      return body.data;
    };
    const before = (await insights()).agentUsage;
    expect(before.default?.chats).toBe(1);

    // The producer claims the same agent and engine on both ingest paths.
    expect(
      (
        await h.ingest(token, 'claimed', {
          event_type: 'session.start',
          agent: { name: 'default', runtime: 'station', version: '1' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.ingestSpan(token, 'claimed', [
          { key: K.AGENT_SLUG, value: { stringValue: 'default' } },
          { key: K.PROVIDER, value: { stringValue: 'station' } },
          { key: K.OP_NAME, value: { stringValue: 'invoke_agent' } },
        ])
      ).status,
    ).toBe(200);
    await h.flush();

    const afterData = await insights();
    const after = afterData.agentUsage;
    expect(after.default?.chats).toBe(1);
    expect(afterData.producerActivity?.claimer?.chats).toBeGreaterThan(0);

    const rows = async (query: string) => {
      const response = await h.read(
        `/monitoring/events?start=0${query}`,
        h.operatorCredential,
      );
      return ((await response.json()) as { data: Record<string, unknown>[] })
        .data;
    };
    for (const query of ['&agent=default', '&engine=station']) {
      const matched = await rows(query);
      expect(matched).toHaveLength(2);
      expect(matched.some((row) => K.TELEMETRY_PRODUCER in row)).toBe(false);
    }
  });

  test("a producer's claimed agent, model, tool and slug-less rows never move Station's figures or filters", async () => {
    const h = await setup();
    const created = await h.create(
      { Authorization: `Bearer ${h.operatorCredential}` },
      'claimer',
    );
    const { token } = ((await created.json()) as { data: { token: string } })
      .data;
    const now = () => ({
      timestamp: new Date().toISOString(),
      [K.TIMESTAMP_MS]: Date.now(),
      [K.USER_ID]: getCachedUser().alias,
    });
    // Station's own activity: one chat for `default` on claude-opus-4, one
    // failed Bash call.
    h.emitRaw({
      ...now(),
      [K.OP_NAME]: 'invoke_agent',
      [K.SPAN_KIND]: 'start',
      [K.TRACE_ID]: 'st',
      [K.AGENT_SLUG]: 'default',
      [K.PROVIDER]: 'station',
    });
    h.emitRaw({
      ...now(),
      [K.OP_NAME]: 'invoke_agent',
      [K.SPAN_KIND]: 'end',
      [K.TRACE_ID]: 'st',
      [K.AGENT_SLUG]: 'default',
      [K.PROVIDER]: 'station',
      [K.MODEL]: 'claude-opus-4',
    });
    h.emitRaw({
      ...now(),
      [K.OP_NAME]: 'execute_tool',
      [K.SPAN_KIND]: 'start',
      [K.TOOL_NAME]: 'Bash',
      [K.AGENT_SLUG]: 'default',
      [K.PROVIDER]: 'station',
    });
    h.emitRaw({
      ...now(),
      [K.OP_NAME]: 'execute_tool',
      [K.SPAN_KIND]: 'end',
      [K.TOOL_NAME]: 'Bash',
      [K.AGENT_SLUG]: 'default',
      [K.PROVIDER]: 'station',
      [K.TOOL_CALL_OUTCOME]: 'error',
    });
    await h.flush();

    type Insights = {
      agentUsage: Record<string, { chats: number }>;
      modelUsage: Record<string, number>;
      toolUsage: Record<string, { calls: number; errors: number }>;
      totalChats: number;
      totalToolCalls: number;
      totalErrors: number;
      hourlyActivity: number[];
      producerActivity?: Record<
        string,
        { events: number; chats: number; toolCalls: number }
      >;
    };
    const insights = async (query = '') => {
      const response = await h.read(
        `/api/insights?days=1${query}`,
        h.operatorCredential,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { data: Insights }).data;
    };
    const stationFigures = (data: Insights) => ({
      agentUsage: data.agentUsage,
      modelUsage: data.modelUsage,
      toolUsage: data.toolUsage,
      totalChats: data.totalChats,
      totalToolCalls: data.totalToolCalls,
      totalErrors: data.totalErrors,
      hourlyActivity: data.hourlyActivity,
    });
    const before = stationFigures(await insights());
    expect(before.agentUsage.default?.chats).toBe(1);
    expect(before.toolUsage.Bash).toMatchObject({ calls: 1, errors: 1 });

    const span = (attributes: Record<string, string>) =>
      Object.entries(attributes).map(([key, value]) => ({
        key,
        value: { stringValue: value },
      }));
    expect(
      (
        await h.ingest(token, 'p1', {
          event_type: 'session.start',
          agent: { name: 'default', runtime: 'x', version: '1' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.ingest(token, 'p1', {
          event_type: 'tool.invoke',
          agent: { name: 'default', runtime: 'x', version: '1' },
          tool: { name: 'Bash' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.ingestSpan(
          token,
          'p2',
          span({
            [K.OP_NAME]: 'invoke_agent',
            [K.AGENT_SLUG]: 'default',
            [K.MODEL]: 'claude-opus-4',
            [K.PROVIDER]: 'station',
          }),
          true,
        )
      ).status,
    ).toBe(200);
    // Slug-less: an agent turn naming no agent at all.
    expect(
      (await h.ingestSpan(token, 'p3', span({ [K.OP_NAME]: 'invoke_agent' })))
        .status,
    ).toBe(200);
    await h.flush();

    const after = await insights();
    expect(stationFigures(after)).toEqual(before);
    expect(after.agentUsage['(unnamed)']).toBeUndefined();
    expect(after.producerActivity?.claimer?.events).toBe(4);

    // Named, the producer's activity is visible, and only its own.
    const scoped = await insights('&producer=claimer');
    expect(scoped.agentUsage.default).toBeUndefined();
    // The producer's own Bash call, without Station's failed one.
    expect(scoped.toolUsage.Bash).toMatchObject({ calls: 1, errors: 0 });
    expect(
      Object.keys(scoped.agentUsage).every((agent) =>
        agent.startsWith('producer:claimer:'),
      ),
    ).toBe(true);
    expect(scoped.totalToolCalls).toBeGreaterThan(0);
    expect(scoped.agentUsage['producer:claimer:(unnamed)']?.chats).toBe(1);
    expect(scoped.modelUsage['claude-opus-4']).toBe(1);

    const rows = async (query: string) => {
      const response = await h.read(
        `/monitoring/events?start=0${query}`,
        h.operatorCredential,
      );
      return ((await response.json()) as { data: Record<string, unknown>[] })
        .data;
    };
    for (const query of [
      '&agent=default',
      '&tool=Bash',
      '&engine=station',
      '&agent=(unnamed)',
    ]) {
      expect(
        (await rows(query)).some((row) => K.TELEMETRY_PRODUCER in row),
      ).toBe(false);
    }
    const producerRows = await rows('&producer=claimer');
    expect(producerRows).toHaveLength(4);
    expect(
      producerRows.every((row) => row[K.TELEMETRY_PRODUCER] === 'claimer'),
    ).toBe(true);
  });

  test('a Station tool export never includes producer rows (export count check, archive#3130)', async () => {
    const h = await setup();
    const created = await h.create(
      { Authorization: `Bearer ${h.operatorCredential}` },
      'bulk',
    );
    const { token } = ((await created.json()) as { data: { token: string } })
      .data;
    for (let index = 0; index < 40; index += 1)
      h.emitRaw({
        timestamp: new Date().toISOString(),
        [K.TIMESTAMP_MS]: Date.now(),
        [K.OP_NAME]: 'execute_tool',
        [K.SPAN_KIND]: 'start',
        [K.TOOL_NAME]: 'Bash',
        [K.USER_ID]: getCachedUser().alias,
      });
    for (let index = 0; index < 70; index += 1)
      expect(
        (
          await h.ingest(token, `s${index}`, {
            event_id: `e${index}`,
            tool: { name: 'Bash' },
          })
        ).status,
      ).toBe(200);
    await h.flush();
    const rows = async (query: string) => {
      const response = await h.read(
        `/monitoring/events?start=0${query}`,
        h.operatorCredential,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { data: Record<string, unknown>[] })
        .data;
    };
    // What the dashboard export reads: Station's 40, not 110. Against an
    // expected 100 the export is refused instead of passing on producer rows.
    const exported = await rows('&tools=true');
    expect(exported).toHaveLength(40);
    expect(exported.length < 100).toBe(true);
    expect(exported.some((row) => K.TELEMETRY_PRODUCER in row)).toBe(false);
    expect(await rows('&tools=true&producer=bulk')).toHaveLength(70);
  });

  test('producerActivity follows filters and counts chats per distinct trace; a bad producer value is 400', async () => {
    const h = await setup();
    const created = await h.create(
      { Authorization: `Bearer ${h.operatorCredential}` },
      'chats',
    );
    const { token } = ((await created.json()) as { data: { token: string } })
      .data;
    // Where counting STARTs and counting distinct traces disagree: two
    // STARTs on one trace (1 chat, not 2), an END-only trace (1, not 0), two
    // ENDs on the no-session sentinel (2, as Station counts its own).
    const sent: [string, string, string][] = [
      ['one-session', 'session.start', 'a'],
      ['one-session', 'session.start', 'b'],
      ['one-session', 'session.end', 'c'],
      ['end-only', 'session.end', 'd'],
      ['no-session', 'session.end', 'e'],
      ['no-session', 'session.end', 'f'],
    ];
    for (const [session, event_type, event_id] of sent)
      expect(
        (await h.ingest(token, session, { event_type, event_id })).status,
      ).toBe(200);
    await h.flush();
    const insights = async (query: string) => {
      const response = await h.read(
        `/api/insights?days=1${query}`,
        h.operatorCredential,
      );
      return {
        status: response.status,
        body: (await response.json()) as {
          data?: { producerActivity?: Record<string, { chats: number }> };
        },
      };
    };
    expect((await insights('')).body.data?.producerActivity?.chats?.chats).toBe(
      4,
    );
    // A Station filter matches no producer row, so nothing is reported.
    expect(
      (await insights('&agent=producer:chats:codex')).body.data
        ?.producerActivity,
    ).toEqual({});
    for (const bad of ['', 'Not%20A%20Name', '-leading'])
      expect((await insights(`&producer=${bad}`)).status).toBe(400);
    const events = await h.read(
      '/monitoring/events?start=0&producer=',
      h.operatorCredential,
    );
    expect(events.status).toBe(400);
  });
});
