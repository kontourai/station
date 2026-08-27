import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { type QueryConfig, useApiQuery } from '../query-core';

// ── Flow runs (project-scoped gate-engine runs) ───────────────────────────

export interface FlowDefinitionSummaryVM {
  id: string;
  version?: string;
  path: string;
  valid: boolean;
}

export interface FlowWorkspaceStatusVM {
  initialized: boolean;
  definitions: FlowDefinitionSummaryVM[];
}

export interface FlowInitResultVM extends FlowWorkspaceStatusVM {
  outcome: 'created' | 'already-initialized';
}

export interface FlowRunSummaryVM {
  run_id: string;
  definition_id: string;
  subject: string;
  status: string;
  current_step: string;
  updated_at: string;
}

export interface SurveyFlowReviewItemVM {
  reviewSessionRef: string;
  projectSlug: string;
  projectionSource: string;
  workflowSubjectRef: string;
  sessionName: string;
  updatedAt: string;
  summary: {
    accepted: number;
    keptCurrent: number;
    rejected: number;
    escalated: number;
    unresolved: number;
  };
  items: Array<{
    target: string;
    targetLabel: string;
    statusLabel: string;
    candidates: Array<{
      roleLabel: string;
      valueText: string;
      sourceText: string;
    }>;
  }>;
}

export interface FlowConsoleExpectationVM {
  id: string;
  gate_id?: string;
  kind: string | null;
  required: boolean;
  description: string | null;
}

/**
 * A single hachure Surface claim inside a trust.bundle evidence entry's
 * bundle payload (`FlowEvidenceEntry.bundle.claims` in @kontourai/flow).
 */
export interface FlowBundleClaimVM {
  claimType?: string;
  status?: string;
}

export interface FlowConsoleEvidenceVM {
  id: string;
  gate_id: string | null;
  kind: string | null;
  status: string | null;
  expectation_ids: string[];
  producer: string | null;
  stored_path: string | null;
  route_reason: string | null;
  /**
   * The raw manifest evidence entry, kept verbatim by Flow's console
   * projection (`projectFlowRunFromFiles`). Trust.bundle evidence carries
   * its claims at `raw.bundle.claims` — the retired top-level `claim` field
   * is gone as of Flow 1.3.x (see @kontourai/flow's `FlowEvidenceEntry`).
   */
  raw?: { bundle?: { claims?: FlowBundleClaimVM[] } } | null;
}

export interface FlowConsoleGateVM {
  id: string;
  step_id: string;
  status: string;
  summary: string;
  is_open: boolean;
  expectations: FlowConsoleExpectationVM[];
  evidence: FlowConsoleEvidenceVM[];
  missing: string[];
  route_back_to?: string;
  route_reason?: string;
  attempt?: number;
  max_attempts?: number;
  limit_exceeded?: boolean;
  /** Immutable Flow receipt identity, present only for a persisted outcome. */
  evaluation_ref?: { runId: string; gateId: string; evaluationId: string };
}

export interface FlowConsoleExceptionVM {
  id: string;
  gate_id: string | null;
  reason: string | null;
  authority: string | null;
  accepted_at: string | null;
}

export interface FlowConsoleRouteBackVM {
  id: string;
  gate_id: string | null;
  route_back_to: string | null;
  reason: string | null;
  recovery_step: string | null;
  attempt: number | null;
  max_attempts: number | null;
  limit_exceeded: boolean;
}

export interface FlowConsoleStepVM {
  id: string;
  index: number;
  label: string;
  next: string | null;
  gates: string[];
}

export interface FlowRunConsoleVM {
  run: {
    run_id: string;
    definition_id: string;
    definition_version: string;
    subject: string | null;
    status: string | null;
    current_step: string | null;
    updated_at: string | null;
  };
  steps: FlowConsoleStepVM[];
  current_step: string | null;
  open_gates: string[];
  gates: FlowConsoleGateVM[];
  evidence: FlowConsoleEvidenceVM[];
  exceptions: FlowConsoleExceptionVM[];
  route_backs: FlowConsoleRouteBackVM[];
  next_action: string | null;
  report: { path: string | null } | null;
}

