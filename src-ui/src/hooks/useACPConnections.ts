import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  useACPConnectionProbeStatusesQuery,
  useACPConnectionRegistryQuery,
  useACPConnectionsQuery,
} from '@kontourai/station-sdk';

export type { ACPConnectionInfo, ACPConnectionRegistryEntry };

export function useACPConnections() {
  return useACPConnectionsQuery();
}

/** Live probe status; polled only while `enabled` (a first start runs). */
export function useACPConnectionProbeStatuses(enabled: boolean) {
  return useACPConnectionProbeStatusesQuery({
    enabled,
    refetchInterval: enabled ? 2_000 : undefined,
  });
}

export function useACPConnectionRegistry() {
  return useACPConnectionRegistryQuery();
}
