import type {
  RunOutputRef,
  RunSummary,
} from '@kontourai/station-contracts/runs';
import type { AddJobOpts } from '@kontourai/station-contracts/scheduler';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { hasCapability } from '../capability';
import { readPublicStationCapabilities } from '../client/publicStationCapabilities';
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

export function useSchedulerJobs(weekStart?: string, displayZone?: string) {
  return useApiQuery(
    weekStart === undefined
      ? ['scheduler', 'jobs']
      : ['scheduler', 'jobs', weekStart, displayZone ?? 'UTC'],
    async () => {
      const apiBase = await _getApiBase();
      return listJobs(apiBase, undefined, weekStart, displayZone);
    },
    { staleTime: 30_000 },
  );
}

/**
 * Whether the host runs automations in a conversation, on any engine
 * (`scheduledConversationTarget`). `null`: its public handshake could not be
 * read, so support is undetermined. A host without it runs only
 * Station-engine jobs, so a client offers other engines only on `true`.
 */
async function fetchScheduledConversationTargetCapability(
  apiBase: string,
): Promise<boolean | null> {
  const handshake = await readPublicStationCapabilities(apiBase);
  return handshake
    ? hasCapability(handshake, 'scheduledConversationTarget')
    : null;
}

export function useScheduledConversationTargetCapability() {
  return useApiQuery(
    ['scheduler', 'conversation-target-capability'],
    async () => fetchScheduledConversationTargetCapability(await _getApiBase()),
    { staleTime: 10_000, refetchInterval: 10_000, retry: false },
  );
}

/**
 * #5070: whether the host runs a job as a Task in a Project
 * (`projectSchedules`). An older host would strip `projectId` and create a
 * plain job, so a client offers Project schedules only on `true`.
 */
export function useProjectSchedulesCapability() {
  return useApiQuery(
    ['scheduler', 'project-schedules-capability'],
    async () => {
      const handshake = await readPublicStationCapabilities(
        await _getApiBase(),
      );
      return handshake ? hasCapability(handshake, 'projectSchedules') : null;
    },
    { staleTime: 10_000, retry: false },
  );
}

/**
 * Whether the host stores and renames a job's display name
 * (`schedulerJobDisplayName`). An older host drops `displayName` and still
 * answers success, so a client offers renaming only on `true`. `null`: the
 * handshake could not be read.
 */
export function useSchedulerJobDisplayNameCapability() {
  return useApiQuery(
    ['scheduler', 'job-display-name-capability'],
    async () => {
      const handshake = await readPublicStationCapabilities(
        await _getApiBase(),
      );
      return handshake
        ? hasCapability(handshake, 'schedulerJobDisplayName')
        : null;
    },
    { staleTime: 10_000, retry: false },
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
