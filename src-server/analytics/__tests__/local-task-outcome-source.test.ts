import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import { LocalTaskOutcomeSource } from '../local-task-outcome-source.js';
import { usageTaskOutcomeKey } from '../usage-rollup-service.js';

const authority = sessionReadAuthorityFromRequest(
  'person',
  undefined,
  undefined,
);

test('local outcome attribution batches canonical reads, excludes peers and applies current Project read authority', async () => {
  const tasks = vi.fn(() => [
    {
      id: 'one',
      projectId: 'project',
      createdAt: '2026-08-01T00:00:00.000Z',
      status: 'done' as const,
    },
    {
      id: 'two',
      projectId: 'project',
      createdAt: '2026-08-01T00:00:00.000Z',
      status: 'blocked' as const,
    },
    {
      id: 'restricted',
      projectId: 'project',
      createdAt: '2026-08-01T00:00:00.000Z',
      status: 'done' as const,
    },
  ]);
  const authorize = vi.fn(
    async (task: Pick<TaskRecord, 'id' | 'projectId' | 'createdAt'>) =>
      task.id !== 'restricted',
  );
  const source = new LocalTaskOutcomeSource(
    'local',
    tasks,
    authorize,
    () => true,
  );
  const result = await source.read(
    [
      { stationId: 'local', taskId: 'one' },
      { stationId: 'local', taskId: 'two' },
      { stationId: 'local', taskId: 'restricted' },
      { stationId: 'peer', taskId: 'one' },
    ],
    authority,
    new AbortController().signal,
  );
  expect(tasks).toHaveBeenCalledTimes(2);
  expect(
    authorize.mock.calls.filter(([task]) => task.id === 'one'),
  ).toHaveLength(2);
  expect(result.get(usageTaskOutcomeKey('local', 'one'))).toEqual({
    state: 'available',
    taskCreatedAt: '2026-08-01T00:00:00.000Z',
    status: 'done',
  });
  expect(result.get(usageTaskOutcomeKey('local', 'two'))).toEqual({
    state: 'available',
    taskCreatedAt: '2026-08-01T00:00:00.000Z',
    status: 'blocked',
  });
  expect(result.get(usageTaskOutcomeKey('local', 'restricted'))).toEqual({
    state: 'restricted',
  });
  expect(result.has(usageTaskOutcomeKey('peer', 'one'))).toBe(false);
});

test('Project movement or revocation during owner authorization cannot release an outcome', async () => {
  let projectId = 'project';
  const source = new LocalTaskOutcomeSource(
    'local',
    () => [
      {
        id: 'one',
        projectId,
        createdAt: '2026-08-01T00:00:00.000Z',
        status: 'done',
      },
    ],
    async () => {
      projectId = 'other';
      return true;
    },
    () => true,
  );
  expect(
    (
      await source.read(
        [{ stationId: 'local', taskId: 'one' }],
        authority,
        new AbortController().signal,
      )
    ).get(usageTaskOutcomeKey('local', 'one')),
  ).toEqual({ state: 'unavailable' });
  let current = true;
  const revoked = new LocalTaskOutcomeSource(
    'local',
    () => [
      {
        id: 'one',
        projectId: 'project',
        createdAt: '2026-08-01T00:00:00.000Z',
        status: 'done',
      },
    ],
    async () => {
      current = false;
      return true;
    },
    () => current,
  );
  await expect(
    revoked.read(
      [{ stationId: 'local', taskId: 'one' }],
      authority,
      new AbortController().signal,
    ),
  ).rejects.toThrow('authority changed');
});

