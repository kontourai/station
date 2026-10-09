import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  TASK_ROOM_CONTEXT_VERSION,
  TASK_ROOM_WORK_VERSION,
  type TaskRoomContextSnapshot,
  type TaskRoomWorkInput,
  type TaskRoomWorkList,
  type TaskRoomWorkOutcome,
  type TaskRoomWorkRecord,
} from '@kontourai/station-contracts/task-room-work';
import { taskRoomModelOptionsDigest } from '@kontourai/station-sdk/client';
import {
  mutateJsonFile,
  mutateJsonFileWithGuardedRead,
} from '../../domain/file-storage-helpers.js';
import type { ReceiverExecutionEffectAdmission } from '../orchestration/session-command-module.js';
import { validTaskRoomContext } from './task-room-context.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 256;
type StoredRecord = Omit<TaskRoomWorkRecord, 'requesterId'> & {
  ownerId: string;
};
const CONTEXT_STORE_VERSION = 'station.task-room-work-store/v2' as const;
const EXECUTION_STORE_VERSION = 'station.task-room-work-store/v3' as const;
type Store = {
  version:
    | typeof TASK_ROOM_WORK_VERSION
    | typeof CONTEXT_STORE_VERSION
    | typeof EXECUTION_STORE_VERSION;
  records: StoredRecord[];
};
export type TaskRoomWorkScope = {
  projectId: string;
  projectSlug: string;
  roomProjectId: string;
  taskCreatedAt: string;
  requesterId: string;
};
export type TaskRoomInvocationAdmission = ReceiverExecutionEffectAdmission & {
  readonly roomBinding: { readonly projectId: string; readonly taskId: string };
};
type Scope = TaskRoomWorkScope;
class TaskRoomWorkUnavailableError extends Error {}
export class TaskRoomWorkAuthorityChangedError extends Error {}

function validText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= limit
  );
}

function validRecord(value: unknown): value is StoredRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).length ===
      11 +
        Number(r.context !== undefined) +
        Number(r.executionAgentId !== undefined) +
        Number(r.modelId !== undefined) +
        Number(r.modelOptionsDigest !== undefined) +
        Number(r.expectedDefinitionFingerprint !== undefined) &&
    (r.executionAgentId === undefined || validText(r.executionAgentId, 64)) &&
    (r.expectedDefinitionFingerprint === undefined ||
      (r.executionAgentId !== undefined &&
        typeof r.expectedDefinitionFingerprint === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(r.expectedDefinitionFingerprint))) &&
    (r.modelId === undefined || validText(r.modelId, 512)) &&
    (r.modelOptionsDigest === undefined ||
      (typeof r.modelOptionsDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(r.modelOptionsDigest))) &&
    validText(r.taskId, 160) &&
    validText(r.projectId, 160) &&
    validText(r.taskCreatedAt, 40) &&
    (r.context === undefined ||
      validTaskRoomContext(r.context, {
        taskId: r.taskId,
        projectId: r.projectId,
        taskCreatedAt: r.taskCreatedAt,
      })) &&
    r.version === TASK_ROOM_WORK_VERSION &&
    ['operationId', 'ownerId', 'agentId'].every((key) =>
      validText(r[key], 160),
    ) &&
    validText(r.prompt, 12_000) &&
    typeof r.sessionId === 'string' &&
    /^task:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      r.sessionId,
    ) &&
    typeof r.createdAt === 'string' &&
    !Number.isNaN(Date.parse(r.createdAt)) &&
    typeof r.state === 'string' &&
    ['starting', 'dispatched', 'indeterminate', 'refused'].includes(r.state)
  );
}

