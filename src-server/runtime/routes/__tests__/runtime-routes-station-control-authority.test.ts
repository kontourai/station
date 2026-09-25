/**
 * #2377 slice A: the station-control authority guard in the PRODUCTION
 * composition — `configureRuntimeRoutes` with the real credential pipeline,
 * the real caller re-derivation (`resolveStationControlCallerForRequest` over
 * the production record resolver, reading the session owner from
 * `resolveSessionActingPrincipal`) and real token mints. What is proved is
 * the wiring in `runtime-routes.ts`: the guard sits between the auth boundary
 * and every route, reads the real runtime principal stamp, and leaves the
 * operator's credential, Station's own server code and the carve-outs alone.
 * The runtime services behind the routes are inert stubs, so "passed the
 * guard" is read as "not a station_control refusal".
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  __resetStationControlStdioCallerCredentialForTests,
  api,
  STATION_CONTROL_CALLER_TOKEN_HEADER,
} from '../../../tools/station-control-shared.js';
import {
  __resetStationServerSelfAttestationForTests,
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  runAsStationServer,
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
const OPERATOR_CREDENTIAL = 'test-only-operator-credential-authority-guard';
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: the station-control authority guard', () => {
  const closers: Array<() => Promise<void>> = [];
  const originalHosted = process.env[HOSTED_ENV];

  afterEach(async () => {
    if (originalHosted === undefined) delete process.env[HOSTED_ENV];
    else process.env[HOSTED_ENV] = originalHosted;
    __resetStationControlMcpTokensForTests();
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('station-control-authority-');
    const service = new NotificationService(new EventBus(), homeDir, 999_999);
    closers.push(() => service.shutdown());
    support.notificationService = service;
    __resetStationServerSelfAttestationForTests();
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
        // The production caller derivation reads the session's owner here.
        resolveSessionActingPrincipal: (threadId: string) =>
          threadId.startsWith('op-')
            ? {
                id: LOCAL_OPERATOR_PRINCIPAL_ID,
                source: 'session-owner' as const,
              }
            : threadId.startsWith('person-')
              ? {
                  id: 'human:local:someone-else',
                  source: 'session-owner' as const,
                }
              : undefined,
        canUserReadSession: () => true,
        // The start record of the calling session: its agent, and a
        // model-written delegation root that must choose nothing.
        firstStartedMetadataOfThread: () => undefined,
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

  async function outcome(
    base: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<string> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let code: unknown;
    try {
      code = (JSON.parse(text) as { code?: unknown }).code;
    } catch {
      code = undefined;
    }
    return response.status === 403 &&
      typeof code === 'string' &&
      code.startsWith('station_control_')
      ? code
      : 'passed-guard';
  }

  const callerFor = (
    sessionId: string,
    channel: 'sdk-in-process' | 'url-token',
  ) =>
    internal({
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: mintStationControlMcpToken(
        sessionId,
        channel,
      ).token,
    });

  test('an internal request is decided from the table with the real caller derivation', async () => {
    const { base } = await setup();
    const update = { theme: 'dark' };
    expect(await outcome(base, 'PUT', '/config/app', internal(), update)).toBe(
      'station_control_caller_required',
    );
    expect(
      await outcome(
        base,
        'PUT',
        '/config/app',
        callerFor('op-claude', 'sdk-in-process'),
        update,
      ),
    ).toBe('passed-guard');
    expect(
      await outcome(
        base,
        'PUT',
        '/config/app',
        callerFor('person-claude', 'sdk-in-process'),
        update,
      ),
    ).toBe('station_control_role_required');
    expect(
      await outcome(
        base,
        'PUT',
        '/config/app',
        callerFor('op-codex', 'url-token'),
        update,
      ),
    ).toBe('station_control_assurance_insufficient');
    expect(
      await outcome(
        base,
        'POST',
        '/api/providers',
        callerFor('op-x', 'sdk-in-process'),
        {},
      ),
    ).toBe('station_control_person_only');
    // A read stays open to a caller-less request (decision 4).
    expect(await outcome(base, 'GET', '/config/app', internal())).toBe(
      'passed-guard',
    );
    // A route no tool reaches fails closed.
    expect(
      await outcome(base, 'GET', '/api/operator/accounts', internal()),
    ).toBe('station_control_route_unmapped');
  });

  test('the operator credential, Station’s own server code and the readiness carve-outs pass; the relay path does not', async () => {
    const { base } = await setup();
    expect(
      await outcome(
        base,
        'PUT',
        '/config/app',
        {
          'content-type': 'application/json',
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        },
        { theme: 'dark' },
      ),
    ).toBe('passed-guard');
    for (const path of ['/api/system/identity', '/api/system/instance'])
      expect(await outcome(base, 'GET', path, internal())).toBe('passed-guard');
    // M2: the agent relay path is no longer carved out; only the relay
    // itself (server code) passes.
    expect(
      await outcome(base, 'POST', '/api/agents/default/chat', internal(), {
        input: 'hi',
      }),
    ).toBe('station_control_route_unmapped');
    // Station's own server code: an explicit server scope, in the process the
    // composition minted the server attestation in. The same request without
    // the scope is refused (the control).
    expect(
      await outcome(base, 'PUT', '/config/app', internal(), { theme: 'dark' }),
    ).toBe('station_control_caller_required');
    __resetStationControlStdioCallerCredentialForTests();
    process.env.STATION_API_BASE = base;
    try {
      const response = (await runAsStationServer(() =>
        api('/config/app', {
          method: 'PUT',
          body: JSON.stringify({ theme: 'dark' }),
        }),
      )) as { code?: string };
      expect(response?.code ?? 'passed-guard').not.toMatch(/^station_control_/);
    } finally {
      delete process.env.STATION_API_BASE;
    }
  });
});
