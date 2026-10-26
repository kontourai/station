import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { FlowRunService } from '../../../services/flow/flow-run-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { ThreadInboxDelivery } from '../../../services/orchestration/thread-inbox.js';
import { composeTaskDispatcher } from '../../../services/projects/task-dispatch-composition.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { TaskRoomWorkModule } from '../../../services/projects/task-room-work-module.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { execGit } from '../../../utils/git-exec.js';
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-task-review-engine';
const PROJECT = 'project-alpha';
const AT = '2026-10-04T00:00:00.000Z';
const makeTempDir = trackTempDirs();

describe('an engine keeps Task review through its own MCP connection', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    __resetStationControlMcpTokensForTests();
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
    const homeDir = makeTempDir('station-task-review-engine-');
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
    const workspace = join(homeDir, 'workspace');
    await mkdir(workspace);
    const git = (args: string[]) =>
      execGit(args, { cwd: workspace, timeout: 5000 });
    await git(['init']);
    await git(['config', 'user.name', 'Review test']);
    await git(['config', 'user.email', 'review-test@example.invalid']);
    await writeFile(join(workspace, 'README.md'), 'Review workspace\n');
    await git(['add', 'README.md']);
    await git(['commit', '-m', 'test: initial review workspace']);
    const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const blob = (await git(['rev-parse', 'HEAD:README.md'])).stdout.trim();
    await git([
      'tag',
      '-a',
      'review-tag',
      '-m',
      'A tag object is not a commit',
    ]);
    const tag = (await git(['rev-parse', 'review-tag'])).stdout.trim();
    const projectService = {
      listProjects: () => [{ id: PROJECT, slug: PROJECT }],
      getProject: (slug: string) => {
        if (slug !== PROJECT) throw new Error('missing project');
        return {
          id: PROJECT,
          slug: PROJECT,
          name: 'Project alpha',
          workingDirectory: workspace,
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
        devicePairing: deepStub({ listKnownPrincipals: () => [] }),
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
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json };
    };

    /** The session's own station-control MCP connection (URL token). */
    const connect = async (sessionId: string) => {
      const token = mintStationControlMcpToken(sessionId, 'url-token').token;
      let id = 0;
      const mcp = async (method: string, params: object) => {
        id += 1;
        const response = await fetch(
          `${base}/mcp/station-control?token=${token}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          },
        );
        const text = await response.text();
        const data = text
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length);
        return JSON.parse(data ?? text);
      };
      await mcp('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0' },
      });
      const call = async (
        name: string,
        args: Record<string, unknown> = {},
      ): Promise<{ isError: boolean; body: any }> => {
        const reply = await mcp('tools/call', { name, arguments: args });
        const text = reply.result?.content?.[0]?.text;
        let body: unknown = reply;
        try {
          body = text ? JSON.parse(text) : reply;
        } catch {
          body = text;
        }
        return {
          isError: reply.result?.isError === true || reply.error !== undefined,
          body,
        };
      };
      return {
        call,
        tools: async () =>
          (await mcp('tools/list', {})).result.tools as Array<{ name: string }>,
      };
    };

    /** A Task dispatched to an agent: the lead Session, bound to the room. */
    const dispatchedTask = async (conversationId?: string) => {
      if (conversationId) {
        const seed = orchestration.seedSessionRecord.bind(orchestration);
        vi.spyOn(orchestration, 'seedSessionRecord').mockImplementationOnce(
          (input) => {
            const root = seed({ ...input, threadId: conversationId });
            store.reserveNextConversationSession({
              conversationId,
              predecessorSessionId: conversationId,
              proposedSessionId: input.threadId,
              createdAt: root.createdAt,
            });
            return seed(input);
          },
        );
      }
      const task = await taskGraph.createTask({
        projectId: PROJECT,
        title: 'Ship the fix',
      });
      const dispatcher = composeTaskDispatcher(taskGraph, {
        orchestrationService: orchestration,
      });
      const dispatched = await dispatcher.dispatch(task.id, {
        agentId: 'agent-lead',
        provider: 'task-dispatch',
        sourceSurface: 'task-review-engine-test',
        fullAccessGrant: null,
        ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
      } as never);
      if (dispatched.kind !== 'dispatched')
        throw new Error(`dispatch was ${dispatched.kind}`);
      const sessionId = dispatched.result.session.threadId;
      expect(
        await store.bindProjectTaskRoomExecution({
          projectId: PROJECT,
          taskId: task.id,
          sessionId,
        }),
      ).toEqual({ kind: 'bound' });
      return { taskId: task.id, sessionId };
    };

    const createThread = async (taskId: string) => {
      const view = await asOperator('GET', `/api/tasks/${taskId}/review`);
      expect(view.status, JSON.stringify(view.json)).toBe(200);
      const plan = view.json.data.items.find(
        (item: { kind: string }) => item.kind === 'plan',
      );
      expect(plan.status).toBe('available');
      const created = await asOperator(
        'POST',
        `/api/tasks/${taskId}/review/threads`,
        {
          artifact: plan.artifact,
          anchor: { kind: 'whole' },
          body: 'Address the review.',
          operationId: crypto.randomUUID(),
        },
      );
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      return created.json.data.thread.threadId as string;
    };
    const send = async (taskId: string, threadId: string, mode = 'send') => {
      const result = await asOperator(
        'POST',
        `/api/tasks/${taskId}/review/send`,
        { threadIds: [threadId], operationId: crypto.randomUUID(), mode },
      );
      expect(result.status, JSON.stringify(result.json)).toBe(200);
      return result.json.data;
    };
    const stored = (taskId: string, threadId: string) =>
      store.taskReviewStore().readThread({
        taskId,
        taskCreatedAt: taskGraph.readTask(taskId)!.createdAt,
        threadId,
      })!;
    return {
      async helper(taskId: string) {
        const journal = new TaskRoomWorkModule(
          join(homeDir, 'task-room-work.json'),
        );
        const outcome = await journal.submit(
          taskId,
          LOCAL_OPERATOR_PRINCIPAL_ID,
          {
            operationId: 'helper-request',
            agentId: 'agent-helper',
            prompt: 'Help with this Task.',
          },
          async () => ({
            projectId: PROJECT,
            projectSlug: PROJECT,
            roomProjectId: PROJECT,
            taskCreatedAt: taskGraph.readTask(taskId)!.createdAt,
            requesterId: LOCAL_OPERATOR_PRINCIPAL_ID,
          }),
          async (sessionId) => {
            orchestration.seedSessionRecord({
              threadId: sessionId,
              provider: 'task-dispatch',
              status: 'ready',
              ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
            } as never);
            expect(
              await store.bindProjectTaskRoomExecution({
                projectId: PROJECT,
                taskId,
                sessionId,
              }),
            ).toEqual({ kind: 'bound' });
            return { sessionId };
          },
        );
        if (outcome.kind !== 'recorded')
          throw new Error('helper request refused');
        expect(outcome.record.state).toBe('dispatched');
        return outcome.record.sessionId;
      },
      store,
      homeDir,
      orchestration,
      taskGraph,
      asOperator,
      connect,
      dispatchedTask,
      createThread,
      send,
      stored,
      commit,
      blob,
      tag,
    };
  }

  test('one corrupt thread does not hide healthy threads from the agent list', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const corruptId = await e.createThread(taskId);
    const healthyId = await e.createThread(taskId);
    const db = new DatabaseSync(join(e.homeDir, 'orchestration.sqlite'));
    try {
      db.exec('PRAGMA ignore_check_constraints=ON');
      db.prepare(`INSERT INTO task_review_events(thread_id, ordinal, kind, author_kind, author_id, body, evidence_json, operation_id, created_at)
        VALUES (?, 2, 'reply', 'person', ?, 'Invalid reply evidence', '{}', 'corrupt', ?)`).run(
        corruptId,
        LOCAL_OPERATOR_PRINCIPAL_ID,
        AT,
      );
    } finally {
      db.close();
    }
    const { call } = await e.connect(sessionId);
    const result = await call('task_thread_list');
    expect(result).toMatchObject({
      isError: false,
      body: {
        success: true,
        data: {
          threads: [
            expect.objectContaining({
              threadId: healthyId,
              events: [expect.objectContaining({ kind: 'comment' })],
            }),
          ],
          counts: { open: 1, outdated: 0, resolved: 0 },
        },
      },
    });
    expect(result.body.data.threads).toHaveLength(1);
    expect(e.stored(taskId, healthyId).events).toHaveLength(1);
  });

  test('list, reply with verified commit evidence, and resolve through Codex MCP keep Task status unchanged', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const threadId = await e.createThread(taskId);
    const delivery = await e.send(taskId, threadId);
    const status = e.taskGraph.readTask(taskId)?.status;
    const { call, tools } = await e.connect(sessionId);
    const listed = await call('task_thread_list');
    expect(listed).toMatchObject({
      isError: false,
      body: {
        success: true,
        data: {
          taskId,
          threads: [
            {
              threadId,
              baseState: 'sent',
              events: [
                expect.objectContaining({ kind: 'comment' }),
                expect.objectContaining({ kind: 'sent' }),
              ],
            },
          ],
        },
      },
    });
    const names = (await tools()).map((t) => t.name);
    expect(names).toContain('task_thread_reply');
    expect(names).not.toContain('task_thread_delete');
    expect(names).not.toContain('task_thread_reopen');
    const gateRead = vi.spyOn(FlowRunService.prototype, 'readGateEvaluation');
    const gateRef = {
      runId: 'missing-run',
      gateId: 'tests',
      evaluationId: '11111111-1111-4111-8111-111111111111',
    };
    const args = {
      threadId,
      deliveryKey: delivery.deliveryKey,
      body: 'Committed the repair.',
      evidence: {
        commit: e.commit,
        gateRefs: [gateRef, { ...gateRef, gateId: 'lint' }, gateRef],
      },
      operationId: 'answer',
    };
    const reply = await call('task_thread_reply', args);
    expect(reply, JSON.stringify(reply.body)).toMatchObject({
      isError: false,
      body: { success: true, data: { thread: { baseState: 'agent-replied' } } },
    });
    expect(e.stored(taskId, threadId).events.at(-1)).toMatchObject({
      kind: 'agent-reply',
      author: { kind: 'session', sessionId },
      evidence: { commit: e.commit, commitVerified: true, gateVerified: false },
    });
    expect(gateRead).not.toHaveBeenCalled();
    expect(await call('task_thread_reply', args)).toEqual(reply);
    expect(gateRead).not.toHaveBeenCalled();
    expect(e.stored(taskId, threadId).events).toHaveLength(3);
    const resolved = await call('task_thread_resolve', {
      threadId,
      reason: 'Repair committed.',
      operationId: 'resolve',
    });
    expect(resolved).toMatchObject({
      isError: false,
      body: { success: true, data: { thread: { baseState: 'resolved' } } },
    });
    expect(e.taskGraph.readTask(taskId)?.status).toBe(status);
    expect(e.stored(taskId, threadId).events.map((e) => e.kind)).toEqual([
      'comment',
      'sent',
      'agent-reply',
      'resolved',
    ]);
  });

  test('person summaries and detail refresh delivery status through the lead conversation, with unchanged history', async () => {
    const e = await setup();
    const conversationId = 'review-lead-conversation';
    const { taskId, sessionId } = await e.dispatchedTask(conversationId);
    expect(sessionId).not.toBe(conversationId);
    expect(e.store.conversationForSession(sessionId)?.conversationId).toBe(
      conversationId,
    );
    const threadId = await e.createThread(taskId);
    const delivery = await e.send(taskId, threadId);
    expect(delivery.status).toBe('queued');
    const originalEntry = ThreadInboxDelivery.prototype.entry;
    const entry = vi.spyOn(ThreadInboxDelivery.prototype, 'entry');
    for (const status of ['confirmed', 'unconfirmed', 'confirmed']) {
      entry.mockImplementation(function (
        this: ThreadInboxDelivery,
        conversationId,
        key,
      ) {
        const retained = originalEntry.call(this, conversationId, key);
        if (!retained) throw new Error('Missing retained inbox fixture entry');
        return {
          ...retained,
          state: status === 'confirmed' ? 'queued' : 'unconfirmed',
        };
      });
      const list = await e.asOperator('GET', `/api/tasks/${taskId}/review`);
      const detail = await e.asOperator(
        'GET',
        `/api/tasks/${taskId}/review/threads/${threadId}`,
      );
      expect(list).toMatchObject({
        status: 200,
        json: {
          data: {
            threads: [
              {
                threadId,
                deliveryKey: delivery.deliveryKey,
                deliveryStatus: status,
                eventCount: 2,
              },
            ],
          },
        },
      });
      expect(detail).toMatchObject({
        status: 200,
        json: {
          data: {
            thread: {
              threadId,
              deliveryKey: delivery.deliveryKey,
              deliveryStatus: status,
            },
          },
        },
      });
      expect(detail.json.data.thread.events).toHaveLength(2);
      expect(entry).toHaveBeenLastCalledWith(
        conversationId,
        delivery.deliveryKey,
      );
    }
  });

  test('a current passing gate linked only to another Task stays claimed; a linked own gate verifies once per request', async () => {
    const e = await setup();
    const own = await e.dispatchedTask();
    const other = await e.dispatchedTask();
    const ref = {
      runId: 'passing-run',
      gateId: 'tests',
      evaluationId: '11111111-1111-4111-8111-111111111111',
    };
    const gateRead = vi
      .spyOn(FlowRunService.prototype, 'readGateEvaluation')
      .mockImplementation(async (_cwd, ref) => ({
        status: 'found',
        evaluation: {
          ref,
          evaluatedAt: AT,
          originalVerdict: 'pass',
          kind: 'initial',
          trigger: 'ordinary',
          currentStanding: 'current',
          currentRun: { status: 'active', currentStep: null },
          selectedEvidence: [],
          validityAsOf: AT,
          validityScope: 'retained-immutable-bundle',
          externalRevocation: 'not-observed',
        },
      }));
    const kept = await e.asOperator(
      'POST',
      `/api/tasks/${other.taskId}/references`,
      { kind: 'gate-evaluation', ref },
    );
    expect(kept.status, JSON.stringify(kept.json)).toBe(201);
    gateRead.mockClear();
    const threadId = await e.createThread(own.taskId);
    const delivery = await e.send(own.taskId, threadId);
    const { call } = await e.connect(own.sessionId);
    const args = {
      threadId,
      deliveryKey: delivery.deliveryKey,
      body: 'Passing gate claim.',
      evidence: { gateRefs: [ref, ref] },
      operationId: 'foreign-gate',
    };
    expect(await call('task_thread_reply', args)).toMatchObject({
      isError: false,
    });
    expect(e.stored(own.taskId, threadId).events.at(-1)).toMatchObject({
      evidence: { gateVerified: false },
    });
    expect(gateRead).not.toHaveBeenCalled();
    const ownKeep = await e.asOperator(
      'POST',
      `/api/tasks/${own.taskId}/references`,
      { kind: 'gate-evaluation', ref },
    );
    expect(ownKeep.status, JSON.stringify(ownKeep.json)).toBe(201);
    gateRead.mockClear();
    const linkedArgs = { ...args, operationId: 'own-gate' };
    expect(await call('task_thread_reply', linkedArgs)).toMatchObject({
      isError: false,
    });
    expect(e.stored(own.taskId, threadId).events.at(-1)).toMatchObject({
      evidence: { gateVerified: true },
    });
    expect(gateRead).toHaveBeenCalledTimes(1);
    expect(await call('task_thread_reply', linkedArgs)).toMatchObject({
      isError: false,
    });
    expect(gateRead).toHaveBeenCalledTimes(2);
  });

  test('missing commits and existing non-commit objects stay claimed; caller verification is refused', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const threadId = await e.createThread(taskId);
    const delivery = await e.send(taskId, threadId);
    const { call } = await e.connect(sessionId);
    expect(
      await call('task_thread_reply', {
        threadId,
        deliveryKey: delivery.deliveryKey,
        body: 'False verification.',
        evidence: { commit: e.commit, commitVerified: true },
      }),
    ).toMatchObject({ isError: true });
    const reply = await call('task_thread_reply', {
      threadId,
      deliveryKey: delivery.deliveryKey,
      body: 'Claim only.',
      evidence: { commit: 'f'.repeat(40) },
    });
    expect(reply).toMatchObject({ isError: false });
    expect(e.stored(taskId, threadId).events.at(-1)).toMatchObject({
      evidence: { commitVerified: false, gateVerified: false },
    });
    for (const object of [e.blob, e.tag]) {
      const blobThreadId = await e.createThread(taskId);
      const blobDelivery = await e.send(taskId, blobThreadId);
      expect(
        await call('task_thread_reply', {
          threadId: blobThreadId,
          deliveryKey: blobDelivery.deliveryKey,
          body: 'This object exists but is not a commit.',
          evidence: { commit: object },
        }),
      ).toMatchObject({ isError: false });
      expect(e.stored(taskId, blobThreadId).events.at(-1)).toMatchObject({
        evidence: { commit: object, commitVerified: false },
      });
    }
  });

  test('reply to a thread on another Task is refused inside the write transaction', async () => {
    const e = await setup();
    const own = await e.dispatchedTask();
    const other = await e.dispatchedTask();
    const ownId = await e.createThread(own.taskId);
    const otherId = await e.createThread(other.taskId);
    const ownDelivery = await e.send(own.taskId, ownId);
    const otherDelivery = await e.send(other.taskId, otherId);
    const { call } = await e.connect(own.sessionId);
    expect(
      await call('task_thread_reply', {
        threadId: ownId,
        deliveryKey: ownDelivery.deliveryKey,
        body: 'Own thread.',
        operationId: 'own-reply',
      }),
    ).toMatchObject({ isError: false });
    const before = e.stored(other.taskId, otherId);
    const refused = await call('task_thread_reply', {
      threadId: otherId,
      deliveryKey: otherDelivery.deliveryKey,
      body: 'Cross-Task reply.',
      operationId: 'cross-task',
    });
    expect(refused).toMatchObject({
      isError: true,
      body: { success: false, code: 'not-found' },
    });
    expect(e.stored(other.taskId, otherId)).toEqual(before);
    expect(
      await call('task_thread_resolve', {
        threadId: otherId,
        reason: 'Not mine.',
      }),
    ).toMatchObject({ isError: true, body: { code: 'not-found' } });
  });

  test('an unbound or non-lead bound Session gets no_task_binding for every thread tool', async () => {
    const e = await setup();
    const { taskId } = await e.dispatchedTask();
    const threadId = await e.createThread(taskId);
    const delivery = await e.send(taskId, threadId);
    for (const id of ['unbound', await e.helper(taskId)]) {
      if (id === 'unbound')
        e.orchestration.seedSessionRecord({
          threadId: id,
          provider: 'task-dispatch',
          status: 'ready',
          ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
        } as never);
      if (id !== 'unbound')
        expect(
          await e.store.bindProjectTaskRoomExecution({
            projectId: PROJECT,
            taskId,
            sessionId: id,
          }),
        ).toEqual({ kind: 'bound' });
      const { call } = await e.connect(id);
      for (const [name, args] of [
        ['task_thread_list', {}],
        [
          'task_thread_reply',
          { threadId, deliveryKey: delivery.deliveryKey, body: 'Reply.' },
        ],
        ['task_thread_resolve', { threadId, reason: 'Resolved.' }],
      ] as const) {
        expect(await call(name, args)).toMatchObject({
          isError: true,
          body: { success: false, code: 'no_task_binding' },
        });
      }
    }
    expect(e.stored(taskId, threadId).events).toHaveLength(2);
  });

  test('person send validates selection and transitions; Send + Resolve resolves after queuing', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const threadId = await e.createThread(taskId);
    const invalid = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/review/send`,
      { threadIds: [threadId, threadId], operationId: 'invalid', mode: 'send' },
    );
    expect(invalid.status).toBe(400);
    expect(e.stored(taskId, threadId).events).toHaveLength(1);
    const delivery = await e.send(taskId, threadId, 'send-and-resolve');
    expect(delivery).toMatchObject({
      status: 'queued',
      threads: [{ baseState: 'resolved' }],
    });
    expect(e.stored(taskId, threadId).events.at(-1)).toMatchObject({
      reason: 'sent-and-resolved',
    });
    const { call } = await e.connect(sessionId);
    expect(
      await call('task_thread_reply', {
        threadId,
        deliveryKey: delivery.deliveryKey,
        body: 'Acknowledged after automatic resolution.',
      }),
    ).toMatchObject({
      isError: false,
      body: { data: { thread: { baseState: 'resolved' } } },
    });
    const refused = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/review/send`,
      { threadIds: [threadId], operationId: 'again', mode: 'send' },
    );
    expect(refused).toMatchObject({
      status: 409,
      json: { code: 'invalid-transition' },
    });
  });
  test('agent thread filters use current plan freshness through the artifact owner', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const edit = async (desiredText: string) => {
      const planned = await e.asOperator(
        'POST',
        `/api/tasks/${taskId}/room/edit-plan`,
        {
          intentId: crypto.randomUUID(),
          desiredText,
          selection: { anchor: 0, focus: 0 },
        },
      );
      expect(planned.status, JSON.stringify(planned.json)).toBe(200);
      const committed = await e.asOperator(
        'POST',
        `/api/tasks/${taskId}/room/batches`,
        {
          intentId: planned.json.data.intentId,
          intentDigest: planned.json.data.digest,
        },
      );
      expect(committed.status, JSON.stringify(committed.json)).toBe(200);
    };
    await edit('Review this exact plan.');
    const current = await e.asOperator('GET', `/api/tasks/${taskId}/review`);
    const plan = current.json.data.items.find(
      (item: { kind: string }) => item.kind === 'plan',
    );
    const created = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/review/threads`,
      {
        artifact: plan.artifact,
        anchor: {
          kind: 'text-quote',
          start: 0,
          end: 22,
          exact: 'Review this exact plan',
          prefix: '',
          suffix: '.',
        },
        body: 'Clarify this.',
        operationId: 'freshness-thread',
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const threadId = created.json.data.thread.threadId;
    await e.send(taskId, threadId);
    const { call } = await e.connect(sessionId);
    expect(await call('task_thread_list', { state: 'open' })).toMatchObject({
      isError: false,
      body: {
        data: {
          threads: [{ threadId, outdated: false }],
        },
      },
    });
    await edit('A completely different replacement.');
    const outdated = await call('task_thread_list', { state: 'outdated' });
    expect(outdated).toMatchObject({
      isError: false,
      body: {
        data: {
          threads: [{ threadId, state: 'outdated', outdated: true }],
          counts: { open: 0, outdated: 1, resolved: 0 },
        },
      },
    });
    expect(await call('task_thread_list', { state: 'open' })).toMatchObject({
      isError: false,
      body: { data: { threads: [], counts: { outdated: 1 } } },
    });
  });
  test('a stale delivery cannot claim a newer follow-up while the current delivery can reply', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const threadId = await e.createThread(taskId);
    const first = await e.send(taskId, threadId);
    const followUp = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/review/threads/${threadId}/replies`,
      { body: 'Additional review.', operationId: 'follow-up' },
    );
    expect(followUp.status).toBe(200);
    expect(followUp.json.data.thread).toMatchObject({
      baseState: 'sent',
      pendingFollowUp: true,
    });
    const second = await e.send(taskId, threadId);
    expect(second.deliveryKey).not.toBe(first.deliveryKey);
    const { call } = await e.connect(sessionId);
    expect(
      await call('task_thread_reply', {
        threadId,
        deliveryKey: first.deliveryKey,
        body: 'Old delivery reply.',
      }),
    ).toMatchObject({ isError: true, body: { code: 'invalid-transition' } });
    expect(e.stored(taskId, threadId).events).toHaveLength(4);
    expect(
      await call('task_thread_reply', {
        threadId,
        deliveryKey: second.deliveryKey,
        body: 'Current delivery reply.',
      }),
    ).toMatchObject({
      isError: false,
      body: {
        data: {
          thread: { baseState: 'agent-replied', pendingFollowUp: false },
        },
      },
    });
  });
});
