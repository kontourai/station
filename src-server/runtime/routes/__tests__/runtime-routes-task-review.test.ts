/** Real runtime composition, TaskGraph, room worker and SQLite; inert unrelated services. */
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-task-review';
const PROJECT = 'project-alpha';
const AT = '2026-10-04T00:00:00.000Z';
const makeTempDir = trackTempDirs();

describe('Task review through configureRuntimeRoutes', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const failures: unknown[] = [];
    for (const close of closers.splice(0)) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Task review teardown failed');
  });

  async function setup() {
    const homeDir = makeTempDir('station-task-review-');
    const notifications = new NotificationService(
      new EventBus(),
      homeDir,
      999_999,
    );
    closers.push(() => notifications.shutdown());
    support.notificationService = notifications;
    __resetStationServerSelfAttestationForTests();

    const store = new EventStore(join(homeDir, 'orchestration.sqlite'));
    closers.push(async () => {
      await store.close();
    });
    const orchestration = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: () => undefined,
        list: () => [],
      } as never,
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
    });
    closers.unshift(async () => {
      await orchestration.shutdown();
    });
    const projectService = {
      listProjects: () => [{ id: PROJECT, slug: PROJECT }],
      getProject: (slug: string) => {
        if (slug !== PROJECT) throw new Error('missing project');
        return {
          id: PROJECT,
          slug: PROJECT,
          name: 'Project alpha',
          createdAt: AT,
          updatedAt: AT,
        };
      },
    };
    const taskGraph = new TaskGraphService(homeDir, {
      projectService: projectService as never,
    });

    // The room's revision evidence is signed by the real security service;
    // without it every edit after the first waits on an undrained publication.
    const security = new EnvironmentSecurityService({
      homeDir: join(homeDir, 'security-home'),
    });
    await security.initialize();

    const app = new Hono();
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
    const port = await listening;
    const runtimeLogger = {
      debug() {},
      info() {},
      warn: vi.fn(),
      error: vi.fn(),
    };
    const context = deepStub({
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: runtimeLogger,
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
      orchestrationEventStore: store,
      orchestrationService: orchestration,
      storageAdapter: deepStub({
        getProject: (slug: string) => {
          if (slug !== PROJECT) throw new Error('no project');
          return { id: PROJECT };
        },
      }),
      projectMembership: undefined,
      taskGraphService: taskGraph,
      projectService,
      environmentSecurityService: deepStub({
        devicePairing: deepStub({
          listKnownPrincipals: () => [
            { id: LOCAL_OPERATOR_PRINCIPAL_ID, display: 'Test owner' },
          ],
          listDevices: () => [],
        }),
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
        signRevisionEvidenceAuthorityBinding: (
          ...args: Parameters<
            EnvironmentSecurityService['signRevisionEvidenceAuthorityBinding']
          >
        ) => security.signRevisionEvidenceAuthorityBinding(...args),
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const createWorking = store.createProjectTaskRoomWorkingState.bind(store);
    let working!: ReturnType<typeof createWorking>;
    vi.spyOn(store, 'createProjectTaskRoomWorkingState').mockImplementation(
      (options) => (working = createWorking(options)),
    );
    const configured = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    closers.unshift(async () => {
      // The room workers share the orchestration SQLite file.
      const closed = await configured.projectTaskRoomRuntime?.close();
      expect(closed?.kind).toBe('closed');
    });
    await configured.kitLifecycleReady;
    const base = `http://127.0.0.1:${port}`;

    const asOperator = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: any }> => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      expect(
        response.status,
        JSON.stringify(runtimeLogger.error.mock.calls),
      ).not.toBe(500);
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json };
    };

    const task = await taskGraph.createTask({
      projectId: PROJECT,
      title: 'Review the plan',
    });
    const reviewPath = `/api/tasks/${task.id}/review`;
    const edit = async (desiredText: string) => {
      const planned = await asOperator(
        'POST',
        `/api/tasks/${task.id}/room/edit-plan`,
        {
          intentId: `edit-${crypto.randomUUID()}`,
          desiredText,
          selection: { anchor: 0, focus: 0 },
        },
      );
      expect(planned.status, JSON.stringify(planned.json)).toBe(200);
      expect(planned.json.data.kind).toBe('planned');
      const settled = await asOperator(
        'POST',
        `/api/tasks/${task.id}/room/batches`,
        {
          intentId: planned.json.data.intentId,
          intentDigest: planned.json.data.digest,
        },
      );
      expect(settled.status, JSON.stringify(settled.json)).toBe(200);
      expect(settled.json.data.kind).toBe('committed');
    };
    const createThread = async () => {
      const view = await asOperator('GET', reviewPath);
      expect(view.status, JSON.stringify(view.json)).toBe(200);
      const plan = view.json.data.items.find(
        (item: any) => item.kind === 'plan',
      );
      const response = await asOperator('POST', `${reviewPath}/threads`, {
        artifact: plan.artifact,
        anchor: {
          kind: 'text-quote',
          start: 0,
          end: 10,
          exact: 'First plan',
          prefix: '',
          suffix: '',
        },
        body: 'Please explain this.',
        operationId: 'thread-create',
      });
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      return response.json.data.thread;
    };
    const evidence = () => {
      const db = new DatabaseSync(join(homeDir, 'orchestration.sqlite'), {
        readOnly: true,
      });
      try {
        return db
          .prepare(
            'SELECT * FROM revision_evidence_receipts ORDER BY revision_id',
          )
          .all();
      } finally {
        db.close();
      }
    };
    return {
      asOperator,
      task,
      taskGraph,
      store,
      working,
      edit,
      reviewPath,
      createThread,
      evidence,
    };
  }

  test('plan edits relocate quotes before marking Outdated, retain the original quote, and resolve/reopen without changing room state or Task status', async () => {
    const e = await setup();
    await e.edit('First plan\nDetails.');
    const documentBefore = await e.asOperator(
      'GET',
      `/api/tasks/${e.task.id}/room/document`,
    );
    const historyBefore = await e.asOperator(
      'GET',
      `/api/tasks/${e.task.id}/room/history`,
    );
    expect(documentBefore.status).toBe(200);
    expect(historyBefore.status).toBe(200);
    const evidenceBefore = e.evidence();
    const thread = await e.createThread();
    const reply = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/replies`,
      { body: 'More detail?', operationId: 'reply' },
    );
    expect(reply.json.data.thread).toMatchObject({
      baseState: 'open',
      outdated: false,
      events: [{ kind: 'comment' }, { kind: 'reply' }],
    });
    expect(
      (await e.asOperator('GET', `/api/tasks/${e.task.id}/room/document`)).json,
    ).toEqual(documentBefore.json);
    expect(
      (await e.asOperator('GET', `/api/tasks/${e.task.id}/room/history`)).json,
    ).toEqual(historyBefore.json);
    expect(e.evidence()).toEqual(evidenceBefore);
    await e.edit('Intro.\nFirst plan\nDetails.');
    let read = await e.asOperator('GET', e.reviewPath);
    expect(read.json.data.threads[0]).toMatchObject({
      state: 'open',
      outdated: false,
    });
    expect(read.json.data.threads[0].currentRevision).not.toBe(
      thread.artifact.revision,
    );
    await e.edit('Replacement plan\nDetails.');
    read = await e.asOperator('GET', `${e.reviewPath}?state=outdated`);
    expect(read.json.data).toMatchObject({
      counts: { open: 0, outdated: 1, resolved: 0 },
      threads: [
        { threadId: thread.threadId, state: 'outdated', quote: 'First plan' },
      ],
    });
    const documentAfterEdit = await e.asOperator(
      'GET',
      `/api/tasks/${e.task.id}/room/document`,
    );
    const historyAfterEdit = await e.asOperator(
      'GET',
      `/api/tasks/${e.task.id}/room/history`,
    );
    const evidenceAfterEdit = e.evidence();
    const resolved = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/resolve`,
      { operationId: 'resolve' },
    );
    expect(resolved.json.data.thread).toMatchObject({
      state: 'resolved',
      outdated: false,
    });
    const reopened = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/reopen`,
      { operationId: 'reopen' },
    );
    expect(reopened.json.data.thread).toMatchObject({
      state: 'outdated',
      baseState: 'open',
      outdated: true,
    });
    expect(
      (await e.asOperator('GET', `/api/tasks/${e.task.id}/room/document`)).json,
    ).toEqual(documentAfterEdit.json);
    expect(
      (await e.asOperator('GET', `/api/tasks/${e.task.id}/room/history`)).json,
    ).toEqual(historyAfterEdit.json);
    expect(e.evidence()).toEqual(evidenceAfterEdit);
    expect(e.taskGraph.readTaskView(e.task.id)?.status).toBe(e.task.status);
  });

  test('cross-Task 404 includes another Task id and a previous incarnation of the current Task', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    const other = await e.taskGraph.createTask({
      projectId: PROJECT,
      title: 'Other Task',
    });
    const refused = await e.asOperator(
      'POST',
      `/api/tasks/${other.id}/review/threads/${thread.threadId}/replies`,
      { body: 'Wrong Task', operationId: 'cross-task' },
    );
    expect(refused.status).toBe(404);
    // Durable historical rows remain after a Task id is reused; this fixture
    // leaves the real current TaskGraph untouched and writes its predecessor.
    const old = e.store.taskReviewStore().createThread({
      projectId: PROJECT,
      taskId: e.task.id,
      taskCreatedAt: '2026-01-01T00:00:00.000Z',
      author: { kind: 'person', principalId: 'past-owner' },
      beforeCommit: () => true,
      artifact: thread.artifact,
      anchor: thread.anchor,
      body: 'Historical',
      operationId: 'historical',
    });
    if (!old.success) throw new Error(old.error);
    for (const action of ['replies', 'resolve', 'reopen']) {
      const response = await e.asOperator(
        'POST',
        `${e.reviewPath}/threads/${old.data.threadId}/${action}`,
        action === 'replies'
          ? { body: 'Wrong incarnation', operationId: `old-${action}` }
          : { operationId: `old-${action}` },
      );
      expect(response.status).toBe(404);
    }
    expect(
      (await e.asOperator('GET', e.reviewPath)).json.data.threads.map(
        (t: any) => t.threadId,
      ),
    ).toEqual([thread.threadId]);
  });

  test('a real unavailable document worker returns unknown freshness and still allows review replies', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    await e.working.close();
    const read = await e.asOperator('GET', e.reviewPath);
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect(read.json.data.threads[0]).toMatchObject({
      threadId: thread.threadId,
      outdated: 'unknown',
      state: 'open',
    });
    const replied = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/replies`,
      { body: 'Still retained', operationId: 'after-unavailable' },
    );
    expect(replied.status).toBe(200);
    expect(replied.json.data.thread.events).toHaveLength(2);
  });

  test('new anchors require the current revision and matching quote; strict route validation refuses extra keys', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    for (const change of [
      { artifact: { ...thread.artifact, revision: 'stale' } },
      { anchor: { ...thread.anchor, exact: 'Wrong text' } },
      { anchor: { ...thread.anchor, extra: true } },
    ]) {
      const response = await e.asOperator('POST', `${e.reviewPath}/threads`, {
        artifact: thread.artifact,
        anchor: thread.anchor,
        body: 'No',
        operationId: crypto.randomUUID(),
        ...change,
      });
      expect([400, 409]).toContain(response.status);
    }
    const repeated = await e.asOperator('POST', `${e.reviewPath}/threads`, {
      artifact: thread.artifact,
      anchor: thread.anchor,
      body: 'Please explain this.',
      operationId: 'thread-create',
    });
    expect(repeated.status).toBe(200);
    expect(repeated.json.data.thread.threadId).toBe(thread.threadId);
    expect(
      (await e.asOperator('GET', e.reviewPath)).json.data.threads,
    ).toHaveLength(1);
  });
});
