/**
 * #4005: a Task dispatched with an Agent starts its Session AS that Agent,
 * so the Session can take turns.
 *
 * This drives the real dispatch route, the real Dispatcher and TaskGraph
 * adapters, the real `resolveTaskDispatchAgentStart` resolver, and a real
 * OrchestrationService over a real EventStore. Then it sends a turn to the
 * dispatched Session through the real `continueExecutionTargetMessage`, the
 * seam `/chat/:id/continue` and the conversation inbox (lead wakes) use,
 * which reads back the Environment + Agent binding from the start's
 * `session.started` record. Only the engine is a fake, and it publishes its
 * start metadata the way the real adapters do. The Station's own HTTP reads
 * (handshake, Agent, connection, Project) are answered in the shapes the
 * real routes return.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { composeTaskDispatcher } from '../../../services/projects/task-dispatch-composition.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import {
  assertTaskDispatchAgentExists,
  continueExecutionTargetMessage,
  resolveTaskDispatchAgentStart,
} from '../../../tools/station-control-delegation.js';
import { createTaskRoutes } from '../tasks.js';

const CURRENT_API = 'http://task-dispatch-agent.test';
const ENVIRONMENT_ID = 'environment-current';
const OWNER = 'owner';

class FakeClaudeAdapter implements ProviderAdapterShape {
  readonly provider = 'claude' as const;
  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly sessions = new Map<string, { threadId: string }>();
  readonly startSession = vi.fn(async (input: ProviderSessionStartInput) => {
    const now = new Date().toISOString();
    const session = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.modelId ? { model: input.modelId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    // The real adapters publish the start metadata the service prepared:
    // that record is where continuations read the binding back from.
    this.events.push({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      initialState: 'created',
      createdAt: now,
      metadata: { ...input.metadata, cwd: input.cwd },
    } as CanonicalRuntimeEvent);
    return session;
  });
  readonly sendTurn = vi.fn(async (input: ProviderSendTurnInput) => ({
    threadId: input.threadId,
    turnId: `turn-${this.sendTurn.mock.calls.length}`,
  }));
  readonly interruptTurn = vi.fn(async () => ({
    outcome: 'no-active-turn' as const,
  }));
  readonly steerTurn = vi.fn(async () => undefined);
  readonly respondToRequest = vi.fn(async () => undefined);
  async listSessions() {
    return [];
  }
  async hasSession(threadId: string) {
    return this.sessions.has(threadId);
  }
  async discardSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async stopSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async stopAll() {
    this.sessions.clear();
  }
  async getPrerequisites() {
    return [];
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Runtime',
    description: 'claude adapter for tests',
    capabilities: ['agent-runtime'],
    engineId: engineId('claude'),
    builtin: true,
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** This Station's own reads, in the shapes its routes return. */
function installCurrentStation(projectDirectory: string) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`)
      return json({ environmentId: ENVIRONMENT_ID });
    if (url === `${CURRENT_API}/api/agents/task-lead`)
      return json({
        success: true,
        data: {
          slug: 'task-lead',
          name: 'Task lead',
          available: true,
          execution: { agentConnectionId: 'claude', modelId: 'haiku' },
        },
      });
    if (url === `${CURRENT_API}/api/agents/ghost`)
      return json({ success: false, error: "Agent 'ghost' not found" }, 404);
    if (url === `${CURRENT_API}/api/connections/claude`)
      return json({
        success: true,
        data: {
          id: 'claude',
          kind: 'agent',
          type: 'claude',
          name: 'Claude Code',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: { provider: 'claude' },
          status: 'ready',
          prerequisites: [],
        },
      });
    if (url === `${CURRENT_API}/api/projects/project-alpha`)
      return json({
        success: true,
        data: {
          id: 'project-alpha',
          slug: 'project-alpha',
          name: 'Project alpha',
          workingDirectory: projectDirectory,
        },
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Task dispatch binds its Session to the Task Agent (#4005)', () => {
  const makeTempDir = trackTempDirs();
  const services: OrchestrationService[] = [];
  const stores: EventStore[] = [];
  let home: string;
  let workspace: string;

  beforeEach(() => {
    process.env.STATION_API_BASE = CURRENT_API;
    process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';
    home = makeTempDir('task-dispatch-agent-');
    workspace = realpathSync(makeTempDir('task-dispatch-ws-'));
  });

  afterEach(async () => {
    try {
      for (const service of services.splice(0)) await service.shutdown();
    } finally {
      for (const store of stores.splice(0)) store.close();
      vi.unstubAllGlobals();
    }
  });

  function compose() {
    const eventStore = new EventStore(join(home, 'orchestration.sqlite'));
    stores.push(eventStore);
    const claude = new FakeClaudeAdapter();
    const service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider: string) =>
          provider === claude.provider ? claude : undefined,
        list: () => [claude],
      },
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      // The production resolver: it applies the Agent named by the start's
      // `agentSlug`, and refuses a start that names no authored Agent.
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) =>
          slug === 'task-lead'
            ? {
                name: 'Task lead',
                prompt: 'You lead this Task.',
                execution: {
                  agentConnectionId: engineConnectionId('claude'),
                  modelId: 'haiku',
                },
              }
            : null,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    services.push(service);
    const graph = new TaskGraphService(home, {
      orchestrationService: service,
      projectService: {
        getProject: (slug: string) => {
          if (slug !== 'project-alpha') throw new Error('missing project');
          return {
            id: slug,
            slug,
            name: 'Project alpha',
            workingDirectory: workspace,
            createdAt: '2026-10-22T00:00:00.000Z',
            updatedAt: '2026-10-22T00:00:00.000Z',
          };
        },
      },
    });
    const routes = createTaskRoutes(graph, {
      taskDispatcher: composeTaskDispatcher(graph, {
        resolveAgentStart: (input) =>
          resolveTaskDispatchAgentStart(input, service),
        assertAgentExists: (agentId) =>
          assertTaskDispatchAgentExists(agentId, service),
        // Epic #4003's brief, which only a turn can deliver.
        taskBrief: {
          forDispatch: async (task: { id: string }) => ({
            brief: {
              digest: `sha256:${'a'.repeat(64)}`,
              text: `BRIEF FOR ${task.id}`,
            },
          }),
        } as never,
      }),
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
      canReadSession: () => true,
      resolveProjectWorkspace: (projectId: string) =>
        projectId === 'project-alpha' ? workspace : undefined,
    });
    // The operator in person, who may choose a working directory.
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'operator-credential',
        authority: 'operator-credential',
        source: 'bearer',
      });
      await next();
    });
    app.route('/', routes);
    return { app, graph, service, claude, eventStore };
  }

  async function createTask(app: Hono, agentId?: string): Promise<string> {
    const created = await readJson(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-alpha',
          title: 'Lead the Task',
          ...(agentId ? { agentId } : {}),
        }),
      }),
    );
    expect(created.success).toBe(true);
    return created.data.id as string;
  }

  async function dispatch(
    app: Hono,
    taskId: string,
    body: Record<string, unknown>,
  ) {
    const response = await app.request(`/${taskId}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await readJson(response) };
  }

  test('a dispatched Session runs as its Agent and accepts a turn through the continuation seam', async () => {
    installCurrentStation(workspace);
    const { app, service, claude } = compose();
    const taskId = await createTask(app);

    const dispatched = await dispatch(app, taskId, {
      agentId: 'task-lead',
      provider: 'claude',
    });
    expect(dispatched.body.error).toBeUndefined();
    expect(dispatched.body).toMatchObject({
      success: true,
      data: {
        task: { status: 'in_progress', agentId: 'task-lead' },
        dispatch: { provider: 'claude', outcome: 'started' },
      },
    });
    const sessionId = dispatched.body.data.dispatch.sessionId as string;

    // The engine started as the Agent: its engine, model, Project directory
    // and the binding a continuation verifies.
    expect(claude.startSession).toHaveBeenCalledTimes(1);
    const start = claude.startSession.mock.calls[0]![0];
    expect(start).toMatchObject({
      threadId: sessionId,
      provider: 'claude',
      modelId: 'haiku',
      cwd: workspace,
      persistSession: true,
      metadata: expect.objectContaining({
        agentId: 'task-lead',
        agentSlug: 'task-lead',
        targetKind: 'agent',
        targetId: 'task-lead',
        connectionId: 'claude',
        environmentId: ENVIRONMENT_ID,
        conversationId: sessionId,
        projectSlug: 'project-alpha',
        userId: OWNER,
      }),
    });
    // The Agent's authored prompt is applied to the start.
    expect(start.agent?.systemPrompt).toContain('You lead this Task.');

    // `/chat/:id/continue` and the inbox both enter here. Before #4005 this
    // refused: "no verified local Environment and Agent binding".
    const handle = await continueExecutionTargetMessage(
      {
        conversationId: sessionId,
        message: 'Start on the Task',
        userId: OWNER,
        readAuthority: sessionReadAuthorityFromRequest(
          OWNER,
          undefined,
          undefined,
        ),
      },
      service,
    );
    expect(handle).toMatchObject({
      conversationId: sessionId,
      sessionId,
      target: { kind: 'agent', id: 'task-lead' },
    });
    // The turn reached the dispatched Session itself, not a new one.
    expect(claude.startSession).toHaveBeenCalledTimes(1);
    expect(claude.sendTurn).toHaveBeenCalledTimes(1);
    expect(claude.sendTurn.mock.calls[0]![0]).toMatchObject({
      threadId: sessionId,
    });
    // The first turn carries the Task brief the start recorded.
    expect(JSON.stringify(claude.sendTurn.mock.calls[0]![0])).toContain(
      `BRIEF FOR ${taskId}`,
    );
  });

  test('the UI’s Dispatch request (an Agent, no provider) starts the Agent’s engine as that Agent and the Session takes a turn', async () => {
    installCurrentStation(workspace);
    const { app, service, claude } = compose();
    const taskId = await createTask(app, 'task-lead');
    const selectedTask = {
      id: taskId,
      agentId: 'task-lead',
      skillName: undefined,
    };

    // The exact body ProjectTasksSection's dispatchSelectedTask sends.
    const dispatched = await dispatch(app, taskId, {
      agentId: selectedTask.agentId,
      skillName: selectedTask.skillName,
      runtimeConfig: workspace ? { cwd: workspace } : undefined,
      sourceSurface: 'project-page',
    });
    expect(dispatched.body.error).toBeUndefined();
    expect(dispatched.body.data).toMatchObject({
      task: { status: 'in_progress', agentId: 'task-lead' },
      dispatch: {
        provider: 'claude',
        outcome: 'started',
        sourceSurface: 'project-page',
      },
    });
    const sessionId = dispatched.body.data.dispatch.sessionId as string;
    expect(claude.startSession.mock.calls[0]![0]).toMatchObject({
      provider: 'claude',
      modelId: 'haiku',
      metadata: expect.objectContaining({
        agentSlug: 'task-lead',
        targetKind: 'agent',
        targetId: 'task-lead',
        environmentId: ENVIRONMENT_ID,
      }),
    });

    await continueExecutionTargetMessage(
      {
        conversationId: sessionId,
        message: 'Start on the Task',
        userId: OWNER,
        readAuthority: sessionReadAuthorityFromRequest(
          OWNER,
          undefined,
          undefined,
        ),
      },
      service,
    );
    expect(claude.sendTurn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(claude.sendTurn.mock.calls[0]![0])).toContain(
      `BRIEF FOR ${taskId}`,
    );
  });

  test('a seeded dispatch records a known Agent and refuses an unknown one', async () => {
    installCurrentStation(workspace);
    const { app, graph, claude } = compose();
    const taskId = await createTask(app);

    const refused = await dispatch(app, taskId, {
      agentId: 'ghost',
      provider: 'task-dispatch',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain(
      "Agent 'ghost' cannot be recorded on this Task",
    );
    expect(graph.readTaskView(taskId)).toMatchObject({ status: 'todo' });
    expect(graph.readTaskView(taskId)?.agentId).toBeUndefined();

    const seeded = await dispatch(app, taskId, {
      agentId: 'task-lead',
      provider: 'task-dispatch',
    });
    expect(seeded.body.data).toMatchObject({
      task: { agentId: 'task-lead', status: 'ready' },
      dispatch: { provider: 'task-dispatch', outcome: 'seeded' },
    });
    expect(claude.startSession).not.toHaveBeenCalled();
  });

  test('the Task’s recorded Agent is used when the dispatch names none', async () => {
    installCurrentStation(workspace);
    const { app, claude } = compose();
    const taskId = await createTask(app, 'task-lead');

    const dispatched = await dispatch(app, taskId, { provider: 'claude' });
    expect(dispatched.body.success).toBe(true);
    expect(claude.startSession.mock.calls[0]![0].metadata).toMatchObject({
      agentId: 'task-lead',
      targetId: 'task-lead',
    });
  });

  test.each([
    [
      'an unknown Agent',
      { agentId: 'ghost', provider: 'claude' },
      "Agent 'ghost' cannot start this Task",
    ],
    [
      'no Agent at all',
      { provider: 'claude' },
      'A Task dispatch that starts an engine needs an Agent',
    ],
    [
      'a provider other than the Agent’s engine',
      { agentId: 'task-lead', provider: 'codex' },
      "Agent 'task-lead' runs on claude, not codex",
    ],
    [
      'a directory other than the Project’s',
      {
        agentId: 'task-lead',
        provider: 'claude',
        // Inside the Project, so the route admits it, but not its directory.
        runtimeConfig: { cwd: 'WORKSPACE/packages' },
      },
      "runs in its Project's working directory",
    ],
  ])(
    'refuses %s before any engine start and leaves the Task as it was',
    async (_label, body, reason) => {
      installCurrentStation(workspace);
      const { app, graph, claude } = compose();
      const taskId = await createTask(app);
      const before = graph.readTaskView(taskId);

      const subdirectory = join(workspace, 'packages');
      mkdirSync(subdirectory);
      const refused = await dispatch(
        app,
        taskId,
        JSON.parse(
          JSON.stringify(body).replace('WORKSPACE/packages', subdirectory),
        ),
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain(reason);
      expect(claude.startSession).not.toHaveBeenCalled();
      // A definite refusal restores the Task: no reservation, no dispatch,
      // nothing left "indeterminate" to reconcile.
      const after = graph.readTaskView(taskId);
      expect(after?.status).toBe(before?.status);
      expect(after?.sessionId).toBeUndefined();
      expect((await graph.readTaskGraph(taskId))?.links ?? []).toEqual([]);
      const retried = await dispatch(app, taskId, {
        agentId: 'task-lead',
        provider: 'claude',
      });
      expect(retried.body.success).toBe(true);
    },
  );
});
