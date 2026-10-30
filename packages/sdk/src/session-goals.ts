import type { SessionGoalCommand } from '@kontourai/station-contracts/session-goal';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { controlSessionGoal, readSessionGoal } from './client/session-goals';
import { type ApiRequestScope, useApiQuery } from './query-core';

export { controlSessionGoal, readSessionGoal };

const key = (sessionId: string, scope: ApiRequestScope) => [
  'session-goal',
  scope.apiBase,
  scope.authorityKey,
  sessionId,
];

export function useSessionGoalQuery(sessionId: string, scope: ApiRequestScope) {
  const query = useApiQuery(
    key(sessionId, scope),
    (signal) =>
      readSessionGoal(scope.apiBase, sessionId, {
        signal,
        requestScope: scope,
      }),
    {
      enabled: Boolean(sessionId),
      refetchOnMount: 'always',
      retry: false,
      cancelWhenInactive: true,
    },
  );
  return {
    ...query,
    data:
      query.isFetchedAfterMount && !query.isFetching && query.isSuccess
        ? query.data
        : undefined,
  };
}

export function useSessionGoalMutation(
  sessionId: string,
  scope: ApiRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (command: SessionGoalCommand) =>
      controlSessionGoal(scope.apiBase, sessionId, command, {
        requestScope: scope,
      }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: key(sessionId, scope) }),
    retry: false,
  });
}
