import type {
  ProviderWorkItem,
  WorkItemClaimStatus,
  WorkItemProviderCapabilities,
  WorkItemProviderIdentity,
  WorkItemsListResponse,
} from '@kontourai/station-contracts/work-item-provider';
import { _getApiBase } from '../api';
import { type QueryConfig, useApiQuery } from '../query-core';

// ── Work-item provider seam (roadmap #583, part of epic #580, S3) ────────
//
// VM field types are re-exported from @kontourai/station-contracts/
// work-item-provider — the same shapes the server-side seam
// (WorkItemProviderService) returns — rather than a second drifting
// representation on the SDK surface (the same discipline workflowTasks.ts
// uses for its VM types).

export type {
  ProviderWorkItem,
  WorkItemClaimStatus,
  WorkItemProviderCapabilities,
  WorkItemProviderIdentity,
};

export interface WorkItemProviderResultVM {
  identity: WorkItemProviderIdentity;
  capabilities: WorkItemProviderCapabilities;
  available: boolean;
  items: ProviderWorkItem[];
  warnings?: string[];
  reason?: string;
}

export interface WorkItemsListResponseVM {
  providers: WorkItemProviderResultVM[];
}

async function fetchWorkItemsJson(
  projectSlug: string,
): Promise<WorkItemsListResponse> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/work-items`,
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load work items'));
  }
  return result.data as WorkItemsListResponse;
}

export function useWorkItemsQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<WorkItemsListResponseVM>,
) {
  return useApiQuery<WorkItemsListResponseVM>(
    ['work-items', projectSlug ?? ''],
    async () => fetchWorkItemsJson(projectSlug!),
    {
      ...config,
      enabled: !!projectSlug && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 15_000,
      refetchInterval: config?.refetchInterval ?? 30_000,
    },
  );
}

// ── AssignmentProvider claim read (roadmap #584, part of epic #580, S4) ──
//
// Generic claim-state lookup by namespaced subject id (a task's
// `workItemRef` or a raw `ProviderWorkItem.workItemRef`) — lets the Tasks
// board show claim state and guard dispatch for provider-backed rows.

async function fetchWorkItemClaimJson(
  projectSlug: string,
  subjectId: string,
): Promise<WorkItemClaimStatus> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/work-items/claim?subjectId=${encodeURIComponent(subjectId)}`,
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load claim status'));
  }
  return result.data as WorkItemClaimStatus;
}

export function useWorkItemClaimQuery(
  projectSlug: string | null | undefined,
  subjectId: string | null | undefined,
  config?: QueryConfig<WorkItemClaimStatus>,
) {
  return useApiQuery<WorkItemClaimStatus>(
    ['work-item-claim', projectSlug ?? '', subjectId ?? ''],
    async () => fetchWorkItemClaimJson(projectSlug!, subjectId!),
    {
      ...config,
      enabled: !!projectSlug && !!subjectId && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 10_000,
    },
  );
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
