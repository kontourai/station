import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  recheckACPConnectionRegistry,
  refreshACPPublicRegistrySource,
  useACPConnectionRegistryQuery,
  useACPConnectionsQuery,
  useACPPublicRegistrySourceQuery,
} from '@kontourai/station-sdk';

export type { ACPConnectionInfo, ACPConnectionRegistryEntry };
export { recheckACPConnectionRegistry, refreshACPPublicRegistrySource };

export function useACPConnections() {
  return useACPConnectionsQuery();
}

export function useACPConnectionRegistry() {
  return useACPConnectionRegistryQuery();
}

export function useACPPublicRegistrySource() {
  return useACPPublicRegistrySourceQuery();
}
