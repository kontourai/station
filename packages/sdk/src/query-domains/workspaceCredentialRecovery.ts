import type {
  CredentialProfileApplicationProjection,
  CredentialRecoveryGroupProjection,
} from '@kontourai/station-contracts/connection-recovery';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import {
  type MutationOptions,
  type QueryConfig,
  useApiQuery,
} from '../query-core';
export const credentialRecoveryQueryKey = (id: string) =>
  ['connections', 'agent', id, 'credential-recovery'] as const;

export interface CredentialProfileInput {
  id: string;
  ref: string;
  label?: string;
}

export interface CredentialProfileEnrollmentInput {
  id: string;
  ref: string;
  enrolled: boolean;
}

export interface CredentialRecoveryPolicyInput {
  id: string;
  automatic: boolean;
}

export interface ImportCredentialProfileSnapshotInput {
  id: string;
  ref: string;
  includeCredentials?: boolean;
}

/** Candidate import reports relative entry names only; it never exposes an
 * absolute provider profile directory or credential material. */
export interface ImportCredentialProfileSnapshotResult {
  outcome: 'completed';
  copied: string[];
  skipped: Array<{ path: string; reason: string }>;
  provenanceUpdated: boolean;
}

export interface ApplyCredentialProfileInput {
  id: string;
  ref: string;
  confirmed: true;
  timeoutMs?: number;
}

function invalidateCredentialRecoveryQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
): void {
  queryClient.invalidateQueries({ queryKey: ['connections'] });
  queryClient.invalidateQueries({ queryKey: ['connections', 'runtimes'] });
  queryClient.invalidateQueries({ queryKey: ['connections', id] });
  queryClient.invalidateQueries({ queryKey: credentialRecoveryQueryKey(id) });
}

function useCredentialRecoveryMutation<
  TResult,
  TVariables extends { id: string },
>(
  request: (apiBase: string, variables: TVariables) => Promise<Response>,
  failureMessage: string,
  options?: MutationOptions<TResult, TVariables>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: TVariables) => {
      const response = await request(await _getApiBase(), variables);
      const result = await response.json();
      if (!result.success)
        throw new Error(apiErrorMessage(result, failureMessage));
      return result.data as TResult;
    },
    onSuccess: (data, variables) => {
      invalidateCredentialRecoveryQueries(queryClient, variables.id);
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useCredentialRecoveryQuery(
  id: string | undefined,
  config?: QueryConfig<CredentialRecoveryGroupProjection | null>,
) {
  return useApiQuery(
    [...credentialRecoveryQueryKey(id ?? '')],
    async () => {
      if (!id) return null;
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-recovery`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to load credential recovery'),
        );
      }
      return result.data as CredentialRecoveryGroupProjection;
    },
    { ...config, enabled: !!id && (config?.enabled ?? true) },
  );
}

export function useUpsertCredentialProfileMutation(
  options?: MutationOptions<
    CredentialRecoveryGroupProjection,
    CredentialProfileInput
  >,
) {
  return useCredentialRecoveryMutation<
    CredentialRecoveryGroupProjection,
    CredentialProfileInput
  >(
    (apiBase, { id, ref, label }) =>
      authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ref,
            ...(label === undefined ? {} : { label }),
          }),
        },
      ),
    'Failed to save credential profile',
    options,
  );
}

export function useDeleteCredentialProfileMutation(
  options?: MutationOptions<
    CredentialRecoveryGroupProjection,
    CredentialProfileInput
  >,
) {
  return useCredentialRecoveryMutation<
    CredentialRecoveryGroupProjection,
    CredentialProfileInput
  >(
    (apiBase, { id, ref }) =>
      authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles/${encodeURIComponent(ref)}`,
        { method: 'DELETE' },
      ),
    'Failed to delete credential profile',
    options,
  );
}

export function useSetCredentialProfileEnrollmentMutation(
  options?: MutationOptions<
    CredentialRecoveryGroupProjection,
    CredentialProfileEnrollmentInput
  >,
) {
  return useCredentialRecoveryMutation<
    CredentialRecoveryGroupProjection,
    CredentialProfileEnrollmentInput
  >(
    (apiBase, { id, ref, enrolled }) =>
      authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles/${encodeURIComponent(ref)}/enrollment`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enrolled }),
        },
      ),
    'Failed to update credential enrollment',
    options,
  );
}

export function useSetCredentialRecoveryAutomaticPolicyMutation(
  options?: MutationOptions<
    CredentialRecoveryGroupProjection,
    CredentialRecoveryPolicyInput
  >,
) {
  return useCredentialRecoveryMutation<
    CredentialRecoveryGroupProjection,
    CredentialRecoveryPolicyInput
  >(
    (apiBase, { id, automatic }) =>
      authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/policy`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ automatic }),
        },
      ),
    'Failed to update credential recovery policy',
    options,
  );
}

export function useImportCredentialProfileSnapshotMutation(
  options?: MutationOptions<
    ImportCredentialProfileSnapshotResult,
    ImportCredentialProfileSnapshotInput
  >,
) {
  return useCredentialRecoveryMutation<
    ImportCredentialProfileSnapshotResult,
    ImportCredentialProfileSnapshotInput
  >(
    (apiBase, { id, ref, includeCredentials }) =>
      authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles/${encodeURIComponent(ref)}/import`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            includeCredentials: includeCredentials === true,
          }),
        },
      ),
    'Failed to import credential profile',
    options,
  );
}

export function useApplyCredentialProfileMutation(
  options?: MutationOptions<
    CredentialProfileApplicationProjection,
    ApplyCredentialProfileInput
  >,
) {
  return useCredentialRecoveryMutation<
    CredentialProfileApplicationProjection,
    ApplyCredentialProfileInput
  >(
    (apiBase, { id, ref, confirmed, timeoutMs }) =>
      authenticatedFetch(
        `${apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles/${encodeURIComponent(ref)}/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirmed,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          }),
        },
      ),
    'Credential profile application failed',
    options,
  );
}
