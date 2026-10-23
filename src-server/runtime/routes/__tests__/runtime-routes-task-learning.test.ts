/**
 * #4003 layer 4 (Learning), end to end: a person closes a Task, its active
 * standing decisions and dead ends become candidates for the Project's
 * knowledge store, and the person promotes or dismisses each one.
 *
 * Real between the person and the store's files: the production runtime
 * composition (`configureRuntimeRoutes`: credential pipeline, the central
 * station-control authority guard, the room request principal, the learning,
 * Task, room memory and knowledge routes), the real `OrchestrationService`
 * over a real SQLite event store (Task memory and dismissals), the real
 * `TaskGraphService`, the real room runtime, a real `KnowledgeStoreProvider`
 * with the Kit default-file adapter writing under the test home, and the
 * real sqlite-vec index searched through `/api/knowledge/index/search`.
 *
 * Stand-ins: the root registry's persistence is in memory, the embedder is
 * a deterministic stub, and the dispatch uses the seeded `task-dispatch`
 * provider (no engine), with the room execution binding written by the same
 * store method a provider start uses.
 */

import { mkdirSync, realpathSync, renameSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, sep } from 'node:path';
import { serve } from '@hono/node-server';
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { composeTaskDispatcher } from '../../../services/projects/task-dispatch-composition.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-task-learning';
const PROJECT = 'project-alpha';
const AT = '2026-10-04T00:00:00.000Z';
const makeTempDir = trackTempDirs();

/**
 * Whether the native realpath returns the on-disk case for another spelling:
 * decided by trying, not by OS. A case-insensitive volume is not enough
 * (Linux casefold mounts answer with the case given), so ask realpath itself.
 */
function realpathFoldsCase(): boolean {
  const probe = makeTempDir('station-case-probe-');
  mkdirSync(join(probe, 'CaseProbe'));
  try {
    return realpathSync
      .native(join(probe, 'caseprobe'))
      .endsWith(`${sep}CaseProbe`);
  } catch {
    return false;
  }
}

/** The root registry's persistence, kept in memory (the shape the file
 * storage adapter implements). */
class MemoryRootPersistence {
  private roots: KnowledgeStoreRoot[] = [];
  listKnowledgeStoreRoots() {
    return this.roots.slice();
  }
  saveKnowledgeStoreRoot(root: KnowledgeStoreRoot) {
    this.roots = [...this.roots.filter((r) => r.id !== root.id), root];
  }
  removeKnowledgeStoreRoot(id: string) {
    this.roots = this.roots.filter((r) => r.id !== id);
  }
}

/** Deterministic vectors: a word's presence sets its own dimension. */
class StubEmbedder implements IEmbeddingProvider {
  readonly id = 'stub-embedder';
  readonly displayName = 'Deterministic stub embedder';
  dimensions() {
    return 8;
  }
  embeddingIdentity() {
    return 'stub-embedder:model=task-learning';
  }
  async embed(texts: string[]) {
    const words = ['sqlite', 'postgres', 'retry', 'backoff', 'cache'];
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const vector = words.map((w) => (lower.includes(w) ? 1 : 0));
      return [...vector, 0.01, 0.01, 0.01];
    });
  }
}

