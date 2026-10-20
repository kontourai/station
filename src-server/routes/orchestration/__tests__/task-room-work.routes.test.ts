import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type {
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
} from '@kontourai/station-contracts/project-task-room';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { TaskRoomWorkOutcome } from '@kontourai/station-contracts/task-room-work';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderSessionStartInput } from '../../../providers/adapter-shape.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { hasPendingProjectTaskRoomExecution } from '../../../services/orchestration/project-task-room-source-seal.js';
import { createTaskRoomContext } from '../../../services/projects/task-room-context.js';
import { TaskRoomWorkModule } from '../../../services/projects/task-room-work-module.js';
import { delegateTask } from '../../../tools/station-control-delegation.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const makeTempDir = trackTempDirs();

test.each([undefined, 'codex'])(
  'the delegation route records one request with binding %s and refuses a changed target or Task Project',
  async (executionAgentId) => {
    const directory = makeTempDir('task-room-work-route-');
    const eventStore = new EventStore(join(directory, 'events.sqlite'));
    const eventBus = new EventBus();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const principal = humanPrincipal('test', 'alice', 'Alice');
    type Dispatch = NonNullable<
      Parameters<typeof createOrchestrationRoutes>[1]['delegateTask']
    >;
    const start = vi.fn<Dispatch>(async (input) => {
      if (!input.sessionId)
        throw new Error('expected server-reserved session identity');
      return { sessionId: input.sessionId };
    });
    const module = new TaskRoomWorkModule(join(directory, 'work.json'));
    const scope = {
      projectId: 'project',
      projectSlug: 'demo',
      roomProjectId: 'room-project',
      taskCreatedAt: '2026-09-30T12:00:00.000Z',
      requesterId: principal.id,
    };
    const app = createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      resolvePrincipal: () => principal,
      delegateTask: start,
      taskRoomWork: {
        module,
        authorize: async () => scope,
        resolveContext: async () =>
          createTaskRoomContext(
            {
              taskId: 'durable-task',
              projectId: scope.projectId,
              taskCreatedAt: scope.taskCreatedAt,
            },
            {
              title: 'Objective',
              description: 'Investigate',
              documentRevision: 'revision-1',
              text: 'Selected shared brief.',
            },
          ),
      },
    });
    const send = (
      projectSlug: string,
      taskCreatedAt = scope.taskCreatedAt,
      context?: { version: 'station.task-room-context/v1'; digest: string },
      execution = executionAgentId,
      modelId = 'model-a',
    ) =>
      app.request('/delegations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Investigate this idea',
          target: {
            environment: { kind: 'current' },
            agent: execution
              ? {
                  kind: 'agent-execution-override',
                  agent: 'researcher',
                  executionAgent: execution,
                }
              : 'researcher',
            model: { override: modelId, options: { reasoningEffort: 'high' } },
            workspace: { kind: 'project', projectSlug },
          },
          taskRoomRequest: {
            taskId: 'durable-task',
            taskCreatedAt,
            operationId: context ? 'request-context' : 'request-1',
            ...(context ? { context } : {}),
          },
        }),
      });
    try {
      const denied = await send('other-project');
      expect(denied.status).toBe(403);
      expect(start).not.toHaveBeenCalled();
      const staleTask = await send('demo', '2026-09-29T12:00:00.000Z');
      expect(staleTask.status).toBe(403);
      expect(start).not.toHaveBeenCalled();
      const first = await send('demo');
      expect(first.status).toBe(200);
      const firstBody = await readJson<{ data: TaskRoomWorkOutcome }>(first);
      if (firstBody.data.kind !== 'recorded')
        throw new Error('expected recorded request');
      expect(firstBody.data).toMatchObject({
        kind: 'recorded',
        replayed: false,
        record: {
          taskId: 'durable-task',
          agentId: 'researcher',
          modelId: 'model-a',
          modelOptionsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          ...(executionAgentId ? { executionAgentId } : {}),
          requesterId: expect.stringMatching(/^task-room-requester:/),
          state: 'dispatched',
        },
      });
      const replay = await send('demo');
      expect(replay.status).toBe(200);
      expect(JSON.stringify(firstBody)).not.toContain(principal.id);
      expect(
        (await readJson<{ data: TaskRoomWorkOutcome }>(replay)).data,
      ).toMatchObject({
        kind: 'recorded',
        replayed: true,
        record: { sessionId: firstBody.data.record.sessionId },
      });
      expect(start).toHaveBeenCalledOnce();
      const changedEngine = await send(
        'demo',
        scope.taskCreatedAt,
        undefined,
        executionAgentId === 'codex' ? 'claude' : 'codex',
      );
      expect(changedEngine.status).toBe(409);
      const changedModel = await send(
        'demo',
        scope.taskCreatedAt,
        undefined,
        executionAgentId,
        'model-b',
      );
      expect(changedModel.status).toBe(409);
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0][0]).toMatchObject({
        target: {
          agent: executionAgentId
            ? {
                kind: 'agent-execution-override',
                agent: 'researcher',
                executionAgent: executionAgentId,
              }
            : 'researcher',
        },
        sessionId: firstBody.data.record.sessionId,
        parentTaskId: 'durable-task',
        userId: principal.id,
      });
      const snapshot = createTaskRoomContext(
        {
          taskId: 'durable-task',
          projectId: scope.projectId,
          taskCreatedAt: scope.taskCreatedAt,
        },
        {
          title: 'Objective',
          description: 'Investigate',
          documentRevision: 'revision-1',
          text: 'Selected shared brief.',
        },
      );
      if (!snapshot) throw new Error('Missing snapshot');
      const withContext = await send('demo', scope.taskCreatedAt, {
        version: snapshot.version,
        digest: snapshot.digest,
      });
      expect(withContext.status).toBe(200);
      expect(start.mock.calls[1][0].prompt).toContain('Selected shared brief.');
      expect(
        (await readJson<{ data: TaskRoomWorkOutcome }>(withContext)).data,
      ).toMatchObject({ kind: 'recorded', record: { context: snapshot } });
    } finally {
      await service.shutdown();
      eventStore.close();
    }
  },
);

