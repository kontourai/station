import { TASK_ROOM_WORK_VERSION } from '@kontourai/station-contracts/task-room-work';
import { afterEach, expect, test, vi } from 'vitest';
import {
  fetchTaskRoomAgentRequests,
  submitTaskRoomAgentRequest,
  TaskRoomWorkNotSentError,
} from '../client/task-room-work';

const input = {
  operationId: 'operation-1',
  agentId: 'researcher',
  prompt: 'Explore this idea',
};
const incarnation = '2026-09-30T12:00:00.000Z';
const record = {
  version: TASK_ROOM_WORK_VERSION,
  taskId: 'task-1',
  projectId: 'project-1',
  taskCreatedAt: incarnation,
  ...input,
  requesterId: 'task-room-requester:alice',
  sessionId: 'task:123',
  createdAt: incarnation,
  state: 'dispatched',
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
afterEach(() => vi.unstubAllGlobals());

test('an older Station never receives a delegation before version negotiation succeeds', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ kind: 'available', records: [] }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      input,
    ),
  ).rejects.toBeInstanceOf(TaskRoomWorkNotSentError);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe(
    'http://station.test/api/tasks/task-1/room/agent-requests',
  );
});

test('a room request preserves exact intent and incarnation across an explicit replay', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      String(url).endsWith('/agent-requests')
        ? response({
            version: TASK_ROOM_WORK_VERSION,
            kind: 'available',
            records: [],
          })
        : response({ kind: 'recorded', record, replayed: true }),
    );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      input,
    ),
  ).resolves.toMatchObject({ kind: 'recorded', replayed: true, record });
  const write = fetcher.mock.calls[1];
  expect(write[0]).toBe('http://station.test/api/orchestration/delegations');
  expect(JSON.parse(String(write[1]?.body))).toEqual({
    prompt: input.prompt,
    target: {
      environment: { kind: 'current' },
      agent: input.agentId,
      workspace: { kind: 'project', projectSlug: 'demo' },
    },
    taskRoomRequest: {
      taskId: 'task-1',
      taskCreatedAt: incarnation,
      operationId: input.operationId,
    },
  });
});

test('cross-Task history and mismatched acknowledgements are rejected rather than adopted', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      response({
        version: TASK_ROOM_WORK_VERSION,
        kind: 'available',
        records: [{ ...record, taskId: 'other-task' }],
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    fetchTaskRoomAgentRequests('http://station.test', 'task-1'),
  ).rejects.toThrow('does not support');
  fetcher.mockImplementation(async (url) =>
    String(url).endsWith('/agent-requests')
      ? response({
          version: TASK_ROOM_WORK_VERSION,
          kind: 'available',
          records: [],
        })
      : response({
          kind: 'recorded',
          record: { ...record, operationId: 'other-operation' },
          replayed: false,
        }),
  );
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      input,
    ),
  ).rejects.toThrow('acknowledgement is unavailable');
});