describe("a done Task's lessons are promoted by a person, never by an agent", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
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
      throw new AggregateError(failures, 'Task learning teardown failed');
  });

  async function setup() {
    const homeDir = makeTempDir('station-task-learning-');
    const notifications = new NotificationService(
      new EventBus(),
      homeDir,
      999_999,
    );
    closers.push(() => notifications.shutdown());
    support.notificationService = notifications;
    __resetStationServerSelfAttestationForTests();

    const store = new EventStore(join(homeDir, 'orchestration.sqlite'));
    const knowledge = new KnowledgeStoreProvider(new MemoryRootPersistence());
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
    // The runtime's logger, which the Learning routes must reach (round 7).
    const runtimeLogger = {
      debug() {},
      info() {},
      warn: vi.fn(),
      error() {},
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
      knowledgeStoreProvider: knowledge,
      resolveEmbeddingProvider: () => new StubEmbedder(),
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
      return async (
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
    };

    /** A Task dispatched to an agent: the lead Session, bound to the room. */
    const dispatchedTask = async () => {
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
        sourceSurface: 'task-learning-test',
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

    /** A station-control tool's request, as an agent's call reaches Station. */
    const asAgent = async (
      sessionId: string,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
          'x-station-control-caller-token': mintStationControlMcpToken(
            sessionId,
            'sdk-in-process',
          ).token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: await response.json() };
    };

    const learning = async (taskId: string) => {
      const read = await asOperator(
        'GET',
        `/api/tasks/${taskId}/room/memory/learning`,
      );
      expect(read.status, JSON.stringify(read.json)).toBe(200);
      return read.json.data;
    };

    const createProjectStore = async (storeRoot?: string) => {
      const created = await asOperator('POST', '/api/knowledge/roots', {
        scope: { kind: 'project', projectSlug: PROJECT },
        expectedProjectId: projectService.getProject(PROJECT).id,
        adapterId: 'kit-default-store',
        ...(storeRoot ? { storeRoot } : {}),
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      return created.json.data as KnowledgeStoreRoot;
    };

    /** A done Task with a decision an agent recorded and a dead end a
     * person recorded, both standing, plus an on-topic decision. */
    const closedTaskWithLessons = async () => {
      const { taskId, sessionId } = await dispatchedTask();
      const tool = await connect(sessionId);
      const decision = await tool('task_record', {
        kind: 'decision',
        key: 'storage-engine',
        text: 'Use SQLite for the queue; postgres is not available on device.',
      });
      expect(decision.isError, JSON.stringify(decision.body)).toBe(false);
      const deadEnd = await asOperator(
        'POST',
        `/api/tasks/${taskId}/room/memory/records`,
        {
          kind: 'dead_end',
          key: 'naive-retry',
          text: 'Retrying without backoff floods the provider.',
        },
      );
      expect(deadEnd.status, JSON.stringify(deadEnd.json)).toBe(200);
      const narrow = await tool('task_record', {
        kind: 'decision',
        key: 'log-format',
        importance: 'on_topic',
        text: 'Logs are JSON lines.',
      });
      expect(narrow.isError).toBe(false);
      // A person moves the Task through its lifecycle to done.
      const started = await asOperator('PATCH', `/api/tasks/${taskId}/status`, {
        status: 'in_progress',
      });
      expect(started.status, JSON.stringify(started.json)).toBe(200);
      const done = await asOperator('PATCH', `/api/tasks/${taskId}/status`, {
        status: 'done',
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return { taskId, sessionId };
    };

    return {
      store,
      runtimeLogger,
      knowledge,
      taskGraph,
      asOperator,
      asAgent,
      connect,
      dispatchedTask,
      learning,
      createProjectStore,
      closedTaskWithLessons,
    };
  }

  test('a Task offers nothing until it is done; then its active standing decisions and dead ends', async () => {
    const e = await setup();
    const { taskId } = await e.dispatchedTask();
    const before = await e.learning(taskId);
    expect(before).toMatchObject({
      version: 'station.task-learning/v1',
      taskId,
      offered: false,
      candidates: [],
    });

    const closed = await e.closedTaskWithLessons();
    const view = await e.learning(closed.taskId);
    expect(view.offered).toBe(true);
    // The on-topic decision is not a candidate; the standing two are.
    expect(
      view.candidates.map((c: any) => [
        c.record.kind,
        c.record.key,
        c.record.version,
        c.review.state,
      ]),
    ).toEqual([
      ['decision', 'storage-engine', 1, 'open'],
      ['dead_end', 'naive-retry', 1, 'open'],
    ]);
  });

  test('a Project with no knowledge store says so, and promotion is refused without writing', async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const view = await e.learning(taskId);
    expect(view.stores).toEqual([]);
    expect(view.projectSlug).toBe(PROJECT);
    expect(view.candidates).toHaveLength(2);

    const refused = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      {
        kind: 'decision',
        key: 'storage-engine',
        version: 1,
        rootId: `root:project-${PROJECT}`,
        title: 'Storage engine',
        text: 'Use SQLite.',
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('task_learning_no_store');
    expect(await e.knowledge.listRoots()).toEqual([]);
  });

  test('promote writes one knowledge record with provenance that search finds, and promoting the same version again writes nothing', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.closedTaskWithLessons();
    const root = await e.createProjectStore();
    const view = await e.learning(taskId);
    expect(view.stores).toEqual([
      { rootId: root.id, displayName: root.displayName },
    ]);
    const candidate = view.candidates[0];

    const promotion = {
      kind: 'decision',
      key: 'storage-engine',
      version: 1,
      rootId: root.id,
      title: 'Queue storage engine',
      // The person's edit, not the Task's text.
      text: 'The queue stores in SQLite: postgres is not available on devices.',
    };
    const first = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      promotion,
    );
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.data.status).toBe('promoted');

    const adapter = await e.knowledge.adapterFor(root.id);
    const written = await adapter.get(candidate.knowledgeRecordId);
    const task = e.taskGraph.readTask(taskId)!;
    expect(written).toMatchObject({
      id: candidate.knowledgeRecordId,
      type: 'raw',
      title: 'Queue storage engine',
      body: promotion.text,
      category: 'task-learning.decisions',
      tags: ['task-learning', 'decision'],
      provenance: {
        agent: 'station-task-learning',
        // The Session that made the decision.
        session_id: sessionId,
      },
    });
    const note = written?.provenance.note ?? '';
    expect(note).toContain(`Promoted by ${LOCAL_OPERATOR_PRINCIPAL_ID}`);
    expect(note).toContain(`task: ${taskId}`);
    expect(note).toContain(`task created: ${task.createdAt}`);
    expect(note).toContain('record: decision/storage-engine v1');

    // The candidate now reads as promoted, from the store itself.
    const after = await e.learning(taskId);
    expect(after.candidates[0].review).toEqual({
      state: 'promoted',
      rootId: root.id,
      knowledgeRecordId: candidate.knowledgeRecordId,
    });

    // The same version again, even with other text: nothing new is written.
    const again = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      { ...promotion, title: 'Another title', text: 'Different text.' },
    );
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.data.status).toBe('already-promoted');
    const raw = await adapter.listByType('raw');
    expect(raw.map((r) => r.id)).toEqual([candidate.knowledgeRecordId]);
    expect((await adapter.get(candidate.knowledgeRecordId))?.body).toBe(
      promotion.text,
    );

    // Searching the Project store finds it once the index is rebuilt.
    const rebuilt = await e.asOperator('POST', '/api/knowledge/index/rebuild', {
      rootId: root.id,
    });
    expect(rebuilt.status, JSON.stringify(rebuilt.json)).toBe(200);
    const search = await e.asOperator('POST', '/api/knowledge/index/search', {
      query: 'which sqlite storage',
      rootIds: [root.id],
      topK: 3,
    });
    expect(search.status, JSON.stringify(search.json)).toBe(200);
    expect(search.json.data.map((hit: any) => hit.recordId)).toContain(
      candidate.knowledgeRecordId,
    );
  });

  test('a version that is no longer current, or blank text, is refused', async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const root = await e.createProjectStore();
    const refused = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      {
        kind: 'decision',
        key: 'storage-engine',
        version: 2,
        rootId: root.id,
        title: 'Storage',
        text: 'Use SQLite.',
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('task_learning_not_a_candidate');
    // Blank text is refused with a sentence, before any write.
    const blank = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      {
        kind: 'decision',
        key: 'storage-engine',
        version: 1,
        rootId: root.id,
        title: 'Storage',
        text: '   ',
      },
    );
    expect(blank.status).toBe(400);
    expect(blank.json).toMatchObject({
      code: 'task_learning_invalid',
      error: 'The text must be 1 to 4000 characters. Nothing was written.',
    });
    expect(
      await (await e.knowledge.adapterFor(root.id)).listByType('raw'),
    ).toEqual([]);
  });

  test('a dismissal is persisted: the candidate is not offered again and cannot be promoted', async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const root = await e.createProjectStore();
    const dismissal = { kind: 'dead_end', key: 'naive-retry', version: 1 };
    const dismissed = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/dismiss`,
      dismissal,
    );
    expect(dismissed.status, JSON.stringify(dismissed.json)).toBe(200);
    expect(dismissed.json.data.status).toBe('dismissed');

    const view = await e.learning(taskId);
    expect(
      view.candidates.map((c: any) => [c.record.key, c.review.state]),
    ).toEqual([
      ['storage-engine', 'open'],
      ['naive-retry', 'dismissed'],
    ]);
    expect(view.candidates[1].review.dismissedBy).toBe(
      LOCAL_OPERATOR_PRINCIPAL_ID,
    );
    // Held in the orchestration database, not in this process.
    const task = e.taskGraph.readTask(taskId)!;
    expect(
      e.store.taskMemoryStore().listLearningDismissals({
        taskId,
        taskCreatedAt: task.createdAt,
      }),
    ).toMatchObject([dismissal]);

    const again = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/dismiss`,
      dismissal,
    );
    expect(again.json.data.status).toBe('already-dismissed');

    const promote = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      {
        ...dismissal,
        rootId: root.id,
        title: 'Retry',
        text: 'Back off.',
      },
    );
    expect(promote.status).toBe(409);
    expect(promote.json.code).toBe('task_learning_dismissed');
    expect(
      await (await e.knowledge.adapterFor(root.id)).listByType('raw'),
    ).toEqual([]);
  });

  const DECISION = { kind: 'decision', key: 'storage-engine', version: 1 };
  const promotionBody = (rootId: string) => ({
    ...DECISION,
    rootId,
    title: 'Queue storage engine',
    text: 'The queue stores in SQLite.',
  });
  const reviewOf = async (
    e: Awaited<ReturnType<typeof setup>>,
    taskId: string,
  ) =>
    (await e.learning(taskId)).candidates.find(
      (candidate: any) => candidate.record.key === 'storage-engine',
    ).review;

  test('the store registered again under another spelling of its directory reads as promoted, as promote answers (review round 6)', async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const directory = join(makeTempDir('task-learning-store-'), 'store');
    mkdirSync(directory);
    const first = await e.createProjectStore(directory);
    expect(
      (
        await e.asOperator(
          'POST',
          `/api/tasks/${taskId}/room/memory/learning/promote`,
          promotionBody(first.id),
        )
      ).status,
    ).toBe(201);
    // Removed, then registered again as its real path with a trailing '/'
    // (the temp directory sits under a symlinked ancestor, `/var` on macOS,
    // so the spelling differs). The kit store refuses a root that is itself
    // a symlink, so that case is pinned on storeIdentity alone.
    expect(
      (await e.asOperator('DELETE', `/api/knowledge/roots/${first.id}`)).status,
    ).toBe(200);
    const again = await e.createProjectStore(`${realpathSync(directory)}/`);
    expect(await reviewOf(e, taskId)).toMatchObject({
      state: 'promoted',
      rootId: again.id,
    });
    const repeat = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      promotionBody(again.id),
    );
    expect([repeat.status, repeat.json.data.status]).toEqual([
      200,
      'already-promoted',
    ]);
  });

  test('a pending promotion whose store is registered under another spelling can still be finished there (review round 6)', async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const task = e.taskGraph.readTask(taskId)!;
    const directory = join(makeTempDir('task-learning-store-'), 'store');
    mkdirSync(directory);
    // The promotion recorded this directory, then its write never ran.
    e.store.taskMemoryStore().claimLearningPromotion({
      taskId,
      taskCreatedAt: task.createdAt,
      ...(DECISION as { kind: 'decision'; key: string; version: number }),
      projectId: task.projectId,
      rootId: 'root:project-alpha',
      adapterId: 'kit-default-store',
      storeRoot: directory,
      principalId: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
    // The Project's store is that directory, spelled with './'.
    const store = await e.createProjectStore(join(directory, '.', '.') + '/./');
    expect(await reviewOf(e, taskId)).toEqual({
      state: 'pending',
      rootId: store.id,
    });
    const finished = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      promotionBody(store.id),
    );
    expect([finished.status, finished.json.data?.status]).toEqual([
      201,
      'promoted',
    ]);
    expect(await reviewOf(e, taskId)).toMatchObject({ state: 'promoted' });
  });

  test('promoting a version whose recorded store is gone is 409 task_learning_store_gone, and nothing is written (review round 6)', async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const task = e.taskGraph.readTask(taskId)!;
    e.store.taskMemoryStore().claimLearningPromotion({
      taskId,
      taskCreatedAt: task.createdAt,
      ...(DECISION as { kind: 'decision'; key: string; version: number }),
      projectId: task.projectId,
      rootId: 'root:project-alpha',
      adapterId: 'kit-default-store',
      storeRoot: join(makeTempDir('task-learning-gone-'), 'removed'),
      principalId: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
    const current = await e.createProjectStore();
    expect(await reviewOf(e, taskId)).toEqual({
      state: 'promotion-store-gone',
      rootId: 'root:project-alpha',
    });
    const refused = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      promotionBody(current.id),
    );
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      success: false,
      code: 'task_learning_store_gone',
    });
    const adapter = await e.knowledge.adapterFor(current.id);
    expect(await adapter.listByType('raw')).toEqual([]);
  });

  test('a pending promotion whose store is registered in another letter case is the same store when the native realpath folds case (review round 7)', async (context) => {
    if (!realpathFoldsCase())
      context.skip(
        'the native realpath keeps the case it is given here, so the two spellings are two directories or two identities',
      );
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const task = e.taskGraph.readTask(taskId)!;
    const directory = join(makeTempDir('task-learning-case-'), 'Store');
    mkdirSync(directory);
    e.store.taskMemoryStore().claimLearningPromotion({
      taskId,
      taskCreatedAt: task.createdAt,
      ...(DECISION as { kind: 'decision'; key: string; version: number }),
      projectId: task.projectId,
      rootId: 'root:project-alpha',
      adapterId: 'kit-default-store',
      storeRoot: directory,
      principalId: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
    const store = await e.createProjectStore(join(directory, '..', 'store'));
    expect(await reviewOf(e, taskId)).toEqual({
      state: 'pending',
      rootId: store.id,
    });
    const finished = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      promotionBody(store.id),
    );
    expect(finished.status, JSON.stringify(finished.json)).toBe(201);
  });

  test('a store whose directory moved, registered at its new path, still reads promoted, as promote answers (review round 7)', async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const parent = makeTempDir('task-learning-move-');
    const before = join(parent, 'before');
    mkdirSync(before);
    const first = await e.createProjectStore(before);
    expect(
      (
        await e.asOperator(
          'POST',
          `/api/tasks/${taskId}/room/memory/learning/promote`,
          promotionBody(first.id),
        )
      ).status,
    ).toBe(201);
    expect(
      (await e.asOperator('DELETE', `/api/knowledge/roots/${first.id}`)).status,
    ).toBe(200);
    const after = join(parent, 'after');
    renameSync(before, after);
    const moved = await e.createProjectStore(after);
    expect(await reviewOf(e, taskId)).toMatchObject({
      state: 'promoted',
      rootId: moved.id,
    });
    const repeat = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      promotionBody(moved.id),
    );
    expect([repeat.status, repeat.json.data?.status]).toEqual([
      200,
      'already-promoted',
    ]);
  });

  test("a record a person made under a candidate's id is not its promotion (review round 7)", async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const root = await e.createProjectStore();
    const view = await e.learning(taskId);
    const candidate = view.candidates.find(
      (c: any) => c.record.key === 'storage-engine',
    );
    const adapter = await e.knowledge.adapterFor(root.id);
    await adapter.create({
      id: candidate.knowledgeRecordId,
      type: 'raw',
      title: 'Forged',
      body: 'Not what the Task decided.',
      category: 'task-learning.decisions',
      tags: ['task-learning', 'decision'],
      provenance: { agent: 'a-person', note: `task: ${taskId}` },
    } as never);
    expect(await reviewOf(e, taskId)).toEqual({ state: 'open' });
    const promoted = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      promotionBody(root.id),
    );
    // Not 'already-promoted' with the forged content: the id is taken by a
    // record Task Learning did not write, and the answer says so (round 8).
    expect(promoted.status).toBe(409);
    expect(promoted.json).toMatchObject({
      success: false,
      code: 'task_learning_id_taken',
      error: `A record not written by Task Learning already uses the id ${candidate.knowledgeRecordId}. Remove it from the store, or remove the store. Nothing was written.`,
    });
    expect(JSON.stringify(promoted.json)).not.toContain('Not what the Task');
  });

  test('a person cannot create a record as Task Learning through the records route, so a candidate stays open (review round 8)', async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    const root = await e.createProjectStore();
    const candidate = (await e.learning(taskId)).candidates.find(
      (c: any) => c.record.key === 'storage-engine',
    );
    const forged = await e.asOperator(
      'POST',
      `/api/knowledge/roots/${root.id}/records`,
      {
        id: candidate.knowledgeRecordId,
        type: 'raw',
        title: 'Forged',
        body: 'Not what the Task decided.',
        category: 'task-learning.decisions',
        provenance: {
          agent: 'station-task-learning',
          note: `task: ${taskId}`,
        },
      },
    );
    expect(forged.status).toBe(400);
    expect(forged.json.error).toBe(
      'provenance.agent "station-task-learning" is reserved for Station\'s Task Learning.',
    );
    expect(await reviewOf(e, taskId)).toEqual({ state: 'open' });
    const adapter = await e.knowledge.adapterFor(root.id);
    expect(await adapter.listByType('raw')).toEqual([]);
  });

  test("a Learning route failure reaches the runtime's logger (review round 7)", async () => {
    const e = await setup();
    const { taskId } = await e.closedTaskWithLessons();
    vi.spyOn(e.knowledge, 'listRoots').mockRejectedValueOnce(
      Object.assign(new Error('roots unreadable'), { code: 'EIO' }),
    );
    const read = await e.asOperator(
      'GET',
      `/api/tasks/${taskId}/room/memory/learning`,
    );
    expect(read.status).toBe(503);
    expect(e.runtimeLogger.warn).toHaveBeenCalledWith(
      'task learning request failed',
      expect.objectContaining({
        operation: 'read',
        errorName: 'Error',
        code: 'EIO',
      }),
    );
  });

  test("an agent's station-control request to every learning route is refused before it runs", async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.closedTaskWithLessons();
    const root = await e.createProjectStore();
    const promotion = {
      kind: 'decision',
      key: 'storage-engine',
      version: 1,
      rootId: root.id,
      title: 'Storage',
      text: 'Use SQLite.',
    };
    const attempts = [
      await e.asAgent(
        sessionId,
        'GET',
        `/api/tasks/${taskId}/room/memory/learning`,
      ),
      await e.asAgent(
        sessionId,
        'POST',
        `/api/tasks/${taskId}/room/memory/learning/promote`,
        promotion,
      ),
      await e.asAgent(
        sessionId,
        'POST',
        `/api/tasks/${taskId}/room/memory/learning/dismiss`,
        { kind: 'decision', key: 'storage-engine', version: 1 },
      ),
    ];
    for (const attempt of attempts) {
      expect(attempt.status, JSON.stringify(attempt.json)).toBe(403);
      expect(attempt.json).toMatchObject({
        code: 'station_control_route_unmapped',
      });
    }
    // Nothing was written by any of them.
    expect(
      await (await e.knowledge.adapterFor(root.id)).listByType('raw'),
    ).toEqual([]);
    const view = await e.learning(taskId);
    expect(view.candidates.map((c: any) => c.review.state)).toEqual([
      'open',
      'open',
    ]);
    // The same request from the person goes through.
    const person = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/learning/promote`,
      promotion,
    );
    expect(person.status, JSON.stringify(person.json)).toBe(201);
  });
});
