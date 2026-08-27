import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import { type QueryConfig, useApiQuery } from '../query-core';
// ── Runtime resource posture (station#3089) ───────────────────────────────
//
// The one client read of the runtime resource posture
// `src-server/services/infra/resource-posture.ts` already derives and
// enforces (`admitEngineStart` refuses engine starts at critical,
// `admitScheduledJob` defers scheduled jobs at degraded/critical). This
// fetches `GET /api/system/resource-posture`, which reads the SAME probe —
// there is no second threshold or derivation on this side of the wire, only
// a typed projection of the server's response.

export type ResourcePostureKind =
  | 'healthy'
  | 'degraded'
  | 'critical'
  | 'unavailable';

export interface ResourcePostureVM {
  kind: ResourcePostureKind;
  /** Absent only for `kind: 'unavailable'` — no observation to report. */
  busyPercent?: number;
  cpuCount: number;
  sampledAt: number | null;
  sampleMs: number | null;
  thresholdPercent: number;
  source: string;
}

export async function fetchResourcePosture(): Promise<ResourcePostureVM> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/system/resource-posture`,
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load resource posture'));
  }
  return result.data as ResourcePostureVM;
}

/**
 * Polling honesty (station#3089): posture is time-varying and this app
 * globally disables refetch-on-focus/refetch-on-mount (`query-core.ts`), so
 * the poll interval is the ONLY freshness mechanism — a 15s cadence bounds
 * how stale a rendered reading can be, matching `operatingState.ts`'s
 * interval for the same class of host-state poll. `staleTime` is kept below
 * the poll interval so a second mount (e.g. the composer and a Schedule view
 * open at once) shares the same cached read rather than double-sampling —
 * each server-side observation costs a real ~500ms CPU sampling window
 * (`scripts/lib/verification-host-pressure.mjs`), so this is not free to
 * over-poll.
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
