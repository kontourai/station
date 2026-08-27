import type {
  ProposedChange,
  ProposedChangeBulkDecisionInput,
  ProposedChangeCreateInput,
  ProposedChangeDecisionInput,
  ProposedChangeFilters,
} from '@kontourai/station-contracts/proposed-change';
import { _getApiBase } from '../api';
import { type QueryConfig, useApiMutation, useApiQuery } from '../query-core';

interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export const proposedChangesQueryKey = (filters?: ProposedChangeFilters) => [
  'proposed-changes',
  filters ?? {},
];

export async function fetchProposedChanges(
  filters?: ProposedChangeFilters,
): Promise<ProposedChange[]> {
  const apiBase = await _getApiBase();
  const params = new URLSearchParams();
  filters?.status?.forEach((status) => params.append('status', status));
  if (filters?.sessionId) params.set('sessionId', filters.sessionId);
  if (filters?.projectId) params.set('projectId', filters.projectId);
  const query = params.toString();
  const response = await authenticatedFetch(
    `${apiBase}/api/proposed-changes${query ? `?${query}` : ''}`,
  );
  const result = (await response.json()) as ApiResult<ProposedChange[]>;
  if (!response.ok || !result.success) {
    throw new Error(
      apiErrorMessage(result, 'Failed to fetch proposed changes'),
    );
  }
  return result.data ?? [];
}

export async function createProposedChange(
  input: ProposedChangeCreateInput,
): Promise<ProposedChange> {
  return requestProposedChange('/api/proposed-changes', input);
}

export async function approveProposedChange(input: {
  id: string;
  decision?: ProposedChangeDecisionInput;
}): Promise<ProposedChange> {
  return requestProposedChange(
    `/api/proposed-changes/${encodeURIComponent(input.id)}/approve`,
    input.decision ?? {},
  );
}

export async function rejectProposedChange(input: {
  id: string;
  decision?: ProposedChangeDecisionInput;
}): Promise<ProposedChange> {
  return requestProposedChange(
    `/api/proposed-changes/${encodeURIComponent(input.id)}/reject`,
    input.decision ?? {},
  );
}

export async function bulkApproveProposedChanges(
  input: ProposedChangeBulkDecisionInput,
): Promise<ProposedChange[]> {
  return requestProposedChanges('/api/proposed-changes/bulk/approve', input);
}

export async function bulkRejectProposedChanges(
  input: ProposedChangeBulkDecisionInput,
): Promise<ProposedChange[]> {
  return requestProposedChanges('/api/proposed-changes/bulk/reject', input);
}

export function useProposedChangesQuery(
  filters?: ProposedChangeFilters,
  config?: QueryConfig<ProposedChange[]>,
) {
  return useApiQuery(
    proposedChangesQueryKey(filters),
    () => fetchProposedChanges(filters),
    config,
  );
}

export function useCreateProposedChangeMutation() {
  return useApiMutation(createProposedChange, {
    invalidateKeys: [['proposed-changes']],
  });
}

export function useApproveProposedChangeMutation() {
  return useApiMutation(approveProposedChange, {
    invalidateKeys: [['proposed-changes']],
  });
}

export function useRejectProposedChangeMutation() {
  return useApiMutation(rejectProposedChange, {
    invalidateKeys: [['proposed-changes']],
  });
}

export function useBulkApproveProposedChangesMutation() {
  return useApiMutation(bulkApproveProposedChanges, {
    invalidateKeys: [['proposed-changes']],
  });
}

export function useBulkRejectProposedChangesMutation() {
  return useApiMutation(bulkRejectProposedChanges, {
    invalidateKeys: [['proposed-changes']],
  });
}

async function requestProposedChange(
  path: string,
  body: unknown,
): Promise<ProposedChange> {
  const result = await requestJson<ProposedChange>(path, body);
  return result;
}

async function requestProposedChanges(
  path: string,
  body: unknown,
): Promise<ProposedChange[]> {
  const result = await requestJson<ProposedChange[]>(path, body);
  return result;
}

async function requestJson<T>(path: string, body: unknown): Promise<T> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as ApiResult<T>;
  if (!response.ok || !result.success || result.data === undefined) {
    throw new Error(
      apiErrorMessage(result, 'Failed to update proposed change'),
    );
  }
  return result.data;
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
