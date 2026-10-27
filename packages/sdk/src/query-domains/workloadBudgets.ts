import type { WorkloadBudgetStatus } from '@kontourai/station-contracts/system-status';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import {
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
} from '../query-core';

export type { WorkloadBudgetStatus };

/**
 * Thrown when this Station does not serve workload budgets (an older host,
 * or a hosted deployment). Callers say so rather than show an error.
 */
export class WorkloadBudgetsUnsupportedError extends Error {
  constructor() {
    super(
      'This Station does not report workload budgets. Update Station to manage them.',
    );
    this.name = 'WorkloadBudgetsUnsupportedError';
  }
}

async function readEnvelope(response: Response): Promise<WorkloadBudgetStatus> {
  const result = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    data?: WorkloadBudgetStatus;
    error?: string;
    code?: string;
  };
  if (response.status === 404 && result.code !== 'feature_preview_disabled')
    throw new WorkloadBudgetsUnsupportedError();
  if (!response.ok || !result.success || !result.data)
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  return result.data;
}

export async function fetchWorkloadBudgets(
  apiBase?: string,
): Promise<WorkloadBudgetStatus> {
  const base = await resolveApiBase(apiBase);
  return readEnvelope(await authenticatedFetch(`${base}/api/system/workload`));
}

/** `null` returns a budget to its default. */
export async function updateWorkloadBudgetSettings(
  input: { memoryMiB: number | null; totalMemoryMiB: number | null },
  apiBase?: string,
): Promise<WorkloadBudgetStatus> {
  const base = await resolveApiBase(apiBase);
  return readEnvelope(
    await authenticatedFetch(`${base}/api/system/workload/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export function useWorkloadBudgetsQuery(
  apiBase?: string,
  config?: QueryConfig<WorkloadBudgetStatus>,
) {
  return useApiQuery(
    ['workload-budgets', apiBase ?? 'default'],
    () => fetchWorkloadBudgets(apiBase),
    config,
  );
}

export function useUpdateWorkloadBudgetSettingsMutation(apiBase?: string) {
  return useApiMutation(
    (input: { memoryMiB: number | null; totalMemoryMiB: number | null }) =>
      updateWorkloadBudgetSettings(input, apiBase),
    { invalidateKeys: [['workload-budgets']] },
  );
}
