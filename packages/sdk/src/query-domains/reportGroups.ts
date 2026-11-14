import type {
  ReportGroupAmounts,
  ReportGroupCancelInput,
  ReportGroupContextCheckpoint,
  ReportGroupContextSyncInput,
  ReportGroupFinalizeCancelInput,
  ReportGroupFinalizeSyncInput,
  ReportGroupInput,
  ReportGroupOperation,
} from '@kontourai/station-contracts/report-group';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  StationRequestAuthorityError,
} from '../client/http';
import {
  cancelReportGroup,
  createReportGroup,
  finalizeReportGroupCancel,
  finalizeReportGroupSync,
  listReportGroups,
  readReportGroupContextCheckpoint,
  readReportGroupResult,
  syncReportGroupContext,
} from '../client/report-groups';
import { useApiQuery } from '../query-core';

type Scope = ApiRequestScope & { isCurrent(): boolean };
export function useReportGroupsQuery(
  scope: Scope,
  options: { enabled: boolean; afterGroupId?: string },
) {
  return useApiQuery(
    [
      'report-groups',
      scope.apiBase,
      scope.authorityKey,
      options.afterGroupId ?? null,
    ],
    async (signal) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      const page = await listReportGroups(scope.apiBase, options.afterGroupId, {
        signal,
        requestScope: scope,
      });
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      return page;
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

export function useReportGroupResultQuery(
  scope: Scope,
  member: { groupId: string; seatId: string; invocationId: string },
  enabled: boolean,
) {
  return useApiQuery(
    [
      'report-group-result',
      scope.apiBase,
      scope.authorityKey,
      member.groupId,
      member.seatId,
      member.invocationId,
    ],
    async (signal) => {
      let text = '';
      let identity: { modelId: string; usage: ReportGroupAmounts } | undefined;
      // Assemble bounded UTF-16 pages before rendering, including split surrogate pairs.
      for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
        if (!scope.isCurrent()) throw new StationRequestAuthorityError();
        const page = await readReportGroupResult(
          scope.apiBase,
          member.groupId,
          member.seatId,
          member.invocationId,
          text.length,
          { signal, requestScope: scope },
        );
        if (!scope.isCurrent()) throw new StationRequestAuthorityError();
        if (page.kind === 'failure') return page;
        if (
          identity &&
          (identity.modelId !== page.modelId ||
            identity.usage.inputTokens !== page.usage.inputTokens ||
            identity.usage.outputTokens !== page.usage.outputTokens ||
            identity.usage.costMicros !== page.usage.costMicros)
        )
          throw new Error('Report identity changed.');
        identity = { modelId: page.modelId, usage: page.usage };
        text += page.text;
        if (!page.hasMore)
          return { kind: 'result' as const, ...identity, text };
      }
      throw new Error('Report exceeds the display bound.');
    },
    {
      enabled: enabled && scope.isCurrent(),
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      cancelWhenInactive: true,
    },
  );
}

/** One explicit cancellation attempt; a failed response never triggers an automatic resend. */
export function useCancelReportGroup(scope: Scope) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['report-group-cancel', scope.apiBase, scope.authorityKey],
    mutationFn: async (input: ReportGroupCancelInput & { groupId: string }) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      const { groupId, ...command } = input;
      const result = await cancelReportGroup(scope.apiBase, groupId, command, {
        requestScope: scope,
      });
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      return result;
    },
    onSuccess: () => {
      if (scope.isCurrent())
        void client.invalidateQueries({
          queryKey: ['report-groups', scope.apiBase, scope.authorityKey],
        });
    },
    retry: false,
    networkMode: 'always',
    gcTime: 0,
  });
}

