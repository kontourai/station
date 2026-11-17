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
import { envelopeError } from '../client/api-error-message';
import { readJsonBody } from '../client/http';
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
  return readResult<WorkItemsListResponse>(
    response,
    'Failed to load work items',
  );
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
  return readResult<WorkItemClaimStatus>(
    response,
    'Failed to load claim status',
  );
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

/**
 * The canonical envelope read with this domain's own fallback sentence: a
 * refusal throws the `StationHttpError` from `envelopeError` (status, `code`,
 * `details`), and a body that is not JSON (a proxy's error page, an empty
 * body) reports the status instead of a parse exception.
 */
async function readResult<T>(response: Response, fallback: string): Promise<T> {
  const result = (await readJsonBody(response)) as
    | { success?: boolean; data?: T }
    | null
    | undefined;
  if (!response.ok || !result?.success || result.data === undefined)
    throw envelopeError(response, result, fallback);
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

import { authenticatedFetch } from '../client/http';
