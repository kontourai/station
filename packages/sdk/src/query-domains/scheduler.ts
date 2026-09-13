import type {
  RunOutputRef,
  RunSummary,
} from '@kontourai/station-contracts/runs';
import type { AddJobOpts } from '@kontourai/station-contracts/scheduler';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { getRun, listRuns } from '../client/runs';
import {
  createJob,
  deleteJob,
  disableJob,
  enableJob,
  getJobLogs,
  getSchedulerStats,
  getSchedulerStatus,
  listJobs,
  listSchedulerProviders,
  previewSchedule,
  resolveIndeterminateJobMonitor,
  restartJobMonitor,
  runJob,
  updateJob,
} from '../client/scheduler';
import { type QueryConfig, useApiQuery } from '../query-core';

export const runsQueries = {
  list: () => ({
    queryKey: ['runs'] as const,
    queryFn: async () => {
      const apiBase = await _getApiBase();
      return listRuns<RunSummary[]>(apiBase);
    },
    staleTime: 30_000,
  }),
  detail: (runId: string) => ({
    queryKey: ['runs', runId] as const,
    queryFn: async () => {
      const apiBase = await _getApiBase();
      return getRun<RunSummary>(apiBase, runId);
    },
    staleTime: 30_000,
  }),
};

export function useSchedulerJobs() {
  return useApiQuery(
    ['scheduler', 'jobs'],
    async () => {
      const apiBase = await _getApiBase();
      return listJobs(apiBase);
    },
    { staleTime: 30_000 },
  );
}

export function useSchedulerProviders() {
  return useApiQuery(
    ['scheduler', 'providers'],
    async () => listSchedulerProviders(await _getApiBase()),
    { staleTime: 60_000 },
  );
}

export function useSchedulerStats() {
  return useApiQuery(
    ['scheduler', 'stats'],
    async () => getSchedulerStats(await _getApiBase()),
    { staleTime: 30_000 },
  );
}

export function useSchedulerStatus() {
  return useApiQuery(
    ['scheduler', 'status'],
    async () => getSchedulerStatus(await _getApiBase()),
    { staleTime: 30_000 },
  );
}

export function useJobLogs(target: string | null, providerId?: string) {
  return useApiQuery(
    ['scheduler', 'logs', target ?? '', providerId ?? ''],
    async () => getJobLogs(await _getApiBase(), target!, { providerId }),
    { staleTime: 30_000, enabled: !!target },
  );
}

export function usePreviewSchedule(
  cron: string | null,
  /** The zone the expression is written in; part of the key, not a detail. */
  timezone?: string,
) {
  return useApiQuery(
    ['scheduler', 'preview', cron ?? '', timezone ?? ''],
    async () =>
      previewSchedule(await _getApiBase(), cron!, undefined, {
        ...(timezone ? { timezone } : {}),
      }),
    { staleTime: 60_000, enabled: !!cron && cron.trim().length > 0 },
  );
}

export function useRunsQuery(config?: QueryConfig<RunSummary[]>) {
  return useQuery({
    ...runsQueries.list(),
    ...config,
  });
}

export function useRunQuery(
  runId: string | null | undefined,
  config?: QueryConfig<RunSummary>,
) {
  return useQuery({
    ...runsQueries.detail(runId ?? ''),
    ...config,
    enabled: !!runId && (config?.enabled ?? true),
  });
}

export function useRunJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (target: string) => {
      const apiBase = await _getApiBase();
      return runJob(apiBase, target);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduler'] });
      queryClient.invalidateQueries({ queryKey: runsQueries.list().queryKey });
    },
  });
}

export function useRestartJobMonitor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (target: string) =>
      restartJobMonitor(await _getApiBase(), target),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduler'] }),
  });
}

export function useResolveIndeterminateJobMonitor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      target,
      triggerId,
    }: {
      target: string;
      triggerId: string;
    }) =>
      resolveIndeterminateJobMonitor(await _getApiBase(), target, {
        triggerId,
        action: 'resolve',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduler'] }),
  });
}

export function useToggleJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      target,
      enabled,
    }: {
      target: string;
      enabled: boolean;
    }) => {
      const apiBase = await _getApiBase();
      return enabled ? enableJob(apiBase, target) : disableJob(apiBase, target);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduler'] }),
  });
}

export function useDeleteJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (target: string) =>
      deleteJob(await _getApiBase(), target),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduler'] }),
  });
}

export function useEditJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      target,
      ...options
    }: {
      target: string;
      [key: string]: unknown;
    }) => updateJob(await _getApiBase(), target, options),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduler'] }),
  });
}

export function useAddJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (options: AddJobOpts) => {
      const apiBase = await _getApiBase();
      return createJob(apiBase, options);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduler'] }),
  });
}

export function useFetchRunOutputRef() {
  return useMutation({
    mutationFn: async (outputRef: RunOutputRef) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(`${apiBase}/api/runs/output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outputRef),
      });
      if (!response.ok) {
        throw new Error(`Runs API error: ${response.status}`);
      }
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Unknown runs error'));
      }
      return result.data;
    },
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
