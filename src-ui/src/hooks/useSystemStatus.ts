/**
 * useSystemStatus — fetches /api/system/status through shared SDK queries.
 * Used by OnboardingGate, Agents page, Schedule page.
 */

import { useConnections } from '@kontourai/station-connect';
import { useSystemStatusForApiBaseQuery } from '@kontourai/station-sdk';

export function useSystemStatus(pollInterval?: number) {
  const { apiBase } = useConnections();
  return useSystemStatusForApiBaseQuery(apiBase, pollInterval);
}
