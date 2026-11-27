import {
  fetchExternalSessionHistory,
  fetchExternalSessionTranscript,
  importExternalSessionHistory,
} from '../client/external-session-history';
import { StationRequestAuthorityError } from '../client/http';

export { cancelExternalSessionHistoryImport } from '../client/external-session-history';

import {
  type ApiRequestScope,
  useApiMutation,
  useApiQuery,
} from '../query-core';

const queryConfig = {
  staleTime: 15_000,
  gcTime: 60_000,
  refetchOnMount: 'always',
  cancelWhenInactive: true,
  retry: false,
} as const;

export function useExternalSessionHistoryQuery(
  scope: ApiRequestScope | undefined,
  offset: number,
  search: string,
  provider?: string,
) {
  return useApiQuery(
    [
      'external-session-history',
      scope?.authorityKey ?? null,
      provider ?? null,
      offset,
      search,
    ],
    (signal) => {
      if (!scope) throw new StationRequestAuthorityError();
      return fetchExternalSessionHistory(
        scope.apiBase,
        offset,
        search,
        provider,
        {
          requestScope: scope,
          signal,
        },
      );
    },
    { ...queryConfig, enabled: !!scope },
  );
}

export function useExternalSessionTranscriptQuery(
  scope: ApiRequestScope | undefined,
  id: string,
  cursor: string | null,
  fromStart: boolean,
) {
  return useApiQuery(
    [
      'external-session-transcript',
      scope?.authorityKey ?? null,
      id,
      cursor,
      fromStart,
    ],
    (signal) => {
      if (!scope) throw new StationRequestAuthorityError();
      return fetchExternalSessionTranscript(
        scope.apiBase,
        id,
        cursor,
        fromStart,
        {
          requestScope: scope,
          signal,
        },
      );
    },
    { ...queryConfig, enabled: !!scope },
  );
}

export function useImportExternalSessionHistory(
  scope: ApiRequestScope | undefined,
) {
  return useApiMutation(
    async ({
      id,
      operationId,
      signal,
    }: {
      id: string;
      operationId: string;
      signal: AbortSignal;
    }) => {
      if (!scope) throw new StationRequestAuthorityError();
      let result: Awaited<ReturnType<typeof importExternalSessionHistory>>;
      do {
        signal.throwIfAborted();
        result = await importExternalSessionHistory(
          scope.apiBase,
          id,
          operationId,
          {
            requestScope: scope,
            signal,
          },
        );
      } while (result.more);
      return result;
    },
  );
}