test('real delegation refuses revoked Task authority at provider effects and leaves a clean turn boundary', async () => {
  const directory = makeTempDir('task-room-effect-');
  const eventStore = new EventStore(join(directory, 'events.sqlite'));
  const eventBus = new EventBus();
  class SessionTrackingAdapter extends GateTestAdapter {
    readonly sessions = new Map<string, ProviderSession>();
    override async startSession(input: ProviderSessionStartInput) {
      const session = await super.startSession(input);
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
    override async hasSession(threadId?: string) {
      return !!threadId && this.sessions.has(threadId);
    }
    override async listSessions() {
      return [...this.sessions.values()];
    }
  }
  const adapter = new SessionTrackingAdapter();
  const normalStart = adapter.startSession.bind(adapter);
  const started = vi.spyOn(adapter, 'startSession');
  const turned = vi.spyOn(adapter, 'sendTurn');
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus,
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
    resolveSessionAgent: async (input) => ({
      ...input,
      agent: { slug: 'researcher' },
    }),
  });
  const principal = humanPrincipal('test', 'alice', 'Alice');
  const module = new TaskRoomWorkModule(join(directory, 'work.json'));
  const inspector = new DatabaseSync(join(directory, 'events.sqlite'), {
    readOnly: true,
  });
  let revokedThread: string | undefined;
  let revokeDuringTurn = false;
  let allowed = true;
  const failures: unknown[] = [];
  let revokeDuringProjectRead = false;
  vi.stubEnv('STATION_API_BASE', 'http://task-room-effects.test');
  vi.stubEnv('STATION_INTERNAL_API_TOKEN', 'test-task-room-effects');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (raw) => {
      const url = String(raw);
      const response = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.endsWith('/.well-known/station/v1'))
        return response({ environmentId: 'current' });
      if (url.endsWith('/api/agents/researcher'))
        return response({
          success: true,
          data: {
            slug: 'researcher',
            name: 'Researcher',
            available: true,
            execution: { agentConnectionId: 'claude' },
          },
        });
      if (url.endsWith('/api/connections/claude'))
        return response({
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
      if (url.endsWith('/api/projects/demo')) {
        if (revokeDuringProjectRead) allowed = false;
        return response({
          success: true,
          data: { workingDirectory: directory },
        });
      }
      throw new Error(`Unmodeled request: ${url}`);
    }),
  );
  const app = createOrchestrationRoutes(service, {
    eventBus,
    logger: { debug: vi.fn() },
    resolvePrincipal: () => principal,
    delegateTask: async (input) => {
      try {
        return await delegateTask(input, service);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
    taskRoomWork: {
      module,
      authorize: async () => {
        if (revokeDuringTurn) {
          const row = inspector
            .prepare(
              "SELECT thread_id FROM orchestration_turn_boundaries WHERE purpose = 'turn' AND state = 'invoking'",
            )
            .get();
          if (row && typeof row.thread_id === 'string') {
            revokedThread = row.thread_id;
            allowed = false;
          }
        }
        return allowed
          ? {
              projectId: 'project',
              projectSlug: 'demo',
              roomProjectId: 'room-project',
              taskCreatedAt: '2026-09-30T12:00:00.000Z',
              requesterId: principal.id,
            }
          : undefined;
      },
    },
  });
  const send = (operationId: string, taskId = 'durable-task') =>
    app.request('/delegations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Investigate this idea',
        target: {
          environment: { kind: 'current' },
          agent: 'researcher',
          workspace: { kind: 'project', projectSlug: 'demo' },
        },
        taskRoomRequest: {
          taskId,
          taskCreatedAt: '2026-09-30T12:00:00.000Z',
          operationId,
        },
      }),
    });
  try {
    const control = await readJson<{ data: TaskRoomWorkOutcome }>(
      await send('control'),
    );
    expect(failures).toEqual([]);
    expect(control.data).toMatchObject({
      kind: 'recorded',
      record: { state: 'dispatched' },
    });
    expect(started).toHaveBeenCalledOnce();
    expect(turned).toHaveBeenCalledOnce();
    if (control.data.kind !== 'recorded')
      throw new Error('Missing positive-control request');
    expect(
      inspector
        .prepare(
          'SELECT project_id,task_id FROM project_task_room_execution_bindings WHERE session_id=?',
        )
        .get(control.data.record.sessionId),
    ).toMatchObject({ project_id: 'room-project', task_id: 'durable-task' });
    expect(
      hasPendingProjectTaskRoomExecution(inspector, {
        projectId: 'room-project',
        taskId: 'durable-task',
      }),
    ).toBe(true);
    revokeDuringProjectRead = true;
    const refused = await send('revoked');
    expect(refused.status).toBe(403);
    expect(started).toHaveBeenCalledOnce();
    expect(turned).toHaveBeenCalledOnce();
    allowed = true;
    revokeDuringProjectRead = false;
    started.mockImplementationOnce(async (input) => {
      const session = await normalStart(input);
      allowed = false;
      return session;
    });
    const turnRefused = await send('revoked-before-turn');
    expect(turnRefused.status).toBe(403);
    expect(started).toHaveBeenCalledTimes(2);
    expect(turned).toHaveBeenCalledOnce();
    allowed = true;
    revokeDuringTurn = true;
    const innerRefused = await send('revoked-inside-turn');
    expect(innerRefused.status).toBe(403);
    expect(revokedThread).toBeDefined();
    expect(started).toHaveBeenCalledTimes(3);
    expect(turned).toHaveBeenCalledOnce();
    expect(
      eventStore
        .sessionTurnBoundaryAuthority()
        .hasPossibleEffect(revokedThread!),
    ).toEqual({ kind: 'available', active: false });
    allowed = true;
    revokeDuringTurn = false;
    const continuation = await service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: { threadId: revokedThread!, input: 'Continue explicitly' },
      },
      { userId: principal.id, principal },
    );
    expect(continuation.receipt.status).toBe('accepted');
    expect(turned).toHaveBeenCalledTimes(2);
    const sealedScope = {
      projectId: 'room-project',
      projectSlug: 'demo',
      taskId: 'sealed-task',
    };
    const history = eventStore.createProjectTaskRoomHistory({
      capabilities: {
        resolve: async ({ required }) => ({
          kind: 'granted',
          receipt: {
            receiptId: `sealed-test-${required}`,
            capability: required,
            scope: sealedScope,
            principal: {
              kind: 'operator',
              operatorId: 'alice',
              deviceId: 'test-device',
            },
            policyRevision: 'sealed-test',
          },
        }),
      },
    });
    const grant = <K extends ProjectTaskRoomGrantKind>(
      capability: K,
    ): ProjectTaskRoomGrant<K> =>
      Object.freeze({
        schemaVersion: 'station.project-task-room-grant/v1',
        capability,
        opaqueToken: 'sealed-test',
      }) as ProjectTaskRoomGrant<K>;
    try {
      await history.open({ grant: grant('discover') });
      const seal = await history.sealSource({
        grant: grant('home-transfer'),
        operationId: 'seal-task',
        sourceHomeRef: 'station:source-test',
        targetHomeRef: 'paired:target',
      });
      expect(seal.kind).toBe('sealed');
      const afterSeal = await readJson<{ data: TaskRoomWorkOutcome }>(
        await send('sealed-request', sealedScope.taskId),
      );
      expect(afterSeal.data).toMatchObject({
        kind: 'recorded',
        record: { state: 'indeterminate' },
      });
      expect(started).toHaveBeenCalledTimes(3);
      expect(turned).toHaveBeenCalledTimes(2);
    } finally {
      await history.close();
    }
  } finally {
    inspector.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await service.shutdown();
    eventStore.close();
  }
});
