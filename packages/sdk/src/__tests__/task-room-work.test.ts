import {
  TASK_ROOM_CONTEXT_VERSION,
  TASK_ROOM_WORK_VERSION,
} from '@kontourai/station-contracts/task-room-work';
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

test('a room request sends exact intent and incarnation and adopts a replay acknowledgement', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
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
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
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

test('context support is negotiated, the selected reference survives newer briefs, and mismatched receipts are rejected', async () => {
  const snapshot = {
    version: TASK_ROOM_CONTEXT_VERSION,
    digest: 'a'.repeat(64),
    title: 'Objective',
    description: '',
    documentRevision: 'revision-1',
    text: 'Selected brief.',
  };
  const intent = {
    ...input,
    context: { version: snapshot.version, digest: snapshot.digest },
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response({
      version: TASK_ROOM_WORK_VERSION,
      kind: 'available',
      records: [],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      intent,
    ),
  ).rejects.toBeInstanceOf(TaskRoomWorkNotSentError);
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockReset().mockImplementation(async (url) =>
    String(url).endsWith('/agent-requests')
      ? response({
          version: TASK_ROOM_WORK_VERSION,
          kind: 'available',
          records: [],
          contextVersion: TASK_ROOM_CONTEXT_VERSION,
          context: {
            ...snapshot,
            digest: 'b'.repeat(64),
            text: 'Newer brief.',
          },
        })
      : response({
          kind: 'recorded',
          replayed: true,
          record: { ...record, context: snapshot },
        }),
  );
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      intent,
    ),
  ).resolves.toMatchObject({ kind: 'recorded', replayed: true });
  expect(
    JSON.parse(String(fetcher.mock.calls[1][1]?.body)).taskRoomRequest.context,
  ).toEqual(intent.context);
  fetcher.mockImplementation(async (url) =>
    String(url).endsWith('/agent-requests')
      ? response({
          version: TASK_ROOM_WORK_VERSION,
          kind: 'available',
          records: [],
          contextVersion: TASK_ROOM_CONTEXT_VERSION,
          context: snapshot,
        })
      : response({
          kind: 'recorded',
          replayed: true,
          record: {
            ...record,
            context: { ...snapshot, digest: 'b'.repeat(64) },
          },
        }),
  );
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      intent,
    ),
  ).rejects.toThrow('acknowledgement');
});

test('an explicit context refusal is not sent while a lost acknowledgement stays uncertain', async () => {
  const context = {
    version: TASK_ROOM_CONTEXT_VERSION,
    digest: 'a'.repeat(64),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).endsWith('/agent-requests')
      ? response({
          version: TASK_ROOM_WORK_VERSION,
          kind: 'available',
          records: [],
          contextVersion: TASK_ROOM_CONTEXT_VERSION,
          context: null,
        })
      : new Response(
          JSON.stringify({
            success: false,
            data: { kind: 'refused', reason: 'context' },
          }),
          { status: 409 },
        ),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      { ...input, context },
    ),
  ).rejects.toThrow('Nothing was sent');
  fetcher.mockImplementation(async (url) => {
    if (String(url).endsWith('/agent-requests'))
      return response({
        version: TASK_ROOM_WORK_VERSION,
        kind: 'available',
        records: [],
        contextVersion: TASK_ROOM_CONTEXT_VERSION,
        context: null,
      });
    throw new Error('lost acknowledgement');
  });
  await expect(
    submitTaskRoomAgentRequest(
      'http://station.test',
      'task-1',
      'demo',
      incarnation,
      { ...input, context },
    ),
  ).rejects.not.toBeInstanceOf(TaskRoomWorkNotSentError);
});
