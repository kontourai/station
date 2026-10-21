/**
 * #4003, end to end: an engine's `task_summary_update` and `task_record`
 * calls reach its Task's memory, a person's Task workspace routes read and
 * edit it under the same rules, `get_task_brief` composes the brief from it
 * and the Sessions' recorded facts, and an open question reaches the Tasks
 * list that Home and the inbox derive "Needs you" from.
 *
 * Real between the engine and the log: the engine's own station-control MCP
 * connection (`/mcp/station-control` with the URL token a Codex session is
 * given), the tools, the production runtime composition
 * (`configureRuntimeRoutes`: credential pipeline, authority guard, caller and
 * scope derivation, the task-memory, task-brief and tasks routes), the real
 * `OrchestrationService` over a real SQLite event store (its Task memory),
 * the real `TaskGraphService` and Task dispatcher, the real room runtime, and
 * the person's own room memory and document routes.
 *
 * One stand-in: the dispatch uses the seeded `task-dispatch` provider, which
 * starts no engine, so the room execution binding a provider start writes
 * (`OrchestrationService` start admission -> `bindProjectTaskRoomExecution`)
 * is written here with that same store method.
 */
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
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
import { taskQuestionWakeKey } from '../../../services/orchestration/task-question-wake.js';
import { composeTaskDispatcher } from '../../../services/projects/task-dispatch-composition.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-task-memory-engine';
const PROJECT = 'project-alpha';
const AT = '2026-10-04T00:00:00.000Z';
const makeTempDir = trackTempDirs();

