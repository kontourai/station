import type {
  WorkflowFlowRun,
  WorkflowNextActionStatus,
  WorkflowPhase,
  WorkflowTaskStatus,
} from '@kontourai/station-contracts/workflow';
import { _getApiBase } from '../api';
import { type QueryConfig, useApiQuery } from '../query-core';

// ── Workflow task sidecars (durable Flow Agents task state, S3) ───────────
//
// VM field types are derived from @kontourai/station-contracts/workflow's
// unions (the same source WorkflowSidecarService validates against) rather
// than bare `string` — a single source of truth, no second drifting
// representation on the public SDK surface (#582 review finding).

export interface WorkflowNextActionVM {
  status: WorkflowNextActionStatus;
  summary: string;
  target_phase?: WorkflowPhase;
  target_artifact?: string;
  skills?: string[];
  operations?: string[];
  command?: string;
}

export interface WorkflowTaskSummaryVM {
  taskSlug: string;
  status: WorkflowTaskStatus;
  phase: WorkflowPhase;
  updatedAt: string;
  nextAction: WorkflowNextActionVM;
  workItemRefs?: string[];
  flowRun?: WorkflowFlowRun;
  hasHandoff: boolean;
  path: string;
}

export interface WorkflowTaskStateVM {
  schema_version: string;
  task_slug: string;
  repo?: string;
  status: WorkflowTaskStatus;
  phase: WorkflowPhase;
  owner?: string;
  created_at?: string;
  updated_at: string;
  source_request?: string;
  artifact_paths?: string[];
  work_item_refs?: string[];
  flow_run?: WorkflowFlowRun;
  next_action: WorkflowNextActionVM;
}

export interface WorkflowTaskHandoffVM {
  schema_version: string;
  task_slug: string;
  repo?: string;
  summary: string;
  current_state_ref?: string;
  next_steps: string[];
  blockers?: string[];
  warnings?: string[];
}

export interface WorkflowTaskDetailVM {
  taskSlug: string;
  state: WorkflowTaskStateVM;
  handoff: WorkflowTaskHandoffVM | null;
  path: string;
}

async function fetchWorkflowJson<T>(path: string, label: string): Promise<T> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}${path}`);
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, `Failed to load ${label}`));
  }
  return result.data as T;
}

export function useWorkflowTasksQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<WorkflowTaskSummaryVM[]>,
) {
  return useApiQuery<WorkflowTaskSummaryVM[]>(
    ['workflow-tasks', projectSlug ?? ''],
    async () =>
      fetchWorkflowJson(
        `/api/projects/${encodeURIComponent(projectSlug!)}/workflow/tasks`,
        'Workflow tasks',
      ),
    {
      ...config,
      enabled: !!projectSlug && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 15_000,
      refetchInterval: config?.refetchInterval ?? 30_000,
    },
  );
}

export function useWorkflowTaskDetailQuery(
  projectSlug: string | null | undefined,
  taskSlug: string | null | undefined,
  config?: QueryConfig<WorkflowTaskDetailVM>,
) {
  return useApiQuery<WorkflowTaskDetailVM>(
    ['workflow-task', projectSlug ?? '', taskSlug ?? ''],
    async () =>
      fetchWorkflowJson(
        `/api/projects/${encodeURIComponent(projectSlug!)}/workflow/tasks/${encodeURIComponent(taskSlug!)}`,
        'Workflow task',
      ),
    {
      ...config,
      enabled: !!projectSlug && !!taskSlug && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 15_000,
      refetchInterval: config?.refetchInterval ?? 30_000,
    },
  );
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
