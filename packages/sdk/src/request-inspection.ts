import type { AttentionRequestReference } from '@kontourai/station-contracts/attention';
import { inspectAttentionRequest } from './client/request-inspection';
import { type ApiRequestScope, useApiQuery } from './query-core';

export type {
  AttentionRequestInspection,
  AttentionRequestReference,
} from './client/request-inspection';
export { inspectAttentionRequest };

export const attentionRequestQueryKey = (
  reference: AttentionRequestReference,
  scope: ApiRequestScope,
) =>
  [
    'attention-request',
    scope.apiBase,
    scope.authorityKey,
    reference.threadId,
    reference.requestId,
    reference.requestEventId,
  ] as const;

export function useAttentionRequestInspection(
  reference: AttentionRequestReference,
  scope: ApiRequestScope,
  enabled = true,
) {
  const query = useApiQuery(
    [...attentionRequestQueryKey(reference, scope)],
    (signal) =>
      inspectAttentionRequest(scope.apiBase, reference, {
        signal,
        requestScope: scope,
      }),
    {
      enabled,
      staleTime: 0,
      refetchOnMount: 'always',
      retry: false,
      cancelWhenInactive: true,
      gcTime: 30_000,
    },
  );
  return {
    ...query,
    data:
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
    isLoading:
      !query.isFetchedAfterMount || query.isLoading || query.isFetching,
  };
}
