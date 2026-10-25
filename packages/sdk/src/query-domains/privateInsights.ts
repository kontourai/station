import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  type ApiRequestScope,
  StationHttpError,
  StationRequestAuthorityError,
} from '../client/http';
import {
  type AnalyticsViewDefinition,
  createSavedAnalyticsView,
  deleteSavedAnalyticsView,
  fetchPrivateInsights,
  fetchPrivateInsightsSources,
  fetchSavedAnalyticsViews,
  type PrivateInsightsQuery,
  syncPrivateInsightsPage,
  syncPrivateInsightsWindow,
  updateSavedAnalyticsView,
} from '../client/private-insights';
import { useApiMutation, useApiQuery } from '../query-core';

export * from '../client/private-insights';
export type PrivateInsightsAuthority = ApiRequestScope & {
  isCurrent(): boolean;
};
function requireScope(
  scope: PrivateInsightsAuthority | undefined,
): PrivateInsightsAuthority {
  if (!scope?.isCurrent()) throw new StationRequestAuthorityError();
  return scope;
}
const policy = {
  staleTime: 0,
  refetchOnMount: 'always',
  retry: false,
  keepPreviousData: false,
  cancelWhenInactive: true,
} as const;
export function usePrivateInsightsInventory(
  scope: PrivateInsightsAuthority | undefined,
) {
  const sources = useApiQuery(
    [
      'private-insights',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
      'sources',
    ],
    (signal) => fetchPrivateInsightsSources(requireScope(scope), signal),
    {
      ...policy,
      enabled: !!scope,
      refetchInterval: 30000,
      refetchIntervalForError: (e) => (e ? false : undefined),
    },
  );
  const views = useApiQuery(
    [
      'private-insights',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
      'views',
    ],
    (signal) => fetchSavedAnalyticsViews(requireScope(scope), signal),
    { ...policy, enabled: !!scope },
  );
  return {
    sources: {
      ...sources,
      data:
        scope?.isCurrent() && !sources.isError && !sources.isFetching
          ? sources.data
          : undefined,
    },
    views: {
      ...views,
      data:
        scope?.isCurrent() && !views.isError && !views.isFetching
          ? views.data
          : undefined,
    },
  };
}
export function usePrivateInsightsResult(
  scope: PrivateInsightsAuthority | undefined,
  id: string,
  input: PrivateInsightsQuery,
  selection: string,
  intervalMs = 2000,
) {
  const client = useQueryClient();
  const validationKey = [
    'private-insights',
    scope?.apiBase ?? null,
    scope?.authorityKey ?? null,
    'source-validation',
    id,
  ];
  type Validation = { generation: number; denied: boolean };
  const validation = useApiQuery<Validation>(
    validationKey,
    async () => ({ generation: 0, denied: false }),
    { enabled: false, gcTime: Infinity },
  );
  const signature = JSON.stringify([
    scope?.apiBase,
    scope?.authorityKey,
    id,
    input,
    selection,
  ]);
  const progress = useRef<{
    signature: string;
    generation: number;
    indexId?: string;
    summaryId?: string;
    pending: boolean;
  }>({ signature, generation: 0, pending: true });
  if (progress.current.signature !== signature)
    progress.current = {
      signature,
      generation: progress.current.generation + 1,
      pending: true,
    };
  const generation = progress.current.generation;
  const query = useApiQuery(
    [
      'private-insights',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
      'result',
      id,
      input,
      selection,
    ],
    async (signal) => {
      const authority = requireScope(scope);
      const validationGeneration =
        client.getQueryData<Validation>(validationKey)?.generation ?? 0;
      let result: Awaited<ReturnType<typeof fetchPrivateInsights>>;
      try {
        result = await fetchPrivateInsights(
          authority,
          id,
          {
            ...input,
            ...(progress.current.indexId
              ? { indexId: progress.current.indexId }
              : {}),
            ...(progress.current.summaryId
              ? { summaryId: progress.current.summaryId }
              : {}),
          },
          signal,
        );
      } catch (error) {
        if (
          authority.isCurrent() &&
          error instanceof StationHttpError &&
          [401, 403, 404, 409, 410].includes(error.status)
        )
          client.setQueryData<Validation>(validationKey, (previous) => ({
            generation:
              (previous?.generation ?? 0) + (previous?.denied ? 0 : 1),
            denied: true,
          }));
        throw error;
      }
      if (
        !authority.isCurrent() ||
        progress.current.generation !== generation ||
        (client.getQueryData<Validation>(validationKey)?.generation ?? 0) !==
          validationGeneration
      )
        throw new StationRequestAuthorityError();
      client.setQueryData<Validation>(validationKey, {
        generation: validationGeneration,
        denied: false,
      });
      progress.current = {
        signature,
        generation,
        indexId: result.indexId,
        ...(result.summary ? { summaryId: result.summary.id } : {}),
        pending:
          result.phase === 'indexing' ||
          result.summary?.phase === 'aggregating',
      };
      return { ...result, validationGeneration };
    },
    {
      ...policy,
      enabled: !!scope && !!id,
      refetchInterval: progress.current.pending ? intervalMs : undefined,
      refetchIntervalForError: (e) => (e ? false : undefined),
    },
  );
  const snapshotAllowed =
    !validation.data?.denied &&
    (query.data?.validationGeneration ?? -1) ===
      (validation.data?.generation ?? 0);
  return {
    ...query,
    data:
      scope?.isCurrent() &&
      snapshotAllowed &&
      query.isSuccess &&
      !query.isFetching
        ? query.data
        : undefined,
    historical:
      scope?.isCurrent() &&
      snapshotAllowed &&
      query.isError &&
      ((query.error instanceof StationHttpError &&
        query.error.status === 503) ||
        query.error instanceof TypeError) &&
      query.data?.retainedCopy &&
      query.data.summary?.phase === 'ready' &&
      Date.parse(query.data.validUntil) > Date.now()
        ? query.data
        : undefined,
    async refetch() {
      requireScope(scope);
      if (progress.current.generation !== generation)
        throw new StationRequestAuthorityError();
      const value = await query.refetch({ throwOnError: true });
      if (progress.current.generation !== generation)
        throw new StationRequestAuthorityError();
      return value;
    },
  };
}
export function useSavedAnalyticsViewMutation(
  scope: PrivateInsightsAuthority | undefined,
) {
  return useApiMutation(
    async (
      input:
        | {
            kind: 'create';
            operationId: string;
            definition: AnalyticsViewDefinition;
          }
        | {
            kind: 'update';
            id: string;
            revision: number;
            definition: AnalyticsViewDefinition;
          }
        | { kind: 'delete'; id: string; revision: number },
    ) => {
      const authority = requireScope(scope);
      const value =
        input.kind === 'create'
          ? await createSavedAnalyticsView(
              authority,
              input.operationId,
              input.definition,
            )
          : input.kind === 'update'
            ? await updateSavedAnalyticsView(
                authority,
                input.id,
                input.revision,
                input.definition,
              )
            : await deleteSavedAnalyticsView(
                authority,
                input.id,
                input.revision,
              );
      if (!authority.isCurrent()) throw new StationRequestAuthorityError();
      return value;
    },
    {
      evictSettledVariables: true,
      invalidateKeys: scope
        ? [['private-insights', scope.apiBase, scope.authorityKey]]
        : [],
    },
  );
}
export function usePrivateInsightsSync(
  scope: PrivateInsightsAuthority | undefined,
) {
  return useApiMutation(
    async (input: {
      id: string;
      from: string;
      to: string;
      operationId: string;
      restart?: boolean;
    }) => {
      const authority = requireScope(scope);
      const value = await syncPrivateInsightsPage(authority, input.id, input);
      if (!authority.isCurrent()) throw new StationRequestAuthorityError();
      return value;
    },
    {
      evictSettledVariables: true,
      invalidateKeys: scope
        ? [['private-insights', scope.apiBase, scope.authorityKey]]
        : [],
    },
  );
}

