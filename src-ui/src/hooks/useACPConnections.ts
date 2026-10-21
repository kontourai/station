import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  useACPConnectionProbeStatusesQuery,
  useACPConnectionRegistryQuery,
  useACPConnectionsQuery,
  useUnregisteredACPConnectionsQuery,
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

/** Saved connections whose engine never registered (not installed engines). */
export function useUnregisteredACPConnections() {
  return useUnregisteredACPConnectionsQuery();
}

export function useACPConnectionRegistry() {
  return useACPConnectionRegistryQuery();
}
