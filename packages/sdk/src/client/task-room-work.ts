import { isTaskRoomAttachments } from '@kontourai/station-contracts/project-task-room';
import {
  isSharedAgentRequest,
  isSharedResultRef,
  isSharedThreadRef,
  type SharedAgentRequest,
  type SharedContextSnapshot,
  type SharedResultRef,
  type SharedTaskIdentity,
  type SharedWorkCapability,
  type SharedWorkOutcome,
  type SharedWorkRecord,
  TASK_ROOM_CONTEXT_VERSION,
  TASK_ROOM_SHARED_CONTEXT_VERSION,
  TASK_ROOM_SHARED_RESULT_VERSION,
  TASK_ROOM_SHARED_WORK_VERSION,
  TASK_ROOM_WORK_VERSION,
  type TaskRoomContextSnapshot,
  type TaskRoomWorkInput,
  type TaskRoomWorkList,
  type TaskRoomWorkOutcome,
  type TaskRoomWorkRecord,
} from '@kontourai/station-contracts/task-room-work';
import { envelopeError } from './api-error-message';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  getJson,
  mutateJson,
} from './http';

/** Stable option identity shared by the request sender and durable reservation owner. */
export async function taskRoomModelOptionsDigest(
  options: unknown,
): Promise<string> {
  const canonical = JSON.stringify(options, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : value,
  );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

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

function contextSnapshot(value: unknown): value is TaskRoomContextSnapshot {
  return (
    object(value) &&
    value.version === TASK_ROOM_CONTEXT_VERSION &&
    typeof value.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.digest) &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    value.title.length <= 512 &&
    typeof value.description === 'string' &&
    value.description.length <= 12000 &&
    typeof value.documentRevision === 'string' &&
    value.documentRevision.length > 0 &&
    value.documentRevision.length <= 256 &&
    typeof value.text === 'string' &&
    value.text.length <= 16000
  );
}

