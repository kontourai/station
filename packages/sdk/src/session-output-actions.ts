import type { TaskDeclaredOutputKeepResult } from '@kontourai/station-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keepDeclaredTaskOutput } from './client/task-outputs';
import type { ApiRequestScope } from './query-core';

export type KeepSessionOutputInput = {
  taskId: string;
  sessionId: string;
  eventId: string;
  operationId: string;
  requestScope: ApiRequestScope;
};
async function keep(
  input: KeepSessionOutputInput,
): Promise<TaskDeclaredOutputKeepResult> {
  return keepDeclaredTaskOutput(
    input.requestScope.apiBase,
    input.taskId,
    input.sessionId,
    input.eventId,
    { operationId: input.operationId },
    { requestScope: input.requestScope },
  );
}
export function useKeepSessionOutputMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: keep,
    onSuccess: (_result, input) =>
      Promise.all([
        client.invalidateQueries({
          queryKey: ['task-outputs', input.taskId],
          exact: true,
        }),
        client.invalidateQueries({
          queryKey: [
            'task-basis',
            input.taskId,
            input.requestScope.apiBase,
            input.requestScope.authorityKey,
          ],
        }),
        client.invalidateQueries({
          queryKey: [
            'task-tool-result-references',
            input.taskId,
            input.requestScope.apiBase,
            input.requestScope.authorityKey,
          ],
          exact: true,
        }),
        // Kept output references predate authority-partitioned Task refs. This
        // exact legacy key remains task-local and cannot reach another Task.
        client.invalidateQueries({
          queryKey: ['task-references', input.taskId],
          exact: true,
        }),
        client.invalidateQueries({
          predicate: (query) =>
            isMatchingSessionInventoryQuery(query.queryKey, input),
        }),
      ]),
  });
}

function isMatchingSessionInventoryQuery(
  key: readonly unknown[],
  input: KeepSessionOutputInput,
) {
  if (key[0] !== 'session-inventory' && key[0] !== 'session-inventory-page')
    return false;
  const scope = key[1];
  if (
    !scope ||
    typeof scope !== 'object' ||
    !('sessionId' in scope) ||
    scope.sessionId !== input.sessionId
  )
    return false;
  const offset = key[0] === 'session-inventory' ? 2 : 4;
  return (
    key[offset] === input.requestScope.apiBase &&
    key[offset + 1] === input.requestScope.authorityKey
  );
}