describe('an engine keeps Task memory through its own MCP connection', () => {
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
      throw new AggregateError(failures, 'Task memory teardown failed');
  });

  async function setup() {
    const homeDir = makeTempDir('station-task-memory-engine-');
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
        sourceSurface: 'task-memory-engine-test',
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

    const documentText = async (taskId: string) => {
      const read = await asOperator(
        'GET',
        `/api/tasks/${taskId}/room/document`,
      );
      expect(read.status, JSON.stringify(read.json)).toBe(200);
      return read.json.data.text as string;
    };

    /** Task memory as the person's Task workspace reads it. */
    const memory = async (taskId: string) => {
      const read = await asOperator('GET', `/api/tasks/${taskId}/room/memory`);
      expect(read.status, JSON.stringify(read.json)).toBe(200);
      expect(read.json.data).toMatchObject({
        version: 'station.task-memory/v1',
        taskId,
      });
      return read.json.data as {
        summary?: Record<string, any>;
        records: Array<Record<string, any>>;
      };
    };

    /** Task memory as the store itself holds it. */
    const stored = (taskId: string) => {
      const task = taskGraph.readTask(taskId)!;
      const incarnation = { taskId, taskCreatedAt: task.createdAt };
      return {
        summary: store.taskMemoryStore().readSummary(incarnation),
        records: store.taskMemoryStore().listRecords(incarnation),
      };
    };

    let tick = 0;
    /** One recorded turn, as an engine's events record it. */
    const recordTurn = (threadId: string, prompt: string) => {
      tick += 1;
      const turnId = `${threadId}-turn-${tick}`;
      const at = new Date(Date.UTC(2026, 9, 21, 0, 0, tick)).toISOString();
      const base = { threadId, turnId, provider: 'codex' } as const;
      store.appendEvent({
        ...base,
        eventId: `${turnId}:start`,
        method: 'turn.started',
        createdAt: at,
        prompt,
      } as never);
      store.appendEvent({
        ...base,
        eventId: `${turnId}:done`,
        method: 'turn.completed',
        createdAt: at,
        finishReason: 'stop',
        outputText: 'done',
      } as never);
    };

    /** A second Session bound to the Task's room that is not its lead. */
    const strangerOf = async (taskId: string) => {
      const stranger = 'codex-stranger-session';
      orchestration.seedSessionRecord({
        threadId: stranger,
        provider: 'task-dispatch',
        status: 'ready',
        ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
      } as never);
      expect(
        await store.bindProjectTaskRoomExecution({
          projectId: PROJECT,
          taskId,
          sessionId: stranger,
        }),
      ).toEqual({ kind: 'bound' });
      return stranger;
    };

    return {
      store,
      orchestration,
      taskGraph,
      asOperator,
      connect,
      dispatchedTask,
      documentText,
      memory,
      stored,
      recordTurn,
      strangerOf,
    };
  }

  test('the summary: write, stale-base refusal with the current text, over-cap refusal, and a person edit', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const statusBefore = e.taskGraph.readTask(taskId)?.status;
    const call = await e.connect(sessionId);

    const first = await call('task_summary_update', {
      text: 'Now: parser fixed.\nNext: tests.',
      baseRevision: 0,
    });
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    expect(first.body).toMatchObject({
      status: 'updated',
      taskId,
      summary: {
        revision: 1,
        text: 'Now: parser fixed.\nNext: tests.',
        author: { kind: 'session', sessionId },
      },
    });

    // A person edits from the Task workspace on revision 1.
    const person = await e.asOperator(
      'PUT',
      `/api/tasks/${taskId}/room/memory/summary`,
      { text: 'Person: ship Friday.', baseRevision: 1 },
    );
    expect(person.status, JSON.stringify(person.json)).toBe(200);
    expect(person.json.data).toMatchObject({
      revision: 2,
      author: { kind: 'person', principalId: LOCAL_OPERATOR_PRINCIPAL_ID },
    });

    // The agent still holds revision 1: refused, handed the current text.
    const stale = await call('task_summary_update', {
      text: 'Agent: my older view.',
      baseRevision: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.body).toMatchObject({
      success: false,
      code: 'task_summary_stale_base',
      current: { revision: 2, text: 'Person: ship Friday.' },
    });
    expect(stale.body.error).toContain('baseRevision 2');

    const tooLong = await call('task_summary_update', {
      text: 'x'.repeat(4001),
      baseRevision: 2,
    });
    expect(tooLong).toMatchObject({
      isError: true,
      body: { success: false, code: 'task_summary_too_long' },
    });
    expect(tooLong.body.error).toContain('prune it');

    // A person's over-cap write is the same refusal.
    const personTooLong = await e.asOperator(
      'PUT',
      `/api/tasks/${taskId}/room/memory/summary`,
      { text: 'p'.repeat(4001), baseRevision: 2 },
    );
    expect(personTooLong.status).toBe(400);
    expect(personTooLong.json.code).toBe('task_summary_too_long');

    // Read back through the person's route and the store: revision 2 stands.
    expect((await e.memory(taskId)).summary).toMatchObject({
      revision: 2,
      text: 'Person: ship Friday.',
    });
    expect(e.stored(taskId).summary?.revision).toBe(2);
    const history = await e.asOperator(
      'GET',
      `/api/tasks/${taskId}/room/memory/summary/revisions?limit=5`,
    );
    expect(
      history.json.data.revisions.map((revision: any) => revision.revision),
    ).toEqual([2, 1]);
    // Memory never writes the document or the Task status.
    expect(await e.documentText(taskId)).toBe('');
    expect(e.taskGraph.readTask(taskId)?.status).toBe(statusBefore);
  });

  test('records: set, supersede, answer, retire, cap refusal and invalid-key refusal', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const statusBefore = e.taskGraph.readTask(taskId)?.status;
    const call = await e.connect(sessionId);
    const record = (args: Record<string, unknown>) => call('task_record', args);

    expect(
      (await record({ kind: 'decision', key: 'storage', text: 'Use JSON.' }))
        .body,
    ).toMatchObject({
      status: 'recorded',
      record: { key: 'storage', version: 1, importance: 'standing' },
    });
    expect(
      (await record({ kind: 'decision', key: 'storage', text: 'Use SQLite.' }))
        .body,
    ).toMatchObject({ record: { version: 2, text: 'Use SQLite.' } });
    await record({ kind: 'question', key: 'scope', text: 'CLI too?' });
    expect(
      (
        await record({
          kind: 'question',
          key: 'scope',
          action: 'answer',
          text: 'No.',
        })
      ).body,
    ).toMatchObject({ record: { state: 'answered', answer: 'No.' } });
    await record({ kind: 'dead_end', key: 'regex', text: 'Cannot nest.' });
    expect(
      (
        await record({
          kind: 'dead_end',
          key: 'regex',
          action: 'retire',
          reason: 'Nesting dropped.',
        })
      ).body,
    ).toMatchObject({
      record: { state: 'retired', reason: 'Nesting dropped.' },
    });

    const invalid = await record({
      kind: 'decision',
      key: 'Not A Slug',
      text: 'x',
    });
    expect(invalid).toMatchObject({
      isError: true,
      body: { success: false, code: 'task_record_key_invalid' },
    });

    // Fill the decision cap: 1 live already, 38 through the store, 1 by the
    // engine, and the next new key is refused.
    const task = e.taskGraph.readTask(taskId)!;
    for (let i = 0; i < 38; i += 1)
      e.store.taskMemoryStore().writeRecord({
        projectId: PROJECT,
        taskId,
        taskCreatedAt: task.createdAt,
        author: { kind: 'person', principalId: LOCAL_OPERATOR_PRINCIPAL_ID },
        write: { kind: 'decision', key: `filler-${i}`, text: 'Filler.' },
      });
    expect(
      (await record({ kind: 'decision', key: 'last', text: 'The 40th.' })).body,
    ).toMatchObject({ status: 'recorded' });
    const full = await record({ kind: 'decision', key: 'one-more', text: 'x' });
    expect(full).toMatchObject({
      isError: true,
      body: { success: false, code: 'task_record_cap_reached' },
    });
    expect(full.body.error).toContain('supersede or retire one');
    // Superseding at the cap still works.
    expect(
      (await record({ kind: 'decision', key: 'last', text: 'Revised.' })).body,
    ).toMatchObject({ record: { version: 2 } });

    // Read back through the person's route and the store.
    const read = await e.memory(taskId);
    const byKey = new Map(read.records.map((r) => [`${r.kind}:${r.key}`, r]));
    expect(byKey.get('decision:storage')).toMatchObject({
      version: 2,
      state: 'active',
    });
    expect(byKey.get('question:scope')).toMatchObject({ state: 'answered' });
    expect(byKey.get('dead_end:regex')).toMatchObject({ state: 'retired' });
    expect(byKey.has('decision:one-more')).toBe(false);
    expect(byKey.has('decision:not-a-slug')).toBe(false);
    expect(e.stored(taskId).records).toEqual(read.records);
    expect(e.taskGraph.readTask(taskId)?.status).toBe(statusBefore);
  });

  test('a session without a Task binding, or bound but not the lead, is refused as a tool error and writes nothing', async () => {
    const e = await setup();
    const { taskId } = await e.dispatchedTask();
    // A session Station knows, owned by the operator, that no Task started.
    const loose = 'codex-loose-session';
    e.orchestration.seedSessionRecord({
      threadId: loose,
      provider: 'task-dispatch',
      status: 'ready',
      ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
    } as never);
    expect(e.store.readProjectTaskRoomExecutionBinding(loose)).toBeUndefined();
    const stranger = await e.strangerOf(taskId);
    for (const sessionId of [loose, stranger]) {
      const call = await e.connect(sessionId);
      for (const [name, args] of [
        ['task_summary_update', { text: 'Mine.', baseRevision: 0 }],
        ['task_record', { kind: 'decision', key: 'mine', text: 'Mine.' }],
      ] as const)
        expect(await call(name, args)).toEqual({
          isError: true,
          body: {
            success: false,
            code: 'no_task_binding',
            error:
              'This session is not working on a Task, so there is no Task memory to write.',
          },
        });
    }
    expect(e.stored(taskId)).toEqual({ summary: undefined, records: [] });
  });

  test('get_task_brief composes Task, summary, tiers, Session digests and omissions; include lists the rest', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const call = await e.connect(sessionId);
    await call('task_summary_update', { text: 'First.', baseRevision: 0 });
    await call('task_summary_update', {
      text: 'Now: tests pass.',
      baseRevision: 1,
    });
    await call('task_record', {
      kind: 'decision',
      key: 'storage',
      text: 'Use SQLite.',
    });
    await call('task_record', {
      kind: 'decision',
      key: 'narrow',
      text: 'Only for the CLI.',
      importance: 'on_topic',
    });
    await call('task_record', {
      kind: 'question',
      key: 'scope',
      text: 'CLI too?',
    });
    await call('task_record', {
      kind: 'dead_end',
      key: 'regex',
      text: 'Cannot nest.',
    });
    e.recordTurn(sessionId, 'Fix the parser\nwith detail');

    const brief = await call('get_task_brief');
    expect(brief.isError, JSON.stringify(brief.body)).toBe(false);
    const text = brief.body as string;
    expect(text).toMatch(
      /## Task summary \(revision 2, by session [^)]+\)\nNow: tests pass\.\n/,
    );
    expect(text).toContain(
      '## Standing decisions (newest first)\n- `storage`: Use SQLite.\n',
    );
    expect(text).toContain(
      `## Open questions for a person (newest first)\n- \`scope\`: CLI too? (asked by session ${sessionId})\n`,
    );
    expect(text).toContain(
      '## Recent dead ends (newest first)\n- `regex`: Cannot nest.\n',
    );
    expect(text).not.toContain('Only for the CLI.');
    expect(text).toContain('- On-topic records, counted only: 1 decision;');
    expect(text).toContain(
      '- 1 earlier summary revision; call `get_task_brief` with `include: "summary_history"`.',
    );
    // The Session line is the digest of its recorded turn.
    expect(text).toContain(`- ${sessionId} (task-dispatch, this session): `);
    expect(text).toContain('1 turn; last turn completed: "Fix the parser"');

    const records = await call('get_task_brief', { include: 'all_records' });
    expect(records.isError).toBe(false);
    expect(records.body as string).toContain(
      '- `narrow` (on_topic, version 1, active',
    );
    const history = await call('get_task_brief', {
      include: 'summary_history',
    });
    expect(history.body as string).toContain('The newest 2 of 2 revisions');
    expect(history.body as string).toContain('First.');
    expect(taskId).toBeTruthy();
  });

  test("an open question puts the Task's openQuestionCount on the Tasks list until it is answered", async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const listed = async () =>
      (
        (await e.asOperator('GET', `/api/tasks?projectId=${PROJECT}`)).json
          .data as Array<Record<string, any>>
      ).find((task) => task.id === taskId);
    expect((await listed())?.openQuestionCount).toBeUndefined();
    const call = await e.connect(sessionId);
    await call('task_record', {
      kind: 'question',
      key: 'scope',
      text: 'CLI too?',
    });
    expect((await listed())?.openQuestionCount).toBe(1);
    // A person answers from the Task workspace.
    const answered = await e.asOperator(
      'POST',
      `/api/tasks/${taskId}/room/memory/records`,
      { kind: 'question', key: 'scope', action: 'answer', text: 'No.' },
    );
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    expect(answered.json.data).toMatchObject({
      state: 'answered',
      author: { kind: 'person', principalId: LOCAL_OPERATOR_PRINCIPAL_ID },
    });
    expect((await listed())?.openQuestionCount).toBeUndefined();
  });

  test("the production composition wakes the lead's conversation inbox with a person's answer, once", async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const call = await e.connect(sessionId);
    await call('task_record', {
      kind: 'question',
      key: 'scope',
      text: 'CLI too?',
    });
    const conversation =
      e.store.conversationForSession(sessionId)?.conversationId ?? sessionId;
    const inbox = () => e.store.threadInboxStore().list(conversation);
    // The lead's own question wakes no one.
    expect(inbox()).toEqual([]);
    const answer = () =>
      e.asOperator('POST', `/api/tasks/${taskId}/room/memory/records`, {
        kind: 'question',
        key: 'scope',
        action: 'answer',
        text: 'No, only the server.',
      });
    expect((await answer()).status).toBe(200);
    const task = e.taskGraph.readTask(taskId)!;
    const key = taskQuestionWakeKey(
      { taskId, taskCreatedAt: task.createdAt },
      { key: 'scope', version: 2, action: 'answer' },
    );
    expect(inbox().map((entry) => entry.key)).toEqual([key]);
    expect(inbox()[0]!.payload).toContain('No, only the server.');
    // A second answer is refused (the question is no longer open): no wake.
    expect((await answer()).status).not.toBe(200);
    expect(inbox().map((entry) => entry.key)).toEqual([key]);
    expect(e.stored(taskId).records).toMatchObject([
      { key: 'scope', version: 2, state: 'answered' },
    ]);
  });
});
