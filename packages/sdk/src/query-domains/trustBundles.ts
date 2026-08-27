import { _getApiBase } from '../api';
import { type QueryConfig, useApiQuery } from '../query-core';

// ── Surface trust bundles (project-scoped) ────────────────────────────────

export type TrustBundleSourceVM = 'workspace' | 'station-home';

export interface TrustBundleSummaryVM {
  id: string;
  fileName: string;
  path: string;
  source: TrustBundleSourceVM;
  plugin?: string;
  modifiedAt: string;
  valid: boolean;
  error?: string;
  bundleSource?: string;
  claimCount?: number;
  claimsByStatus?: Record<string, number>;
  transparencyGapCount?: number;
}

export interface TrustReportClaimVM {
  id: string;
  status: string;
  claimType: string;
  fieldOrBehavior: string;
  subjectId: string;
  value?: unknown;
  updatedAt?: string;
}

export interface TrustReportEvidenceVM {
  id: string;
  claimId: string;
  excerptOrSummary: string;
  sourceRef: string;
  method?: string;
  observedAt?: string;
  passing?: boolean;
  blocking?: boolean;
}

export interface TrustReportGapVM {
  id: string;
  claimId: string;
  type: string;
  severity: string;
  message: string;
}

export interface TrustReportVM {
  id?: string;
  generatedAt?: string;
  source?: string;
  claims: TrustReportClaimVM[];
  evidence: TrustReportEvidenceVM[];
  transparencyGaps: TrustReportGapVM[];
  summary?: {
    totalClaims: number;
    byStatus: Record<string, number>;
  };
}

export interface TrustReportResultVM {
  id: string;
  path: string;
  source: TrustBundleSourceVM;
  plugin?: string;
  modifiedAt: string;
  valid: boolean;
  error?: string;
  report: TrustReportVM | null;
}

async function fetchTrustJson<T>(path: string, label: string): Promise<T> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}${path}`);
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, `Failed to load ${label}`));
  }
  return result.data as T;
}

export function useTrustBundlesQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<TrustBundleSummaryVM[]>,
) {
  return useApiQuery<TrustBundleSummaryVM[]>(
    ['trust-bundles', projectSlug ?? ''],
    async () =>
      fetchTrustJson(
        `/api/projects/${encodeURIComponent(projectSlug!)}/trust-bundles`,
        'trust bundles',
      ),
    {
      ...config,
      enabled: !!projectSlug && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 30_000,
      // Hold the outgoing project's bundle list while the new one loads
      // (station#3092) — TrustPanel marks the held render via
      // `isPlaceholderData` so a project switch never reads as the new
      // project's bundles.
      keepPreviousData: config?.keepPreviousData ?? true,
    },
  );
}

export function useTrustReportQuery(
  projectSlug: string | null | undefined,
  bundleId: string | null | undefined,
  config?: QueryConfig<TrustReportResultVM>,
) {
  return useApiQuery<TrustReportResultVM>(
    ['trust-report', projectSlug ?? '', bundleId ?? ''],
    async () =>
      fetchTrustJson(
        `/api/projects/${encodeURIComponent(projectSlug!)}/trust-bundles/${encodeURIComponent(bundleId!)}`,
        'trust report',
      ),
    {
      ...config,
      enabled: !!projectSlug && !!bundleId && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 30_000,
      // Deliberately NOT defaulted on (station#3092). This key carries a
      // legitimately-nullable selection (`bundleId`), and holding across it
      // breaks two ways:
      //
      //  1. A caller derives the selection FROM a held list — during a
      //     project switch that is the previous project's bundle id against
      //     the new project's slug, which is a real request for a bundle
      //     that project does not own.
      //  2. TanStack applies placeholderData without an `enabled` check
      //     (query-core's queryObserver: `status === 'pending'`), and a
      //     disabled query is pending forever — so `isPlaceholderData`
      //     never clears, and any aria-busy derived from it sticks.
      //
      // A caller that genuinely wants the hold can still pass it.
      keepPreviousData: config?.keepPreviousData,
    },
  );
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
