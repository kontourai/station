import {
  type IntegrationStatus,
  parseIntegrationStatus,
} from '@kontourai/station-contracts/integration-status';
import { envelopeError } from '../client/api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  StationHttpError,
} from '../client/http';
import { unlessDeadline } from '../client/request-deadline';
import { type QueryConfig, useApiQuery } from '../query-core';

export type { IntegrationStatus };

export class IntegrationStatusUnsupportedError extends StationHttpError {
  constructor() {
    super(
      404,
      'Integration status is not supported by this Station. Update the host and try again.',
    );
    this.name = 'IntegrationStatusUnsupportedError';
  }
}

export async function fetchIntegrationStatus(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<IntegrationStatus> {
  const base = options?.requestScope?.apiBase ?? apiBase;
  const response = await getJson(`${base}/api/integrations/status`, {
    ...options,
    maxResponseBytes: 1_048_576,
  });
  if (response.status === 404) throw new IntegrationStatusUnsupportedError();
  const body: unknown = await response.json().catch(unlessDeadline(() => null));
  if (!response.ok)
    throw envelopeError(response, body, 'Integration status unavailable');
  if (
    !body ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true ||
    !('data' in body)
  )
    throw new Error('Integration status response is invalid or unsupported');
  const status = parseIntegrationStatus(body.data);
  if (!status)
    throw new Error('Integration status response is invalid or unsupported');
  return status;
}

export function useIntegrationStatusQuery(
  apiBase: string,
  config?: QueryConfig<IntegrationStatus> & {
    requestScope?: ClientRequestOptions['requestScope'];
  },
) {
  return useApiQuery<IntegrationStatus>(
    [
      'integration-status',
      config?.requestScope?.apiBase ?? apiBase,
      config?.requestScope?.authorityKey ?? 'default',
    ],
    (signal) =>
      fetchIntegrationStatus(apiBase, {
        signal,
        requestScope: config?.requestScope,
      }),
    {
      ...config,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      retry: false,
      keepPreviousData: false,
    },
  );
}
