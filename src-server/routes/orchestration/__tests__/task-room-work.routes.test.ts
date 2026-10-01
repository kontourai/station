import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { TaskRoomWorkOutcome } from '@kontourai/station-contracts/task-room-work';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { TaskRoomWorkModule } from '../../../services/projects/task-room-work-module.js';
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
