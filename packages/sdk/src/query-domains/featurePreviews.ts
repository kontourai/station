import { apiErrorMessage } from '../api-core';
import { type ApiRequestScope, authenticatedFetch } from '../client/http';
import {
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
} from '../query-core';
export interface FeaturePreview {
  id: string;
  label: string;
  description: string;
  defaultEnabled?: boolean;
  enabled: boolean;
}

export async function fetchFeaturePreviews(
  apiBase?: string,
  requestScope?: ApiRequestScope,
): Promise<FeaturePreview[]> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}/api/feature-previews`,
    requestScope ? { requestScope } : undefined,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: FeaturePreview[];
    error?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data;
}

export async function updateFeaturePreview(
  input: { id: string; enabled: boolean },
  apiBase?: string,
): Promise<FeaturePreview> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}/api/feature-previews/${encodeURIComponent(input.id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: input.enabled }),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: FeaturePreview;
    error?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data;
}

export function useFeaturePreviewsQuery(
  apiBase?: string,
  config?: QueryConfig<FeaturePreview[]>,
  requestScope?: ApiRequestScope,
) {
  return useApiQuery(
    [
      'feature-previews',
      apiBase ?? 'default',
      ...(requestScope ? [requestScope.authorityKey] : []),
    ],
    () => fetchFeaturePreviews(apiBase, requestScope),
    config,
  );
}

export function useUpdateFeaturePreviewMutation(apiBase?: string) {
  return useApiMutation(
    (input: { id: string; enabled: boolean }) =>
      updateFeaturePreview(input, apiBase),
    { invalidateKeys: [['feature-previews']] },
  );
}
