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

/** The Station predates continuing after a memory kill (404). */
export class MemoryContinuationUnsupportedError extends Error {
  constructor() {
    super('This Station cannot continue after a memory kill.');
    this.name = 'MemoryContinuationUnsupportedError';
  }
}

/**
 * A person's Continue after the conversation's engine ran out of memory.
 * Station sends the continuation (with its recovery note) under a key derived
 * from the dead turn, so `already-started` means someone, or Station itself,
 * continued it first.
 */
export async function continueAfterMemoryExhaustion(
  conversationId: string,
  apiBase?: string,
): Promise<'queued' | 'already-started'> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/memory-continuation`,
    { method: 'POST' },
  );
  const result = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    code?: string;
    error?: string;
  };
  if (response.status === 404 && result.code === undefined)
    throw new MemoryContinuationUnsupportedError();
  if (result.code === 'memory_continuation_already_started')
    return 'already-started';
  if (!response.ok || !result.success)
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  return 'queued';
}
