import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  useACPConnectionRegistryQuery,
  useACPConnectionsQuery,
} from '@kontourai/station-sdk';

export type { ACPConnectionInfo, ACPConnectionRegistryEntry };

export function useACPConnections() {
  return useACPConnectionsQuery();
}

export function useACPConnectionRegistry() {
  return useACPConnectionRegistryQuery();
}
