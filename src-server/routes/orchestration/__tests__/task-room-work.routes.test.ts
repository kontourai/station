import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { TaskRoomWorkOutcome } from '@kontourai/station-contracts/task-room-work';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import type { ProviderSessionStartInput } from '../../../providers/adapter-shape.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { TaskRoomWorkModule } from '../../../services/projects/task-room-work-module.js';
import { delegateTask } from '../../../tools/station-control-delegation.js';
import { createOrchestrationRoutes } from '../orchestration.js';

test('the delegation route records one channel request and refuses a target outside its Task Project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-room-work-route-'));
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
    taskCreatedAt: '2026-09-30T12:00:00.000Z',
    requesterId: principal.id,
  };
  const app = createOrchestrationRoutes(service, {
    eventBus,
    logger: { debug: vi.fn() },
    resolvePrincipal: () => principal,
    delegateTask: start,
    taskRoomWork: { module, authorize: async () => scope },
  });
  const send = (projectSlug: string) =>
    app.request('/delegations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Investigate this idea',
        target: {
          environment: { kind: 'current' },
          agent: 'researcher',
          workspace: { kind: 'project', projectSlug },
        },
        taskRoomRequest: { taskId: 'durable-task', operationId: 'request-1' },
      }),
    });
  try {
    const denied = await send('other-project');
    expect(denied.status).toBe(403);
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
    expect(start.mock.calls[0][0]).toMatchObject({
      sessionId: firstBody.data.record.sessionId,
      parentTaskId: 'durable-task',
      userId: principal.id,
    });
  } finally {
    await service.shutdown();
    eventStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('real delegation refuses revoked Task authority at provider effects and leaves a clean turn boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-room-effect-'));
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
              taskCreatedAt: '2026-09-30T12:00:00.000Z',
              requesterId: principal.id,
            }
          : undefined;
      },
    },
  });
  const send = (operationId: string) =>
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
        taskRoomRequest: { taskId: 'durable-task', operationId },
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
  } finally {
    inspector.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await service.shutdown();
    eventStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
