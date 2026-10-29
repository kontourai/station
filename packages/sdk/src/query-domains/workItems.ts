import type { TaskCreateInput } from '@kontourai/station-contracts/task-graph';
import type {
  ProviderWorkItem,
  StartTaskFromWorkItemResult,
  TaskWorkItemObservationResponse,
  WorkItemClaimStatus,
  WorkItemProviderCapabilities,
  WorkItemProviderIdentity,
  WorkItemsListResponse,
} from '@kontourai/station-contracts/work-item-provider';
import { _getApiBase } from '../api';
import { StationHttpError } from '../client/http';
import { type QueryConfig, useApiMutation, useApiQuery } from '../query-core';

// ── Work-item provider seam (roadmap #583, part of epic #580, S3) ────────
//
// VM field types are re-exported from @kontourai/station-contracts/
// work-item-provider — the same shapes the server-side seam
// (WorkItemProviderService) returns — rather than a second drifting
// representation on the SDK surface (the same discipline workflowTasks.ts
// uses for its VM types).

export type {
  ProviderWorkItem,
  StartTaskFromWorkItemResult,
  TaskWorkItemObservationResponse,
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

// ── Tracker-backed Tasks (#4003) ─────────────────────────────────────────
//
// Start Task on a provider row, and the Task's linked-item header. The item
// is re-read when the header mounts; nothing polls it.

export interface StartTaskFromWorkItemInput {
  projectId: string;
  workItemRef: string;
  agentId?: string;
  workspaceBinding?: TaskCreateInput['workspaceBinding'];
}

async function readResult<T>(response: Response, fallback: string): Promise<T> {
  const result = (await response.json()) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!response.ok || !result.success || result.data === undefined)
    throw new StationHttpError(
      response.status,
      apiErrorMessage(result, fallback),
    );
  return result.data;
}

export async function startTaskFromWorkItem(
  input: StartTaskFromWorkItemInput,
): Promise<StartTaskFromWorkItemResult> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/tasks/from-work-item`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return readResult(response, 'Failed to start a Task from the work item');
}

/** Creates a Task from a board item, or returns the item's open Task. */
export function useStartTaskFromWorkItemMutation() {
  return useApiMutation(startTaskFromWorkItem, {
    invalidateKeys: [['tasks'], ['work-items']],
  });
}

export async function fetchTaskWorkItem(
  taskId: string,
): Promise<TaskWorkItemObservationResponse> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/work-item`,
  );
  return readResult(response, 'Failed to read the linked work item');
}

/** The Task's linked tracker item, read again every time it mounts. */
export function useTaskWorkItemQuery(
  taskId: string,
  config?: QueryConfig<TaskWorkItemObservationResponse>,
) {
  return useApiQuery<TaskWorkItemObservationResponse>(
    ['task-work-item', taskId],
    () => fetchTaskWorkItem(taskId),
    {
      ...config,
      enabled: taskId.length > 0 && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 0,
      refetchOnMount: config?.refetchOnMount ?? 'always',
      // A gh failure is the host's state; retrying only repeats the call.
      retry: config?.retry ?? false,
    },
  );
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
