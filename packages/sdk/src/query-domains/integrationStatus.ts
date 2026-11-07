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
  options?: ClientRequestOptions & { includeGithubAuthentication?: boolean },
): Promise<IntegrationStatus> {
  const base = options?.requestScope?.apiBase ?? apiBase;
  const response = await getJson(
    `${base}/api/integrations/status${options?.includeGithubAuthentication ? '?include=github-authentication' : ''}`,
    {
      ...options,
      maxResponseBytes: 1_048_576,
    },
  );
  const body: unknown = await response.json().catch(unlessDeadline(() => null));
  if (response.status === 404) {
    if (
      body &&
      typeof body === 'object' &&
      'code' in body &&
      body.code === 'feature_preview_disabled'
    )
      throw envelopeError(
        response,
        body,
        'Repository sign-in details are disabled',
      );
    throw new IntegrationStatusUnsupportedError();
  }
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
    includeGithubAuthentication?: boolean;
  },
) {
  return useApiQuery<IntegrationStatus>(
    [
      'integration-status',
      config?.requestScope?.apiBase ?? apiBase,
      config?.requestScope?.authorityKey ?? 'default',
      ...(config?.includeGithubAuthentication ? ['github-authentication'] : []),
    ],
    (signal) =>
      fetchIntegrationStatus(apiBase, {
        signal,
        includeGithubAuthentication: config?.includeGithubAuthentication,
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
