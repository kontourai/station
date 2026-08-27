import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
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
): Promise<FeaturePreview[]> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(`${base}/api/feature-previews`);
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
) {
  return useApiQuery(
    ['feature-previews', apiBase ?? 'default'],
    () => fetchFeaturePreviews(apiBase),
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
