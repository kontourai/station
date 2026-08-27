import { _getApiBase } from '../api';
import {
  fetchUsageRollup as fetchUsageRollupAt,
  type UsageRollupQuery,
  type UsageRollupResponse,
} from '../client/analytics';

export type {
  UsageRollupQuery,
  UsageRollupResponse,
} from '../client/analytics';

import {
  type MutationOptions,
  type QueryConfig,
  useApiMutation,
  useApiQuery,
} from '../query-core';

export interface FeedbackRatingInput {
  agentSlug: string;
  conversationId: string;
  messageIndex: number;
  messagePreview: string;
  rating: 'thumbs_up' | 'thumbs_down';
  reason?: string;
}

export interface FeedbackRatingDeleteInput {
  conversationId: string;
  messageIndex: number;
}

export async function fetchUsageStats(): Promise<any> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/analytics/usage`);
  if (!response.ok) throw new Error('Failed to fetch usage');
  const result = await response.json();
  return result.data;
}

export async function resetUsageStats(): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/analytics/usage`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to reset usage');
  }
}

export async function rescanAnalytics(): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/analytics/rescan`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to rescan analytics');
  }
}

export function useUsageQuery(config?: QueryConfig<any>) {
  return useApiQuery(['analytics', 'usage'], () => fetchUsageStats(), config);
}

export async function fetchUsageRollup(
  query: UsageRollupQuery,
): Promise<NonNullable<UsageRollupResponse['data']>> {
  const apiBase = await _getApiBase();
  const result = await fetchUsageRollupAt(apiBase, query);
  if (!result.success) {
    throw new Error('Failed to fetch usage rollup');
  }
  if (!result.data) throw new Error('Usage rollup returned no data');
  return result.data;
}

export function useUsageRollupQuery(
  query: UsageRollupQuery,
  config?: QueryConfig<NonNullable<UsageRollupResponse['data']>>,
) {
  return useApiQuery(
    [
      'analytics',
      'usage-rollup',
      query.days,
      query.groupBy ?? 'provider',
      query.cursor ?? '',
      query.pageSize ?? 50,
    ],
    () => fetchUsageRollup(query),
    config,
  );
}

export function useActivityUsageQuery(
  from: string,
  to: string,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    ['analytics', 'usage', from, to],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/analytics/usage?from=${from}&to=${to}`,
      );
      if (!response.ok) throw new Error('Failed to fetch activity usage');
      return (await response.json()).data;
    },
    config,
  );
}

export function useAchievementsQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['analytics', 'achievements'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/analytics/achievements`,
      );
      if (!response.ok) throw new Error('Failed to fetch achievements');
      const result = await response.json();
      return result.data;
    },
    config,
  );
}

/** Server-side slicing of the insights rollup (station#3075). */
export interface InsightsFilters {
  agent?: string;
  tool?: string;
  engine?: string;
  limit?: number;
}

function insightsQuery(days: number, filters: InsightsFilters = {}): string {
  const params = new URLSearchParams({ days: String(days) });
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.tool) params.set('tool', filters.tool);
  if (filters.engine) params.set('engine', filters.engine);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  return params.toString();
}

export async function fetchInsights(
  days = 14,
  filters: InsightsFilters = {},
): Promise<any> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/insights?${insightsQuery(days, filters)}`,
  );
  if (!response.ok) throw new Error('Failed to fetch insights');
  return (await response.json()).data;
}

export function useInsightsQuery(
  days = 14,
  filters: InsightsFilters = {},
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    // Filters belong in the cache key: without them, switching agent would
    // render the previous agent's numbers under the new label.
    // The key must be defined values: an undefined segment is not a valid
    // query key, and collapsing them to one string keeps a filtered result
    // from being served from an unfiltered cache entry.
    ['insights', days, insightsQuery(days, filters)],
    () => fetchInsights(days, filters),
    config,
  );
}

export async function fetchFeedbackRatings(): Promise<any[]> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/feedback/ratings`);
  if (!response.ok) throw new Error('Failed to fetch ratings');
  return (await response.json()).data || [];
}

export async function saveFeedbackRating(
  input: FeedbackRatingInput,
): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/feedback/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error('Failed to save feedback rating');
  }
}

export async function deleteFeedbackRating(
  input: FeedbackRatingDeleteInput,
): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/feedback/rate`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error('Failed to delete feedback rating');
  }
}

export async function analyzeFeedback(): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/feedback/analyze`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to analyze feedback');
  }
}

export async function clearFeedbackAnalysis(): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/feedback/clear-analysis`,
    {
      method: 'POST',
    },
  );
  if (!response.ok) {
    throw new Error('Failed to clear feedback analysis');
  }
}

export function useFeedbackRatingsQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['feedback', 'ratings'],
    () => fetchFeedbackRatings(),
    config,
  );
}

export function useFeedbackGuidelinesQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['feedback', 'guidelines'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/feedback/guidelines`,
      );
      if (!response.ok) throw new Error('Failed to fetch guidelines');
      return (await response.json()).data?.summary || null;
    },
    config,
  );
}

export function useFeedbackStatusQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['feedback', 'status'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/feedback/status`,
      );
      if (!response.ok) throw new Error('Failed to fetch feedback status');
      return (await response.json()).data || null;
    },
    config,
  );
}

export function useAnalyticsRescanMutation(
  options?: MutationOptions<void, void>,
) {
  return useApiMutation(async () => rescanAnalytics(), {
    invalidateKeys: [
      ['analytics', 'usage'],
      ['analytics', 'achievements'],
    ],
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
}

export function useResetUsageStatsMutation(
  options?: MutationOptions<void, void>,
) {
  return useApiMutation(async () => resetUsageStats(), {
    invalidateKeys: [['analytics', 'usage']],
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
}

export function useAnalyzeFeedbackMutation(
  options?: MutationOptions<void, void>,
) {
  return useApiMutation(async () => analyzeFeedback(), {
    invalidateKeys: [
      ['feedback', 'ratings'],
      ['feedback', 'guidelines'],
      ['feedback', 'status'],
    ],
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
}

export function useClearFeedbackAnalysisMutation(
  options?: MutationOptions<void, void>,
) {
  return useApiMutation(async () => clearFeedbackAnalysis(), {
    invalidateKeys: [
      ['feedback', 'ratings'],
      ['feedback', 'guidelines'],
      ['feedback', 'status'],
    ],
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
}

export function useSaveFeedbackRatingMutation(
  options?: MutationOptions<void, FeedbackRatingInput>,
) {
  return useApiMutation(async (input) => saveFeedbackRating(input), {
    invalidateKeys: [['feedback', 'ratings']],
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
}

export function useDeleteFeedbackRatingMutation(
  options?: MutationOptions<void, FeedbackRatingDeleteInput>,
) {
  return useApiMutation(async (input) => deleteFeedbackRating(input), {
    invalidateKeys: [['feedback', 'ratings']],
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
}

import { authenticatedFetch } from '../client/http';
