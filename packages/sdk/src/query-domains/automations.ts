import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  listAutomationDeliveries,
  listAutomationEpisodes,
  listAutomationRules,
  listAutomationSources,
  retryAutomationEpisode,
} from '../client/automations';
import { useApiQuery } from '../query-core';

/**
 * React Query hooks for the Automation operator surface (#4513). Each list is
 * its own query, so one failed read leaves the others usable (a partial
 * view), and a view's count is always the length of the list it shows.
 */
const AUTOMATIONS_KEY = ['automations'] as const;

export function useAutomationSources() {
  return useApiQuery(
    [...AUTOMATIONS_KEY, 'sources'],
    async () => listAutomationSources(await _getApiBase()),
    { staleTime: 30_000, retry: false },
  );
}

export function useAutomationRules() {
  return useApiQuery(
    [...AUTOMATIONS_KEY, 'rules'],
    async () => listAutomationRules(await _getApiBase()),
    { staleTime: 30_000, retry: false },
  );
}

export function useAutomationEpisodes() {
  return useApiQuery(
    [...AUTOMATIONS_KEY, 'episodes'],
    async () => listAutomationEpisodes(await _getApiBase()),
    { staleTime: 30_000, retry: false },
  );
}

export function useAutomationDeliveries(limit = 50) {
  return useApiQuery(
    [...AUTOMATIONS_KEY, 'deliveries', limit],
    async () => listAutomationDeliveries(await _getApiBase(), { limit }),
    { staleTime: 30_000, retry: false },
  );
}

/** `retry-episode`; refreshes every Automation list when it settles. */
export function useRetryAutomationEpisode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (episode: { ruleId: string; episodeId: string }) =>
      retryAutomationEpisode(await _getApiBase(), episode),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY }),
  });
}
