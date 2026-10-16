import type { RefetchOptions } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import {
  fetchUsageExport,
  type UsageExportPage,
  type UsageExportQuery,
} from '../client/usage-export';
import { type QueryConfig, useApiQuery } from '../query-core';

export type {
  UsageExportPage,
  UsageExportQuery,
  UsageExportSnapshot,
} from '../client/usage-export';

export function useUsageExportQuery(
  scope: ApiRequestScope | undefined,
  input: UsageExportQuery,
  config?: QueryConfig<UsageExportPage>,
) {
  const authority = scope ? { ...scope } : undefined;
  const captured = {
    ...input,
    ...(input.snapshot ? { snapshot: { ...input.snapshot } } : {}),
  };
  const key = [
    'analytics',
    'usage-export',
    authority?.apiBase ?? null,
    authority?.authorityKey ?? null,
    captured.expectedStationId,
    captured.from,
    captured.to,
    captured.scope,
    captured.cursor ?? null,
    captured.pageSize ?? 100,
    captured.snapshot?.streamEpoch ?? null,
    captured.snapshot?.highWater ?? null,
    captured.snapshot?.afterGlobalSequence ?? null,
  ];
  const signature = JSON.stringify(key);
  const selection = useRef({ signature, generation: 0 });
  if (selection.current.signature !== signature)
    selection.current = {
      signature,
      generation: selection.current.generation + 1,
    };
  const generation = selection.current.generation;
  const query = useApiQuery(
    key,
    (signal) => {
      if (!authority) throw new StationRequestAuthorityError();
      return fetchUsageExport(authority.apiBase, captured, {
        requestScope: authority,
        signal,
      });
    },
    {
      ...config,
      enabled: !!authority && (config?.enabled ?? true),
      staleTime: 0,
      refetchOnMount: 'always',
      retry: false,
      refetchIntervalForError: (error) => (error ? false : undefined),
      keepPreviousData: false,
    },
  );
  return {
    ...query,
    data:
      authority && query.isSuccess && !query.isFetching
        ? query.data
        : undefined,
    async refetch(options?: RefetchOptions) {
      if (!authority) throw new StationRequestAuthorityError();
      if (selection.current.generation !== generation)
        throw new Error('Usage export selection changed while waiting');
      const result = await query.refetch({ ...options, throwOnError: true });
      // QueryObserver returns its current selection after awaiting the old one.
      if (selection.current.generation !== generation)
        throw new Error('Usage export selection changed while waiting');
      return result;
    },
  };
}