/** Explicit receipt recovery; this endpoint never resends member interrupts. */
export function useFinalizeReportGroupCancel(scope: Scope) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [
      'report-group-cancel-finalize',
      scope.apiBase,
      scope.authorityKey,
    ],
    mutationFn: async (
      input: ReportGroupFinalizeCancelInput & { groupId: string },
    ) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      const { groupId, ...command } = input;
      const result = await finalizeReportGroupCancel(
        scope.apiBase,
        groupId,
        command,
        { requestScope: scope },
      );
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      return result;
    },
    onSuccess: () => {
      if (scope.isCurrent())
        void client.invalidateQueries({
          queryKey: ['report-groups', scope.apiBase, scope.authorityKey],
        });
    },
    retry: false,
    networkMode: 'always',
    gcTime: 0,
  });
}

export function useCreateReportGroup(scope: Scope) {
  const client = useQueryClient();
  const active = useRef<AbortController | undefined>(undefined);
  const current = scope.isCurrent();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each authority tuple owns its in-flight request.
  useEffect(
    () => () => active.current?.abort(),
    [scope.apiBase, scope.authorityKey, current],
  );
  return useMutation({
    mutationKey: ['report-group-create', scope.apiBase, scope.authorityKey],
    mutationFn: async (input: ReportGroupInput) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      if (active.current)
        throw new Error('A report request is already active.');
      const stop = new AbortController();
      active.current = stop;
      try {
        const result = await createReportGroup(scope.apiBase, input, {
          requestScope: scope,
          signal: stop.signal,
        });
        if (!scope.isCurrent()) throw new StationRequestAuthorityError();
        return result;
      } finally {
        if (active.current === stop) active.current = undefined;
      }
    },
    onSuccess: () => {
      if (scope.isCurrent())
        void client.invalidateQueries({
          queryKey: ['report-groups', scope.apiBase, scope.authorityKey],
        });
    },
    retry: false,
    networkMode: 'always',
    gcTime: 0,
  });
}

function useReportContextOperation<Input, Result = ReportGroupOperation>(
  scope: Scope,
  kind: 'sync' | 'finalize-sync' | 'checkpoint',
  perform: (
    base: string,
    groupId: string,
    input: Input,
    options: ClientRequestOptions,
  ) => Promise<Result>,
) {
  const client = useQueryClient();
  const active = useRef<AbortController | undefined>(undefined);
  const current = scope.isCurrent();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each authority tuple owns its in-flight mutation.
  useEffect(
    () => () => active.current?.abort(),
    [scope.apiBase, scope.authorityKey, current],
  );
  return useMutation({
    mutationKey: [
      'report-group-context',
      kind,
      scope.apiBase,
      scope.authorityKey,
    ],
    mutationFn: async ({
      groupId,
      command,
    }: {
      groupId: string;
      command: Input;
    }) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      if (active.current)
        throw new Error('A report context operation is already active.');
      const stop = new AbortController();
      active.current = stop;
      try {
        const result = await perform(scope.apiBase, groupId, command, {
          requestScope: scope,
          signal: stop.signal,
        });
        stop.signal.throwIfAborted();
        if (!scope.isCurrent()) throw new StationRequestAuthorityError();
        return result;
      } finally {
        if (active.current === stop) active.current = undefined;
      }
    },
    onSuccess: () => {
      if (kind !== 'checkpoint' && scope.isCurrent())
        void client.invalidateQueries({
          queryKey: ['report-groups', scope.apiBase, scope.authorityKey],
        });
    },
    retry: false,
    networkMode: 'always',
    gcTime: 0,
  });
}

export function useSyncReportGroupContext(scope: Scope) {
  return useReportContextOperation<ReportGroupContextSyncInput>(
    scope,
    'sync',
    syncReportGroupContext,
  );
}
export function useFinalizeReportGroupSync(scope: Scope) {
  return useReportContextOperation<ReportGroupFinalizeSyncInput>(
    scope,
    'finalize-sync',
    finalizeReportGroupSync,
  );
}

export function useReportGroupContextCheckpoint(scope: Scope) {
  return useReportContextOperation<
    { seatId: string; expectedRevision: number },
    ReportGroupContextCheckpoint
  >(scope, 'checkpoint', readReportGroupContextCheckpoint);
}
