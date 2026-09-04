/** Private, data-only protocol for the fixed first-party Task read operation. */
import { types } from 'node:util';
import type { UnifiedSearchProviderRequest } from '@kontourai/station-contracts/unified-search';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { UNIFIED_SEARCH_LIMITS } from './unified-search-service.js';

export const TASK_SEARCH_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  requestBytes: 2048,
  responseBytes: 20 * 1024,
  deadlineMs: UNIFIED_SEARCH_LIMITS.providerTimeoutMs,
  closeWaitMs: 100,
  workerMemoryMb: 128,
});

export interface TaskReadRequest {
  type: 'task-search';
  id: number;
  query: string;
  limit: number;
  includeTasks: boolean;
  projectId?: string;
  taskId?: string;
}

function data(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

export function boundedTaskText(
  value: unknown,
  maximum: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximum &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    [...value].every(
      (character) =>
        character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127,
    )
  );
}

export function taskReadRequest(
  request: UnifiedSearchProviderRequest,
  id: number,
): TaskReadRequest | null {
  const record = data(request, [
    'version',
    'query',
    'limit',
    'filters',
    'continuation',
  ]);
  if (
    !record ||
    record.version !== UNIFIED_SEARCH_V1 ||
    record.continuation !== undefined
  )
    return null;
  const filters =
    record.filters === undefined
      ? {}
      : data(record.filters, ['kinds', 'projectId', 'taskId']);
  if (!filters) return null;
  let includeTasks = true;
  if (filters.kinds !== undefined) {
    const kinds = filters.kinds;
    if (!Array.isArray(kinds) || types.isProxy(kinds) || kinds.length > 10)
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(kinds);
    if (Reflect.ownKeys(descriptors).length !== kinds.length + 1) return null;
    const values: string[] = [];
    for (let index = 0; index < kinds.length; index++) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string' ||
        ![
          'project',
          'task',
          'session',
          'message',
          'file',
          'output',
          'run',
          'evidence',
          'receipt',
          'contribution',
        ].includes(descriptor.value)
      )
        return null;
      values.push(descriptor.value);
    }
    includeTasks = values.includes('task');
  }
  return parseTaskReadRequest({
    type: 'task-search',
    id,
    query: record.query,
    limit: record.limit,
    includeTasks,
    ...(filters.projectId === undefined
      ? {}
      : { projectId: filters.projectId }),
    ...(filters.taskId === undefined ? {} : { taskId: filters.taskId }),
  });
}

export function parseTaskReadRequest(value: unknown): TaskReadRequest | null {
  const record = data(value, [
    'type',
    'id',
    'query',
    'limit',
    'includeTasks',
    'projectId',
    'taskId',
  ]);
  if (
    record?.type !== 'task-search' ||
    !Number.isSafeInteger(record.id) ||
    (record.id as number) < 1 ||
    !boundedTaskText(record.query, UNIFIED_SEARCH_LIMITS.queryBytes) ||
    !Number.isInteger(record.limit) ||
    (record.limit as number) < 1 ||
    (record.limit as number) > UNIFIED_SEARCH_LIMITS.resultsPerProvider ||
    typeof record.includeTasks !== 'boolean' ||
    (record.projectId !== undefined &&
      !boundedTaskText(record.projectId, UNIFIED_SEARCH_LIMITS.idBytes)) ||
    (record.taskId !== undefined &&
      !boundedTaskText(record.taskId, UNIFIED_SEARCH_LIMITS.idBytes))
  )
    return null;
  return record as unknown as TaskReadRequest;
}
