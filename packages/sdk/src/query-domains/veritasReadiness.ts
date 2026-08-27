import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { type QueryConfig, useApiQuery } from '../query-core';

// ── Veritas merge readiness (project-scoped) ──────────────────────────────

export type ReadinessStatus =
  | 'satisfied'
  | 'missing'
  | 'stale'
  | 'failing'
  | 'advisory'
  | 'recheckable'
  | 'accepted';

export interface ReadinessRequirementVM {
  id: string;
  kind:
    | 'evidence-check'
    | 'policy'
    | 'governance'
    | 'recommendation'
    | 'exception';
  label: string;
  status: ReadinessStatus;
  summary: string;
  claimIds: string[];
}

export interface ReadinessTrustClaimVM {
  id: string;
  status: string;
  claimType: string;
  fieldOrBehavior: string;
  subjectId: string;
  value?: unknown;
  updatedAt?: string;
}

export interface ReadinessTrustEvidenceVM {
  id: string;
  claimId: string;
  excerptOrSummary: string;
  sourceRef: string;
  method?: string;
  observedAt?: string;
  passing?: boolean;
  blocking?: boolean;
}

export interface ReadinessTrustGapVM {
  id: string;
  claimId: string;
  type: string;
  severity: string;
  message: string;
}

export interface ReadinessTrustReportVM {
  id?: string;
  generatedAt?: string;
  claims: ReadinessTrustClaimVM[];
  evidence: ReadinessTrustEvidenceVM[];
  transparencyGaps: ReadinessTrustGapVM[];
}

export interface ReadinessSnapshotVM {
  configured: boolean;
  reason?: string;
  generatedAt?: string;
  overall?: 'ready' | 'not-ready';
  cli?: {
    runId: string;
    message: string;
    reportArtifactPath: string;
    sourceKind: string;
    evidenceCheckLabels: string[];
    evidenceCheckFailure: {
      label?: string;
      message?: string;
      exitCode?: number | null;
    } | null;
  };
  requirements?: ReadinessRequirementVM[];
  counts?: Record<ReadinessStatus, number>;
  trustReport?: ReadinessTrustReportVM | null;
}

async function fetchReadiness(
  projectSlug: string,
  refresh = false,
): Promise<ReadinessSnapshotVM> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/readiness${refresh ? '?refresh=true' : ''}`,
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load merge readiness'));
  }
  return result.data as ReadinessSnapshotVM;
}

export function useReadinessQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<ReadinessSnapshotVM>,
) {
  return useApiQuery<ReadinessSnapshotVM>(
    ['veritas-readiness', projectSlug ?? ''],
    async () => fetchReadiness(projectSlug!),
    {
      ...config,
      enabled: !!projectSlug && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 30_000,
      // Hold the outgoing project's readiness while the new one loads
      // (station#3092) — ReadinessPanel marks the held render via
      // `isPlaceholderData` so a project switch never reads as the new
      // project's verdict.
      keepPreviousData: config?.keepPreviousData ?? true,
    },
  );
}

export function useRefreshReadinessMutation(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => fetchReadiness(projectSlug, true),
    onSuccess: (data) => {
      queryClient.setQueryData(['veritas-readiness', projectSlug], data);
    },
  });
}

export interface ReadinessInitResultVM {
  outcome: 'created' | 'already-initialized' | 'no-cli';
  /** A copyable command to run manually when no local CLI is resolvable. */
  command?: string;
}

export function useInitReadinessMutation(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<ReadinessInitResultVM> => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/readiness/init`,
        { method: 'POST' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Failed to set up readiness'));
      }
      return result.data as ReadinessInitResultVM;
    },
    onSuccess: (data) => {
      // A created/already-initialized workspace becomes readable — drop the
      // cached not-configured snapshot so the panel refetches real data.
      if (data.outcome !== 'no-cli') {
        queryClient.invalidateQueries({
          queryKey: ['veritas-readiness', projectSlug],
        });
      }
    },
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
