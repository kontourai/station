import type { StationBasisProjection } from '@kontourai/station-contracts/task-basis';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { AnswerBasisRequestError, getAnswerBasis } from './client/answer-basis';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type QueryConfig,
  resolveApiBase,
  useApiQuery,
} from './query-core';

export {
  type AnswerAssessmentUpdateEvent,
  parseAnswerAssessmentUpdateEvent,
  refreshAnswerAssessmentQueries,
} from './answer-assessment-events';
export { AnswerBasisRequestError, getAnswerBasis };

export const answerBasisQueries = {
  answer: (
    sessionId: string,
    turnId: string,
    requestScope?: ApiRequestScope,
  ) => ({
    queryKey: requestScope
      ? [
          'answer-basis',
          sessionId,
          turnId,
          requestScope.apiBase,
          requestScope.authorityKey,
        ]
      : ['answer-basis', sessionId, turnId],
    staleTime: 10_000,
  }),
};

export type AnswerBasisQueryConfig = QueryConfig<StationBasisProjection> & {
  /** Captured host authority; new native Basis callers must provide it. */
  requestScope?: ApiRequestScope;
};

export async function fetchAnswerBasis(
  sessionId: string,
  turnId: string,
  apiBase?: string,
  signal?: AbortSignal,
  requestScope?: ApiRequestScope,
): Promise<StationBasisProjection> {
  return getAnswerBasis(await resolveApiBase(apiBase), sessionId, turnId, {
    signal,
    requestScope,
  });
}

function lostAuthority(error: unknown): error is AnswerBasisRequestError {
  return error instanceof AnswerBasisRequestError;
}

/** Never leave a previously authorized answer in a mounted observer's cache. */
export function useAnswerBasisQuery(
  sessionId: string,
  turnId: string,
  config?: AnswerBasisQueryConfig,
) {
  const client = useQueryClient();
  const queryKey = useMemo(
    () =>
      answerBasisQueries.answer(sessionId, turnId, config?.requestScope)
        .queryKey,
    [config?.requestScope, sessionId, turnId],
  );
  const revoke = useCallback(() => {
    client.getQueryCache().find({ queryKey, exact: true })?.setState({
      data: null,
    });
  }, [client, queryKey]);
  const query = useApiQuery(
    queryKey,
    async (signal) => {
      try {
        const apiBase = isApiRequestScope(config?.requestScope)
          ? config.requestScope.apiBase
          : await resolveApiBase();
        const result = await fetchAnswerBasis(
          sessionId,
          turnId,
          apiBase,
          signal,
          config?.requestScope,
        );
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (lostAuthority(error)) {
          revoke();
        }
        throw error;
      }
    },
    {
      staleTime: config?.staleTime ?? 10_000,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? (sessionId.length > 0 && turnId.length > 0),
      refetchOnMount: config?.refetchOnMount ?? 'always',
      retry: false,
      cancelWhenInactive: config?.cancelWhenInactive ?? true,
    },
  );
  return {
    ...query,
    data:
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? (query.data ?? undefined)
        : undefined,
    isLoading:
      !query.isFetchedAfterMount || query.isLoading || query.isFetching,
  };
}
