import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { ApiRequestScope } from './query-core';

export interface AnswerAssessmentUpdateEvent {
  sessionId: string;
  turnId: string;
  revision: number;
  active: boolean;
}

/** Reject payload extensions as well as malformed fields at the notification seam. */
export function parseAnswerAssessmentUpdateEvent(
  value: unknown,
): AnswerAssessmentUpdateEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 4 ||
    !keys.every((key) =>
      ['sessionId', 'turnId', 'revision', 'active'].includes(key),
    ) ||
    typeof record.sessionId !== 'string' ||
    record.sessionId.length === 0 ||
    typeof record.turnId !== 'string' ||
    record.turnId.length === 0 ||
    typeof record.revision !== 'number' ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    typeof record.active !== 'boolean'
  )
    return;
  return {
    sessionId: record.sessionId,
    turnId: record.turnId,
    revision: record.revision,
    active: record.active,
  } as AnswerAssessmentUpdateEvent;
}

function isScopedTaskBasisKey(
  key: QueryKey,
  requestScope: ApiRequestScope,
): boolean {
  return (
    key[0] === 'task-basis' &&
    key[2] === requestScope.apiBase &&
    key[3] === requestScope.authorityKey
  );
}
function isMatchingCurrentAnswerInventoryKey(
  key: QueryKey,
  update: AnswerAssessmentUpdateEvent,
  requestScope: ApiRequestScope,
): boolean {
  if (key[0] !== 'session-inventory' && key[0] !== 'session-inventory-page')
    return false;
  const scope = key[1] as {
    kind?: unknown;
    sessionId?: unknown;
    turnId?: unknown;
  };
  const offset = key[0] === 'session-inventory' ? 2 : 4;
  return (
    scope?.kind === 'current-answer' &&
    scope.sessionId === update.sessionId &&
    scope.turnId === update.turnId &&
    key[offset] === requestScope.apiBase &&
    key[offset + 1] === requestScope.authorityKey
  );
}

/**
 * Treat an assessment push as a hint only. The next exact GET decides whether
 * the answer remains readable; an existing observer is synchronously
 * tombstoned so it cannot keep rendering a prior assessment while refetching.
 */
export function refreshAnswerAssessmentQueries(
  queryClient: QueryClient,
  payload: unknown,
  requestScope: ApiRequestScope,
): boolean {
  const update = parseAnswerAssessmentUpdateEvent(payload);
  if (!update) return false;

  const directKey = [
    'answer-basis',
    update.sessionId,
    update.turnId,
    requestScope.apiBase,
    requestScope.authorityKey,
  ];
  const taskFilter = {
    predicate: (query: { queryKey: QueryKey }) =>
      isScopedTaskBasisKey(query.queryKey, requestScope),
  };
  const inventoryFilter = {
    predicate: (query: { queryKey: QueryKey }) =>
      isMatchingCurrentAnswerInventoryKey(query.queryKey, update, requestScope),
  };
  const directFilter = { queryKey: directKey, exact: true };

  // Cancellation comes first: a deferred pre-update response must never put
  // the old policy back after the tombstone is published.
  void queryClient.cancelQueries(directFilter);
  void queryClient.cancelQueries(taskFilter);
  void queryClient.cancelQueries(inventoryFilter);
  queryClient.setQueryData(directKey, null);
  queryClient.setQueriesData(taskFilter, null);
  queryClient.setQueriesData(inventoryFilter, null);
  void queryClient.invalidateQueries({
    ...directFilter,
    refetchType: 'active',
  });
  // The event carries no task id. Refreshing this authority's task family is
  // conservative, but cannot touch an unscoped or another-authority cache.
  void queryClient.invalidateQueries({ ...taskFilter, refetchType: 'active' });
  void queryClient.invalidateQueries({
    ...inventoryFilter,
    refetchType: 'active',
  });
  return true;
}