async function fetchFlowJson<T>(path: string, label: string): Promise<T> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}${path}`);
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, `Failed to load ${label}`));
  }
  return result.data as T;
}

const SURVEY_FLOW_REVIEW_UNAVAILABLE_REASONS = [
  /** The project workspace path could not be traversed or opened. */
  'workspace-unreadable',
  /** The review-sessions file was reachable but could not be read or parsed. */
  'sessions-unreadable',
  /** Building the review projection from the loaded sessions threw. */
  'projection-failed',
] as const;
export type SurveyFlowReviewUnavailableReason =
  (typeof SURVEY_FLOW_REVIEW_UNAVAILABLE_REASONS)[number];

export interface SurveyFlowReviewUnavailableProjectVM {
  projectSlug: string;
  reason: SurveyFlowReviewUnavailableReason;
}

/** Total over the project inventory: unreadable projects arrive as entries
 * beside the readable items, never as a transport failure (#3322). */
export interface SurveyFlowReviewsVM {
  items: SurveyFlowReviewItemVM[];
  unavailableProjects: SurveyFlowReviewUnavailableProjectVM[];
}

/**
 * This package is published, so it can be pointed at a Station older than
 * #3322, which answers with a bare item array. Reading `.items` off that array
 * would render an empty Review Queue for a source that loaded fine — the one
 * thing that surface must never do — so the legacy shape is adapted, and a
 * response that is neither shape throws instead of shrinking to zero.
 */
function normalizeSurveyFlowReviews(data: unknown): SurveyFlowReviewsVM {
  if (Array.isArray(data)) {
    return { items: data as SurveyFlowReviewItemVM[], unavailableProjects: [] };
  }
  const aggregate = data as Partial<SurveyFlowReviewsVM> | null | undefined;
  if (
    !aggregate ||
    !Array.isArray(aggregate.items) ||
    !Array.isArray(aggregate.unavailableProjects)
  ) {
    throw new Error('Survey Flow reviews response is invalid');
  }
  for (const project of aggregate.unavailableProjects) {
    if (
      !SURVEY_FLOW_REVIEW_UNAVAILABLE_REASONS.includes(
        project?.reason as SurveyFlowReviewUnavailableReason,
      )
    ) {
      throw new Error('Survey Flow reviews unavailability reason is invalid');
    }
  }
  return {
    items: aggregate.items,
    unavailableProjects: aggregate.unavailableProjects,
  };
}

export async function fetchSurveyFlowReviews(): Promise<SurveyFlowReviewsVM> {
  return normalizeSurveyFlowReviews(
    await fetchFlowJson<unknown>(
      '/api/survey-flow-reviews',
      'Survey Flow reviews',
    ),
  );
}

export function useSurveyFlowReviewsQuery(
  config?: QueryConfig<SurveyFlowReviewsVM>,
) {
  return useApiQuery(['survey-flow-reviews'], fetchSurveyFlowReviews, {
    ...config,
    staleTime: config?.staleTime ?? 15_000,
  });
}

export function useFlowDefinitionsQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<FlowWorkspaceStatusVM>,
) {
  return useApiQuery<FlowWorkspaceStatusVM>(
    ['flow-definitions', projectSlug ?? ''],
    async () =>
      fetchFlowJson(
        `/api/projects/${encodeURIComponent(projectSlug!)}/flow/definitions`,
        'Flow definitions',
      ),
    {
      ...config,
      enabled: !!projectSlug && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 30_000,
    },
  );
}

export function useInitFlowMutation(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<FlowInitResultVM> => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/flow/init`,
        { method: 'POST' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to add a delivery flow'),
        );
      }
      return result.data as FlowInitResultVM;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['flow-definitions', projectSlug],
      });
    },
  });
}

export function useFlowRunsQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<FlowRunSummaryVM[]>,
) {
  return useApiQuery<FlowRunSummaryVM[]>(
    ['flow-runs', projectSlug ?? ''],
    async () =>
      fetchFlowJson(
        `/api/projects/${encodeURIComponent(projectSlug!)}/flow/runs`,
        'Flow runs',
      ),
    {
      ...config,
      enabled: !!projectSlug && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 15_000,
    },
  );
}

export function useFlowRunConsoleQuery(
  projectSlug: string | null | undefined,
  runId: string | null | undefined,
  config?: QueryConfig<FlowRunConsoleVM>,
) {
  return useApiQuery<FlowRunConsoleVM>(
    ['flow-run-console', projectSlug ?? '', runId ?? ''],
    async () =>
      fetchFlowJson(
        `/api/projects/${encodeURIComponent(projectSlug!)}/flow/runs/${encodeURIComponent(runId!)}/console`,
        'Flow run console',
      ),
    {
      ...config,
      enabled: !!projectSlug && !!runId && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 15_000,
    },
  );
}

// ── Gate re-evaluation / exception acceptance (attention inbox gate items) ─
// Both post to the SAME routes the Flow run console already uses
// (POST .../runs/:runId/evaluate, POST .../runs/:runId/exception) so a
// decision made from the inbox produces an identical receipt trail to one
// made in the console.

export interface EvaluateFlowGateInput {
  projectSlug: string;
  runId: string;
  gate: string;
}

export async function evaluateFlowGate(
  input: EvaluateFlowGateInput,
): Promise<unknown> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(input.projectSlug)}/flow/runs/${encodeURIComponent(input.runId)}/evaluate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gate: input.gate }),
    },
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to re-evaluate gate'));
  }
  return result.data;
}

export interface AcceptFlowExceptionInput {
  projectSlug: string;
  runId: string;
  gate: string;
  reason: string;
  authority: string;
}

export async function acceptFlowException(
  input: AcceptFlowExceptionInput,
): Promise<unknown> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(input.projectSlug)}/flow/runs/${encodeURIComponent(input.runId)}/exception`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gate: input.gate,
        reason: input.reason,
        authority: input.authority,
      }),
    },
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to accept exception'));
  }
  return result.data;
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
