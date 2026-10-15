import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { parseProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { sessionLifecycleOutcome } from '@kontourai/station-contracts/session-lifecycle';
import type { TaskRoomWorkOutcome } from '@kontourai/station-contracts/task-room-work';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import {
  continueDelegatedTask,
  delegateTask,
} from '../../../tools/station-control-delegation.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { ProjectTaskRoomRuntime } from '../../orchestration/project-task-room-runtime.js';
import { projectSessionLifecycle } from '../../orchestration/session-lifecycle-service.js';
import { TaskGraphService } from '../task-graph-service.js';
import { createTaskRoomContext } from '../task-room-context.js';
import { TaskRoomConversationModule } from '../task-room-conversation-module.js';
import { TaskRoomWorkModule } from '../task-room-work-module.js';

const makeTempDir = trackTempDirs();

class RoomAdapter extends GateTestAdapter {
  readonly sessions = new Map<string, ProviderSession>();
  readonly turns: ProviderSendTurnInput[] = [];
  override async startSession(input: ProviderSessionStartInput) {
    const session = {
      ...(await super.startSession(input)),
      cwd: input.cwd,
      model: input.modelId,
    };
    this.sessions.set(input.threadId, session);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata: input.metadata,
    });
    return session;
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const turnId = `turn-${this.turns.length}`;
    const createdAt = new Date().toISOString();
    const session = this.sessions.get(input.threadId);
    if (!session) throw new Error('Missing provider session');
    this.sessions.set(input.threadId, {
      ...session,
      status: 'running',
      updatedAt: createdAt,
    });
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      method: 'turn.started',
      createdAt,
    });
    return { threadId: input.threadId, turnId };
  }
  override async hasSession(threadId?: string) {
    return !!threadId && this.sessions.has(threadId);
  }
  override async listSessions() {
    return [...this.sessions.values()];
  }
  answer(threadId: string, turnId: string, text: string) {
    const base = {
      provider: this.provider,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    };
    const session = this.sessions.get(threadId);
    if (!session) throw new Error('Missing provider session');
    this.sessions.set(threadId, {
      ...session,
      status: 'ready',
      updatedAt: base.createdAt,
    });
    this.events.push({
      ...base,
      eventId: randomUUID(),
      method: 'content.text-delta',
      itemId: `message-${turnId}`,
      delta: text,
    });
    this.events.push({
      ...base,
      eventId: randomUUID(),
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: text,
    });
  }
}

