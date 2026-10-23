import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  recheckACPConnectionRegistry,
  refreshACPPublicRegistrySource,
  useACPConnectionProbeStatusesQuery,
  useACPConnectionRegistryQuery,
  useACPConnectionsQuery,
  useACPPublicRegistrySourceQuery,
  useUnregisteredACPConnectionsQuery,
} from '@kontourai/station-sdk';

export type { ACPConnectionInfo, ACPConnectionRegistryEntry };
export { recheckACPConnectionRegistry, refreshACPPublicRegistrySource };

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

export function useACPPublicRegistrySource() {
  return useACPPublicRegistrySourceQuery();
}