function checkedStore(value: unknown): Store {
  if (!value || typeof value !== 'object')
    throw new TaskRoomWorkUnavailableError(
      'Agent request history is unavailable.',
    );
  const store = value as Store;
  if (
    Object.keys(store).length !== 2 ||
    (store.version !== TASK_ROOM_WORK_VERSION &&
      store.version !== CONTEXT_STORE_VERSION &&
      store.version !== EXECUTION_STORE_VERSION) ||
    !Array.isArray(store.records) ||
    store.records.length > MAX_REQUESTS ||
    !store.records.every(validRecord) ||
    (store.version !== EXECUTION_STORE_VERSION &&
      store.records.some(
        (record) =>
          record.executionAgentId !== undefined ||
          record.expectedDefinitionFingerprint !== undefined ||
          record.modelId !== undefined ||
          record.modelOptionsDigest !== undefined,
      )) ||
    (store.version === TASK_ROOM_WORK_VERSION &&
      store.records.some((record) => record.context !== undefined))
  )
    throw new TaskRoomWorkUnavailableError('Agent request history is corrupt.');
  const identities = new Set(
    store.records.map((r) =>
      JSON.stringify([r.taskId, r.ownerId, r.operationId]),
    ),
  );
  if (identities.size !== store.records.length)
    throw new TaskRoomWorkUnavailableError(
      'Agent request identities conflict.',
    );
  if (
    new Set(store.records.map((record) => record.sessionId)).size !==
    store.records.length
  )
    throw new TaskRoomWorkUnavailableError(
      'Agent execution identities conflict.',
    );
  return store;
}

function publishedRecord(record: StoredRecord): TaskRoomWorkRecord {
  const { ownerId, ...view } = record;
  return { ...view, requesterId: requesterDisplayId(record.taskId, ownerId) };
}

function requesterDisplayId(taskId: string, ownerId: string): string {
  return `task-room-requester:${createHash('sha256')
    .update(JSON.stringify([taskId, ownerId]))
    .digest('hex')
    .slice(0, 24)}`;
}

export class TaskRoomWorkModule {
  constructor(private readonly file: string) {}

