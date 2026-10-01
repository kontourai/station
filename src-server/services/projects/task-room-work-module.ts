import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  TASK_ROOM_WORK_VERSION,
  type TaskRoomWorkInput,
  type TaskRoomWorkList,
  type TaskRoomWorkOutcome,
  type TaskRoomWorkRecord,
} from '@kontourai/station-contracts/task-room-work';
import { mutateJsonFile } from '../../domain/file-storage-helpers.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 256;
type StoredRecord = Omit<TaskRoomWorkRecord, 'requesterId'> & {
  ownerId: string;
};
type Store = {
  version: typeof TASK_ROOM_WORK_VERSION;
  records: StoredRecord[];
};
export type TaskRoomWorkScope = {
  projectId: string;
  projectSlug: string;
  taskCreatedAt: string;
  requesterId: string;
};
type Scope = TaskRoomWorkScope;
export class TaskRoomWorkUnavailableError extends Error {}

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
    Object.keys(r).length === 11 &&
    r.version === TASK_ROOM_WORK_VERSION &&
    ['taskId', 'projectId', 'operationId', 'ownerId', 'agentId'].every((key) =>
      validText(r[key], 160),
    ) &&
    validText(r.prompt, 12_000) &&
    typeof r.sessionId === 'string' &&
    /^task:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      r.sessionId,
    ) &&
    typeof r.createdAt === 'string' &&
    !Number.isNaN(Date.parse(r.createdAt)) &&
    validText(r.taskCreatedAt, 40) &&
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
    store.version !== TASK_ROOM_WORK_VERSION ||
    !Array.isArray(store.records) ||
    store.records.length > MAX_REQUESTS ||
    !store.records.every(validRecord)
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
    ) => Promise<{ sessionId: string }>,
  ): Promise<TaskRoomWorkOutcome> {
    if (
      ![taskId, requesterId, input.operationId, input.agentId].every((v) =>
        validText(v, 160),
      ) ||
      !validText(input.prompt, 12_000)
    )
      return { kind: 'refused', reason: 'input' };
    const scope = await authorize();
    if (!scope || scope.requesterId !== requesterId)
      return { kind: 'refused', reason: 'access' };
    let selected: TaskRoomWorkOutcome | undefined;
    await mutateJsonFile<Store>(
      this.file,
      { version: TASK_ROOM_WORK_VERSION, records: [] },
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
            existing.prompt !== input.prompt
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
        const record: StoredRecord = {
          version: TASK_ROOM_WORK_VERSION,
          taskId,
          projectId: scope.projectId,
          taskCreatedAt: scope.taskCreatedAt,
          operationId: input.operationId,
          ownerId: requesterId,
          agentId: input.agentId,
          prompt: input.prompt,
          sessionId: `task:${randomUUID()}`,
          createdAt: new Date().toISOString(),
          state: 'starting',
        };
        selected = {
          kind: 'recorded',
          record: publishedRecord(record),
          replayed: false,
        };
        return { ...checked, records: [...checked.records, record] };
      },
      { maxBytes: MAX_BYTES, label: 'Task room agent requests' },
    );
    if (!selected)
      throw new TaskRoomWorkUnavailableError('Agent request was not recorded.');
    const current = await authorize();
    if (
      !current ||
      current.projectId !== scope.projectId ||
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
      const started = await start(record.sessionId, current, async () => {
        const effectScope = await authorize();
        if (
          !effectScope ||
          effectScope.projectId !== scope.projectId ||
          effectScope.projectSlug !== scope.projectSlug ||
          effectScope.taskCreatedAt !== scope.taskCreatedAt ||
          effectScope.requesterId !== scope.requesterId
        )
          throw new TaskRoomWorkUnavailableError(
            'Task authority changed before agent invocation.',
          );
      });
      if (started.sessionId === record.sessionId) state = 'dispatched';
    } catch {
      // The invocation may have started work; the durable request is never replayed.
    }
    const settled = await this.settle(record, state);
    const delivery = await authorize();
    if (
      !delivery ||
      delivery.projectId !== scope.projectId ||
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
          previous.prompt !== record.prompt ||
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
