import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  ProviderAdapterMetadata,
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
import { PROJECT_TASK_ROOM_LIMITS } from '../../orchestration/project-task-room-history.js';
import { ProjectTaskRoomRuntime } from '../../orchestration/project-task-room-runtime.js';
import { projectSessionLifecycle } from '../../orchestration/session-lifecycle-service.js';
import { TaskGraphService } from '../task-graph-service.js';
import { TaskRoomAttachments } from '../task-room-attachments.js';
import { createTaskRoomContext } from '../task-room-context.js';
import { TaskRoomConversationModule } from '../task-room-conversation-module.js';
import { TaskRoomWorkModule } from '../task-room-work-module.js';

const makeTempDir = trackTempDirs();

class RoomAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Task room image adapter',
    capabilities: ['agent-runtime', 'image-input'],
  };
  readonly sessions = new Map<string, ProviderSession>();
  readonly turns: ProviderSendTurnInput[] = [];
  private readonly invocationByTurn = new Map<string, string>();
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
    if (input.invocationId !== undefined)
      this.invocationByTurn.set(
        JSON.stringify([input.threadId, turnId]),
        input.invocationId,
      );
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
      ...(input.invocationId !== undefined
        ? { invocationId: input.invocationId }
        : {}),
      method: 'turn.started',
      prompt: input.displayInput ?? input.input,
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
  fail(threadId: string, turnId: string) {
    const invocationId = this.invocationByTurn.get(
      JSON.stringify([threadId, turnId]),
    );
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId,
      turnId,
      ...(invocationId !== undefined ? { invocationId } : {}),
      createdAt: new Date().toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: 'The response stream failed.',
      retriable: true,
    });
  }
  answer(threadId: string, turnId: string, text: string) {
    const invocationId = this.invocationByTurn.get(
      JSON.stringify([threadId, turnId]),
    );
    const base = {
      provider: this.provider,
      threadId,
      turnId,
      ...(invocationId !== undefined ? { invocationId } : {}),
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

async function fixture(observe = true) {
  const directory = makeTempDir('task-room-conversation-');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const bus = new EventBus();
  const adapter = new RoomAdapter();
  const warnings = vi.fn();
  const sessions = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: warnings },
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
  const historyOpens = vi.fn();
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
    attachments: new TaskRoomAttachments(join(directory, 'assets')),
    taskGraph: graph,
    projectForId: (id) => ({ id, slug: id }),
    history: (authority) => {
      const history = store.createProjectTaskRoomHistory(authority);
      return {
        ...history,
        open: (input) => {
          historyOpens(input);
          return history.open(input);
        },
      };
    },
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
  const starts = new Map<string, () => void>();
  const completions = new Map<string, () => void>();
  const failures: unknown[] = [];
  const publications = new Set<Promise<void>>();
  const unsubscribe = bus.subscribe((frame) => {
    if (frame.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
    const event = frame.data?.event as CanonicalRuntimeEvent;
    if (event.method === 'turn.started' && event.turnId) {
      const key = `${event.threadId}:${event.turnId}`;
      starts.get(key)?.();
      starts.delete(key);
    }
    if (event.method === 'turn.completed' && event.turnId) {
      const key = `${event.threadId}:${event.turnId}`;
      completions.get(key)?.();
      completions.delete(key);
    }
    const pending = (
      observe ? conversation.observe(event) : Promise.resolve()
    ).catch((error) => {
      failures.push(error);
    });
    publications.add(pending);
    void pending.finally(() => publications.delete(pending));
  });
  const request = new Request('http://station.test');
  const discovery = await room.discover({ taskId: task.id, request });
  if (discovery.kind !== 'opened' && discovery.kind !== 'existing') {
    unsubscribe();
    await room.close();
    await sessions.shutdown();
    store.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    throw new Error(
      `Task-room fixture prerequisite failed: ${JSON.stringify(discovery)}`,
    );
  }
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
      holdPublication: (taskId) => conversation.holdPublication(taskId),
      beforeInvocation: (taskId) => conversation.waitForPublication(taskId),
      continued: (taskId) =>
        observe ? conversation.reconcile(taskId) : Promise.resolve(),
      module: work,
      resolveAttachments: (input) => room.resolveAttachments(input),
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
  const fStarted = (sessionId: string, turnId: string) =>
    new Promise<void>((resolve) => {
      if (
        store
          .listEvents(sessionId)
          .some(
            (event) =>
              event.payload.method === 'turn.started' &&
              event.payload.turnId === turnId,
          )
      )
        resolve();
      else starts.set(`${sessionId}:${turnId}`, resolve);
    });
  return {
    task,
    graph,
    room,
    adapter,
    started: (sessionId: string, turnId: string) => fStarted(sessionId, turnId),
    complete: (sessionId: string, turnId: string, text: string) =>
      new Promise<void>((resolve) => {
        completions.set(`${sessionId}:${turnId}`, resolve);
        adapter.answer(sessionId, turnId, text);
      }),
    post,
    principal,
    warnings,
    sessions,
    store,
    conversation,
    workFile: join(directory, 'work.json'),
    historyOpens,
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

test.each(['lineage', 'history', 'query', 'stored'] as const)(
  'the %s conversation title comes from the person rather than the appended brief',
  async (surface) => {
    const f = await fixture();
    try {
      const title = 'Where should preference state live?';
      const response = await f.post('/delegations', {
        prompt: title,
        target: {
          environment: { kind: 'current' },
          agent: 'researcher',
          workspace: { kind: 'project', projectSlug: 'project' },
        },
        taskRoomRequest: {
          taskId: f.task.id,
          taskCreatedAt: f.task.createdAt,
          operationId: 'human-conversation-title',
          context: { version: f.brief.version, digest: f.brief.digest },
        },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await readJson<{ data: TaskRoomWorkOutcome }>(response);
      if (body.data.kind !== 'recorded')
        throw new Error('Request not recorded');
      const sessionId = body.data.record.sessionId;
      await f.started(sessionId, 'turn-1');
      const authority = sessionReadAuthorityFromRequest(
        f.principal.id,
        undefined,
        undefined,
      );
      let actual: string | undefined;
      if (surface === 'lineage')
        actual = (
          await f.sessions.readSessionConversation(sessionId, authority)
        )?.title;
      else if (surface === 'history')
        actual = (await f.sessions.listAllSessionConversations(authority)).find(
          (r) => r.id === sessionId,
        )?.title;
      else if (surface === 'stored')
        actual = f.store.conversationTitle([sessionId]);
      else {
        const result = await f.sessions.sessionQueries.read(
          { type: 'conversation', threadId: sessionId },
          authority,
        );
        if (result.status !== 'found') throw new Error(result.status);
        actual = result.conversation.title;
      }
      expect(actual).toBe(title);
      expect(f.adapter.turns[0].input).toContain('# Task brief: Make the room');
    } finally {
      await f.close();
    }
  },
);

test('a terminal runtime error publishes the failed room line without another request', async () => {
  const f = await fixture(false);
  try {
    const response = await f.post('/delegations', {
      prompt: 'Inspect the export',
      target: {
        environment: { kind: 'current' },
        agent: 'researcher',
        workspace: { kind: 'project', projectSlug: 'project' },
      },
      taskRoomRequest: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'fails-in-stream',
        context: { version: f.brief.version, digest: f.brief.digest },
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await readJson<{ data: TaskRoomWorkOutcome }>(response);
    if (body.data.kind !== 'recorded') throw new Error('Request not recorded');
    const sessionId = body.data.record.sessionId;
    await f.started(sessionId, 'turn-1');
    await f.conversation.reconcile(f.task.id);
    f.adapter.fail(sessionId, 'turn-1');
    let failure: CanonicalRuntimeEvent | undefined;
    await vi.waitFor(() => {
      failure = f.store
        .listEvents(sessionId)
        .find((e) => e.payload.method === 'runtime.error')?.payload;
      expect(failure).toBeDefined();
    });
    if (!failure || failure.method !== 'runtime.error')
      throw new Error('Canonical failure not persisted');
    const reconciliation = vi.spyOn(f.conversation, 'reconcile');
    await f.conversation.observe({
      ...failure,
      provider: 'codex',
      retriable: true,
    });
    expect(reconciliation).not.toHaveBeenCalled();
    await f.conversation.observe(failure);
    await vi.waitFor(async () => {
      expect(
        (await f.history()).filter((r) => r.body.kind === 'live-work-finished'),
      ).toMatchObject([
        { body: { kind: 'live-work-finished', sessionId, outcome: 'failed' } },
      ]);
    });
    expect(await f.agentCount()).toBe(0);
    expect(f.failures).toEqual([]);
  } finally {
    await f.close();
  }
});

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
    await vi.waitFor(() =>
      expect(f.graph.readTaskView(f.task.id)?.status).toBe('in_progress'),
    );
    await vi.waitFor(async () =>
      expect(
        (await f.history()).filter(
          (record) => record.correlationId === 'room-status',
        ),
      ).toMatchObject([
        { body: { kind: 'human-message', text: 'Status → In progress' } },
      ]),
    );
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
          execution: {
            sessionId,
            turnId: 'turn-1',
            runId: `orchestration:claude:${encodeURIComponent(sessionId)}`,
          },
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
    await f.started(sessionId, 'turn-2');
    const continued = await f.sessions.readSession(
      sessionId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(
      continued?.events.find(
        (event) => event.method === 'turn.started' && event.turnId === 'turn-2',
      ),
    ).toMatchObject({
      principal: f.principal,
      clientTurnId: expect.stringMatching(/^room-reply:[0-9a-f-]{36}$/),
    });
    await vi.waitFor(async () => expect(await f.agentCount()).toBe(1));
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
    expect(continuedAnswer.body.text.length).toBe(8 * 1024);
    expect(f.adapter.sessions.size).toBe(1);
    await f.room.reconcileAgentLifecycles([f.task.id]);
    expect(
      (await f.history()).filter(
        (record) => record.correlationId === `room-answer:${sessionId}`,
      ),
    ).toHaveLength(2);
    await vi.waitFor(async () => expect(await f.agentCount()).toBe(0));
    const privateReply = await f.post(`/delegations/${sessionId}/continue`, {
      message: 'Private dock follow-up',
    });
    expect(privateReply.status, await privateReply.clone().text()).toBe(200);
    expect(f.adapter.turns).toHaveLength(3);
    f.adapter.answer(
      sessionId,
      'turn-3',
      'This private dock answer must stay private',
    );
    await vi.waitFor(async () => {
      const detail = await f.sessions.readSession(
        sessionId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      expect(
        detail?.events.some(
          (event) =>
            event.method === 'turn.completed' && event.turnId === 'turn-3',
        ),
      ).toBe(true);
    });
    await f.conversation.reconcile(f.task.id);
    expect(JSON.stringify(await f.history())).not.toContain(
      'This private dock answer must stay private',
    );
    const shared = await f.room.sharedHistory({
      taskId: f.task.id,
      request: new Request('http://station'),
      current: async () => true,
    });
    expect(JSON.stringify(shared)).not.toContain('Alice');
    expect(JSON.stringify(shared)).not.toContain('Please refine it');
    expect(JSON.stringify(shared)).not.toContain('Status →');
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
    expect(f.adapter.turns).toHaveLength(3);
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
    expect(f.adapter.turns).toHaveLength(3);
    expect(f.failures).toEqual([]);
  } finally {
    await f.close();
  }
});

test('Task title edits persist for the exact incarnation; room start accepts Ready and preserves later human statuses', async () => {
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
  await graph.updateTaskStatus(task.id, 'ready');
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

async function requestAgent(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.post('/delegations', {
    prompt: 'Investigate',
    target: {
      environment: { kind: 'current' },
      agent: 'researcher',
      workspace: { kind: 'project', projectSlug: 'project' },
    },
    taskRoomRequest: {
      taskId: f.task.id,
      taskCreatedAt: f.task.createdAt,
      operationId: 'request',
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await readJson<{ data: TaskRoomWorkOutcome }>(response);
  if (body.data.kind !== 'recorded') throw new Error('Missing request record');
  expect(body.data.record.state, JSON.stringify(f.failures)).toBe('dispatched');
  expect(f.adapter.turns).toHaveLength(1);
  await vi.waitFor(() =>
    expect(f.graph.readTaskView(f.task.id)?.status).toBe('in_progress'),
  );
  await f.conversation.waitForPublication(f.task.id);
  return body.data.record.sessionId;
}

test('an exact raw Session with a successor refuses a room reply with 403 before posting or invoking a turn', async () => {
  const f = await fixture();
  try {
    const sessionId = await requestAgent(f);
    await f.complete(sessionId, 'turn-1', 'Initial answer');
    await f.conversation.reconcile(f.task.id);
    expect(
      (await f.history()).some((record) => record.causationId === 'turn-1'),
      JSON.stringify(f.failures),
    ).toBe(true);
    const root = f.store.conversationForSession(sessionId)!;
    const started = f.store
      .listEvents(sessionId)
      .find((event) => event.payload.method === 'session.started');
    const binding =
      started?.payload.method === 'session.started'
        ? started.payload.metadata
        : undefined;
    expect(binding).toMatchObject({
      environmentId: 'current',
      targetId: 'researcher',
    });
    if (!binding || typeof binding.environmentId !== 'string')
      throw new Error(
        'The predecessor must have a verified Environment binding.',
      );
    f.store.reserveNextConversationSession({
      conversationId: root.conversationId,
      predecessorSessionId: sessionId,
      proposedSessionId: 'successor',
      createdAt: new Date().toISOString(),
    });
    await f.sessions.dispatch(
      {
        type: 'startSession',
        input: {
          provider: 'claude',
          threadId: 'successor',
          cwd: f.adapter.sessions.get(sessionId)!.cwd,
          metadata: { ...binding, userId: f.principal.id },
        },
      },
      { userId: f.principal.id },
      {
        conversationIdentity: {
          conversationId: root.conversationId,
          environmentId: binding.environmentId,
        },
      },
    );
    await vi.waitFor(async () =>
      expect(
        await f.sessions.readSession(
          'successor',
          sessionReadAuthorityFromRequest(f.principal.id, undefined, undefined),
        ),
      ).not.toBeNull(),
    );
    await expect(
      f.conversation.admission(
        {
          taskId: f.task.id,
          taskCreatedAt: f.task.createdAt,
          sessionId,
          operationId: 'successor-admission',
        },
        new Request('http://station'),
        f.principal,
      ),
    ).rejects.toThrow('Task authority or agent Session changed');
    const response = await f.post(`/delegations/${sessionId}/continue`, {
      message: 'Refused successor reply',
      taskRoomReply: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'successor-reply',
        attachBrief: false,
      },
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(f.adapter.turns).toHaveLength(1);
    expect(JSON.stringify(await f.history())).not.toContain(
      'Refused successor reply',
    );
    // The continuation command also enforces the exact raw identity, independently of route admission.
    await expect(
      continueDelegatedTask(
        {
          taskId: sessionId,
          message: 'Refused direct continuation',
          userId: f.principal.id,
          principal: f.principal,
          taskRoomInvocationAdmission: {
            expectedSessionId: sessionId,
            roomBinding: { taskId: f.task.id, projectId: 'project' },
            recheck: async () => {},
          },
        },
        f.sessions,
      ),
    ).rejects.toThrow(/room reply.*Session/);
    expect(f.adapter.turns).toHaveLength(1);
    await continueDelegatedTask(
      {
        taskId: sessionId,
        message: 'Private follow-up reaches the owned successor',
        userId: f.principal.id,
        principal: f.principal,
      },
      f.sessions,
    );
    expect(f.adapter.turns).toHaveLength(2);
    expect(f.adapter.turns[1].threadId).toBe('successor');
  } finally {
    await f.close();
  }
});

test('a continuation failure after admission posts no human reply', async () => {
  const f = await fixture();
  try {
    const sessionId = await requestAgent(f);
    await f.complete(sessionId, 'turn-1', 'Initial answer');
    await f.conversation.reconcile(f.task.id);
    expect(
      (await f.history()).some((record) => record.causationId === 'turn-1'),
      JSON.stringify(f.failures),
    ).toBe(true);
    const send = vi
      .spyOn(f.adapter, 'sendTurn')
      .mockRejectedValueOnce(new Error('Controlled provider refusal'));
    const response = await f.post(`/delegations/${sessionId}/continue`, {
      message: 'Failed delivery',
      taskRoomReply: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'failed-delivery',
        attachBrief: false,
      },
    });
    expect(response.status).not.toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(await f.history())).not.toContain('Failed delivery');
  } finally {
    await f.close();
  }
});

test('a continued provider turn remains acknowledged when posting its human reply fails', async () => {
  const f = await fixture();
  try {
    const sessionId = await requestAgent(f);
    await f.complete(sessionId, 'turn-1', 'Initial answer');
    await f.conversation.reconcile(f.task.id);
    vi.spyOn(f.conversation, 'reply').mockRejectedValueOnce(
      new Error('Controlled history failure'),
    );
    const response = await f.post(`/delegations/${sessionId}/continue`, {
      message: 'Accepted but unposted',
      taskRoomReply: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'unposted-reply',
        attachBrief: false,
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await readJson(response)).toMatchObject({
      data: { taskRoomReplyDelivery: 'unpublished', sessionId },
    });
    expect(f.adapter.turns).toHaveLength(2);
    expect(JSON.stringify(await f.history())).not.toContain(
      'Accepted but unposted',
    );
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

test.each(['initial', 'reply'] as const)(
  'a fast %s completion before human history publication preserves prompt-before-answer order',
  async (kind) => {
    const f = await fixture();
    const fastCompletions: Promise<void>[] = [];
    try {
      let sessionId: string | undefined;
      if (kind === 'reply') {
        sessionId = await requestAgent(f);
        await f.complete(sessionId, 'turn-1', 'Initial answer');
        await f.conversation.reconcile(f.task.id);
      }
      const send = f.adapter.sendTurn.bind(f.adapter);
      vi.spyOn(f.adapter, 'sendTurn').mockImplementation(async (input) => {
        const turn = await send(input);
        fastCompletions.push(
          f
            .started(input.threadId, turn.turnId)
            .then(() =>
              f.complete(
                input.threadId,
                turn.turnId,
                'Immediate canonical answer',
              ),
            ),
        );
        return turn;
      });
      if (kind === 'initial') {
        const recorded = f.conversation.recorded.bind(f.conversation);
        vi.spyOn(f.conversation, 'recorded').mockImplementation(
          async (...args) => {
            await Promise.all(fastCompletions);
            return recorded(...args);
          },
        );
        sessionId = await requestAgent(f);
      } else {
        const reply = f.conversation.reply.bind(f.conversation);
        vi.spyOn(f.conversation, 'reply').mockImplementation(
          async (...args) => {
            await Promise.all(fastCompletions);
            return reply(...args);
          },
        );
        const response = await f.post(`/delegations/${sessionId}/continue`, {
          message: 'Fast reply prompt',
          taskRoomReply: {
            taskId: f.task.id,
            taskCreatedAt: f.task.createdAt,
            operationId: 'fast-reply',
            attachBrief: false,
          },
        });
        expect(response.status, await response.clone().text()).toBe(200);
      }
      await Promise.all(fastCompletions);
      await f.conversation.reconcile(f.task.id);
      const records = await f.history();
      const prompt = records.find((record) =>
        kind === 'reply'
          ? record.correlationId === `room-thread:${sessionId}`
          : record.body.kind === 'human-message' &&
            record.body.text === '**@researcher** Investigate',
      );
      const answer = records.find(
        (record) =>
          record.body.kind === 'human-message' &&
          record.body.text === 'Immediate canonical answer',
      );
      expect(prompt).toBeDefined();
      expect(answer, JSON.stringify(f.failures)).toBeDefined();
      expect(prompt!.envelope.seq).toBeLessThan(answer!.envelope.seq);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

test.each([undefined, 'room-reply:forged-dock-send'])(
  'the second turn from the private dock stays private, including a forged room tag (%s)',
  async (clientTurnId) => {
    const f = await fixture();
    try {
      const sessionId = await requestAgent(f);
      await f.complete(sessionId, 'turn-1', 'Public initial answer');
      await f.conversation.reconcile(f.task.id);
      await f.sessions.dispatch({
        type: 'sendTurn',
        input: {
          threadId: sessionId,
          input: 'Private dock send',
          ...(clientTurnId ? { clientTurnId } : {}),
        },
      });
      await f.started(sessionId, 'turn-2');
      await f.complete(sessionId, 'turn-2', 'Private second-turn answer');
      await f.conversation.reconcile(f.task.id);
      const detail = await f.sessions.readSession(
        sessionId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      expect(detail?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'turn.started',
            turnId: 'turn-2',
            ...(clientTurnId ? { clientTurnId } : {}),
          }),
        ]),
      );
      const history = await f.history();
      expect(
        history.filter(
          (entry) => entry.correlationId === `room-answer:${sessionId}`,
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(history)).toContain('Public initial answer');
      expect(JSON.stringify(history)).not.toContain(
        'Private second-turn answer',
      );
      expect(f.failures).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test('one publication pass opens history once for several pending answers and skips already published answers', async () => {
  const f = await fixture(false);
  try {
    const sessionId = await requestAgent(f);
    await f.complete(sessionId, 'turn-1', 'First pending answer');
    const response = await f.post(`/delegations/${sessionId}/continue`, {
      message: 'Second request',
      taskRoomReply: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'second-pending',
        attachBrief: false,
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await f.conversation.waitForPublication(f.task.id);
    const longAnswer = '🧪"\\\n'.repeat(3000);
    await f.complete(sessionId, 'turn-2', longAnswer);
    const answers = await f.conversation.answers({
      sessionId,
      ownerOperatorId: f.principal.id,
    });
    expect(answers).toHaveLength(2);
    f.historyOpens.mockClear();
    await f.room.publishAgentAnswers(f.task.id, sessionId);
    const published = (await f.history()).filter(
      (entry) => entry.correlationId === `room-answer:${sessionId}`,
    );
    expect(published).toHaveLength(2);
    const answer = published.find((entry) => entry.causationId === 'turn-2');
    if (answer?.body.kind !== 'human-message')
      throw new Error('Missing Unicode answer');
    const notice =
      '\n\n_Answer shortened for the room. Open full run for the complete answer._';
    expect(answer.body.text.endsWith(notice)).toBe(true);
    const prefix = answer.body.text.slice(0, -notice.length);
    expect(longAnswer.startsWith(prefix)).toBe(true);
    expect(/[\uD800-\uDFFF]/u.test(prefix)).toBe(false);
    expect(answer.body.text.length).toBeLessThanOrEqual(
      PROJECT_TASK_ROOM_LIMITS.stringBytes,
    );
    expect(Buffer.byteLength(answer.body.text, 'utf8')).toBeLessThanOrEqual(
      PROJECT_TASK_ROOM_LIMITS.stringBytes,
    );
    expect(Buffer.byteLength(JSON.stringify(answer.body))).toBeLessThanOrEqual(
      PROJECT_TASK_ROOM_LIMITS.bodyBytes,
    );
    const next = Array.from(longAnswer)[Array.from(prefix).length];
    const extended = prefix + next + notice;
    expect(
      extended.length > PROJECT_TASK_ROOM_LIMITS.stringBytes ||
        Buffer.byteLength(extended, 'utf8') >
          PROJECT_TASK_ROOM_LIMITS.stringBytes ||
        Buffer.byteLength(
          JSON.stringify({ kind: 'human-message', text: extended }),
        ) > PROJECT_TASK_ROOM_LIMITS.bodyBytes,
    ).toBe(true);

    expect(f.historyOpens).toHaveBeenCalledTimes(1);
    f.historyOpens.mockClear();
    await f.room.publishAgentAnswers(f.task.id, sessionId);
    expect(f.historyOpens).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('publication holds expire and an expired release cannot release a newer hold', async () => {
  const f = await fixture(false);
  const reconcile = vi
    .spyOn(f.room, 'reconcileAgentLifecycles')
    .mockResolvedValue(undefined);
  let expiredRelease = () => {};
  let release = () => {};
  let pending = Promise.resolve();
  try {
    vi.useFakeTimers();
    expiredRelease = f.conversation.holdPublication(f.task.id);
    pending = f.conversation.reconcile(f.task.id);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledOnce();
    await pending;
    release = f.conversation.holdPublication(f.task.id);
    const next = f.conversation.reconcile(f.task.id);
    expiredRelease();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledOnce();
    release();
    await next;
    expect(reconcile).toHaveBeenCalledTimes(2);
  } finally {
    expiredRelease();
    release();
    await pending;
    vi.useRealTimers();
    reconcile.mockRestore();
    await f.close();
  }
});

test('canonical initial answers remain readable without a reply journal, while corrupt journals fail closed', async () => {
  const f = await fixture(false);
  try {
    const sessionId = await requestAgent(f);
    await f.complete(sessionId, 'turn-1', 'Initial canonical answer');
    await rm(f.workFile);
    const input = { sessionId, ownerOperatorId: f.principal.id };
    await expect(f.conversation.answers(input)).resolves.toMatchObject([
      { turnId: 'turn-1', text: 'Initial canonical answer' },
    ]);
    await writeFile(f.workFile, '{corrupt');
    await expect(f.conversation.answers(input)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test('Task images reach the provider on requests and same-session replies and remain visible in room history', async () => {
  const f = await fixture();
  try {
    const image = {
      kind: 'image' as const,
      name: 'screen.png',
      mimeType: 'image/png' as const,
      size: 8,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    };
    const attachments = await f.room.storeAttachments({
      taskId: f.task.id,
      taskCreatedAt: f.task.createdAt,
      request: new Request('http://station.test'),
      attachments: [image],
    });
    if (!attachments) throw new Error('Upload refused');
    const body = {
      prompt: 'Inspect this screenshot',
      target: {
        environment: { kind: 'current' },
        agent: 'researcher',
        workspace: { kind: 'project', projectSlug: 'project' },
      },
      taskRoomRequest: {
        taskId: f.task.id,
        taskCreatedAt: f.task.createdAt,
        operationId: 'image-request',
        attachments,
      },
    };
    const unavailable = await f.post('/delegations', {
      ...body,
      taskRoomRequest: {
        ...body.taskRoomRequest,
        attachments: [
          { ...attachments[0], id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
        ],
      },
    });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({
      success: false,
      code: 'task_room_attachments_unavailable',
    });
    expect(f.adapter.turns).toHaveLength(0);
    const response = await f.post('/delegations', body);
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await readJson<{ data: TaskRoomWorkOutcome }>(response);
    if (result.data.kind !== 'recorded')
      throw new Error('Request not recorded');
    expect(result.data.record.state, JSON.stringify(f.failures)).toBe(
      'dispatched',
    );
    expect(f.adapter.turns).toHaveLength(1);
    const sessionId = result.data.record.sessionId;
    await f.started(sessionId, 'turn-1');
    expect(f.adapter.turns[0].attachments).toEqual([image]);
    expect(result.data.record.attachments).toEqual(attachments);
    await vi.waitFor(async () =>
      expect(await f.history()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: expect.objectContaining({ attachments }),
          }),
        ]),
      ),
    );
    const changed = await f.room.storeAttachments({
      taskId: f.task.id,
      taskCreatedAt: f.task.createdAt,
      request: new Request('http://station.test'),
      attachments: [{ ...image, name: 'other.png' }],
    });
    expect(
      (
        await f.post('/delegations', {
          ...body,
          taskRoomRequest: { ...body.taskRoomRequest, attachments: changed },
        })
      ).status,
    ).toBe(409);
    expect(f.adapter.turns).toHaveLength(1);
    await f.complete(sessionId, 'turn-1', 'I see the screenshot.');
    const reply = await f.post(
      `/delegations/${encodeURIComponent(sessionId)}/continue`,
      {
        message: 'Look again',
        taskRoomReply: {
          taskId: f.task.id,
          taskCreatedAt: f.task.createdAt,
          operationId: 'image-reply',
          attachBrief: false,
          attachments,
        },
      },
    );
    expect(reply.status, await reply.clone().text()).toBe(200);
    await f.started(sessionId, 'turn-2');
    expect(f.adapter.turns[1]).toMatchObject({
      threadId: sessionId,
      attachments: [image],
    });
    await vi.waitFor(async () =>
      expect(await f.history()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: { kind: 'human-message', text: 'Look again', attachments },
          }),
        ]),
      ),
    );
    await rm(join(dirname(f.workFile), 'assets', 'blobs'), { recursive: true });
    const replay = await f.post('/delegations', {
      ...body,
      taskRoomRequest: {
        ...body.taskRoomRequest,
        attachments: attachments.map(({ id, kind, name, mimeType, size }) => ({
          size,
          mimeType,
          name,
          kind,
          id,
        })),
      },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: { kind: 'recorded', replayed: true, record: { sessionId } },
    });
    expect(f.adapter.turns).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('unavailable reply attachments release publication before the hold expires', async () => {
  const f = await fixture(false);
  const reconcile = vi
    .spyOn(f.room, 'reconcileAgentLifecycles')
    .mockResolvedValue(undefined);
  try {
    const sessionId = await requestAgent(f);
    await f.complete(sessionId, 'turn-1', 'Ready for another image');
    const response = await f.post(
      `/delegations/${encodeURIComponent(sessionId)}/continue`,
      {
        message: 'Missing screenshot',
        taskRoomReply: {
          taskId: f.task.id,
          taskCreatedAt: f.task.createdAt,
          operationId: 'missing-image-reply',
          attachBrief: false,
          attachments: [
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              kind: 'image',
              name: 'missing.png',
              mimeType: 'image/png',
              size: 8,
            },
          ],
        },
      },
    );
    expect(response.ok).toBe(false);
    reconcile.mockClear();
    let reconciled = false;
    const pending = f.conversation.reconcile(f.task.id).then(() => {
      reconciled = true;
    });
    await vi.waitFor(() => expect(reconciled).toBe(true), { timeout: 1000 });
    await pending;
    expect(reconcile).toHaveBeenCalled();
    expect(f.adapter.turns).toHaveLength(1);
  } finally {
    reconcile.mockRestore();
    await f.close();
  }
});