  /** Private publication lookup; callers must verify the durable session/room binding. */
  async readPublicationRequests(input: {
    taskId: string;
    projectId: string;
    taskCreatedAt: string;
    roomProjectId: string;
    readBinding: (
      sessionId: string,
    ) => { projectId: string; taskId: string } | undefined;
  }): Promise<readonly StoredRecord[]> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (bytes.length > MAX_BYTES)
      throw new TaskRoomWorkUnavailableError(
        'Agent request history exceeds its limit.',
      );
    return checkedStore(JSON.parse(bytes.toString('utf8'))).records.filter(
      (record) => {
        if (
          record.taskId !== input.taskId ||
          record.projectId !== input.projectId ||
          record.taskCreatedAt !== input.taskCreatedAt ||
          record.state === 'refused'
        )
          return false;
        const binding = input.readBinding(record.sessionId);
        return (
          binding?.projectId === input.roomProjectId &&
          binding.taskId === input.taskId
        );
      },
    );
  }

  async list(
    taskId: string,
    authorize: () => Promise<Scope | undefined>,
  ): Promise<TaskRoomWorkList> {
    const scope = await authorize();
    if (!scope) return { kind: 'refused' };
    let records: StoredRecord[];
    try {
      const bytes = await readFile(this.file);
      if (bytes.length > MAX_BYTES)
        throw new TaskRoomWorkUnavailableError(
          'Agent request history exceeds its limit.',
        );
      records = checkedStore(JSON.parse(bytes.toString('utf8'))).records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') records = [];
      else throw error;
    }
    const current = await authorize();
    if (
      !current ||
      current.projectId !== scope.projectId ||
      current.roomProjectId !== scope.roomProjectId ||
      current.projectSlug !== scope.projectSlug ||
      current.taskCreatedAt !== scope.taskCreatedAt ||
      current.requesterId !== scope.requesterId
    )
      return { kind: 'refused' };
    return {
      kind: 'available',
      records: records
        .filter(
          (r) =>
            r.taskId === taskId &&
            r.projectId === scope.projectId &&
            r.taskCreatedAt === scope.taskCreatedAt,
        )
        .map(publishedRecord),
    };
  }

  async submit(
    taskId: string,
    requesterId: string,
    input: TaskRoomWorkInput,
    authorize: () => Promise<Scope | undefined>,
    start: (
      sessionId: string,
      scope: Scope,
      recheck: () => Promise<void>,
      context?: TaskRoomContextSnapshot,
    ) => Promise<{ sessionId: string }>,
    resolveContext?: () => Promise<TaskRoomContextSnapshot | undefined>,
  ): Promise<TaskRoomWorkOutcome> {
    if (
      ![taskId, requesterId, input.operationId, input.agentId].every((v) =>
        validText(v, 160),
      ) ||
      !validText(input.prompt, 12_000) ||
      (input.executionAgentId !== undefined &&
        !validText(input.executionAgentId, 64)) ||
      (input.context !== undefined &&
        (input.context.version !== TASK_ROOM_CONTEXT_VERSION ||
          !/^[0-9a-f]{64}$/.test(input.context.digest)))
    )
      return { kind: 'refused', reason: 'input' };
    if (
      input.model?.override !== undefined &&
      !validText(input.model.override, 512)
    )
      return { kind: 'refused', reason: 'input' };
    if (
      input.expectedDefinitionFingerprint !== undefined &&
      (!input.executionAgentId ||
        !/^sha256:[0-9a-f]{64}$/.test(input.expectedDefinitionFingerprint))
    )
      return { kind: 'refused', reason: 'input' };
    const modelId = input.model?.override?.trim() || undefined;
    const modelOptionsDigest =
      input.model?.options === undefined
        ? undefined
        : await taskRoomModelOptionsDigest(input.model.options);
    const scope = await authorize();
    if (!scope || scope.requesterId !== requesterId)
      return { kind: 'refused', reason: 'access' };
    let selected: TaskRoomWorkOutcome | undefined;
    let captured: TaskRoomContextSnapshot | undefined;
    await mutateJsonFileWithGuardedRead<Store>(
      this.file,
      { version: TASK_ROOM_WORK_VERSION, records: [] },
      async () => {
        let store: Store;
        try {
          const bytes = await readFile(this.file);
          if (bytes.length > MAX_BYTES)
            throw new TaskRoomWorkUnavailableError(
              'Agent request history exceeds its limit.',
            );
          store = checkedStore(JSON.parse(bytes.toString('utf8')));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          store = { version: TASK_ROOM_WORK_VERSION, records: [] };
        }
        const existing = store.records.some(
          (record) =>
            record.taskId === taskId &&
            record.ownerId === requesterId &&
            record.operationId === input.operationId,
        );
        if (!existing && input.context) captured = await resolveContext?.();
        return store;
      },
      (store) => {
        const checked = checkedStore(store);
        const existing = checked.records.find(
          (r) =>
            r.taskId === taskId &&
            r.ownerId === requesterId &&
            r.operationId === input.operationId,
        );
        if (existing) {
          selected =
            existing.projectId !== scope.projectId ||
            existing.taskCreatedAt !== scope.taskCreatedAt ||
            existing.agentId !== input.agentId ||
            existing.executionAgentId !== input.executionAgentId ||
            existing.expectedDefinitionFingerprint !==
              input.expectedDefinitionFingerprint ||
            existing.modelId !== modelId ||
            existing.modelOptionsDigest !== modelOptionsDigest ||
            existing.prompt !== input.prompt ||
            existing.context?.digest !== input.context?.digest
              ? { kind: 'refused', reason: 'conflict' }
              : {
                  kind: 'recorded',
                  record: publishedRecord(existing),
                  replayed: true,
                };
          return checked;
        }
        if (checked.records.length >= MAX_REQUESTS) {
          selected = { kind: 'refused', reason: 'capacity' };
          return checked;
        }
        if (
          input.context &&
          (!captured ||
            captured.digest !== input.context.digest ||
            !validTaskRoomContext(captured, {
              taskId,
              projectId: scope.projectId,
              taskCreatedAt: scope.taskCreatedAt,
            }))
        ) {
          selected = { kind: 'refused', reason: 'context' };
          return checked;
        }
        const record: StoredRecord = {
          version: TASK_ROOM_WORK_VERSION,
          taskId,
          projectId: scope.projectId,
          taskCreatedAt: scope.taskCreatedAt,
          operationId: input.operationId,
          ownerId: requesterId,
          agentId: input.agentId,
          ...(input.executionAgentId
            ? { executionAgentId: input.executionAgentId }
            : {}),
          ...(input.expectedDefinitionFingerprint
            ? {
                expectedDefinitionFingerprint:
                  input.expectedDefinitionFingerprint,
              }
            : {}),
          ...(modelId ? { modelId } : {}),
          ...(modelOptionsDigest ? { modelOptionsDigest } : {}),
          prompt: input.prompt,
          sessionId: `task:${randomUUID()}`,
          createdAt: new Date().toISOString(),
          state: 'starting',
          ...(captured ? { context: Object.freeze({ ...captured }) } : {}),
        };
        selected = {
          kind: 'recorded',
          record: publishedRecord(record),
          replayed: false,
        };
        return {
          version:
            input.executionAgentId !== undefined ||
            modelId !== undefined ||
            modelOptionsDigest !== undefined ||
            checked.version === EXECUTION_STORE_VERSION
              ? EXECUTION_STORE_VERSION
              : captured
                ? CONTEXT_STORE_VERSION
                : checked.version,
          records: [...checked.records, record],
        };
      },
      { maxBytes: MAX_BYTES, label: 'Task room agent requests' },
    );
    if (!selected)
      throw new TaskRoomWorkUnavailableError('Agent request was not recorded.');
    const current = await authorize();
    if (
      !current ||
      current.projectId !== scope.projectId ||
      current.roomProjectId !== scope.roomProjectId ||
      current.projectSlug !== scope.projectSlug ||
      current.taskCreatedAt !== scope.taskCreatedAt ||
      current.requesterId !== scope.requesterId
    ) {
      if (selected.kind === 'recorded' && !selected.replayed)
        await this.settle(selected.record, 'refused');
      return { kind: 'refused', reason: 'access' };
    }
    if (selected.kind === 'refused' || selected.replayed) return selected;
    const record = selected.record;
    let state: TaskRoomWorkRecord['state'] = 'indeterminate';
    try {
      const started = await start(
        record.sessionId,
        current,
        async () => {
          const effectScope = await authorize();
          if (
            !effectScope ||
            effectScope.projectId !== scope.projectId ||
            effectScope.roomProjectId !== scope.roomProjectId ||
            effectScope.projectSlug !== scope.projectSlug ||
            effectScope.taskCreatedAt !== scope.taskCreatedAt ||
            effectScope.requesterId !== scope.requesterId
          )
            throw new TaskRoomWorkAuthorityChangedError(
              'Task authority changed before agent invocation.',
            );
        },
        record.context,
      );
      if (started.sessionId === record.sessionId) state = 'dispatched';
    } catch {
      // The invocation may have started work; the durable request is never replayed.
    }
    const settled = await this.settle(record, state);
    const delivery = await authorize();
    if (
      !delivery ||
      delivery.projectId !== scope.projectId ||
      delivery.roomProjectId !== scope.roomProjectId ||
      delivery.projectSlug !== scope.projectSlug ||
      delivery.taskCreatedAt !== scope.taskCreatedAt ||
      delivery.requesterId !== scope.requesterId
    )
      return { kind: 'refused', reason: 'access' };
    return { kind: 'recorded', record: settled, replayed: false };
  }

  private async settle(
    record: TaskRoomWorkRecord,
    state: TaskRoomWorkRecord['state'],
  ): Promise<TaskRoomWorkRecord> {
    const settled = { ...record, state };
    await mutateJsonFile<Store>(
      this.file,
      { version: TASK_ROOM_WORK_VERSION, records: [] },
      (store) => {
        const checked = checkedStore(store);
        const previous = checked.records.find(
          (r) => r.sessionId === record.sessionId,
        );
        if (
          !previous ||
          previous.taskId !== record.taskId ||
          previous.projectId !== record.projectId ||
          previous.taskCreatedAt !== record.taskCreatedAt ||
          requesterDisplayId(previous.taskId, previous.ownerId) !==
            record.requesterId ||
          previous.operationId !== record.operationId ||
          previous.agentId !== record.agentId ||
          previous.executionAgentId !== record.executionAgentId ||
          previous.expectedDefinitionFingerprint !==
            record.expectedDefinitionFingerprint ||
          previous.modelId !== record.modelId ||
          previous.modelOptionsDigest !== record.modelOptionsDigest ||
          previous.prompt !== record.prompt ||
          previous.context?.digest !== record.context?.digest ||
          previous.createdAt !== record.createdAt
        )
          throw new TaskRoomWorkUnavailableError(
            'Agent request identity changed before settlement.',
          );
        return {
          ...checked,
          records: checked.records.map((r) =>
            r.sessionId === record.sessionId ? { ...r, state } : r,
          ),
        };
      },
      { maxBytes: MAX_BYTES, label: 'Task room agent requests' },
    );
    return settled;
  }
}