test('the real analytics request seam consumes local canonical Task outcomes under its own usage authority', async () => {
  const { createAnalyticsRoutes } = await import(
    '../../routes/operations/analytics.js'
  );
  const window = { from: '2026-08-01', to: '2026-08-07' };
  const receipt = {
    id: 'event-1',
    stationId: 'local',
    provider: 'engine',
    taskId: 'one',
    observedAt: '2026-08-07T10:00:00.000Z',
    pricing: { status: 'unpriced' as const },
    reportedCost: { amount: 0, currency: 'USD' },
  };
  const tasks = vi.fn(() => [
    {
      id: 'one',
      projectId: 'project',
      createdAt: '2026-08-01T00:00:00.000Z',
      status: 'done' as const,
    },
  ]);
  const requestSource = vi.fn(
    () =>
      new LocalTaskOutcomeSource(
        'local',
        tasks,
        async (_project, passed) => passed === authority,
        () => true,
      ),
  );
  const app = createAnalyticsRoutes(
    {
      readUsageReceipts: () => ({
        receipts: [receipt],
        coverage: { stationId: 'local', state: 'complete', window },
      }),
    } as never,
    undefined,
    () => authority,
    undefined,
    'local',
    undefined,
    undefined,
    requestSource,
  );
  const response = await app.request(
    `http://station.test/usage-rollup?from=${window.from}&to=${window.to}`,
  );
  expect(response.status).toBe(200);
  expect(requestSource).toHaveBeenCalledTimes(1);
  const body = await response.json();
  expect(body).toHaveProperty('data.taskOutcomes', [
    {
      stationId: 'local',
      taskId: 'one',
      state: 'available',
      taskCreatedAt: '2026-08-01T00:00:00.000Z',
      status: 'done',
      receiptCount: 1,
      reportedCostBuckets: [{ amount: 0, currency: 'USD' }],
    },
  ]);
});

test('a replacement Task with the same id and Project never inherits the original incarnation outcome', async () => {
  let createdAt = '2026-08-01T00:00:00.000Z';
  const source = new LocalTaskOutcomeSource(
    'local',
    () => [{ id: 'one', projectId: 'project', createdAt, status: 'done' }],
    async () => {
      createdAt = '2026-08-02T00:00:00.000Z';
      return true;
    },
    () => true,
  );
  expect(
    (
      await source.read(
        [{ stationId: 'local', taskId: 'one' }],
        authority,
        new AbortController().signal,
      )
    ).get(usageTaskOutcomeKey('local', 'one')),
  ).toEqual({ state: 'unavailable' });
});

test('a peer-only receipt set does not read or authorize local Tasks', async () => {
  const read = vi.fn(() => []);
  const authorize = vi.fn(async () => true);
  const source = new LocalTaskOutcomeSource(
    'local',
    read,
    authorize,
    () => true,
  );
  expect(
    (
      await source.read(
        [{ stationId: 'peer', taskId: 'one' }],
        authority,
        new AbortController().signal,
      )
    ).size,
  ).toBe(0);
  expect(read).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});

test('the analytics response cannot stream an admitted Task outcome after its canonical read/share permission ends', async () => {
  const { createAnalyticsRoutes } = await import(
    '../../routes/operations/analytics.js'
  );
  let readable = true;
  const task = {
    id: 'one',
    projectId: 'project',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'done' as const,
  };
  const receipt = {
    id: 'event',
    stationId: 'local',
    provider: 'engine',
    taskId: task.id,
    observedAt: '2026-08-07T10:00:00.000Z',
    pricing: { status: 'unpriced' as const },
  };
  const window = { from: '2026-08-01', to: '2026-08-07' };
  const app = createAnalyticsRoutes(
    {
      readUsageReceipts: () => ({
        receipts: [receipt],
        coverage: { stationId: 'local', state: 'complete', window },
      }),
    } as never,
    undefined,
    () => authority,
    undefined,
    'local',
    undefined,
    undefined,
    () =>
      new LocalTaskOutcomeSource(
        'local',
        () => [task],
        async () => readable,
        () => true,
      ),
  );
  const response = await app.request(
    `http://station.test/usage-rollup?from=${window.from}&to=${window.to}`,
  );
  readable = false;
  await expect(response.text()).rejects.toThrow(
    'Project authorization ended before response delivery',
  );
});
