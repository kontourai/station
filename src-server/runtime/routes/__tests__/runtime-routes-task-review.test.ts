/** Real runtime composition, TaskGraph, room worker and SQLite; inert unrelated services. */
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import * as reviewContracts from '@kontourai/station-contracts/task-review';
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
import { TaskOutputModule } from '../../../services/projects/task-output-module.js';
import { TASK_REVIEW_ITEM_MAX_BYTES } from '../../../services/projects/task-review-module.js';
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
const REVOKED_CREDENTIAL = 'test-only-revoked-person-task-review';
const PROJECT = 'project-alpha';
const OTHER_PROJECT = 'project-beta';
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
    vi.restoreAllMocks();
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
      listProjects: () =>
        [PROJECT, OTHER_PROJECT].map((id) => ({ id, slug: id })),
      getProject: (slug: string) => {
        if (![PROJECT, OTHER_PROJECT].includes(slug))
          throw new Error('missing project');
        return {
          id: slug,
          slug,
          workingDirectory: homeDir,
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
    let revokedGrant = false;
    let operatorGrant = true;
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
          [OPERATOR_CREDENTIAL, REVOKED_CREDENTIAL].includes(credential),
        authorizeCredential: (credential: string) =>
          [OPERATOR_CREDENTIAL, REVOKED_CREDENTIAL].includes(credential),
        verifyOperatorCredential: (credential: string) => {
          if (credential === OPERATOR_CREDENTIAL) return operatorGrant;
          if (credential !== REVOKED_CREDENTIAL) return false;
          // Accepted with a resolved operator identity at ingress, then revoked
          // before the room's separate person-grant lookup.
          const current = !revokedGrant;
          revokedGrant = true;
          return current;
        },
        resolveGrantedScope: (credential: string) =>
          [OPERATOR_CREDENTIAL, REVOKED_CREDENTIAL].includes(credential)
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
      credential = OPERATOR_CREDENTIAL,
    ): Promise<{ status: number; json: any }> => {
      if (credential === REVOKED_CREDENTIAL) revokedGrant = false;
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
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
      revokePerson: () => {
        operatorGrant = false;
      },
      runtimeLogger,
      orchestration,
      homeDir,
      runtime: configured.projectTaskRoomRuntime!,
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
  test('invalid reopen and double resolve return 409 invalid-transition without consuming an event slot', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    const path = `${e.reviewPath}/threads/${thread.threadId}`;
    const reopened = await e.asOperator('POST', `${path}/reopen`, {
      operationId: 'invalid-reopen',
    });
    expect(reopened).toMatchObject({
      status: 409,
      json: { code: 'invalid-transition' },
    });
    const resolved = await e.asOperator('POST', `${path}/resolve`, {
      operationId: 'resolve',
    });
    expect(resolved.status).toBe(200);
    expect(
      (
        await e.asOperator('POST', `${path}/resolve`, {
          operationId: 'resolve',
        })
      ).status,
    ).toBe(200);
    const duplicate = await e.asOperator('POST', `${path}/resolve`, {
      operationId: 'double-resolve',
    });
    expect(duplicate).toMatchObject({
      status: 409,
      json: { code: 'invalid-transition' },
    });
    expect(
      e.store
        .taskReviewStore()
        .readThread({
          taskId: e.task.id,
          taskCreatedAt: e.task.createdAt,
          threadId: thread.threadId,
        })
        ?.events.map((event) => event.kind),
    ).toEqual(['comment', 'resolved']);
  });

  test('an invalid stored transition returns invalid-event as HTTP 400 without appending', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    const db = new DatabaseSync(join(e.homeDir, 'orchestration.sqlite'));
    try {
      db.prepare(`INSERT INTO task_review_events(thread_id, ordinal, kind, author_kind, author_id, operation_id, created_at)
        VALUES (?, 2, 'reopened', 'person', ?, 'invalid-history', ?)`).run(
        thread.threadId,
        LOCAL_OPERATOR_PRINCIPAL_ID,
        AT,
      );
    } finally {
      db.close();
    }
    const result = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/replies`,
      { body: 'Cannot append', operationId: 'after-invalid' },
    );
    expect(result).toMatchObject({
      status: 400,
      json: { code: 'invalid-event' },
    });
    expect(
      e.store.taskReviewStore().readThread({
        taskId: e.task.id,
        taskCreatedAt: e.task.createdAt,
        threadId: thread.threadId,
      })?.events,
    ).toHaveLength(2);
  });

  test('a credential whose person grant is revoked gets 404 and no write; another Project cannot reply to this thread', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    const before = e.store
      .taskReviewStore()
      .listThreads({ taskId: e.task.id, taskCreatedAt: e.task.createdAt });
    const revoked = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/replies`,
      { body: 'Forbidden', operationId: 'revoked' },
      REVOKED_CREDENTIAL,
    );
    expect(revoked).toMatchObject({ status: 404, json: { code: 'not-found' } });
    expect(
      (await e.asOperator('GET', e.reviewPath, undefined, REVOKED_CREDENTIAL))
        .status,
    ).toBe(404);
    const other = await e.taskGraph.createTask({
      projectId: OTHER_PROJECT,
      title: 'Other Project',
    });
    const cross = await e.asOperator(
      'POST',
      `/api/tasks/${other.id}/review/threads/${thread.threadId}/replies`,
      { body: 'Cross Project', operationId: 'cross-project' },
    );
    expect(cross).toMatchObject({ status: 404, json: { code: 'not-found' } });
    expect(
      e.store
        .taskReviewStore()
        .listThreads({ taskId: e.task.id, taskCreatedAt: e.task.createdAt }),
    ).toEqual(before);
    expect(
      e.store
        .taskReviewStore()
        .listThreads({ taskId: other.id, taskCreatedAt: other.createdAt }),
    ).toEqual([]);
    const allowed = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/replies`,
      { body: 'Allowed', operationId: 'owner' },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.json.data.thread.events).toHaveLength(2);
  });

  test('lists contain metadata only, item text is capped, and mutations read only their artifact', async () => {
    const e = await setup();
    await e.edit('First plan');
    expect(TASK_REVIEW_ITEM_MAX_BYTES).toBe(1048576);
    for (const [name, size] of [
      ['small', 1048576],
      ['large', 1048577],
    ] as const) {
      writeFileSync(join(e.homeDir, `${name}.txt`), 'x'.repeat(size));
      const saved = await e.asOperator(
        'POST',
        `/api/tasks/${e.task.id}/outputs`,
        { relativePath: `${name}.txt`, title: name, operationId: name },
      );
      expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    }
    const listOutputs = vi.spyOn(TaskOutputModule.prototype, 'list');
    const content = vi.spyOn(TaskOutputModule.prototype, 'readContent');
    const read = await e.asOperator('GET', e.reviewPath);
    expect(read.status).toBe(200);
    expect(read.json.data.items.every((item: any) => !('text' in item))).toBe(
      true,
    );
    expect(listOutputs).toHaveBeenCalledTimes(1);
    expect(content).not.toHaveBeenCalled();
    const small = read.json.data.items.find(
      (item: any) => item.kind === 'output' && item.label === 'small',
    );
    const large = read.json.data.items.find(
      (item: any) => item.kind === 'output' && item.label === 'large',
    );
    const selected = await e.asOperator(
      'GET',
      `${e.reviewPath}/items/output/${small.id}`,
    );
    expect(selected.status).toBe(200);
    expect(selected.json.data.text).toHaveLength(TASK_REVIEW_ITEM_MAX_BYTES);
    expect(content).toHaveBeenCalledTimes(1);
    const refused = await e.asOperator(
      'GET',
      `${e.reviewPath}/items/output/${large.id}`,
    );
    expect(refused).toMatchObject({
      status: 503,
      json: { code: 'artifact-unavailable' },
    });
    expect(refused.json.error).toContain(String(TASK_REVIEW_ITEM_MAX_BYTES));
    expect(content).toHaveBeenCalledTimes(1);
    listOutputs.mockClear();
    content.mockClear();
    const thread = await e.createThread();
    expect(listOutputs).toHaveBeenCalledTimes(1);
    expect(content).not.toHaveBeenCalled();
    listOutputs.mockClear();
    const reply = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/replies`,
      { body: 'Next', operationId: 'only-plan' },
    );
    expect(reply.status).toBe(200);
    expect(listOutputs).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    await e.edit('First plan changed');
    const plan = (await e.asOperator('GET', e.reviewPath)).json.data.items.find(
      (item: any) => item.kind === 'plan',
    );
    const updated = await e.asOperator(
      'GET',
      `${e.reviewPath}/items/plan/${encodeURIComponent(plan.id)}`,
    );
    expect(updated.json.data.text).toBe('First plan changed');
    expect(
      (await e.asOperator('GET', `${e.reviewPath}/items/output/missing`))
        .status,
    ).toBe(404);
  });

  test('whitespace block anchors retain their exact lines and whole anchors do not store full-body quotes', async () => {
    const e = await setup();
    await e.edit('First plan\n   \nEnd');
    const plan = (await e.asOperator('GET', e.reviewPath)).json.data.items.find(
      (item: any) => item.kind === 'plan',
    );
    for (const [operationId, anchor] of [
      ['blank-block', { kind: 'block', startLine: 2, endLine: 2 }],
      ['whole', { kind: 'whole' }],
    ] as const) {
      const saved = await e.asOperator('POST', `${e.reviewPath}/threads`, {
        artifact: plan.artifact,
        anchor,
        ...(anchor.kind === 'block'
          ? { quote: '   ' }
          : { quote: 'First plan\n   \nEnd' }),
        body: 'Comment',
        operationId,
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      expect(saved.json.data.thread.quote).toBe(
        operationId === 'whole' ? undefined : '   ',
      );
    }
  });
  test('person follow-ups preserve Sent delivery; keyed repeated agent replies and late send failures round-trip without reopening Resolved', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    const store = e.store.taskReviewStore();
    const write = {
      projectId: PROJECT,
      taskId: e.task.id,
      taskCreatedAt: e.task.createdAt,
      author: {
        kind: 'person',
        principalId: LOCAL_OPERATOR_PRINCIPAL_ID,
      } as const,
      beforeCommit: () => true,
    };
    expect(
      store.recordSend({
        ...write,
        threadIds: [thread.threadId],
        deliveryKey: 'delivery-one',
        operationId: 'send',
      }).success,
    ).toBe(true);
    const replied = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/replies`,
      { body: 'And this', operationId: 'follow-up' },
    );
    expect(replied.json.data.thread).toMatchObject({
      baseState: 'sent',
      deliveryKey: 'delivery-one',
      pendingFollowUp: true,
    });
    const session = {
      ...write,
      author: { kind: 'session', sessionId: 'lead' } as const,
    };
    expect(
      store.appendEvent({
        ...session,
        threadId: thread.threadId,
        event: {
          kind: 'agent-reply',
          deliveryKey: 'wrong-delivery',
          body: 'Wrong',
          operationId: 'wrong',
        },
      }),
    ).toMatchObject({ success: false, code: 'invalid-transition' });
    for (const operationId of ['agent-one', 'agent-two'])
      expect(
        store.appendEvent({
          ...session,
          threadId: thread.threadId,
          event: {
            kind: 'agent-reply',
            deliveryKey: 'delivery-one',
            body: 'Done',
            operationId,
          },
        }).success,
      ).toBe(true);
    expect(
      (
        await e.asOperator(
          'POST',
          `${e.reviewPath}/threads/${thread.threadId}/resolve`,
          { operationId: 'resolve' },
        )
      ).status,
    ).toBe(200);
    expect(
      store.recordSendFailed({
        ...session,
        threadIds: [thread.threadId],
        deliveryKey: 'delivery-one',
        reason: 'Late failure',
        operationId: 'late-failure',
      }),
    ).toMatchObject({ success: false, code: 'invalid-transition' });
    expect(
      store.recordSendFailed({
        ...write,
        threadIds: [thread.threadId],
        deliveryKey: 'delivery-one',
        reason: 'Late failure',
        operationId: 'late-failure',
      }).success,
    ).toBe(true);
    const read = await e.asOperator('GET', e.reviewPath);
    expect(read.json.data.threads[0]).toMatchObject({
      baseState: 'resolved',
      deliveryKey: 'delivery-one',
      pendingFollowUp: true,
    });
    expect(
      (
        await e.asOperator('GET', `${e.reviewPath}/threads/${thread.threadId}`)
      ).json.data.thread.events.map((event: any) => event.kind),
    ).toEqual([
      'comment',
      'sent',
      'reply',
      'agent-reply',
      'agent-reply',
      'resolved',
      'send-failed',
    ]);
    expect(read.json.data.counts).toEqual({
      open: 0,
      outdated: 0,
      resolved: 1,
    });
  });
  test('a grant revoked after access resolution is rechecked inside the write transaction', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    const original = e.runtime.personTaskReviewAccess.bind(e.runtime);
    vi.spyOn(e.runtime, 'personTaskReviewAccess').mockImplementation(
      async (input) => {
        const access = await original(input);
        expect(access.kind).toBe('granted');
        e.revokePerson();
        return access;
      },
    );
    const result = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${thread.threadId}/replies`,
      { body: 'Forbidden', operationId: 'mid-request-revoked' },
    );
    expect(result).toMatchObject({ status: 404, json: { code: 'not-found' } });
    expect(
      e.store.taskReviewStore().readThread({
        taskId: e.task.id,
        taskCreatedAt: e.task.createdAt,
        threadId: thread.threadId,
      })?.events,
    ).toEqual(thread.events);
  });

  test('a corrupt stored event is unavailable while healthy summaries and detail still list', async () => {
    const e = await setup();
    await e.edit('First plan');
    const thread = await e.createThread();
    const healthy = e.store.taskReviewStore().createThread({
      projectId: PROJECT,
      taskId: e.task.id,
      taskCreatedAt: e.task.createdAt,
      author: { kind: 'person', principalId: LOCAL_OPERATOR_PRINCIPAL_ID },
      beforeCommit: () => true,
      artifact: thread.artifact,
      anchor: thread.anchor,
      body: 'Healthy',
      operationId: 'healthy',
    });
    expect(healthy.success).toBe(true);
    if (!healthy.success) throw new Error(healthy.error);
    expect((await e.asOperator('GET', e.reviewPath)).status).toBe(200);
    const db = new DatabaseSync(join(e.homeDir, 'orchestration.sqlite'));
    try {
      // Simulate historical corruption despite the current CHECK backstop.
      db.exec('PRAGMA ignore_check_constraints=ON');
      db.prepare(`INSERT INTO task_review_events(thread_id, ordinal, kind, author_kind, author_id, body, evidence_json, operation_id, created_at)
        VALUES (?, 2, 'reply', 'person', ?, 'Invalid reply evidence', '{}', 'corrupt', ?)`).run(
        thread.threadId,
        LOCAL_OPERATOR_PRINCIPAL_ID,
        AT,
      );
    } finally {
      db.close();
    }
    const list = await e.asOperator('GET', e.reviewPath);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.data.threads).toEqual([
      {
        threadId: thread.threadId,
        ordinal: 1,
        eventCount: 2,
        status: 'unavailable',
        state: 'unavailable',
      },
      expect.objectContaining({
        threadId: healthy.data.threadId,
        status: 'available',
        eventCount: 1,
        lastEvent: expect.objectContaining({ body: 'Healthy' }),
      }),
    ]);
    expect(list.json.data.counts).toEqual({
      open: 1,
      outdated: 0,
      resolved: 0,
    });
    expect(e.runtimeLogger.warn).toHaveBeenCalledWith(
      'task review thread unavailable',
      expect.objectContaining({ threadId: thread.threadId }),
    );
    expect(list.json.data.threads.every((t: any) => !('events' in t))).toBe(
      true,
    );
    expect(
      (await e.asOperator('GET', `${e.reviewPath}/threads/${thread.threadId}`))
        .status,
    ).toBe(503);
    expect(
      (
        await e.asOperator(
          'GET',
          `${e.reviewPath}/threads/${healthy.data.threadId}`,
        )
      ).json.data.thread.events,
    ).toHaveLength(1);
  });

  test('500 relocating threads do zero freshness derivations or text preparations on an unchanged poll', async () => {
    const e = await setup();
    await e.edit('First plan');
    const first = await e.createThread();
    const db = new DatabaseSync(join(e.homeDir, 'orchestration.sqlite'));
    try {
      const threadRow = db.prepare('SELECT * FROM task_review_threads').get()!;
      const eventRow = db.prepare('SELECT * FROM task_review_events').get()!;
      const insert = (table: string, row: Record<string, any>) =>
        db
          .prepare(
            `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
              row,
            )
              .map(() => '?')
              .join(',')})`,
          )
          .run(...Object.values(row));
      db.exec('BEGIN');
      for (let n = 2; n <= 500; n++) {
        insert('task_review_threads', {
          ...threadRow,
          thread_id: `benchmark-${n}`,
          ordinal: n,
          operation_id: `open-${n}`,
        });
        insert('task_review_events', {
          ...eventRow,
          thread_id: `benchmark-${n}`,
          operation_id: `open-${n}`,
        });
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    // Fixture only the artifact-owner boundary; HTTP, access, module and SQLite are real.
    // The room edit command has smaller write bounds than this reader workload.
    const planOwner = vi.spyOn(e.runtime, 'readPlanForReview');
    planOwner.mockResolvedValue({
      kind: 'available',
      documentId: first.artifact.id,
      revision: 'benchmark-v2',
      text: `${'x'.repeat(200_000)}\nFirst plan`,
    });
    const derive = vi.spyOn(reviewContracts, 'deriveThreadView');
    const prepare = vi.spyOn(reviewContracts, 'prepareTaskReviewDocument');
    let list = await e.asOperator('GET', e.reviewPath);
    expect(list.status).toBe(200);
    expect(list.json.data.threads).toHaveLength(500);
    expect(list.json.data.counts).toEqual({
      open: 500,
      outdated: 0,
      resolved: 0,
    });
    expect(derive).toHaveBeenCalledTimes(500);
    expect(prepare).toHaveBeenCalledTimes(1);
    derive.mockClear();
    prepare.mockClear();
    for (let poll = 0; poll < 2; poll++) {
      list = await e.asOperator('GET', e.reviewPath);
      expect(list.status).toBe(200);
      expect(
        list.json.data.threads.every(
          (t: any) => t.outdated === false && !('events' in t),
        ),
      ).toBe(true);
    }
    expect(derive).toHaveBeenCalledTimes(0);
    expect(prepare).toHaveBeenCalledTimes(0);
    const reply = await e.asOperator(
      'POST',
      `${e.reviewPath}/threads/${first.threadId}/replies`,
      { body: 'One changed history', operationId: 'benchmark-reply' },
    );
    expect(reply.status).toBe(200);
    expect(derive).toHaveBeenCalledTimes(1);
    derive.mockClear();
    await e.asOperator('GET', e.reviewPath);
    expect(derive).toHaveBeenCalledTimes(0);
    planOwner.mockResolvedValue({
      kind: 'available',
      documentId: first.artifact.id,
      revision: 'benchmark-v3',
      text: 'Replacement without the quote',
    });
    list = await e.asOperator('GET', e.reviewPath);
    expect(list.json.data.counts).toEqual({
      open: 0,
      outdated: 500,
      resolved: 0,
    });
    expect(derive).toHaveBeenCalledTimes(500);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  test('linked answers require an explicit matching Project, including on selected-item reads', async () => {
    const e = await setup();
    const ref = {
      kind: 'turn' as const,
      sessionId: 'answer-session',
      turnId: 'answer-turn',
    };
    await e.taskGraph.createTaskReference(e.task.id, ref);
    const answer = {
      status: 'found' as const,
      sessionId: ref.sessionId,
      turnId: ref.turnId,
      message: {
        id: 'message',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'An answer' }],
        timestamp: Date.now(),
      },
    };
    const reader = vi.spyOn(
      e.orchestration.sessionQueries,
      'readAssistantTurn',
    );
    // This boundary fixture varies only the canonical reader's Project provenance.
    reader.mockResolvedValue({ ...answer, projectSlug: PROJECT });
    const accepted = await e.asOperator('GET', e.reviewPath);
    const item = accepted.json.data.items.find(
      (item: any) => item.kind === 'answer',
    );
    expect(item).toBeDefined();
    for (const projectSlug of [undefined, OTHER_PROJECT]) {
      reader.mockResolvedValue({ ...answer, projectSlug });
      expect(
        (await e.asOperator('GET', e.reviewPath)).json.data.items.some(
          (item: any) => item.kind === 'answer',
        ),
      ).toBe(false);
      expect(
        (
          await e.asOperator(
            'GET',
            `${e.reviewPath}/items/answer/${encodeURIComponent(item.id)}`,
          )
        ).status,
      ).toBe(404);
    }
  });

  test('capture metadata uses the clean commit revision, and selected items preserve thread counts', async () => {
    const e = await setup();
    const capture = e.store.taskReviewStore().createCapture({
      projectId: PROJECT,
      taskId: e.task.id,
      taskCreatedAt: e.task.createdAt,
      author: { kind: 'person', principalId: LOCAL_OPERATOR_PRINCIPAL_ID },
      beforeCommit: () => true,
      sourceKind: 'browser',
      sourceSessionId: 'browser-one',
      commit: 'a'.repeat(40),
      mediaType: 'image/png',
      byteLength: 100,
      digest: `sha256:${'b'.repeat(64)}`,
      operationId: 'capture',
    });
    expect(capture.success).toBe(true);
    const list = await e.asOperator('GET', e.reviewPath);
    const item = list.json.data.items.find(
      (item: any) => item.kind === 'capture',
    );
    expect(item.artifact.revision).toBe('a'.repeat(40));
    const saved = await e.asOperator('POST', `${e.reviewPath}/threads`, {
      artifact: item.artifact,
      anchor: { kind: 'region', x: 0, y: 0, w: 0.5, h: 0.5 },
      body: 'Screen comment',
      operationId: 'region',
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.data.thread.currentRevision).toBe('a'.repeat(40));
    const selected = await e.asOperator(
      'GET',
      `${e.reviewPath}/items/capture/${item.id}`,
    );
    expect(selected.json.data.counts).toEqual({
      open: 1,
      outdated: 0,
      resolved: 0,
    });
  });
});