async function fixture() {
  const directory = makeTempDir('task-room-conversation-');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const bus = new EventBus();
  const adapter = new RoomAdapter();
  const sessions = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
    resolveSessionAgent: async (input) => ({
      ...input,
      agent: { slug: 'researcher' },
    }),
  });
  const graph = new TaskGraphService(directory, {
    resolveProjectWorkspace: async () => directory,
  });
  const principal = humanPrincipal('test', 'alice', 'Alice');
  const task = await graph.createTask({
    projectId: 'project',
    title: 'Make the room',
    createdBy: principal.id,
  });
  const work = new TaskRoomWorkModule(join(directory, 'work.json'));
  let allowed = true;
  let revokeAtProjectRead = false;
  vi.stubEnv('STATION_API_BASE', 'http://task-room-conversation.test');
  vi.stubEnv('STATION_INTERNAL_API_TOKEN', 'task-room-conversation-test');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (raw) => {
      const url = String(raw);
      const respond = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.endsWith('/.well-known/station/v1'))
        return respond({ environmentId: 'current' });
      if (url.endsWith('/api/agents/researcher'))
        return respond({
          success: true,
          data: {
            slug: 'researcher',
            name: 'Researcher',
            available: true,
            execution: { agentConnectionId: 'claude' },
          },
        });
      if (url.endsWith('/api/connections/claude'))
        return respond({
          success: true,
          data: {
            id: 'claude',
            name: 'Claude',
            kind: 'agent',
            type: 'custom',
            enabled: true,
            status: 'ready',
            capabilities: ['agent-runtime'],
            config: { provider: 'claude' },
          },
        });
      if (url.endsWith('/api/projects/project')) {
        if (revokeAtProjectRead) allowed = false;
        return respond({
          success: true,
          data: { workingDirectory: directory },
        });
      }
      throw new Error(`Unexpected environment read: ${url}`);
    }),
  );
  const scope = {
    projectId: 'project',
    projectSlug: 'project',
    roomProjectId: 'project',
    taskCreatedAt: task.createdAt,
    requesterId: principal.id,
  };
  const authorize = async () => (allowed ? scope : undefined);
  const brief = createTaskRoomContext(
    { taskId: task.id, projectId: 'project', taskCreatedAt: task.createdAt },
    {
      title: task.title,
      description: task.description,
      documentRevision: 'saved-revision',
      text: `# Goal\nShip the room.\n${'Detailed plan. '.repeat(1400)}`,
    },
  )!;
  let room: ProjectTaskRoomRuntime;
  const conversation = new TaskRoomConversationModule({
    graph,
    work,
    room: () => room,
    authorize,
    sessions,
    authorityForOwner: (id) =>
      sessionReadAuthorityFromRequest(id, undefined, undefined),
    readBinding: (id) => store.readProjectTaskRoomExecutionBinding(id),
  });
  room = new ProjectTaskRoomRuntime({
    taskGraph: graph,
    projectForId: (id) => ({ id, slug: id }),
    history: (authority) => store.createProjectTaskRoomHistory(authority),
    working: store.createProjectTaskRoomWorkingState(),
    requestAuthority: {
      resolve: async () =>
        allowed
          ? {
              kind: 'granted',
              operatorId: principal.id,
              deviceId: 'device',
              policyRevision: 'test',
              displayName: 'Alice',
            }
          : { kind: 'revoked' },
    },
    readAgentRequests: async () =>
      (
        await work.readPublicationRequests({
          taskId: task.id,
          projectId: 'project',
          roomProjectId: 'project',
          taskCreatedAt: task.createdAt,
          readBinding: (id) => store.readProjectTaskRoomExecutionBinding(id),
        })
      ).map((record) => ({
        sessionId: record.sessionId,
        agentId: record.agentId,
        ownerOperatorId: record.ownerId,
        createdAt: record.createdAt,
        taskCreatedAt: record.taskCreatedAt,
      })),
    readAgentAnswers: (input) => conversation.answers(input),
    readAgentLifecycle: async ({ sessionId }) => {
      const detail = await sessions.readSession(
        sessionId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      return detail
        ? {
            provider: detail.session.provider,
            createdAt: detail.session.createdAt,
            updatedAt: detail.session.updatedAt,
            outcome: sessionLifecycleOutcome(
              projectSessionLifecycle({
                session: detail.session,
                events: detail.events,
              }).lifecycleState,
            ),
          }
        : undefined;
    },
  });
  const failures: unknown[] = [];
  const publications = new Set<Promise<void>>();
  const unsubscribe = bus.subscribe((frame) => {
    if (frame.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
    const event = frame.data?.event as CanonicalRuntimeEvent;
    const pending = conversation.observe(event).catch((error) => {
      failures.push(error);
    });
    publications.add(pending);
    void pending.finally(() => publications.delete(pending));
  });
  const request = new Request('http://station.test');
  await room.discover({ taskId: task.id, request });
  const app = createOrchestrationRoutes(sessions, {
    eventBus: bus,
    logger: { debug: vi.fn() },
    resolvePrincipal: () => principal,
    isRequestPrincipalCurrent: () => allowed,
    delegateTask: async (input) => {
      try {
        return await delegateTask(input, sessions);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
    continueDelegatedTask: (input) => continueDelegatedTask(input, sessions),
    taskRoomWork: {
      beforeInvocation: (taskId) => conversation.waitForPublication(taskId),
      continued: (taskId) => conversation.reconcile(taskId),
      module: work,
      authorize,
      resolveContext: async () => brief,
      onRecorded: (...args) => conversation.recorded(...args),
      onReply: (...args) => conversation.reply(...args),
      admitReply: (...args) => conversation.admission(...args),
    },
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const history = async () => {
    const result = await room.history({ taskId: task.id, request });
    if (result.kind !== 'available') throw new Error(`History ${result.kind}`);
    return result.records;
  };
  return {
    task,
    graph,
    room,
    adapter,
    post,
    history,
    failures,
    agentCount: async () => {
      const result = await room.liveActivity({ request });
      if (result.kind !== 'available')
        throw new Error('Live activity unavailable');
      return result.projection.participants.filter(
        (p) => p.actor.kind === 'agent',
      ).length;
    },
    browserHistory: async () =>
      parseProjectTaskRoomBrowserHistory(
        await room.history({ taskId: task.id, request, project: true }),
      ),
    brief,
    revoke: () => {
      allowed = false;
    },
    revokeDuringResolution: () => {
      revokeAtProjectRead = true;
    },
    close: async () => {
      unsubscribe();
      await Promise.all(publications);
      await room.close();
      await sessions.shutdown();
      store.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    },
  };
}

test('room requests start the Task and publish canonical answers and continued turns into one agent thread', async () => {
  const f = await fixture();
  try {
    const created = await f.post('/delegations', {
      prompt: 'Investigate',
      target: {
        environment: { kind: 'current' },
        agent: 'researcher',
        workspace: { kind: 'project', projectSlug: 'project' },
      },
      taskRoomRequest: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'first',
        context: { version: f.brief.version, digest: f.brief.digest },
      },
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const body = await readJson<{ data: TaskRoomWorkOutcome }>(created);
    if (body.data.kind !== 'recorded')
      throw new Error('Request was not recorded');
    const sessionId = body.data.record.sessionId;
    expect(f.failures).toEqual([]);
    expect(body.data.record.state, JSON.stringify(body)).toBe('dispatched');
    expect(f.adapter.turns[0].input).toContain('# Task brief: Make the room');
    expect(f.adapter.turns[0].input).toContain('Brief shortened to fit');
    expect(f.adapter.turns[0].input).not.toContain('"documentRevision"');
    expect(f.graph.readTaskView(f.task.id)?.status).toBe('in_progress');
    expect(
      (await f.history()).filter(
        (record) => record.correlationId === 'room-status',
      ),
    ).toMatchObject([
      { body: { kind: 'human-message', text: 'Status → In progress' } },
    ]);
    f.adapter.answer(
      sessionId,
      'turn-1',
      '**First answer** from the real event writer.',
    );
    await vi.waitFor(async () =>
      expect(
        (await f.history()).filter(
          (record) => record.correlationId === `room-answer:${sessionId}`,
        ),
      ).toMatchObject([
        {
          principal: { kind: 'agent', agentId: 'researcher' },
          causationId: 'turn-1',
          body: {
            kind: 'human-message',
            text: '**First answer** from the real event writer.',
          },
        },
      ]),
    );
    const projected = await f.browserHistory();
    expect(projected).toMatchObject({
      kind: 'available',
      records: expect.arrayContaining([
        expect.objectContaining({
          actor: expect.objectContaining({
            kind: 'agent',
            label: 'researcher',
          }),
          occurredAt: expect.any(String),
          execution: { sessionId, turnId: 'turn-1', runId: expect.any(String) },
        }),
        expect.objectContaining({
          actor: expect.objectContaining({ kind: 'human', label: 'Alice' }),
        }),
      ]),
    });
    const reply = await f.post(`/delegations/${sessionId}/continue`, {
      message: 'Please refine it',
      taskRoomReply: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'reply-1',
      },
    });
    expect(reply.status, await reply.clone().text()).toBe(200);
    expect(f.adapter.turns).toHaveLength(2);
    expect(f.adapter.turns[1].threadId).toBe(sessionId);
    expect(f.adapter.turns[1].input).toContain('Please refine it');
    expect(f.adapter.turns[1].input).toContain('# Task brief: Make the room');
    expect(await f.agentCount()).toBe(1);
    f.adapter.answer(
      sessionId,
      'turn-2',
      `Refined answer. ${'Useful detail. '.repeat(900)}`,
    );
    await vi.waitFor(async () =>
      expect(
        (await f.history()).filter(
          (record) => record.correlationId === `room-answer:${sessionId}`,
        ),
      ).toHaveLength(2),
    );
    expect(
      (await f.history()).find(
        (record) => record.correlationId === `room-thread:${sessionId}`,
      ),
    ).toMatchObject({ body: { text: 'Please refine it' } });
    const continuedAnswer = (await f.history()).find(
      (record) => record.causationId === 'turn-2',
    );
    expect(continuedAnswer?.body).toMatchObject({
      kind: 'human-message',
      text: expect.stringContaining('Answer shortened for the room'),
    });
    if (continuedAnswer?.body.kind !== 'human-message')
      throw new Error('Missing continued answer');
    expect(continuedAnswer.body.text.length).toBeLessThanOrEqual(8 * 1024);
    expect(f.adapter.sessions.size).toBe(1);
    await f.room.reconcileAgentLifecycles([f.task.id]);
    expect(
      (await f.history()).filter(
        (record) => record.correlationId === `room-answer:${sessionId}`,
      ),
    ).toHaveLength(2);
    await vi.waitFor(async () => expect(await f.agentCount()).toBe(0));
    f.revokeDuringResolution();
    const duringResolution = await f.post(
      `/delegations/${sessionId}/continue`,
      {
        message: 'Should never reach the provider',
        taskRoomReply: {
          taskId: f.task.id,
          taskCreatedAt: f.task.createdAt,
          operationId: 'revoked-at-effect',
          attachBrief: false,
        },
      },
    );
    expect(duringResolution.status).not.toBe(200);
    expect(f.adapter.turns).toHaveLength(2);
    f.revoke();
    const forbidden = await f.post(`/delegations/${sessionId}/continue`, {
      message: 'Unauthorized',
      taskRoomReply: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'reply-forbidden',
      },
    });
    expect(forbidden.status).toBe(403);
    expect(f.adapter.turns).toHaveLength(2);
    expect(f.failures).toEqual([]);
  } finally {
    await f.close();
  }
});

test('Task title edits persist for the exact incarnation and room start leaves later human statuses intact', async () => {
  const directory = makeTempDir('task-room-title-');
  const graph = new TaskGraphService(directory, {
    resolveProjectWorkspace: async () => directory,
  });
  const task = await graph.createTask({
    projectId: 'project',
    title: 'Original',
  });
  await graph.updateTaskTitle(task.id, 'Revised', task.createdAt);
  const reopened = new TaskGraphService(directory, {
    resolveProjectWorkspace: async () => directory,
  });
  expect(reopened.readTaskView(task.id)?.title).toBe('Revised');
  await expect(
    graph.updateTaskTitle(
      task.id,
      'Wrong incarnation',
      '2026-01-01T00:00:00.000Z',
    ),
  ).rejects.toThrow('Task not found');
  expect(await graph.startTaskRoomWork(task.id, task.createdAt)).toMatchObject({
    changed: true,
    task: { status: 'in_progress' },
  });
  await graph.updateTaskStatus(task.id, 'blocked');
  expect(await graph.startTaskRoomWork(task.id, task.createdAt)).toMatchObject({
    changed: false,
    task: { status: 'blocked' },
  });
});
