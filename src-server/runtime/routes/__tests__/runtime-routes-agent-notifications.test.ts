/**
 * #2584: `notify_user`'s REST side through the REAL runtime composition —
 * `configureRuntimeRoutes` with the real credential pipeline, so what is
 * proved is the wiring in `runtime-routes.ts`: the mount path, the caller
 * re-derivation, the production session context read from the session's
 * start metadata, the hosted check, and the legacy route's agent refusal.
 * Only the notification store is supplied (a real NotificationService) and
 * the orchestration records are a small fake.
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const support = vi.hoisted(() => ({
  notificationService: undefined as unknown,
}));

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: support.notificationService,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => stub,
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

const HOSTED_ENV = 'STATION_HOSTED_TENANT_REGISTRY_FILE';
const OPERATOR_CREDENTIAL = 'test-only-operator-credential-notifications';
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: agent notifications', () => {
  const closers: Array<() => Promise<void>> = [];
  const originalHosted = process.env[HOSTED_ENV];

  afterEach(async () => {
    if (originalHosted === undefined) delete process.env[HOSTED_ENV];
    else process.env[HOSTED_ENV] = originalHosted;
    __resetStationControlMcpTokensForTests();
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('station-agent-notifications-');
    const service = new NotificationService(new EventBus(), homeDir, 999_999);
    closers.push(() => service.shutdown());
    support.notificationService = service;
    const app = new Hono();
    const context = deepStub({
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
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
        }),
        conversationForSession: () => undefined,
      }),
      orchestrationService: deepStub({
        resolveSessionActingPrincipal: () => undefined,
        canUserReadSession: () => true,
        // The start record of the calling session: its agent, and a
        // model-written delegation root that must choose nothing.
        firstStartedMetadataOfThread: (threadId: string) =>
          threadId === 'agent-session'
            ? {
                agentSlug: 'planner',
                delegation: { rootConversationId: 'someone-else' },
              }
            : undefined,
      }),
      storageAdapter: deepStub({
        getProject: () => {
          throw new Error('no project');
        },
      }),
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_CREDENTIAL
            ? 'orchestration:read orchestration:operate'
            : undefined,
        identifyDevice: () => undefined,
        devicePairing: deepStub({}),
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    // A real loopback listener, so the runtime boundary sees a real peer.
    let resolvePort!: (port: number) => void;
    const listening = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolvePort((info as AddressInfo).port),
    );
    closers.unshift(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const base = `http://127.0.0.1:${await listening}`;
    return { service, base };
  }

  const internal = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    ...extra,
  });

  test('the mounted route re-derives the caller and schedules with the production session context', async () => {
    const { service, base } = await setup();
    const { token } = mintStationControlMcpToken('agent-session', 'url-token');
    const missing = await fetch(`${base}/api/notifications/agent`, {
      method: 'POST',
      headers: internal(),
      body: JSON.stringify({ title: 'No caller' }),
    });
    expect(missing.status).toBe(403);

    const sent = await fetch(`${base}/api/notifications/agent`, {
      method: 'POST',
      headers: internal({ [STATION_CONTROL_CALLER_TOKEN_HEADER]: token }),
      body: JSON.stringify({ title: 'Build finished', dedupeKey: 'build' }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ status: 'sent' });
    const [stored] = await service.list();
    expect(readNotificationEnvelope(stored)?.source).toMatchObject({
      kind: 'agent',
      sessionId: 'agent-session',
      agent: 'planner',
      assurance: 'bearer-exposed',
    });
    // Namespaced by the verified session, not the model-written root.
    expect(stored.metadata?.dedupeTag).toBe('agent:agent-session:build');
  });

  test('a hosted Station answers unavailable and stores nothing', async () => {
    const { service, base } = await setup();
    const { token } = mintStationControlMcpToken('agent-session', 'url-token');
    // Read per request by the composed gate.
    process.env[HOSTED_ENV] = '/nonexistent/tenants.json';
    const response = await fetch(`${base}/api/notifications/agent`, {
      method: 'POST',
      headers: internal({ [STATION_CONTROL_CALLER_TOKEN_HEADER]: token }),
      body: JSON.stringify({ title: 'Hosted' }),
    });
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(await service.list()).toEqual([]);
  });

  test('the legacy POST /notifications refuses an agent-originated request and still serves the operator client', async () => {
    const { service, base } = await setup();
    const body = JSON.stringify({ category: 'job-failure', title: 'Nightly' });
    const agent = await fetch(`${base}/notifications`, {
      method: 'POST',
      headers: internal({
        [STATION_CONTROL_ORIGIN_HEADER]: STATION_CONTROL_ORIGIN_AGENT_TOOL,
      }),
      body,
    });
    expect(agent.status).toBe(403);
    // #2377 slice A: the operator's client authenticates with its own
    // credential (the UI proxy never forwards the internal token as a local
    // caller). A bare internal token without the agent marker is not "the
    // operator": no station-control tool reaches this route, so the
    // station-control authority guard refuses it before the route runs.
    const bareInternal = await fetch(`${base}/notifications`, {
      method: 'POST',
      headers: internal(),
      body,
    });
    expect(bareInternal.status).toBe(403);
    expect(await bareInternal.json()).toMatchObject({
      code: 'station_control_route_unmapped',
    });
    const operator = await fetch(`${base}/notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
      },
      body,
    });
    expect(operator.status).toBe(201);
    expect(await service.list()).toHaveLength(1);
  });
});
