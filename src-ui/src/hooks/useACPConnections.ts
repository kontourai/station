import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  type ACPPublicRegistrySourceStatus,
  recheckACPConnectionRegistry,
  refreshACPPublicRegistrySource,
  useACPConnectionRegistryQuery,
  useACPConnectionsQuery,
  useACPPublicRegistrySourceQuery,
} from '@kontourai/station-sdk';

export type {
  ACPConnectionInfo,
  ACPConnectionRegistryEntry,
  ACPPublicRegistrySourceStatus,
};
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
