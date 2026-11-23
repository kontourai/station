/**
 * The Automation episode list and retry through the PRODUCTION composition:
 * `configureRuntimeRoutes` must hand both a Task-status lookup built on the
 * runtime's own `taskGraphService.readTaskView`. Without it the list keeps
 * `task-not-canceled` after the Task is canceled (Retry never returns), and
 * a retry cannot see that the leftover Task is still live. The route and
 * ledger suites prove the decisions; this proves the wiring.
 */
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import type { AutomationEpisodeRecord } from '../../../services/automation/automation-ledger.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const tasks = vi.hoisted(() => ({ status: 'in-progress' as string }));

/** The exact shape the ledger lists for a start whose Task was not canceled. */
const EPISODE: AutomationEpisodeRecord = {
  episodeKey: '["rule-1","x"]',
  ruleId: 'rule-1',
  episodeId: '42',
  state: 'open',
  attemptCount: 0,
  maxAttempts: 1,
  openedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  startFailed: true,
  startFailure: 'task-not-canceled',
  failedPolicyFingerprint: 'policy',
  failedTaskId: 'task-1',
};

const automation = vi.hoisted(() => ({
  taskLive: [] as boolean[],
}));

const runtimeSupport = vi.hoisted(() => {
  const service = new Proxy({}, { get: () => () => undefined });
  return {
    notificationService: { list: vi.fn(() => [] as unknown[]) },
    service,
  };
});

vi.mock('../runtime-route-support.js', () => ({
  configureRuntimeSupportServices: () => ({
    schedulerService: runtimeSupport.service,
    notificationService: runtimeSupport.notificationService,
    attentionProjection: runtimeSupport.service,
    webPushService: runtimeSupport.service,
    webPushEnabled: true,
    automationPreview: {
      select: (branches: { enabled(): unknown }) => branches.enabled(),
    },
    automationStore: {
      read: () => ({ sources: [], rules: [] }),
    },
    automationLedger: {
      getExisting: () => undefined,
      get: () => ({
        listOpenEpisodes: () => [EPISODE],
        retryEpisode: (input: { taskLive(taskId: string): boolean }) => {
          automation.taskLive.push(input.taskLive('task-1'));
          return { kind: 'not-found' };
        },
      }),
    },
  }),
  createRuntimeSystemRouteDeps: () => runtimeSupport.service,
}));

// Ingress has its own boundary suite; the test middleware below stands in
// for its one output this test needs, the authenticated request principal.
vi.mock('../../bootstrap/runtime-http.js', async (importOriginal) => ({
  configureRuntimeHttp: () => undefined,
  configureRuntimeRouteClassificationGate: () => undefined,
  installStationEnvelopeMarker: (
    await importOriginal<typeof import('../../bootstrap/runtime-http.js')>()
  ).installStationEnvelopeMarker,
  LOOPBACK_DEVICE_SESSION_COOKIE: 'station-device',
  SECURE_DEVICE_SESSION_COOKIE: '__Host-station-device',
}));

/** Callable at every depth, never thenable (see the late-binding suite). */
function deepCallable(): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    get: (_target, property) => (property === 'then' ? undefined : proxy),
    apply: () => proxy,
  });
  return proxy;
}

const OPERATOR_CREDENTIAL = 'operator-credential-full-authority';

function runtimeContext(app: Hono, homeDir: string) {
  const fallback = new Proxy(
    {
      deploymentAuthentication: undefined,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: new Proxy(
        {
          sessionTurnBoundaryAuthority: () => ({
            reconcile: () => ({ kind: 'available', interrupted: [] }),
          }),
        },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      environmentSecurityService: new Proxy(
        {
          authorizeCredential: (candidate: string) =>
            candidate === OPERATOR_CREDENTIAL,
          resolveGrantedScope: (candidate: string) =>
            candidate === OPERATOR_CREDENTIAL
              ? DEFAULT_GRANT_PAIRING_SCOPE
              : undefined,
          verifyOperatorCredential: (candidate: string) =>
            candidate === OPERATOR_CREDENTIAL,
        },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      // The runtime's own Task read: the composition must decide from it.
      taskGraphService: {
        listTasks: () => [],
        readTaskView: (taskId: string) =>
          taskId === 'task-1'
            ? { id: taskId, status: tasks.status }
            : undefined,
      },
    },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return deepCallable();
      },
    },
  );
  Reflect.set(fallback as object, 'buildRuntimeContext', () => fallback);
  return fallback as never;
}

describe('configureRuntimeRoutes — Automation episode Task status wiring', () => {
  const tempDir = trackTempDirs();

  test("the episode list and retry read the leftover Task's status from the runtime's Task service", async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'credential',
        credential: OPERATOR_CREDENTIAL,
        authority: 'operator-credential',
        source: 'bearer',
        locality: 'home-possession',
      });
      await next();
    });
    const result = configureRuntimeRoutes(
      runtimeContext(app, tempDir('station-automation-task-status-')),
    );
    await result.kitLifecycleReady;
    const request = (path: string, init: RequestInit = {}) =>
      app.request(
        path,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
            'content-type': 'application/json',
          },
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
      );
    const listed = async () => {
      const response = await request('/automations/episodes');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { episodes: Record<string, unknown>[] };
      };
      return body.data.episodes[0];
    };
    const retry = async () =>
      (
        await request('/automations/episodes/rule-1%3A42/retry', {
          method: 'POST',
          body: '{}',
        })
      ).status;

    expect(await listed()).toMatchObject({ startFailure: 'task-not-canceled' });
    expect(await retry()).toBe(404);
    tasks.status = 'canceled';
    expect(await listed()).not.toHaveProperty('startFailure');
    expect(await retry()).toBe(404);
    // The retry asked the ledger with the Task's status at each call.
    expect(automation.taskLive).toEqual([true, false]);
  });
});
