import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import { type QueryConfig, useApiQuery } from '../query-core';
// ── Runtime resource posture (station#3089) ───────────────────────────────
//
// Developer-facing CPU diagnostics from `GET /api/system/resource-posture`.
// Product behavior must never branch on this display-only projection.

export type ResourcePostureKind =
  | 'healthy'
  | 'degraded'
  | 'critical'
  | 'unavailable';

export interface ResourcePostureVM {
  kind: ResourcePostureKind;
  /** Latest raw sample; absent only when observation is unavailable. */
  busyPercent?: number;
  cpuCount: number;
  sampledAt: number | null;
  ageMs?: number | null;
  sampleMs: number | null;
  thresholdPercent: number;
  criticalThresholdPercent?: number;
  source: string;
}

export async function fetchResourcePosture(): Promise<ResourcePostureVM> {
  const apiBase = await _getApiBase();
  return fetchResourcePostureForApiBase(apiBase);
}

export async function fetchResourcePostureForApiBase(
  apiBase: string,
): Promise<ResourcePostureVM> {
  const response = await authenticatedFetch(
    `${apiBase}/api/system/resource-posture`,
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load resource posture'));
  }
  return result.data as ResourcePostureVM;
}

export function useResourcePostureForApiBaseQuery(
  apiBase: string,
  config?: QueryConfig<ResourcePostureVM>,
) {
  return useApiQuery<ResourcePostureVM>(
    ['resource-posture', apiBase],
    () => fetchResourcePostureForApiBase(apiBase),
    {
      ...config,
      staleTime: config?.staleTime ?? 10_000,
      refetchInterval: config?.refetchInterval ?? RESOURCE_POSTURE_POLL_MS,
    },
  );
}

/**
 * Polling honesty: this diagnostic is time-varying and this app
 * globally disables refetch-on-focus/refetch-on-mount (`query-core.ts`), so
 * the poll interval is the ONLY freshness mechanism — a 15s cadence bounds
 * how stale a rendered reading can be, matching `operatingState.ts`'s
 * interval for the same class of host-state poll. `staleTime` is kept below
 * the poll interval so a second mount (e.g. the composer and a Schedule view
 * open at once) shares the same cached read rather than double-sampling —
 * each server-side observation costs a real sampling window, so this is not
 * free to over-poll.
 */
const RESOURCE_POSTURE_POLL_MS = 15_000;

export function useResourcePostureQuery(
  config?: QueryConfig<ResourcePostureVM>,
) {
  return useApiQuery<ResourcePostureVM>(
    ['resource-posture'],
    fetchResourcePosture,
    {
      ...config,
      staleTime: config?.staleTime ?? 10_000,
      refetchInterval: config?.refetchInterval ?? RESOURCE_POSTURE_POLL_MS,
    },
  );
}
