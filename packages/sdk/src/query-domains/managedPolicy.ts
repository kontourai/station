import {
  type ManagedPolicyStatus,
  parseManagedPolicyStatus,
} from '@kontourai/station-contracts/managed-policy-status';
import { apiErrorMessage } from '../api-core';
import { type ApiRequestScope, authenticatedFetch } from '../client/http';
import {
  captureConnectionReadTarget,
  connectionQueryKey,
} from '../connection-read-target';
import { type QueryConfig, resolveApiBase, useApiQuery } from '../query-core';

/**
 * `GET /api/settings/managed-policy` (#4516): the managed policy the server
 * loaded at startup. A host older than the route answers 404, which means it
 * enforces no policy, so it reads as `{ state: 'none' }`. The server enforces
 * the policy whatever a client shows; this read only explains a managed
 * control.
 */
export async function fetchManagedPolicyStatus(
  apiBase?: string,
  options?: { requestScope?: ApiRequestScope; signal?: AbortSignal },
): Promise<ManagedPolicyStatus> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}/api/settings/managed-policy`,
    { signal: options?.signal, requestScope: options?.requestScope },
  );
  if (response.status === 404) return { state: 'none' };
  const result = (await response.json()) as {
    success?: boolean;
    data?: unknown;
    error?: string;
  };
  if (!response.ok || !result.success)
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  const status = parseManagedPolicyStatus(result.data);
  if (!status) throw new Error('The managed policy status was not readable.');
  return status;
}

/** The policy is fixed for the server's lifetime, so one read per base serves. */
export function useManagedPolicyStatusQuery(
  apiBase?: string,
  config?: QueryConfig<ManagedPolicyStatus>,
) {
  const target = captureConnectionReadTarget(config?.readTarget);
  return useApiQuery(
    target
      ? connectionQueryKey('managed-policy', target)
      : ['managed-policy', apiBase ?? 'default'],
    (signal) =>
      fetchManagedPolicyStatus(target?.targetApiBase ?? apiBase, {
        requestScope: target?.requestScope,
        signal,
      }),
    { staleTime: Number.POSITIVE_INFINITY, ...config },
  );
}