export function usePrivateInsightsSyncWindow(
  scope: PrivateInsightsAuthority | undefined,
) {
  return useApiMutation(
    async (input: {
      id: string;
      windows: readonly { from: string; to: string }[];
      signal: AbortSignal;
      onProgress?: (value: { phase: string; pages: number }) => void;
    }) => {
      const authority = requireScope(scope);
      const result = await syncPrivateInsightsWindow(
        authority,
        input.id,
        input.windows,
        {
          signal: input.signal,
          onProgress: (value) => {
            requireScope(authority);
            input.onProgress?.(value);
          },
        },
      );
      requireScope(authority);
      return result;
    },
    {
      evictSettledVariables: true,
      invalidateKeys: scope
        ? [['private-insights', scope.apiBase, scope.authorityKey]]
        : [],
    },
  );
}

export * from '../client/analytics-enrollment';

import {
  type AnalyticsReview,
  type AnalyticsSetupAction,
  fetchAnalyticsRecipientSetup,
  fetchAnalyticsReview,
  performAnalyticsSetup,
} from '../client/analytics-enrollment';
export function useAnalyticsSetupMutation(
  scope: PrivateInsightsAuthority | undefined,
) {
  return useApiMutation(
    async (input: AnalyticsSetupAction) => {
      const authority = requireScope(scope);
      const value = await performAnalyticsSetup(authority, input);
      requireScope(authority);
      return value;
    },
    {
      evictSettledVariables: true,
      invalidateKeys: scope
        ? [['private-insights', scope.apiBase, scope.authorityKey]]
        : [],
    },
  );
}
export function useAnalyticsReceivingProof(
  scope: PrivateInsightsAuthority | undefined,
  id: string,
) {
  const query = useApiQuery(
    [
      'private-insights',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
      'receiving-proof',
      id,
    ],
    (signal) => fetchAnalyticsRecipientSetup(requireScope(scope), id, signal),
    { ...policy, enabled: !!scope && !!id },
  );
  return {
    ...query,
    data:
      scope?.isCurrent() && !query.isError && !query.isFetching
        ? query.data
        : undefined,
  };
}
export function useAnalyticsSetupReview(
  scope: PrivateInsightsAuthority | undefined,
  review: AnalyticsReview | undefined,
) {
  const terminal = useRef(false);
  const key = JSON.stringify([scope?.authorityKey, review?.id]);
  const held = useRef(key);
  if (held.current !== key) {
    held.current = key;
    terminal.current = false;
  }
  const query = useApiQuery(
    [
      'private-insights',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
      'setup-review',
      review?.kind ?? null,
      review?.subject ?? null,
      review?.id ?? null,
    ],
    async (signal) => {
      if (!review) throw new Error('No requester review');
      const value = await fetchAnalyticsReview(
        requireScope(scope),
        review,
        signal,
      );
      terminal.current = value.status !== 'pending';
      return value;
    },
    {
      ...policy,
      enabled: !!scope && !!review && review.status === 'pending',
      refetchInterval: terminal.current ? undefined : 1000,
      refetchIntervalForError: (e) => (e ? false : undefined),
    },
  );
  return {
    ...query,
    data: scope?.isCurrent() && !query.isError ? query.data : undefined,
  };
}

export function useAnalyticsReceiverInfo(
  scope: PrivateInsightsAuthority | undefined,
) {
  const query = useApiQuery(
    [
      'private-insights',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
      'receiver-info',
    ],
    async (signal) => {
      const { fetchAnalyticsReceiverInfo } = await import(
        '../client/analytics-enrollment'
      );
      return fetchAnalyticsReceiverInfo(requireScope(scope), signal);
    },
    { ...policy, enabled: !!scope },
  );
  return {
    ...query,
    data: scope?.isCurrent() && !query.isError ? query.data : undefined,
  };
}

export function useAnalyticsSourceOffers(
  scope: PrivateInsightsAuthority | undefined,
) {
  const query = useApiQuery(
    [
      'private-insights',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
      'source-offers',
    ],
    async (signal) => {
      const { fetchAnalyticsSourceOffers } = await import(
        '../client/analytics-enrollment'
      );
      return fetchAnalyticsSourceOffers(requireScope(scope), signal);
    },
    { ...policy, enabled: !!scope },
  );
  return {
    ...query,
    data:
      scope?.isCurrent() && !query.isError && !query.isFetching
        ? query.data
        : undefined,
  };
}
