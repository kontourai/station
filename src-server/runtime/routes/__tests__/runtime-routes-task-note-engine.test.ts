/**
 * #4003, end to end: an engine's `task_note` call reaches its Task's
 * document.
 *
 * Real between the engine and the document: the engine's own station-control
 * MCP connection (`/mcp/station-control` with the URL token a Codex session
 * is given), the tool, the production runtime composition
 * (`configureRuntimeRoutes`: credential pipeline, authority guard, caller and
 * scope derivation, the task-note route), the real `OrchestrationService`
 * over a real SQLite event store, the real `TaskGraphService` and Task
 * dispatcher, the real room runtime and working-state worker, and the
 * person's own room document/edit routes.
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-task-note-engine';
const PROJECT = 'project-alpha';
const AT = '2026-10-04T00:00:00.000Z';
const makeTempDir = trackTempDirs();

describe('an engine records Task memory with task_note', () => {
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
      throw new AggregateError(failures, 'Task note teardown failed');
  });

  async function setup() {
    const homeDir = makeTempDir('station-task-note-engine-');
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
        args: Record<string, unknown>,
      ): Promise<{ isError: boolean; body: any }> => {
        const reply = await mcp('tools/call', {
          name: 'task_note',
          arguments: args,
        });
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
        sourceSurface: 'task-note-engine-test',
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

    /** A person's edit through the browser's own plan/submit routes. */
    const personPlan = async (taskId: string, desiredText: string) => {
      const plan = await asOperator(
        'POST',
        `/api/tasks/${taskId}/room/edit-plan`,
        {
          intentId: crypto.randomUUID(),
          desiredText,
          selection: { anchor: 0, focus: 0 },
        },
      );
      expect(plan.status, JSON.stringify(plan.json)).toBe(200);
      expect(plan.json.data.kind).toBe('planned');
      return async () => {
        const submitted = await asOperator(
          'POST',
          `/api/tasks/${taskId}/room/batches`,
          {
            intentId: plan.json.data.intentId,
            intentDigest: plan.json.data.digest,
          },
        );
        expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);
        return submitted.json.data.kind as string;
      };
    };

    return {
      store,
      orchestration,
      taskGraph,
      asOperator,
      connect,
      dispatchedTask,
      documentText,
      personPlan,
    };
  }

  test('a note reaches the Task document as a new revision; the Task status is unchanged', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const statusBefore = e.taskGraph.readTask(taskId)?.status;
    expect(await e.documentText(taskId)).toBe('');
    const before = await e.asOperator(
      'GET',
      `/api/tasks/${taskId}/room/document`,
    );
    const note = await e.connect(sessionId);

    const recorded = await note({ section: 'decision', text: 'Use SQLite.' });
    expect(recorded.isError, JSON.stringify(recorded.body)).toBe(false);
    expect(recorded.body).toMatchObject({
      status: 'recorded',
      taskId,
      section: 'decision',
      replaced: false,
    });
    expect(recorded.body.entry).toMatch(
      new RegExp(
        `^- \\[session ${sessionId}, \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\] Use SQLite\\.$`,
      ),
    );
    expect(recorded.body.revision).not.toBe(before.json.data.revision);
    const text = await e.documentText(taskId);
    expect(text).toBe(
      `## Decisions\n\n${recorded.body.entry}\n\n## Done\n\n## In progress\n\n## Open questions\n`,
    );
    expect(e.taskGraph.readTask(taskId)?.status).toBe(statusBefore);

    // In progress: a second note replaces this Session's own line.
    const first = await note({ section: 'in_progress', text: 'Reading.' });
    const second = await note({ section: 'in_progress', text: 'Writing.' });
    expect(first.body).toMatchObject({ status: 'recorded', replaced: false });
    expect(second.body).toMatchObject({ status: 'recorded', replaced: true });
    const after = await e.documentText(taskId);
    expect(after).toContain(second.body.entry);
    expect(after).not.toContain(first.body.entry);
    expect(e.taskGraph.readTask(taskId)?.status).toBe(statusBefore);
  });

  test('a session without a Task binding is refused as a tool error and writes nothing', async () => {
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
    const note = await e.connect(loose);
    const refused = await note({ section: 'done', text: 'Did a thing.' });
    expect(refused.isError).toBe(true);
    // Refused by the note route itself, not by the caller guard.
    expect(refused.body).toEqual({
      success: false,
      error:
        'This session is not working on a Task, so there is no Task to note on.',
    });
    expect(await e.documentText(taskId)).toBe('');
  });

  test('text over the limit is refused, never cut, and the document is unchanged', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const note = await e.connect(sessionId);
    const refused = await note({ section: 'done', text: 'x'.repeat(2001) });
    expect(refused.isError).toBe(true);
    expect(refused.body).toEqual({
      success: false,
      error:
        'The note text is 2001 characters; the limit is 2000. Nothing was recorded: shorten it or split it into several notes.',
    });
    expect(await e.documentText(taskId)).toBe('');
    const accepted = await note({ section: 'done', text: 'x'.repeat(2000) });
    expect(accepted.body).toMatchObject({ status: 'recorded' });
  });

  test('a person editing the same Task concurrently keeps their edit', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    const note = await e.connect(sessionId);
    expect(
      (await note({ section: 'decision', text: 'First.' })).body,
    ).toMatchObject({ status: 'recorded' });
    const base = await e.documentText(taskId);
    // The person plans on the text they see, then the agent notes, then the
    // person's edit lands.
    const submit = await e.personPlan(
      taskId,
      `The brief, typed by a person.\n\n${base}`.replace(
        '## Done\n',
        '## Done\n\n- Person did this.\n',
      ),
    );
    const agent = await note({ section: 'done', text: 'Agent did that.' });
    expect(agent.body).toMatchObject({ status: 'recorded' });
    expect(await submit()).toBe('committed');
    const text = await e.documentText(taskId);
    expect(
      text.startsWith('The brief, typed by a person.\n\n## Decisions\n'),
    ).toBe(true);
    expect(text).toContain('- Person did this.');
    expect(text).toContain(agent.body.entry);
    expect(text.endsWith(`## In progress\n\n## Open questions\n`)).toBe(true);
  });

  test('a note that would push the Task document past its stored-state bound is refused as full, not retried', async () => {
    const e = await setup();
    const { taskId, sessionId } = await e.dispatchedTask();
    // A person's 3500-character brief fits; a maximum-length note on top of
    // it would cross the room's 512 KiB stored-state bound.
    const submit = await e.personPlan(taskId, 'b'.repeat(3500));
    expect(await submit()).toBe('committed');
    const note = await e.connect(sessionId);
    const refused = await note({ section: 'done', text: 'n'.repeat(2000) });
    expect(refused).toEqual({
      isError: true,
      body: {
        success: false,
        error:
          'The Task document is at its size limit, so nothing was recorded. Ask a person to trim the document; retrying will not help.',
      },
    });
    expect(await e.documentText(taskId)).toBe('b'.repeat(3500));
  });
});
