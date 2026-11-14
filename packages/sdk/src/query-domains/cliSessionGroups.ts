import { listCliSessionGroups } from '../client/cli-session-groups';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import { useApiQuery } from '../query-core';

export function useCliSessionGroupsQuery(
  scope: ApiRequestScope & { isCurrent(): boolean },
  options: { enabled: boolean; afterGroupId?: string },
) {
  return useApiQuery(
    [
      'cli-session-groups',
      scope.apiBase,
      scope.authorityKey,
      options.afterGroupId ?? null,
    ],
    async (signal) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      const result = await listCliSessionGroups(
        scope.apiBase,
        { afterGroupId: options.afterGroupId },
        { signal, requestScope: scope },
      );
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      return result;
    },
    {
      enabled: options.enabled && scope.isCurrent(),
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      refetchInterval: 5000,
      refetchIntervalForError: (error) => (error ? false : undefined),
      cancelWhenInactive: true,
    },
  );
}
