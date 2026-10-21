/**
 * Epic #4003: `get_task_brief`'s REST leaf in the PRODUCTION composition:
 * `configureRuntimeRoutes` with the real credential pipeline, the real
 * station-control authority guard and policy table, real caller derivation
 * and real token mints. Only the stores behind the route are stubs: the
 * event store answers the immutable Session → Task binding and the Task graph
 * answers the Task. The tracker re-read is the real `GitHubWorkItemObserver`
 * against a fake `gh` at the process seam.
 *
 * Sessions are named for their records: `op-*` is the operator's; `*-bound`
 * was dispatched for `task-bound`, `*-other` for `task-other`, and `*-free`
 * for no Task.
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../../services/orchestration/session-project-identity.js';
import * as fakeGh from '../../../services/work-item-providers/__tests__/fixtures/fake-gh.js';
import { GitHubWorkItemObserver } from '../../../services/work-item-providers/github-work-item-observer.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../../tools/station-control-shared.js';
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

const TASKS = {
  'task-bound': {
    id: 'task-bound',
    projectId: 'project-a',
    title: 'The bound Task',
    description: '',
    priority: 'medium',
    status: 'in_progress',
    createdBy: LOCAL_OPERATOR_PRINCIPAL_ID,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    workItemRef: 'github:owner/repo#7',
    sourceProvider: 'github',
    // The last dispatch's read: the re-read asks for comments after it.
    workItemObservedAt: '2026-10-20T05:00:00.000Z',
  },
  'task-other': {
    id: 'task-other',
    projectId: 'project-a',
    title: 'Somebody else’s Task',
    description: '',
    priority: 'medium',
    status: 'in_progress',
    createdBy: LOCAL_OPERATOR_PRINCIPAL_ID,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  },
} as const;

function bindingOf(sessionId: string) {
  if (sessionId.endsWith('-bound'))
    return { projectId: 'project-a', taskId: 'task-bound' };
  if (sessionId.endsWith('-other'))
    return { projectId: 'project-a', taskId: 'task-other' };
  return undefined;
}

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-task-brief';
const PATH = '/api/orchestration/station-control/task-brief';
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: get_task_brief', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('station-task-brief-route-');
    const ghDir = makeTempDir('station-task-brief-fake-gh-');
    const gh = fakeGh.installFakeGh(ghDir);
    const issuePath = 'repos/owner/repo/issues/7';
    fakeGh.answer(
      ghDir,
      issuePath,
      fakeGh.issue({
        number: 7,
        html_url: 'https://github.com/owner/repo/issues/7',
        title: 'The bound issue',
        comments: 2,
      }),
    );
    fakeGh.answer(ghDir, `${issuePath}/comments?per_page=30&page=1`, [
      fakeGh.comment(1, '2026-10-20T04:00:00Z', 'Already seen at dispatch.'),
      fakeGh.comment(2, '2026-10-20T06:00:00Z', 'Posted after the dispatch.'),
    ]);
    const service = new NotificationService(new EventBus(), homeDir, 999_999);
    closers.push(() => service.shutdown());
    support.notificationService = service;
    __resetStationServerSelfAttestationForTests();
    const app = new Hono();
    const context = deepStub({
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port: 4321,
      appConfig: {},
      getLiveAppConfig: () => ({}),
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
      workItemObserver: new GitHubWorkItemObserver({ command: gh }),
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
        }),
        conversationForSession: () => undefined,
        conversationSessions: () => [],
        readSessionByThread: (threadId: string) =>
          threadId === 'op-sibling-bound' ? { status: 'running' } : undefined,
        readProjectTaskRoomExecutionBinding: bindingOf,
      }),
      orchestrationService: deepStub({
        resolveSessionActingPrincipal: (threadId: string) =>
          threadId.startsWith('op-')
            ? {
                id: LOCAL_OPERATOR_PRINCIPAL_ID,
                source: 'session-owner' as const,
              }
            : undefined,
        sessionRecordedOwnerId: (threadId: string) =>
          threadId.startsWith('op-') ? LOCAL_OPERATOR_PRINCIPAL_ID : undefined,
        hasSessionStartRecord: () => true,
        currentConversationSessionId: (conversationId: string) =>
          conversationId,
        canUserReadSession: () => true,
        firstStartedMetadataOfThread: () => ({
          adoptedFromThreadId: 'attached',
          [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: 'project-a',
        }),
        firstStartedEngineOfThread: () => 'codex',
        sessionRunsHost: () => false,
      }),
      storageAdapter: deepStub({
        getProject: () => {
          throw new Error('no project');
        },
      }),
      projectMembership: deepStub({
        admissionsForResolvedPrincipal: () => [],
      }),
      taskGraphService: {
        listTasks: () => [],
        readTaskView: (taskId: string) =>
          (TASKS as Record<string, unknown>)[taskId] ?? null,
        listTaskDispatchSessions: (taskId: string) =>
          taskId === 'task-bound'
            ? [
                {
                  sessionId: 'op-sibling-bound',
                  provider: 'claude',
                  createdAt: '2026-10-20T01:00:00.000Z',
                },
                {
                  sessionId: 'op-caller-bound',
                  provider: 'codex',
                  createdAt: '2026-10-20T02:00:00.000Z',
                },
              ]
            : [],
      },
      projectService: {
        listProjects: () => [],
        getProject: (slug: string) => ({ slug }),
      },
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
    return `http://127.0.0.1:${await listening}`;
  }

  const internal = (extra: Record<string, string> = {}) => ({
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    ...extra,
  });
  const as = (sessionId: string) =>
    internal({
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: mintStationControlMcpToken(
        sessionId,
        'sdk-in-process',
      ).token,
    });

  async function get(
    base: string,
    headers: Record<string, string>,
    query = '',
  ) {
    const response = await fetch(`${base}${PATH}${query}`, { headers });
    const text = await response.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, json };
  }

  // The fake `gh` is a POSIX shell script.
  test.skipIf(process.platform === 'win32')(
    'a bound caller reads the brief for its OWN Task, whatever the request names, with the item re-read',
    async () => {
      const base = await setup();
      const { status, json } = await get(
        base,
        as('op-caller-bound'),
        // Nothing the caller supplies chooses the Task.
        '?taskId=task-other',
      );
      expect(status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.taskId).toBe('task-bound');
      expect(json.data.version).toBe('station.task-brief/v1');
      expect(json.data.text).toContain('Task: The bound Task');
      expect(json.data.text).not.toContain('Somebody else');
      // The other Session in the Task, with its status word; not the caller.
      expect(json.data.text).toContain('- op-sibling-bound (claude): running');
      expect(json.data.text).not.toContain('op-caller-bound');
      // get_task_brief re-reads the linked item, for comments after the
      // Task's recorded observation only.
      expect(json.data.text).toContain('Title: The bound issue');
      expect(json.data.text).toContain(
        '- commenter2 (2026-10-20T06:00:00Z): Posted after the dispatch.',
      );
      expect(json.data.text).not.toContain('Already seen at dispatch.');
      expect(json.data.text).not.toContain('linked item not re-read');
      expect(json.data.text).toContain('## Tracker guidance');
    },
  );

  test('a caller whose session has no Task binding is refused', async () => {
    const base = await setup();
    const { status, json } = await get(base, as('op-caller-free'));
    expect(status).toBe(409);
    expect(json).toMatchObject({ success: false, code: 'no_task_binding' });
    expect(JSON.stringify(json)).not.toContain('Task:');
  });

  test('an internal request with no verified caller is refused', async () => {
    const base = await setup();
    const { status, json } = await get(base, internal());
    expect(status).toBe(403);
    expect(JSON.stringify(json)).toContain('station_control_caller_required');
  });

  test('a request that is not Station-internal does not find the route', async () => {
    const base = await setup();
    const { status } = await get(base, {
      authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    });
    expect(status).toBe(404);
  });
});