function workRecord(
  value: unknown,
  taskId: string,
): value is TaskRoomWorkRecord {
  if (!object(value)) return false;
  return (
    (value.attachments === undefined ||
      isTaskRoomAttachments(value.attachments)) &&
    value.version === TASK_ROOM_WORK_VERSION &&
    value.taskId === taskId &&
    (value.expectedDefinitionFingerprint === undefined ||
      (typeof value.expectedDefinitionFingerprint === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(value.expectedDefinitionFingerprint))) &&
    (value.modelId === undefined ||
      (typeof value.modelId === 'string' &&
        value.modelId.length > 0 &&
        value.modelId.length <= 512)) &&
    (value.modelOptionsDigest === undefined ||
      (typeof value.modelOptionsDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(value.modelOptionsDigest))) &&
    (value.executionAgentId === undefined ||
      (typeof value.executionAgentId === 'string' &&
        value.executionAgentId.length > 0 &&
        value.executionAgentId.length <= 64)) &&
    (value.context === undefined || contextSnapshot(value.context)) &&
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
  if (
    value.contextVersion !== undefined &&
    (value.contextVersion !== TASK_ROOM_CONTEXT_VERSION ||
      (value.context !== null && !contextSnapshot(value.context)))
  )
    throw new TaskRoomWorkProtocolError('Task brief context is unavailable.');
  return {
    kind: 'available',
    records: value.records,
    ...(value.contextVersion === TASK_ROOM_CONTEXT_VERSION
      ? {
          contextVersion: TASK_ROOM_CONTEXT_VERSION,
          context: contextSnapshot(value.context) ? value.context : null,
        }
      : {}),
  };
}

export async function submitTaskRoomAgentRequest(
  apiBase: string,
  taskId: string,
  projectSlug: string,
  taskCreatedAt: string,
  input: TaskRoomWorkInput,
  options?: ClientRequestOptions,
): Promise<TaskRoomWorkOutcome> {
  if (input.expectedDefinitionFingerprint && !input.executionAgentId)
    throw new TaskRoomWorkNotSentError(
      'A verified Agent definition requires an explicit execution binding. Nothing was sent.',
    );
  const modelId = input.model?.override?.trim() || undefined;
  const modelOptionsDigest =
    input.model?.options === undefined
      ? undefined
      : await taskRoomModelOptionsDigest(input.model.options);
  try {
    const supported = await fetchTaskRoomAgentRequests(
      apiBase,
      taskId,
      options,
    );
    if (input.context && supported.contextVersion !== TASK_ROOM_CONTEXT_VERSION)
      throw new TaskRoomWorkProtocolError(
        'This Station does not support saved Task briefs.',
      );
  } catch (cause) {
    throw new TaskRoomWorkNotSentError(
      'Task agent requests are unavailable. Nothing was sent.',
      cause,
    );
  }
  const response = await mutateJson(
    `${apiBase}/api/orchestration/delegations`,
    'POST',
    options,
    {
      prompt: input.prompt,
      clientTurnId: input.operationId,
      target: {
        environment: { kind: 'current' },
        agent: input.executionAgentId
          ? {
              kind: 'agent-execution-override',
              agent: input.agentId,
              executionAgent: input.executionAgentId,
              ...(input.expectedDefinitionFingerprint
                ? {
                    expectedDefinitionFingerprint:
                      input.expectedDefinitionFingerprint,
                  }
                : {}),
            }
          : input.agentId,
        ...(input.model ? { model: input.model } : {}),
        workspace: { kind: 'project', projectSlug },
      },
      taskRoomRequest: {
        taskId,
        taskCreatedAt,
        operationId: input.operationId,
        ...(input.attachments?.length
          ? { attachments: input.attachments }
          : {}),
        ...(input.context ? { context: input.context } : {}),
      },
    },
  );
  const acknowledgement: unknown = await response.json();
  if (
    response.status === 409 &&
    object(acknowledgement) &&
    acknowledgement.success === false &&
    acknowledgement.code === 'task_room_attachments_unavailable'
  )
    throw new TaskRoomWorkNotSentError(
      'Task attachments are unavailable. Choose the files again. Nothing was sent.',
    );
  if (
    input.context &&
    response.status === 409 &&
    object(acknowledgement) &&
    acknowledgement.success === false &&
    object(acknowledgement.data) &&
    acknowledgement.data.kind === 'refused' &&
    acknowledgement.data.reason === 'context'
  )
    throw new TaskRoomWorkNotSentError(
      'The Task brief changed or is unavailable. Refresh the brief before sending. Nothing was sent.',
    );
  if (
    !response.ok ||
    !object(acknowledgement) ||
    acknowledgement.success !== true
  )
    throw envelopeError(
      response,
      acknowledgement,
      'Task agent request is unavailable.',
    );
  const value = acknowledgement.data;
  if (
    object(value) &&
    value.kind === 'recorded' &&
    typeof value.replayed === 'boolean' &&
    workRecord(value.record, taskId) &&
    value.record.operationId === input.operationId &&
    value.record.agentId === input.agentId &&
    value.record.executionAgentId === input.executionAgentId &&
    value.record.expectedDefinitionFingerprint ===
      input.expectedDefinitionFingerprint &&
    value.record.modelId === modelId &&
    value.record.modelOptionsDigest === modelOptionsDigest &&
    (value.record.attachments ?? []).length ===
      (input.attachments ?? []).length &&
    (value.record.attachments ?? []).every((attachment, index) => {
      const other = input.attachments?.[index];
      return (
        other &&
        attachment.id === other.id &&
        attachment.kind === other.kind &&
        attachment.name === other.name &&
        attachment.mimeType === other.mimeType &&
        attachment.size === other.size
      );
    }) &&
    value.record.prompt === input.prompt.trim() &&
    value.record.taskCreatedAt === taskCreatedAt &&
    value.record.context?.digest === input.context?.digest
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

// UNWIRED(#4659): these paths negotiate a future shared receiver.
export interface SharedWorkRequestOptions extends ClientRequestOptions {
  requestScope: ApiRequestScope;
  isCurrent: () => boolean;
}
const unavailable = (): SharedWorkCapability => ({
  version: TASK_ROOM_SHARED_WORK_VERSION,
  kind: 'unavailable',
  reason: 'unsupported',
});
const sharedPath = (apiBase: string, taskId: string) =>
  `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/room/agent-requests/shared`;
const sharedDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sharedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value;
const keys = (
  value: unknown,
  names: readonly string[],
): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.keys(value).includes(name));
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left, canonicalOrder) ===
  JSON.stringify(right, canonicalOrder);
function canonicalOrder(_key: string, value: unknown): unknown {
  return object(value)
    ? Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      )
    : value;
}
function sameTask(
  value: SharedTaskIdentity,
  scope: SharedTaskIdentity,
): boolean {
  return (
    value.projectId === scope.projectId &&
    value.taskId === scope.taskId &&
    value.taskCreatedAt === scope.taskCreatedAt
  );
}
function sharedBrief(value: unknown): value is TaskRoomContextSnapshot {
  return (
    keys(value, [
      'version',
      'digest',
      'title',
      'description',
      'documentRevision',
      'text',
    ]) && contextSnapshot(value)
  );
}
function sharedSnapshot(
  value: unknown,
  scope: SharedTaskIdentity,
  input: SharedAgentRequest,
): value is SharedContextSnapshot {
  return (
    keys(value, ['version', 'digest', 'brief', 'results']) &&
    value.version === TASK_ROOM_SHARED_CONTEXT_VERSION &&
    sharedDigest(value.digest) &&
    sharedBrief(value.brief) &&
    value.brief.digest === input.context.brief.digest &&
    value.brief.documentRevision === input.context.brief.documentRevision &&
    Array.isArray(value.results) &&
    value.results.length === input.context.results.length &&
    value.results.every(
      (item, index) =>
        keys(item, ['reference', 'markdown']) &&
        isSharedResultRef(item.reference) &&
        sameTask(item.reference, scope) &&
        same(item.reference, input.context.results[index]) &&
        typeof item.markdown === 'string',
    )
  );
}
async function publishedDigest(markdown: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(markdown),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function snapshotContentMatches(
  snapshot: SharedContextSnapshot,
): Promise<boolean> {
  for (const result of snapshot.results) {
    if (
      (await publishedDigest(result.markdown)) !==
      result.reference.contentDigest
    )
      return false;
  }
  return true;
}
function sharedRecord(
  value: unknown,
  scope: SharedTaskIdentity,
  input: SharedAgentRequest,
  inputDigest: string,
): value is SharedWorkRecord {
  return (
    keys(value, [
      'version',
      'projectId',
      'taskId',
      'taskCreatedAt',
      'operationId',
      'requesterId',
      'expectedActorId',
      'agentId',
      'modelId',
      'inputDigest',
      'context',
      'thread',
      'target',
      'state',
    ]) &&
    value.version === TASK_ROOM_SHARED_WORK_VERSION &&
    value.projectId === scope.projectId &&
    value.taskId === scope.taskId &&
    value.taskCreatedAt === scope.taskCreatedAt &&
    value.operationId === input.operationId &&
    sharedText(value.requesterId, 512) &&
    value.expectedActorId === input.expectedActorId &&
    value.agentId === input.agentId &&
    value.modelId === input.modelId &&
    value.inputDigest === inputDigest &&
    isSharedThreadRef(value.thread) &&
    sameTask(value.thread, scope) &&
    (input.target.kind === 'new-thread' ||
      same(value.thread, input.target.thread)) &&
    same(value.target, input.target) &&
    sharedSnapshot(value.context, scope, input) &&
    typeof value.state === 'string' &&
    [
      'waiting',
      'placing',
      'placed',
      'refused',
      'withdrawn',
      'unconfirmed',
    ].includes(value.state)
  );
}
export async function fetchSharedTaskRoomCapabilities(
  apiBase: string,
  taskId: string,
  options: SharedWorkRequestOptions,
): Promise<SharedWorkCapability> {
  if (!options.isCurrent() || options.requestScope.apiBase !== apiBase)
    throw new TaskRoomWorkProtocolError('Task request connection changed.');
  let response: Response;
  try {
    response = await getJson(
      `${sharedPath(apiBase, taskId)}-capabilities`,
      options,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return unavailable();
  }
  if (response.status === 404) return unavailable();
  let value: unknown;
  try {
    value = await data(response);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return unavailable();
  }
  if (!options.isCurrent())
    throw new TaskRoomWorkProtocolError('Task request connection changed.');
  if (!object(value) || value.version !== TASK_ROOM_SHARED_WORK_VERSION)
    return unavailable();
  if (
    keys(value, ['version', 'kind', 'reason']) &&
    value.kind === 'unavailable' &&
    typeof value.reason === 'string' &&
    [
      'unsupported',
      'access',
      'host',
      'agent',
      'model',
      'compute',
      'confinement',
    ].includes(value.reason)
  ) {
    switch (value.reason) {
      case 'unsupported':
      case 'access':
      case 'host':
      case 'agent':
      case 'model':
      case 'compute':
      case 'confinement':
        return {
          version: TASK_ROOM_SHARED_WORK_VERSION,
          kind: 'unavailable',
          reason: value.reason,
        };
    }
  }
  if (
    !keys(value, [
      'version',
      'kind',
      'contextVersion',
      'resultVersion',
      'mode',
      'nextTurn',
      'agents',
      'context',
    ]) ||
    value.kind !== 'available' ||
    value.contextVersion !== TASK_ROOM_SHARED_CONTEXT_VERSION ||
    value.resultVersion !== TASK_ROOM_SHARED_RESULT_VERSION ||
    value.mode !== 'model-only' ||
    value.nextTurn !== 'durable' ||
    !Array.isArray(value.agents) ||
    value.agents.length > 160 ||
    !value.agents.every(
      (agent) =>
        keys(agent, ['agentId', 'definitionFingerprint', 'modelIds']) &&
        sharedText(agent.agentId, 160) &&
        typeof agent.definitionFingerprint === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(agent.definitionFingerprint) &&
        Array.isArray(agent.modelIds) &&
        agent.modelIds.length > 0 &&
        agent.modelIds.length <= 160 &&
        agent.modelIds.every((id) => sharedText(id, 512)) &&
        new Set(agent.modelIds).size === agent.modelIds.length,
    ) ||
    (value.context !== null && !sharedBrief(value.context))
  )
    return unavailable();
  return {
    version: TASK_ROOM_SHARED_WORK_VERSION,
    kind: 'available',
    contextVersion: TASK_ROOM_SHARED_CONTEXT_VERSION,
    resultVersion: TASK_ROOM_SHARED_RESULT_VERSION,
    mode: 'model-only',
    nextTurn: 'durable',
    agents: value.agents,
    context: value.context,
  };
}
export async function submitSharedTaskRoomAgentRequest(
  apiBase: string,
  scope: SharedTaskIdentity,
  input: SharedAgentRequest,
  options: SharedWorkRequestOptions,
): Promise<SharedWorkOutcome> {
  if (!options.isCurrent() || options.requestScope.apiBase !== apiBase)
    return { kind: 'not-sent', reason: 'authority' };
  if (
    !isSharedAgentRequest(input) ||
    input.taskCreatedAt !== scope.taskCreatedAt ||
    input.context.results.some((ref) => !sameTask(ref, scope)) ||
    (input.target.kind === 'thread' && !sameTask(input.target.thread, scope))
  )
    return { kind: 'not-sent', reason: 'input' };
  const intent = structuredClone(input);
  const task = { ...scope };
  const capability = await fetchSharedTaskRoomCapabilities(
    apiBase,
    task.taskId,
    options,
  );
  if (
    capability.kind !== 'available' ||
    !capability.agents.some(
      (agent) =>
        agent.agentId === intent.agentId &&
        agent.modelIds.includes(intent.modelId),
    )
  )
    return { kind: 'not-sent', reason: 'unavailable' };
  if (options.signal?.aborted) throw options.signal.reason;
  const inputDigest = await taskRoomModelOptionsDigest(intent);
  if (!options.isCurrent()) return { kind: 'not-sent', reason: 'authority' };
  try {
    const response = await mutateJson(
      sharedPath(apiBase, task.taskId),
      'POST',
      options,
      intent,
    );
    const value = await data(response);
    if (
      options.isCurrent() &&
      keys(value, ['kind', 'record', 'replayed']) &&
      value.kind === 'accepted' &&
      typeof value.replayed === 'boolean' &&
      sharedRecord(value.record, task, intent, inputDigest) &&
      (await snapshotContentMatches(value.record.context)) &&
      options.isCurrent()
    )
      return {
        kind: 'accepted',
        record: value.record,
        replayed: value.replayed,
      };
  } catch {
    // Once dispatch begins, failure or cancellation does not prove non-acceptance.
  }
  return { kind: 'unconfirmed', operationId: intent.operationId, intent };
}
export async function fetchSharedTaskRoomRequests(
  apiBase: string,
  scope: SharedTaskIdentity,
  input: SharedAgentRequest,
  options: SharedWorkRequestOptions,
): Promise<readonly SharedWorkRecord[]> {
  if (!options.isCurrent() || options.requestScope.apiBase !== apiBase)
    throw new TaskRoomWorkProtocolError('Task request connection changed.');
  if (
    !isSharedAgentRequest(input) ||
    input.taskCreatedAt !== scope.taskCreatedAt
  )
    throw new TaskRoomWorkProtocolError('Invalid shared request.');
  const intent = structuredClone(input);
  const task = { ...scope };
  const inputDigest = await taskRoomModelOptionsDigest(intent);
  const value = await data(
    await getJson(sharedPath(apiBase, task.taskId), options),
  );
  if (
    !keys(value, ['version', 'records']) ||
    value.version !== TASK_ROOM_SHARED_WORK_VERSION ||
    !Array.isArray(value.records)
  )
    throw new TaskRoomWorkProtocolError('Invalid shared request records.');
  const matches: SharedWorkRecord[] = [];
  for (const record of value.records) {
    if (!object(record) || !sharedText(record.operationId, 160))
      throw new TaskRoomWorkProtocolError('Invalid shared request record.');
    if (record.operationId !== intent.operationId) continue;
    if (
      !sharedRecord(record, task, intent, inputDigest) ||
      !(await snapshotContentMatches(record.context))
    )
      throw new TaskRoomWorkProtocolError('Invalid shared request record.');
    matches.push(record);
  }
  if (!options.isCurrent())
    throw new TaskRoomWorkProtocolError('Task request connection changed.');
  return matches;
}
export async function withdrawSharedTaskRoomRequest(
  apiBase: string,
  scope: SharedTaskIdentity,
  input: SharedAgentRequest,
  options: SharedWorkRequestOptions,
): Promise<SharedWorkOutcome> {
  if (!options.isCurrent() || options.requestScope.apiBase !== apiBase)
    return { kind: 'not-sent', reason: 'authority' };
  if (
    !isSharedAgentRequest(input) ||
    input.taskCreatedAt !== scope.taskCreatedAt
  )
    return { kind: 'not-sent', reason: 'input' };
  if (options?.signal?.aborted) throw options.signal.reason;
  const intent = structuredClone(input);
  const task = { ...scope };
  const inputDigest = await taskRoomModelOptionsDigest(intent);
  if (!options.isCurrent()) return { kind: 'not-sent', reason: 'authority' };
  try {
    const value = await data(
      await mutateJson(
        `${sharedPath(apiBase, task.taskId)}/${encodeURIComponent(intent.operationId)}`,
        'DELETE',
        options,
      ),
    );
    if (
      keys(value, ['kind', 'record', 'replayed']) &&
      value.kind === 'accepted' &&
      typeof value.replayed === 'boolean' &&
      sharedRecord(value.record, task, intent, inputDigest) &&
      (await snapshotContentMatches(value.record.context)) &&
      options.isCurrent()
    )
      return {
        kind: 'accepted',
        record: value.record,
        replayed: value.replayed,
      };
  } catch {
    // A dispatched withdrawal can settle even if its response is lost.
  }
  return {
    kind: 'unconfirmed',
    operationId: intent.operationId,
    intent,
  };
}
export async function fetchSharedTaskRoomResult(
  apiBase: string,
  scope: SharedTaskIdentity,
  reference: SharedResultRef,
  options: SharedWorkRequestOptions,
): Promise<string> {
  if (!options.isCurrent() || options.requestScope.apiBase !== apiBase)
    throw new TaskRoomWorkProtocolError('Task request connection changed.');
  if (!isSharedResultRef(reference) || !sameTask(reference, scope))
    throw new TaskRoomWorkProtocolError('Invalid shared result reference.');
  const query = new URLSearchParams({
    sequence: String(reference.sequence),
    proposalDigest: reference.proposalDigest,
    contentDigest: reference.contentDigest,
  });
  const value = await data(
    await getJson(
      `${apiBase}/api/tasks/${encodeURIComponent(scope.taskId)}/room/agent-results/${encodeURIComponent(reference.sessionId)}/${encodeURIComponent(reference.turnId)}?${query}`,
      options,
    ),
  );
  if (
    !keys(value, ['reference', 'markdown']) ||
    !same(value.reference, reference) ||
    typeof value.markdown !== 'string'
  )
    throw new TaskRoomWorkProtocolError('Invalid shared result.');
  if ((await publishedDigest(value.markdown)) !== reference.contentDigest)
    throw new TaskRoomWorkProtocolError('Shared result digest mismatch.');
  if (!options.isCurrent())
    throw new TaskRoomWorkProtocolError('Task request connection changed.');
  return value.markdown;
}
