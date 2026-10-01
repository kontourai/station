import {
  TASK_ROOM_WORK_VERSION,
  type TaskRoomWorkInput,
  type TaskRoomWorkList,
  type TaskRoomWorkOutcome,
  type TaskRoomWorkRecord,
} from '@kontourai/station-contracts/task-room-work';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

export class TaskRoomWorkProtocolError extends Error {}
export class TaskRoomWorkNotSentError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function workRecord(
  value: unknown,
  taskId: string,
): value is TaskRoomWorkRecord {
  if (!object(value)) return false;
  return (
    value.version === TASK_ROOM_WORK_VERSION &&
    value.taskId === taskId &&
    [
      'projectId',
      'taskCreatedAt',
      'operationId',
      'requesterId',
      'agentId',
      'prompt',
      'sessionId',
      'createdAt',
    ].every((key) => typeof value[key] === 'string' && value[key].length > 0) &&
    typeof value.state === 'string' &&
    ['starting', 'dispatched', 'indeterminate', 'refused'].includes(value.state)
  );
}

async function data(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok || !object(body) || body.success !== true)
    throw envelopeError(response, body, 'Task agent request is unavailable.');
  return body.data;
}

/** A successful, versioned read is required before sending the additive create field. */
export async function fetchTaskRoomAgentRequests(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<Extract<TaskRoomWorkList, { kind: 'available' }>> {
  const value = await data(
    await getJson(
      `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/room/agent-requests`,
      options,
    ),
  );
  if (
    !object(value) ||
    value.version !== TASK_ROOM_WORK_VERSION ||
    value.kind !== 'available' ||
    !Array.isArray(value.records) ||
    !value.records.every((record) => workRecord(record, taskId))
  )
    throw new TaskRoomWorkProtocolError(
      'This Station does not support Task agent requests.',
    );
  return { kind: 'available', records: value.records };
}

export async function submitTaskRoomAgentRequest(
  apiBase: string,
  taskId: string,
  projectSlug: string,
  taskCreatedAt: string,
  input: TaskRoomWorkInput,
  options?: ClientRequestOptions,
): Promise<TaskRoomWorkOutcome> {
  try {
    await fetchTaskRoomAgentRequests(apiBase, taskId, options);
  } catch (cause) {
    throw new TaskRoomWorkNotSentError(
      'Task agent requests are unavailable. Nothing was sent.',
      cause,
    );
  }
  const value = await data(
    await mutateJson(
      `${apiBase}/api/orchestration/delegations`,
      'POST',
      options,
      {
        prompt: input.prompt,
        target: {
          environment: { kind: 'current' },
          agent: input.agentId,
          workspace: { kind: 'project', projectSlug },
        },
        taskRoomRequest: {
          taskId,
          taskCreatedAt,
          operationId: input.operationId,
        },
      },
    ),
  );
  if (
    object(value) &&
    value.kind === 'recorded' &&
    typeof value.replayed === 'boolean' &&
    workRecord(value.record, taskId) &&
    value.record.operationId === input.operationId &&
    value.record.agentId === input.agentId &&
    value.record.prompt === input.prompt.trim()
  )
    return { kind: 'recorded', record: value.record, replayed: value.replayed };
  if (
    object(value) &&
    value.kind === 'refused' &&
    (value.reason === 'access' ||
      value.reason === 'conflict' ||
      value.reason === 'capacity' ||
      value.reason === 'input')
  )
    return { kind: 'refused', reason: value.reason };
  throw new TaskRoomWorkProtocolError(
    'Agent request acknowledgement is unavailable. Check requests before retrying.',
  );
}
