import { expect, test } from 'vitest';
import {
  isSharedAgentRequest,
  TASK_ROOM_SHARED_CONTEXT_VERSION,
  TASK_ROOM_SHARED_RESULT_VERSION,
  TASK_ROOM_SHARED_WORK_VERSION,
} from '../task-room-work.js';

const thread = {
  projectId: 'project',
  taskId: 'task',
  taskCreatedAt: '2026-11-06T00:00:00.000Z',
  conversationId: 'conversation',
  originSessionId: 'session',
};
const result = {
  ...thread,
  version: TASK_ROOM_SHARED_RESULT_VERSION,
  sessionId: 'session',
  turnId: 'turn',
  sequence: 1,
  proposalDigest: 'a'.repeat(64),
  contentDigest: 'b'.repeat(64),
};
const request = {
  version: TASK_ROOM_SHARED_WORK_VERSION,
  expectedActorId: 'actor',
  taskCreatedAt: thread.taskCreatedAt,
  operationId: 'op',
  agentId: 'agent',
  modelId: 'model',
  context: {
    version: TASK_ROOM_SHARED_CONTEXT_VERSION,
    brief: { documentRevision: 'rev', digest: 'c'.repeat(64) },
    results: [result],
  },
  prompt: 'Hello',
  target: { kind: 'thread', thread },
};

test('shared requests require closed, bounded versioned references', () => {
  expect(isSharedAgentRequest(request)).toBe(true);
  for (const invalid of [
    { ...request, attachments: [] },
    { ...request, modelId: 'x'.repeat(513) },
    { ...request, version: 'future' },
    {
      ...request,
      target: {
        kind: 'thread',
        thread: { ...thread, taskCreatedAt: '2020-01-01' },
      },
    },
    {
      ...request,
      context: {
        ...request.context,
        results: [{ ...result, contentDigest: 'A'.repeat(64) }],
      },
    },
    {
      ...request,
      context: { ...request.context, results: [{ ...result, sequence: 0 }] },
    },
    { ...request, target: { kind: 'new-thread', credentials: 'secret' } },
  ])
    expect(isSharedAgentRequest(invalid)).toBe(false);
});
